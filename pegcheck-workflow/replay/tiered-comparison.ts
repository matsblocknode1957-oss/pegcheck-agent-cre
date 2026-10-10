// tiered-comparison.ts
// Variant T (tiered): applies different buy-rules by coin backing type.
//   STRICT tier (ust, usdd, frax, dola, alusd, ethena):
//     A + C — block any repeat dip within 72 h + chronic filter (>50% of 72 h below 0.995)
//   BACKED tier (usdc, usdt, pyusd, rlusd, fdusd, usdp, tusd, lusd, bold, mkusd, crvusd, gho, usds):
//     F + C — Rule B only when dip ≥ 1.5% + same chronic filter
//
// Runs T alongside A0, F, F+C on:
//   1. 18-coin 3-slot portfolio (glitches included, same settings as follow-up-comparison)
//   2. UST May 2022 and USDC Mar 2023 crash datasets
//
// Appends results to replay/full-data-comparison.md.
// Run: bun run replay/tiered-comparison.ts

import { conservativeExit } from "./replay-core.js"
import type { Candle } from "./replay-core.js"
import { summariseHistory, buildHistoryStats } from "../lib/agent/history.js"
import type { HistoryEntry, ApiSummary } from "../lib/agent/history.js"
import { decide } from "../lib/agent/rules.js"
import type { OpenTrade, ExitStatus } from "../lib/agent/rules.js"
import {
  DIP_ZONE_START_PCT,
  TAKE_PROFIT_DISTANCE_PCT,
  MAX_TRADE_DAYS,
} from "../lib/agent/config.js"
import { readFileSync, appendFileSync } from "fs"

// ── Constants ──────────────────────────────────────────────────────────────────
const FEE_RATE          = 0.0005
const STOP_PCT          = 0.03
const THREE_DAYS_MS     = 3 * 24 * 60 * 60 * 1000
const PEG               = 1.0
const MAX_PORTFOLIO_POS = 3
const AT_PEG_THRESH     = PEG * (1 - DIP_ZONE_START_PCT)  // 0.995
const CHRONIC_FRAC      = 0.5

// ── Tier assignments ───────────────────────────────────────────────────────────
const STRICT_TIER = new Set(["ust", "usdd", "frax", "dola", "alusd", "ethena"])
const getTier = (slug: string): "strict" | "backed" =>
  STRICT_TIER.has(slug.toLowerCase()) ? "strict" : "backed"

type Mode = "off" | "any" | "f" | "fc" | "t"

// ── Batch CSV loader (18-coin portfolio) ───────────────────────────────────────
type RawTuple = [string, number, number, number, number]

function loadBatches(): { slug: string; candles: Candle[] }[] {
  const result: { slug: string; candles: Candle[] }[] = []
  for (let i = 1; i <= 4; i++) {
    const csvPath = new URL(`data/replay-batch${i}.csv`, import.meta.url)
      .pathname.replace(/^\/([A-Za-z]:)/, "$1")
    const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/).slice(1)
    for (const line of lines) {
      const comma = line.indexOf(",")
      const slug  = line.slice(0, comma)
      let   json  = line.slice(comma + 1)
      if (json.startsWith('"') && json.endsWith('"'))
        json = json.slice(1, -1).replace(/""/g, '"')
      const tuples = JSON.parse(json) as RawTuple[]
      result.push({
        slug,
        candles: tuples.map(([iso, , high, low, close]) => ({
          ts:             Date.parse(iso),
          median:         close,
          low_median:     low,
          high_median:    high,
          pricesBySource: { blended: close },
          historyPrice:   close,
        })),
      })
    }
  }
  return result
}

// ── Candle loaders for crash datasets ─────────────────────────────────────────
const avg = (a: number, b: number | null) => b !== null ? (a + b) / 2 : a

