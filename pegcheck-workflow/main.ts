import {
  CronCapability,
  EVMClient,
  HTTPClient,
  handler,
  Runner,
  type Runtime,
  type NodeRuntime,
  ConsensusAggregationByFields,
  identical,
  ok,
  json,
} from "@chainlink/cre-sdk"
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
} from "viem"
import { decide } from "./lib/agent/rules.js"
import type { Evidence } from "./lib/agent/rules.js"
import { summariseHistory, buildHistoryStats } from "./lib/agent/history.js"
import type { HistoryEntry, ApiSummary } from "./lib/agent/history.js"

// ── Types ──────────────────────────────────────────────────────────────────────

type Config = {
  schedule: string
  ethChainSelector: string   // decimal: "5009297550715157269" = Ethereum mainnet
  usdcFeedAddress: string    // 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6
  pricesApiUrl: string       // https://pegcheck.uk/api/prices
  historyApiUrl: string      // https://pegcheck.uk/api/price-history?slug=usdc&days=3
}

type PricesApiResponse = {
  prices: Record<string, number>
  sources: Record<string, Record<string, number>>
}

type HistoryApiResponse = {
  history: HistoryEntry[]
}

// Compact payload sent through consensus.
// Pre-summarising inside runInNodeMode keeps observation size ~300 bytes instead
// of the ~70 KB of raw 3-day history entries that would exceed the 25 KB limit.
type ConsensusPayload = {
  v: string  // JSON-encoded ApiSummary — single-field wrapper for identical aggregation
}

// ── Constants ─────────────────────────────────────────────────────────────────

const USDC_PEG = 1.0

const CHAINLINK_USDC_USD_ABI = parseAbi([
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
])

// ── Helpers ───────────────────────────────────────────────────────────────────

function uint8ArrayToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x"
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex as `0x${string}`
}

// protobuf JSON encodes bytes as base64; call.to and call.data are bytes fields
function hexToBase64(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex
  return Buffer.from(h, "hex").toString("base64")
}

