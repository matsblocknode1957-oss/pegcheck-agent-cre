// cross-dataset-comparison.ts
// Compares Rule B variants across three datasets in one table.
//
// Variants:
//   A0  No Rule B (baseline)
//   A   Current Rule B — any dip-recover-dip within 72 h
//   B   Refined Rule B — lower lows only (new low must be < previous dip's low)
//   F   Depth guard    — only block if current depeg ≥ 1.5% below peg
//   G   B or F         — block if lower lows OR depth ≥ 1.5% (either condition)
//
// Datasets: UST May 2022, USDC Mar 2023, own data 30 Aug–9 Oct 2026 (4 coins, summed)
//
// Run: bun run replay/cross-dataset-comparison.ts

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
import { readFileSync, writeFileSync } from "fs"

// ── Constants ─────────────────────────────────────────────────────────────────

const FEE_RATE          = 0.0005
const STOP_PCT          = 0.03
const THREE_DAYS_MS     = 3 * 24 * 60 * 60 * 1000
const REPEAT_DIP_WINDOW = 72 * 60 * 60 * 1000
const DEPTH_GUARD_PCT   = 0.015   // F / G: "deep" threshold = 1.5% below peg
const PEG               = 1.0

type RepeatDipMode = "off" | "any" | "lower_lows" | "depth_1_5" | "either"

// ── prevDipLow ────────────────────────────────────────────────────────────────
// Min close in dip zone before lastAtPegTs, within the 72 h window.

function prevDipLow(
  sorted:  { ts: number; price: number }[],
  atPegTs: number,
  nowMs:   number,
): number | null {
  const ws = nowMs - REPEAT_DIP_WINDOW
  let low: number | null = null
  for (const e of sorted) {
    if (e.ts >= atPegTs) break
    if (e.ts < ws) continue
    if ((PEG - e.price) / PEG >= DIP_ZONE_START_PCT && (low === null || e.price < low))
      low = e.price
  }
  return low
}

// ── Per-coin replay ───────────────────────────────────────────────────────────

type CoinResult = { n: number; wins: number; losses: number; netPnl: number }

function runCoin(candles: Candle[], coin: string, mode: RepeatDipMode): CoinResult {
  let openTrade: OpenTrade | null = null
  const trades: { status: ExitStatus | "open"; netPnl: number }[] = []
  const fee = (gross: number, sz: number) => (2 * sz + gross) * FEE_RATE

  for (let i = 0; i < candles.length; i++) {
    const c     = candles[i]!
    const nowMs = c.ts

    // ── Exit ──────────────────────────────────────────────────────────────────
    if (openTrade !== null) {
      const exit = conservativeExit(
        openTrade, c.median, c.low_median, c.high_median,
        new Date(nowMs), STOP_PCT, MAX_TRADE_DAYS, TAKE_PROFIT_DISTANCE_PCT,
      )
      if (exit.status !== "open") {
        trades.push({
          status: exit.status,
          netPnl: exit.profitUsd - fee(exit.profitUsd, openTrade.sizeUsd),
        })
        openTrade = null
      }
    }

    if (openTrade !== null) continue   // still in trade; skip buy logic

    // ── History ───────────────────────────────────────────────────────────────
    const histEntries: HistoryEntry[] = candles
      .slice(0, i + 1)
      .filter(h => h.ts >= nowMs - THREE_DAYS_MS)
      .map(h => ({ created_at: new Date(h.ts).toISOString(), price: h.historyPrice }))

    const sorted = histEntries
      .map(e => ({ ts: Date.parse(e.created_at), price: e.price }))
      .sort((a, b) => a.ts - b.ts)

    // Echo single-source candles so sourcesAgree fires (mirrors relaxSourceCheck)
    let srcPrices = { ...c.pricesBySource }
    if (Object.keys(srcPrices).length === 1) {
      const [k, v] = Object.entries(srcPrices)[0]!
      srcPrices = { [k]: v, [`${k}_echo`]: v }
    }

    const summarised = summariseHistory(histEntries, nowMs)
    const apiSummary: ApiSummary = { medianPrice: c.median, sources: srcPrices, ...summarised }
    const rawStats   = buildHistoryStats(apiSummary, nowMs)

    // ── Rule B strategy ───────────────────────────────────────────────────────
    let histStats = rawStats

    if (mode === "off") {
      histStats = { ...rawStats, hadPriorDipCycle: null }
    } else if (rawStats.hadPriorDipCycle === true && summarised.lastAtPegTs !== null) {
      const depeg  = (PEG - c.median) / PEG
      const isDeep = depeg >= DEPTH_GUARD_PCT

      let isLowerLow = false
      if (mode === "lower_lows" || mode === "either") {
        const pdl = prevDipLow(sorted, summarised.lastAtPegTs, nowMs)
        isLowerLow = pdl !== null && c.low_median < pdl
      }

      const block =
        mode === "any"        ? true :
        mode === "lower_lows" ? isLowerLow :
        mode === "depth_1_5"  ? isDeep :
      /* "either"           */ isLowerLow || isDeep

      if (!block) histStats = { ...rawStats, hadPriorDipCycle: null }
    }

    // ── Decide ────────────────────────────────────────────────────────────────
    const result = decide({
      coin, peg: PEG,
      medianPrice:              c.median,
      pricesBySource:           srcPrices,
      largeTransferCount24h:    0,
      largeTransferTotalUsd24h: 0,
      openPositionsCount:       0,
      history:                  histStats,
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

  // Force-close position still open at end of window
  if (openTrade !== null) {
    const last  = candles[candles.length - 1]!
    const gross = (openTrade.sizeUsd / openTrade.entry) * last.median - openTrade.sizeUsd
    trades.push({ status: "open", netPnl: gross - fee(gross, openTrade.sizeUsd) })
  }

  return {
    n:      trades.length,
    wins:   trades.filter(t => t.status === "won").length,
    losses: trades.filter(t => t.status === "lost").length,
    netPnl: trades.reduce((s, t) => s + t.netPnl, 0),
  }
}

// ── Candle loaders ────────────────────────────────────────────────────────────

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
      const ts  = +c.timestamp * 1000
      const bfx = bfxByTs.get(ts) ?? null
      return {
        ts,
        median:         avg(+c.close, bfx?.close ?? null),
        low_median:     avg(+c.low,   bfx?.low   ?? null),
        high_median:    avg(+c.high,  bfx?.high  ?? null),
        pricesBySource: bfx
          ? { bitstamp: +c.close, bitfinex: bfx.close }
          : { bitstamp: +c.close },
        historyPrice: +c.close,
      }
    })
  } catch { return null }
}