async function loadUsdcCandles(): Promise<Candle[] | null> {
  try {
    const bsResp = await fetch(
      "https://www.bitstamp.net/api/v2/ohlc/usdcusd/?step=3600&start=1678233600&limit=240",
    )
    if (!bsResp.ok) return null
    const bsBody = await bsResp.json() as {
      data: { ohlc: Array<{ timestamp: string; high: string; low: string; close: string }> }
    }
    type BfxC = [number, number, number, number, number, number]
    const bfxResp = await fetch(
      "https://api-pub.bitfinex.com/v2/candles/trade:1h:tUDCUSD/hist" +
      "?start=1678233600000&end=1679097600000&limit=1000&sort=1",
    )
    const bfxRaw  = bfxResp.ok ? (await bfxResp.json() as BfxC[]) : []
    const bfxByTs = new Map(bfxRaw.map(c => [c[0], { close: c[2], high: c[3], low: c[4] }]))
    return bsBody.data.ohlc.map(c => {
      const ts = +c.timestamp * 1000; const bfx = bfxByTs.get(ts) ?? null
      return {
        ts,
        median:         avg(+c.close, bfx?.close ?? null),
        low_median:     avg(+c.low,   bfx?.low   ?? null),
        high_median:    avg(+c.high,  bfx?.high  ?? null),
        pricesBySource: bfx
          ? { bitstamp: +c.close, bitfinex: bfx.close }
          : { bitstamp: +c.close },
        historyPrice:   +c.close,
      }
    })
  } catch { return null }
}

async function loadUstCandles(): Promise<{ candles: Candle[]; singleSrc: boolean } | null> {
  const START = 1651708800000; const END = 1653004800000
  type BinK = [number, string, string, string, string, ...unknown[]]
  type BfxC = [number, number, number, number, number, number]

  let binRaw: BinK[] | null = null
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=USTUSDT&interval=1h` +
      `&startTime=${START}&endTime=${END}&limit=1000`,
    )
    if (r.ok) { const raw = await r.json() as BinK[]; if (raw.length > 5) binRaw = raw }
  } catch { /* skip */ }

  if (binRaw === null) return null

  let bfxByTs: Map<number, { close: number; high: number; low: number }> | null = null
  try {
    const r = await fetch(
      `https://api-pub.bitfinex.com/v2/candles/trade:1h:tTERRAUST:USD/hist` +
      `?start=${START}&end=${END}&limit=1000&sort=1`,
    )
    if (r.ok) {
      const raw = await r.json() as BfxC[] | { error?: string }
      if (Array.isArray(raw) && raw.length > 5 && raw[0]![2] > 0.5 && raw[raw.length - 1]![2] < 0.5)
        bfxByTs = new Map(raw.map(c => [c[0], { close: c[2], high: c[3], low: c[4] }]))
    }
  } catch { /* skip */ }

  if (bfxByTs !== null) {
    return {
      singleSrc: false,
      candles: binRaw.map(k => {
        const ts = k[0]; const close = +k[4]; const high = +k[2]; const low = +k[3]
        const bfx = bfxByTs!.get(ts) ?? null
        return {
          ts,
          median:         avg(close, bfx?.close ?? null),
          low_median:     avg(low,   bfx?.low   ?? null),
          high_median:    avg(high,  bfx?.high  ?? null),
          pricesBySource: bfx ? { binance: close, bitfinex: bfx.close } : { binance: close },
          historyPrice:   close,
        }
      }),
    }
  }
  return {
    singleSrc: true,
    candles: binRaw.map(k => ({
      ts: k[0], median: +k[4], low_median: +k[3], high_median: +k[2],
      pricesBySource: { binance: +k[4] }, historyPrice: +k[4],
    })),
  }
}

// ── Apply mode logic (shared by both portfolio and single-coin runners) ────────
// Returns false if buy should be skipped (chronic block), or mutates histStats in-place.
// Returns true if the caller should proceed to decide().
function applyMode(
  mode:        Mode,
  slug:        string,
  histEntries: HistoryEntry[],
  c:           Candle,
  histStats:   ReturnType<typeof buildHistoryStats>,
): { proceed: boolean; stats: ReturnType<typeof buildHistoryStats> } {
  const depegPct  = (PEG - c.median) / PEG
  const belowN    = histEntries.filter(e => e.price < AT_PEG_THRESH).length
  const chromFrac = histEntries.length > 0 ? belowN / histEntries.length : 0

  if (mode === "off") {
    return { proceed: true, stats: { ...histStats, hadPriorDipCycle: null } }
  }

  if (mode === "any") {
    return { proceed: true, stats: histStats }
  }

  if (mode === "f") {
    const stats = histStats.hadPriorDipCycle === true && depegPct < 0.015
      ? { ...histStats, hadPriorDipCycle: null as null }
      : histStats
    return { proceed: true, stats }
  }

  if (mode === "fc") {
    if (chromFrac > CHRONIC_FRAC) return { proceed: false, stats: histStats }
    const stats = histStats.hadPriorDipCycle === true && depegPct < 0.015
      ? { ...histStats, hadPriorDipCycle: null as null }
      : histStats
    return { proceed: true, stats }
  }

  // mode === "t"
  if (chromFrac > CHRONIC_FRAC) return { proceed: false, stats: histStats }
  const tier = getTier(slug)
  if (tier === "backed") {
    // F rule: suppress Rule B for shallow dips
    const stats = histStats.hadPriorDipCycle === true && depegPct < 0.015
      ? { ...histStats, hadPriorDipCycle: null as null }
      : histStats
    return { proceed: true, stats }
  }
  // strict tier: full Rule B fires — no suppression
  return { proceed: true, stats: histStats }
}