// ── Handler ───────────────────────────────────────────────────────────────────

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const httpClient = new HTTPClient()
  const evmClient  = new EVMClient(BigInt(runtime.config.ethChainSelector))
  const nowMs      = runtime.now().getTime()

  // ── Step 1: Fetch APIs in node mode; pre-summarise history to stay under
  //           the 25 KB consensus observation limit; reach multi-node agreement ──
  const { v: summaryJson } = runtime.runInNodeMode(
    (nodeRuntime: NodeRuntime<Config>): ConsensusPayload => {
      const pricesResp = httpClient.sendRequest(nodeRuntime, {
        url: runtime.config.pricesApiUrl, method: "GET",
      }).result()
      if (!ok(pricesResp)) throw new Error(`prices API HTTP ${pricesResp.statusCode}`)

      const historyResp = httpClient.sendRequest(nodeRuntime, {
        url: runtime.config.historyApiUrl, method: "GET",
      }).result()
      if (!ok(historyResp)) throw new Error(`history API HTTP ${historyResp.statusCode}`)

      const pricesBody  = json(pricesResp)  as PricesApiResponse
      const historyBody = json(historyResp) as HistoryApiResponse

      const rawSources = pricesBody.sources?.["usdc"] ?? {}
      const sources: Record<string, number> = {}
      for (const [src, val] of Object.entries(rawSources)) {
        if (val > 0) sources[src] = val
      }

      const summary: ApiSummary = {
        medianPrice: pricesBody.prices["usdc"] ?? 0,
        sources,
        ...summariseHistory(historyBody.history, nowMs),
      }
      return { v: JSON.stringify(summary) }
    },
    ConsensusAggregationByFields<ConsensusPayload>({ v: identical }),
  )().result()

  const summary = JSON.parse(summaryJson) as ApiSummary

  runtime.log(`[API] USDC median: ${summary.medianPrice}`)
  runtime.log(`[API] History entries: ${summary.historyCount}  oldest=${new Date(summary.oldestTs).toISOString()}  newest=${new Date(summary.latestTs).toISOString()}  newestPrice=$${summary.latestPrice}`)
  if (nowMs - summary.latestTs > 10 * 60 * 1000) {
    runtime.log(`[HISTORY] WARNING: newest entry is ${((nowMs - summary.latestTs) / 60000).toFixed(1)} min old — data may be stale`)
  }

  // ── Step 2: EVM read — Chainlink USDC/USD feed on Ethereum mainnet ──
  const callData = encodeFunctionData({
    abi: CHAINLINK_USDC_USD_ABI, functionName: "latestRoundData",
  })

  const evmResult = evmClient.callContract(runtime, {
    call: {
      to:   hexToBase64(runtime.config.usdcFeedAddress),
      data: hexToBase64(callData),
    },
  }).result()

  // evmResult.data is Uint8Array; viem expects 0x-prefixed hex
  const decoded = decodeFunctionResult({
    abi: CHAINLINK_USDC_USD_ABI, functionName: "latestRoundData",
    data: uint8ArrayToHex(evmResult.data),
  })
  // decoded[1] = int256 answer, 8 decimals
  const chainlinkPriceUsd = Number(decoded[1]) / 1e8

  runtime.log(`[EVM] Chainlink USDC/USD on-chain: $${chainlinkPriceUsd.toFixed(8)}`)

  // ── Step 3: Build evidence ──
  const pricesBySource = { ...summary.sources, "chainlink-onchain": chainlinkPriceUsd }
  const medianPrice    = summary.medianPrice

  const priceDiffPct          = medianPrice > 0
    ? Math.abs(medianPrice - chainlinkPriceUsd) / medianPrice : 1
  const pricesAgreeWithin05pct = priceDiffPct < 0.005

  const historyStats = buildHistoryStats(summary, nowMs)

  const evidence: Evidence = {
    coin: "USDC", peg: USDC_PEG, medianPrice, pricesBySource,
    largeTransferCount24h: 0, largeTransferTotalUsd24h: 0, openPositionsCount: 0,
    history: historyStats,
  }

  const result = decide(evidence)

  // ── Step 4: Log full report ──
  runtime.log("━━━ PegCheck Agent Report ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  runtime.log(`USDC median price   (PegCheck) : $${medianPrice.toFixed(6)}`)
  runtime.log(`USDC on-chain price (Chainlink): $${chainlinkPriceUsd.toFixed(6)}`)
  runtime.log(
    `Prices agree within 0.5%       : ${pricesAgreeWithin05pct}  ` +
    `(diff ${(priceDiffPct * 100).toFixed(4)}%)`
  )
  runtime.log(`Decision                       : ${result.decision.toUpperCase()}`)
  runtime.log(`Danger   score: ${result.danger.score}/100`)
  for (const r of result.danger.reasons) {
    runtime.log(`  [DANGER]  ${r}`)
  }
  runtime.log(`Opportunity score: ${result.opportunity.score}/100`)
  for (const r of result.opportunity.reasons) {
    runtime.log(`  [OPP]     ${r}`)
  }
  if (result.buy) {
    runtime.log(
      `Buy params: entry=$${result.buy.entry.toFixed(6)}  ` +
      `tp=$${result.buy.takeProfit.toFixed(6)}  ` +
      `sl=$${result.buy.stopLoss.toFixed(6)}  ` +
      `size=$${result.buy.sizeUsd}`
    )
  }
  runtime.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

  return JSON.stringify({
    decision:                result.decision,
    dangerScore:             result.danger.score,
    dangerReasons:           result.danger.reasons,
    opportunityScore:        result.opportunity.score,
    opportunityReasons:      result.opportunity.reasons,
    medianPrice,
    chainlinkPrice:          chainlinkPriceUsd,
    pricesAgreeWithin05pct,
    buy:                     result.buy ?? null,
    historyStats: {
      hoursOffPeg:     historyStats.hoursOffPeg,
      change1hPct:     historyStats.change1hPct,
      change24hPct:    historyStats.change24hPct,
      bounceFromLowPct: historyStats.bounceFromLowPct,
      daysOfData:      historyStats.daysOfData,
    },
  })
}

// ── Workflow registration ─────────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}