async function loadUstCandles(): Promise<{ candles: Candle[]; singleSrc: boolean } | null> {
  const START = 1651708800000
  const END   = 1653004800000

  type BinK = [number, string, string, string, string, ...unknown[]]
  type BfxC = [number, number, number, number, number, number]

  let binRaw: BinK[] | null = null
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=USTUSDT&interval=1h` +
      `&startTime=${START}&endTime=${END}&limit=1000`,
    )
    if (r.ok) {
      const raw = await r.json() as BinK[]
      if (raw.length > 5) binRaw = raw
    }
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
      candles:   binRaw.map(k => {
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
    candles:   binRaw.map(k => ({
      ts: k[0], median: +k[4], low_median: +k[3], high_median: +k[2],
      pricesBySource: { binance: +k[4] }, historyPrice: +k[4],
    })),
  }
}

function loadOwnCandles(): Map<string, Candle[]> {
  type RT = [string, number, number, number, number]
  const csvPath = new URL("data/replay-data.csv", import.meta.url)
    .pathname.replace(/^\/([A-Za-z]:)/, "$1")
  const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/)
  const map   = new Map<string, Candle[]>()
  for (const line of lines.slice(1)) {
    const comma = line.indexOf(",")
    const slug  = line.slice(0, comma)
    let   json  = line.slice(comma + 1)
    if (json.startsWith('"') && json.endsWith('"'))
      json = json.slice(1, -1).replace(/""/g, '"')
    const tuples = JSON.parse(json) as RT[]
    map.set(slug, tuples.map(([iso, , high, low, close]) => ({
      ts: Date.parse(iso), median: close, low_median: low, high_median: high,
      pricesBySource: { blended: close }, historyPrice: close,
    })))
  }
  return map
}

// ── Variants ──────────────────────────────────────────────────────────────────

const VARIANTS: { label: string; desc: string; mode: RepeatDipMode }[] = [
  { label: "A0", desc: "No Rule B (baseline)",                       mode: "off"        },
  { label: "A",  desc: "Current Rule B (any dip-recover-dip / 72h)", mode: "any"        },
  { label: "B",  desc: "Refined Rule B — lower lows only",           mode: "lower_lows" },
  { label: "F",  desc: "Depth guard — block only if depth ≥ 1.5%",  mode: "depth_1_5"  },
  { label: "G",  desc: "B OR F — block if lower lows OR depth ≥ 1.5%", mode: "either"  },
]

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("Fetching candles…")
const [usdcCandles, ustData] = await Promise.all([loadUsdcCandles(), loadUstCandles()])
const ownCoinMap = loadOwnCandles()
const ustCandles = ustData?.candles ?? null

const d0 = (ms: number) => new Date(ms).toISOString().slice(0, 10)
if (usdcCandles) console.log(`  USDC 2023: ${usdcCandles.length} candles  ${d0(usdcCandles[0]!.ts)} – ${d0(usdcCandles.at(-1)!.ts)}`)
else             console.log("  USDC 2023: unavailable")
if (ustCandles)  console.log(`  UST  2022: ${ustCandles.length} candles  ${d0(ustCandles[0]!.ts)} – ${d0(ustCandles.at(-1)!.ts)}${ustData?.singleSrc ? " (single-source)" : ""}`)
else             console.log("  UST  2022: unavailable (Binance)")
console.log(`  Own  data: ${[...ownCoinMap.keys()].join(", ")} (${ownCoinMap.values().next().value?.length} candles each)`)
console.log()

type DSResult = { n: number; wins: number; losses: number; netPnl: number } | null
type Row      = { label: string; desc: string; ust: DSResult; usdc: DSResult; own: DSResult }

console.log("Running…")
const rows: Row[] = []

for (const v of VARIANTS) {
  const usdc = usdcCandles ? runCoin(usdcCandles, "USDC", v.mode) : null
  const ust  = ustCandles  ? runCoin(ustCandles,  "UST",  v.mode) : null

  let own: DSResult = null
  if (ownCoinMap.size > 0) {
    let n = 0, wins = 0, losses = 0, netPnl = 0
    for (const [slug, cs] of ownCoinMap) {
      const r = runCoin(cs, slug, v.mode)
      n += r.n; wins += r.wins; losses += r.losses; netPnl += r.netPnl
    }
    own = { n, wins, losses, netPnl }
  }

  rows.push({ label: v.label, desc: v.desc, ust, usdc, own })
  process.stdout.write(`  ${v.label} done\n`)
}

// ── Print summary table ───────────────────────────────────────────────────────

const fp = (n: number) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2)

// Cell: "Nt  Nw/Nl  $net"
const cell = (r: DSResult, w = 22): string => {
  if (r === null) return "n/a".padEnd(w)
  const s = `${r.n}t  ${r.wins}W/${r.losses}L  ${fp(r.netPnl)}`
  return s.padEnd(w)
}

console.log()
console.log("═".repeat(90))
console.log("  CROSS-DATASET COMPARISON  —  A0 / A / B / F / G")
console.log("  3% stop · 7-day max · 0.05%/side fee")
console.log("═".repeat(90))
console.log(
  `  ${"Var".padEnd(4)}  ${"UST May 2022".padEnd(22)}  ${"USDC Mar 2023".padEnd(22)}  ${"Own data (4 coins total)".padEnd(22)}`
)
console.log("  " + "─".repeat(86))
for (const r of rows) {
  console.log(`  ${r.label.padEnd(4)}  ${cell(r.ust)}  ${cell(r.usdc)}  ${cell(r.own)}`)
}
console.log()
console.log("  Variants:")
for (const v of VARIANTS)
  console.log(`  ${v.label.padEnd(4)}  ${v.desc}`)
console.log()

// ── Write markdown ────────────────────────────────────────────────────────────

const md: string[] = []
md.push("# Cross-dataset Rule B Comparison")
md.push("")
md.push("Variants A0, A, B, F, G across UST May 2022, USDC Mar 2023, own data 30 Aug–9 Oct 2026.")
md.push("3% stop-loss · 7-day max hold · 0.05%/side fee.")
md.push("")
md.push("## Variants")
md.push("")
md.push("| Label | Description |")
md.push("| ----- | ----------- |")
for (const v of VARIANTS)
  md.push(`| **${v.label}** | ${v.desc} |`)
md.push("")
md.push("F uses close price for the depth check (same price that triggers the buy signal).")
md.push("B uses intra-hour low vs previous dip's lowest close for the lower-lows check.")
md.push("")
md.push("## Results")
md.push("")
md.push("| Variant | UST May 2022 | USDC Mar 2023 | Own data (4 coins, summed) |")
md.push("| ------- | ------------ | ------------- | ------------------------- |")
for (const r of rows) {
  const fmt = (d: DSResult) =>
    d === null ? "n/a" : `${d.n}t · ${d.wins}W/${d.losses}L · **${fp(d.netPnl)}**`
  md.push(`| **${r.label}** | ${fmt(r.ust)} | ${fmt(r.usdc)} | ${fmt(r.own)} |`)
}
md.push("")

const mdPath = new URL("cross-dataset-comparison.md", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1")
writeFileSync(mdPath, md.join("\n"))
console.log("Results written to replay/cross-dataset-comparison.md")