// ── Single-coin crash-dataset run ──────────────────────────────────────────────
type ClosedTradeSingle = {
  ts:         number
  price:      number
  exitStatus: ExitStatus | "open"
  netPnl:     number
}

type CoinRunResult = {
  trades:      ClosedTradeSingle[]
  maxDrawdown: number
}

function runCoin(candles: Candle[], coin: string, mode: Mode): CoinRunResult {
  const fee = (gross: number, sz: number) => (2 * sz + gross) * FEE_RATE

  let openTrade: OpenTrade | null = null
  const trades: ClosedTradeSingle[] = []
  let cumPnl = 0, peakPnl = 0, maxDrawdown = 0

  const trackClose = (netPnl: number) => {
    cumPnl += netPnl
    if (cumPnl > peakPnl) peakPnl = cumPnl
    if (peakPnl - cumPnl > maxDrawdown) maxDrawdown = peakPnl - cumPnl
  }

  for (let i = 0; i < candles.length; i++) {
    const c     = candles[i]!
    const nowMs = c.ts

    if (openTrade !== null) {
      const exit = conservativeExit(
        openTrade, c.median, c.low_median, c.high_median,
        new Date(nowMs), STOP_PCT, MAX_TRADE_DAYS, TAKE_PROFIT_DISTANCE_PCT,
      )
      if (exit.status !== "open") {
        const netPnl = exit.profitUsd - fee(exit.profitUsd, openTrade.sizeUsd)
        trades.push({
          ts: openTrade.openedAt.getTime(), price: openTrade.entry,
          exitStatus: exit.status, netPnl,
        })
        openTrade = null
        trackClose(netPnl)
      }
    }

    if (openTrade !== null) continue

    const winStart = nowMs - THREE_DAYS_MS
    const histEntries: HistoryEntry[] = []
    let lo = 0, hi = i
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (candles[mid]!.ts < winStart) lo = mid + 1; else hi = mid
    }
    for (let j = lo; j <= i; j++)
      histEntries.push({ created_at: new Date(candles[j]!.ts).toISOString(), price: candles[j]!.historyPrice })

    let srcPrices = { ...c.pricesBySource }
    if (Object.keys(srcPrices).length === 1) {
      const [k, v] = Object.entries(srcPrices)[0]!
      srcPrices = { [k]: v, [`${k}_echo`]: v }
    }

    const summarised = summariseHistory(histEntries, nowMs)
    const apiSummary: ApiSummary = { medianPrice: c.median, sources: srcPrices, ...summarised }
    const rawStats   = buildHistoryStats(apiSummary, nowMs)

    const { proceed, stats } = applyMode(mode, coin, histEntries, c, rawStats)
    if (!proceed) continue

    const result = decide({
      coin, peg: PEG,
      medianPrice:              c.median,
      pricesBySource:           srcPrices,
      largeTransferCount24h:    0,
      largeTransferTotalUsd24h: 0,
      openPositionsCount:       0,
      history:                  stats,
    })

    if (result.decision === "buy" && result.buy !== undefined) {
      openTrade = {
        coin, peg: PEG,
        entry:    result.buy.entry,
        sizeUsd:  result.buy.sizeUsd,
        openedAt: new Date(nowMs),
      }
    }
  }

  if (openTrade !== null) {
    const last   = candles[candles.length - 1]!
    const gross  = (openTrade.sizeUsd / openTrade.entry) * last.median - openTrade.sizeUsd
    const netPnl = gross - fee(gross, openTrade.sizeUsd)
    trades.push({
      ts: openTrade.openedAt.getTime(), price: openTrade.entry,
      exitStatus: "open", netPnl,
    })
    trackClose(netPnl)
  }

  return { trades, maxDrawdown }
}

// ── Portfolio simulation ───────────────────────────────────────────────────────
type ClosedTradePort = { coin: string; status: ExitStatus | "open"; netPnl: number }

type PortfolioResult = {
  closedTrades: ClosedTradePort[]
  skipped:      number
  maxDrawdown:  number
}

function runPortfolio(
  coins: { slug: string; candles: Candle[] }[],
  mode:  Mode,
): PortfolioResult {
  const fee = (gross: number, sz: number) => (2 * sz + gross) * FEE_RATE

  const bySlug    = new Map<string, Candle[]>()
  for (const { slug, candles } of coins) bySlug.set(slug, candles)

  const candleMap = new Map<string, Map<number, { c: Candle; idx: number }>>()
  for (const { slug, candles } of coins) {
    const m = new Map<number, { c: Candle; idx: number }>()
    candles.forEach((c, idx) => m.set(c.ts, { c, idx }))
    candleMap.set(slug, m)
  }

  const tsToSlugs = new Map<number, string[]>()
  for (const { slug, candles } of coins) {
    for (const c of candles) {
      const arr = tsToSlugs.get(c.ts) ?? []; arr.push(slug); tsToSlugs.set(c.ts, arr)
    }
  }
  const allTs = [...tsToSlugs.keys()].sort((a, b) => a - b)

  const openTrade = new Map<string, OpenTrade | null>()
  for (const { slug } of coins) openTrade.set(slug, null)

  let slotsUsed   = 0
  let skipped     = 0
  const closed: ClosedTradePort[] = []
  let closedPnl   = 0
  let peakPnl     = 0
  let maxDrawdown = 0

  const trackClose = (netPnl: number) => {
    closedPnl += netPnl
    if (closedPnl > peakPnl) peakPnl = closedPnl
    if (peakPnl - closedPnl > maxDrawdown) maxDrawdown = peakPnl - closedPnl
  }

  for (const ts of allTs) {
    const slugsHere = tsToSlugs.get(ts)!

    for (const slug of slugsHere) {
      const ot = openTrade.get(slug)
      if (!ot) continue
      const { c } = candleMap.get(slug)!.get(ts)!
      const exit  = conservativeExit(
        ot, c.median, c.low_median, c.high_median,
        new Date(ts), STOP_PCT, MAX_TRADE_DAYS, TAKE_PROFIT_DISTANCE_PCT,
      )
      if (exit.status !== "open") {
        const netPnl = exit.profitUsd - fee(exit.profitUsd, ot.sizeUsd)
        closed.push({ coin: slug, status: exit.status, netPnl })
        openTrade.set(slug, null)
        slotsUsed--
        trackClose(netPnl)
      }
    }

    for (const slug of slugsHere) {
      if (openTrade.get(slug) !== null) continue

      const { c, idx } = candleMap.get(slug)!.get(ts)!
      const allCandles  = bySlug.get(slug)!
      const winStart    = ts - THREE_DAYS_MS

      let lo = 0, hi = idx
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (allCandles[mid]!.ts < winStart) lo = mid + 1; else hi = mid
      }
      const histEntries: HistoryEntry[] = []
      for (let j = lo; j <= idx; j++)
        histEntries.push({ created_at: new Date(allCandles[j]!.ts).toISOString(), price: allCandles[j]!.historyPrice })

      let srcPrices = { ...c.pricesBySource }
      if (Object.keys(srcPrices).length === 1) {
        const [k, v] = Object.entries(srcPrices)[0]!
        srcPrices = { [k]: v, [`${k}_echo`]: v }
      }

      const summarised = summariseHistory(histEntries, ts)
      const apiSummary: ApiSummary = { medianPrice: c.median, sources: srcPrices, ...summarised }
      const rawStats   = buildHistoryStats(apiSummary, ts)

      const { proceed, stats } = applyMode(mode, slug, histEntries, c, rawStats)
      if (!proceed) continue

      const result = decide({
        coin: slug, peg: PEG,
        medianPrice:              c.median,
        pricesBySource:           srcPrices,
        largeTransferCount24h:    0,
        largeTransferTotalUsd24h: 0,
        openPositionsCount:       0,
        history:                  stats,
      })

      if (result.decision === "buy" && result.buy !== undefined) {
        if (slotsUsed >= MAX_PORTFOLIO_POS) {
          skipped++
        } else {
          openTrade.set(slug, {
            coin: slug, peg: PEG,
            entry:    result.buy.entry,
            sizeUsd:  result.buy.sizeUsd,
            openedAt: new Date(ts),
          })
          slotsUsed++
        }
      }
    }
  }

  for (const { slug, candles } of coins) {
    const ot = openTrade.get(slug)
    if (!ot) continue
    const last   = candles[candles.length - 1]!
    const gross  = (ot.sizeUsd / ot.entry) * last.median - ot.sizeUsd
    const netPnl = gross - fee(gross, ot.sizeUsd)
    closed.push({ coin: slug, status: "open", netPnl })
    trackClose(netPnl)
  }

  return { closedTrades: closed, skipped, maxDrawdown }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const fp = (n: number) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2)

function summariseCoin(r: CoinRunResult) {
  const wins = r.trades.filter(t => t.exitStatus === "won").length
  const loss = r.trades.filter(t => t.exitStatus === "lost").length
  const tout = r.trades.filter(t => t.exitStatus === "timed_out").length
  const open = r.trades.filter(t => t.exitStatus === "open").length
  const pnl  = r.trades.reduce((s, t) => s + t.netPnl, 0)
  return { n: r.trades.length, wins, loss, tout, open, pnl, maxDrawdown: r.maxDrawdown }
}

function perCoinStats(trades: ClosedTradePort[]) {
  const m = new Map<string, { n: number; wins: number; losses: number; timeouts: number; open: number; netPnl: number }>()
  for (const t of trades) {
    const s = m.get(t.coin) ?? { n: 0, wins: 0, losses: 0, timeouts: 0, open: 0, netPnl: 0 }
    s.n++
    if (t.status === "won")            s.wins++
    else if (t.status === "lost")      s.losses++
    else if (t.status === "timed_out") s.timeouts++
    else if (t.status === "open")      s.open++
    s.netPnl += t.netPnl
    m.set(t.coin, s)
  }
  return m
}

// ── Main ───────────────────────────────────────────────────────────────────────
console.log("Fetching / loading candles…")
const [usdcCandles, ustData] = await Promise.all([loadUsdcCandles(), loadUstCandles()])
const ustCandles = ustData?.candles ?? null
const rawCoins   = loadBatches()

const d0 = (ms: number) => new Date(ms).toISOString().slice(0, 10)
console.log(`  Portfolio: ${rawCoins.length} coins`)
if (usdcCandles) console.log(`  USDC 2023: ${usdcCandles.length} candles  ${d0(usdcCandles[0]!.ts)} – ${d0(usdcCandles.at(-1)!.ts)}`)
else             console.log("  USDC 2023: unavailable")
if (ustCandles)  console.log(`  UST  2022: ${ustCandles.length} candles  ${d0(ustCandles[0]!.ts)} – ${d0(ustCandles.at(-1)!.ts)}`)
else             console.log("  UST  2022: unavailable (Binance)")

// Identify tiers in portfolio data
const strictInPortfolio = rawCoins.filter(c => getTier(c.slug) === "strict").map(c => c.slug)
const backedInPortfolio = rawCoins.filter(c => getTier(c.slug) === "backed").map(c => c.slug)
console.log(`\n  Strict tier in portfolio: [${strictInPortfolio.join(", ") || "none"}]`)
console.log(`  Backed tier in portfolio: [${backedInPortfolio.join(", ")}]`)

const VARIANTS: { label: string; mode: Mode }[] = [
  { label: "A0",  mode: "off" },
  { label: "F",   mode: "f"   },
  { label: "F+C", mode: "fc"  },
  { label: "T",   mode: "t"   },
]

// ── Portfolio runs ─────────────────────────────────────────────────────────────
console.log("\nRunning portfolio (18 coins, max 3 slots, glitches included)…")
type PortRun = { label: string; result: PortfolioResult }
const portRuns: PortRun[] = []

for (const v of VARIANTS) {
  process.stdout.write(`  ${v.label.padEnd(4)} … `)
  const result = runPortfolio(rawCoins, v.mode)
  portRuns.push({ label: v.label, result })
  const t    = result.closedTrades
  const wins = t.filter(x => x.status === "won").length
  const loss = t.filter(x => x.status === "lost").length
  const tout = t.filter(x => x.status === "timed_out").length
  const pnl  = t.reduce((s, x) => s + x.netPnl, 0)
  console.log(`${t.length}t  ${wins}W/${loss}L/${tout}TO  ${fp(pnl)}  dd=$${result.maxDrawdown.toFixed(2)}  skip=${result.skipped}`)
}

// ── Crash dataset runs ─────────────────────────────────────────────────────────
console.log("\nRunning crash datasets…")
type CrashRun = { label: string; ust: CoinRunResult | null; usdc: CoinRunResult | null }
const crashRuns: CrashRun[] = []

for (const v of VARIANTS) {
  const ust  = ustCandles  ? runCoin(ustCandles,  "UST",  v.mode) : null
  const usdc = usdcCandles ? runCoin(usdcCandles, "USDC", v.mode) : null
  crashRuns.push({ label: v.label, ust, usdc })
  const fmtCoin = (r: CoinRunResult | null, name: string) => {
    if (!r) return `${name}: n/a`
    const s = summariseCoin(r)
    return `${name}: ${s.n}t ${s.wins}W/${s.loss}L/${s.tout}TO  ${fp(s.pnl)}  dd=$${s.maxDrawdown.toFixed(2)}`
  }
  console.log(`  ${v.label.padEnd(4)} | ${fmtCoin(ust, "UST")} | ${fmtCoin(usdc, "USDC")}`)
}

// ── Console: portfolio summary ─────────────────────────────────────────────────
console.log()
console.log("═".repeat(100))
console.log("  TIERED VARIANT — portfolio A0 / F / F+C / T")
console.log("  18 coins · max 3 slots · glitches included · 3% stop · 7-day max · 0.05%/side fee")
console.log("═".repeat(100))
console.log(`  ${"Var".padEnd(4)}  ${"#".padEnd(4)}  ${"W/L/TO/O".padEnd(18)}  ${"Net P&L".padEnd(10)}  ${"Max DD".padEnd(9)}  Skipped`)
console.log("  " + "─".repeat(76))
for (const { label, result } of portRuns) {
  const t    = result.closedTrades
  const wins = t.filter(x => x.status === "won").length
  const loss = t.filter(x => x.status === "lost").length
  const tout = t.filter(x => x.status === "timed_out").length
  const open = t.filter(x => x.status === "open").length
  const pnl  = t.reduce((s, x) => s + x.netPnl, 0)
  const wlto = `${wins}W/${loss}L/${tout}TO/${open}O`
  console.log(`  ${label.padEnd(4)}  ${String(t.length).padEnd(4)}  ${wlto.padEnd(18)}  ${fp(pnl).padEnd(10)}  $${result.maxDrawdown.toFixed(2).padEnd(8)}  ${result.skipped}`)
}

const slugOrder = rawCoins.map(c => c.slug)
const portByLabel = new Map(portRuns.map(r => [r.label, r]))

console.log()
console.log("  Per-coin Net P&L (all variants)")
const hdr = "  Coin".padEnd(12) + VARIANTS.map(v => v.label.padEnd(12)).join("")
console.log(hdr)
console.log("  " + "─".repeat(hdr.length - 2))
for (const slug of slugOrder) {
  let row = ("  " + slug).padEnd(12)
  const tier = getTier(slug)
  for (const v of VARIANTS) {
    const st = perCoinStats(portByLabel.get(v.label)!.result.closedTrades).get(slug)
    row += (st ? fp(st.netPnl) : "—").padEnd(12)
  }
  row += `  [${tier}]`
  console.log(row)
}
console.log()

// ── Build markdown ─────────────────────────────────────────────────────────────
const md: string[] = []
md.push("")
md.push("---")
md.push("")
md.push("## Variant T (tiered): portfolio and crash datasets")
md.push("")
md.push("Variant T applies different buy-rules by coin backing type:")
md.push("")
md.push("| Tier | Coins | Rule |")
md.push("| ---- | ----- | ---- |")
md.push("| **STRICT** | ust, usdd, frax, dola, alusd, ethena | A + C: block any repeat dip within 72 h + chronic filter |")
md.push("| **BACKED** | usdc, usdt, pyusd, rlusd, fdusd, usdp, tusd, lusd, bold, mkusd, crvusd, gho, usds | F + C: Rule B only when dip ≥ 1.5% + same chronic filter |")
md.push("")
md.push(`Portfolio coins — **strict**: [${strictInPortfolio.join(", ") || "none"}] · **backed**: [${backedInPortfolio.join(", ")}]`)
md.push("")

// ── Portfolio summary table ────────────────────────────────────────────────────
md.push("### Portfolio: A0 / F / F+C / T")
md.push("")
md.push("18 coins · max 3 open · hour by hour · exits before buys · glitches included.")
md.push("Settings: 0.05%/side fee, 3% stop-loss, 7-day max hold, source check relaxed.")
md.push("")
md.push("| Variant | Trades | W/L/TO/O | Net P&L | Max Drawdown | Skipped |")
md.push("| ------- | ------ | -------- | ------- | ------------ | ------- |")

const fcPortPnl = portRuns.find(r => r.label === "F+C")!.result.closedTrades.reduce((s, t) => s + t.netPnl, 0)

for (const { label, result } of portRuns) {
  const t    = result.closedTrades
  const wins = t.filter(x => x.status === "won").length
  const loss = t.filter(x => x.status === "lost").length
  const tout = t.filter(x => x.status === "timed_out").length
  const open = t.filter(x => x.status === "open").length
  const pnl  = t.reduce((s, x) => s + x.netPnl, 0)
  md.push(`| **${label}** | ${t.length} | ${wins}W/${loss}L/${tout}TO/${open}O | **${fp(pnl)}** | $${result.maxDrawdown.toFixed(2)} | ${result.skipped} |`)
}
md.push("")

// ── Per-coin breakdown ─────────────────────────────────────────────────────────
md.push("#### Per-coin P&L")
md.push("")
md.push(`| Coin | Tier | A0 P&L | F P&L | F+C P&L | T P&L |`)
md.push(`| ---- | ---- | ------ | ----- | ------- | ----- |`)

let totPnl: Record<string, number> = {}
for (const v of VARIANTS) totPnl[v.label] = 0

for (const slug of slugOrder) {
  const tier = getTier(slug)
  const pnls = VARIANTS.map(v => {
    const st = perCoinStats(portByLabel.get(v.label)!.result.closedTrades).get(slug)
    if (st) totPnl[v.label]! += st.netPnl
    return st ? `**${fp(st.netPnl)}**` : "—"
  })
  md.push(`| ${slug} | ${tier} | ${pnls.join(" | ")} |`)
}
md.push(`| **TOTAL** | | ${VARIANTS.map(v => `**${fp(totPnl[v.label]!)}**`).join(" | ")} |`)
md.push("")

// ── Crash datasets ─────────────────────────────────────────────────────────────
md.push("### Crash datasets: UST May 2022 and USDC Mar 2023")
md.push("")
md.push("For T: UST is STRICT tier (A + C rules), USDC is BACKED tier (F + C rules).")
md.push("")

for (const [dsLabel, key] of [["UST May 2022 (STRICT tier)", "ust"], ["USDC Mar 2023 (BACKED tier)", "usdc"]] as const) {
  md.push(`#### ${dsLabel}`)
  md.push("")
  md.push("| Variant | Trades | W/L/TO/O | Net P&L | Max Drawdown |")
  md.push("| ------- | ------ | -------- | ------- | ------------ |")
  for (const row of crashRuns) {
    const r = row[key]
    if (!r) { md.push(`| **${row.label}** | n/a | — | — | — |`); continue }
    const s    = summariseCoin(r)
    const wlto = `${s.wins}W/${s.loss}L/${s.tout}TO/${s.open}O`
    md.push(`| **${row.label}** | ${s.n} | ${wlto} | **${fp(s.pnl)}** | $${s.maxDrawdown.toFixed(2)} |`)
  }
  md.push("")
}

// ── Q answers ─────────────────────────────────────────────────────────────────
md.push("### Q answers")
md.push("")

// Q1: UST
const ustT  = crashRuns.find(r => r.label === "T")!.ust
const ustFC = crashRuns.find(r => r.label === "F+C")!.ust
const ustA  = crashRuns.find(r => r.label === "A0")!.ust

if (!ustT || !ustFC) {
  md.push("**Q1: Does T avoid the UST loss?** UST data unavailable.")
} else {
  const sT  = summariseCoin(ustT)
  const sFC = summariseCoin(ustFC)
  const sA0 = ustA ? summariseCoin(ustA) : null
  if (sT.loss === 0 && sT.pnl > 0) {
    md.push(`**Q1: Does T avoid the UST loss? Yes.**`)
    md.push(``)
    md.push(`T takes ${sT.n} trade(s) on UST and nets **${fp(sT.pnl)}** — 0 losses.`)
    md.push(`F+C took ${sFC.n} trade(s) and netted **${fp(sFC.pnl)}** (${sFC.wins}W/${sFC.loss}L).`)
    md.push(``)
    md.push(`UST is in the STRICT tier, so T applies full Rule A (block any repeat dip within 72 h) plus`)
    md.push(`the chronic filter. The second, losing entry on 2022-05-09 had \`hadPriorDipCycle = true\``)
    md.push(`because UST had dipped, recovered briefly, and was dipping again — exactly what Rule A blocks.`)
    md.push(`F+C's version of Rule B was suppressed at that signal because the depeg was only ~0.5%, below`)
    md.push(`the 1.5% F-threshold. T does not suppress Rule B for STRICT coins, so the block fires and`)
    md.push(`the losing trade is avoided.`)
  } else if (sT.loss < sFC.loss) {
    md.push(`**Q1: Does T partially avoid the UST loss?** T reduces UST losses vs F+C.`)
    md.push(`T: ${sT.n}t ${sT.wins}W/${sT.loss}L ${fp(sT.pnl)} — F+C: ${sFC.n}t ${sFC.wins}W/${sFC.loss}L ${fp(sFC.pnl)}.`)
  } else {
    md.push(`**Q1: Does T avoid the UST loss? No**, same result as F+C on UST.`)
    md.push(`T: ${sT.n}t ${sT.wins}W/${sT.loss}L ${fp(sT.pnl)}.`)
    if (sA0) md.push(`(A0 baseline: ${sA0.n}t ${sA0.wins}W/${sA0.loss}L ${fp(sA0.pnl)})`)
  }
}

md.push("")

// Q2: USDC
const usdcT  = crashRuns.find(r => r.label === "T")!.usdc
const usdcFC = crashRuns.find(r => r.label === "F+C")!.usdc

if (!usdcT || !usdcFC) {
  md.push("**Q2: Does T keep the USDC win?** USDC data unavailable.")
} else {
  const sT  = summariseCoin(usdcT)
  const sFC = summariseCoin(usdcFC)
  if (sT.wins > 0) {
    md.push(`**Q2: Does T keep the USDC win? Yes.**`)
    md.push(``)
    md.push(`USDC is BACKED tier, so T = F+C on USDC.`)
    md.push(`T: ${sT.n}t ${sT.wins}W/${sT.loss}L **${fp(sT.pnl)}** — identical to F+C (**${fp(sFC.pnl)}**).`)
  } else {
    md.push(`**Q2: Does T keep the USDC win? No.** T: ${sT.n}t ${sT.wins}W/${sT.loss}L ${fp(sT.pnl)}.`)
  }
}

md.push("")

// Q3: portfolio comparison
const tPortPnl = portRuns.find(r => r.label === "T")!.result.closedTrades.reduce((s, t) => s + t.netPnl, 0)
const pctKept  = fcPortPnl !== 0 ? (tPortPnl / fcPortPnl * 100).toFixed(0) : "n/a"
const diff     = tPortPnl - fcPortPnl

md.push(`**Q3: How much of F+C's ${fp(fcPortPnl)} portfolio P&L does T keep?**`)
md.push(``)
md.push(`T nets **${fp(tPortPnl)}** on the 18-coin portfolio — ${pctKept}% of F+C's total.`)
if (Math.abs(diff) < 0.01) {
  md.push(`T and F+C are **identical** on this portfolio.`)
  md.push(``)
  if (strictInPortfolio.length === 0) {
    md.push(`There are no STRICT-tier coins in the portfolio data, so every coin is treated identically`)
    md.push(`to F+C. T's extra protection only activates for STRICT coins (ust, usdd, frax, dola, alusd,`)
    md.push(`ethena); none of those are present in the batch-data set.`)
  } else {
    md.push(`All STRICT-tier coins (${strictInPortfolio.join(", ")}) were already blocked by the chronic`)
    md.push(`filter under F+C, so T's stronger Rule B for those coins makes no additional difference here.`)
    md.push(`The extra protection only matters when a STRICT coin is at peg → dips → recovers → dips again`)
    md.push(`and is NOT in a chronic state. That pattern (UST May 2022) does not appear in the current`)
    md.push(`batch data.`)
  }
} else if (diff > 0) {
  md.push(`T earns **${fp(diff)} more** than F+C on the portfolio.`)
} else {
  md.push(`T earns **${fp(Math.abs(diff))} less** than F+C on the portfolio.`)
}
md.push("")

// ── Append ────────────────────────────────────────────────────────────────────
const mdPath = new URL("full-data-comparison.md", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1")
appendFileSync(mdPath, md.join("\n"))
console.log("Appended to replay/full-data-comparison.md")
