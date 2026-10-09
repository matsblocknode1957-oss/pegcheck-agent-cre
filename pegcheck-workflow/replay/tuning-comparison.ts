// Tuning-parameter comparison — Rule B ON in every variant, 3% stop-loss, 7-day max.
// Applies a 0.05%/side trading fee. Reports gross and net P&L.
//
// Variants:
//   A  Baseline — current rules, no changes
//   B  Staged buy — 30% on first dip-zone entry (sans falling-fast guard), +70% on normal BUY
//   C  Quick profit — exit at +0.3% above entry OR normal 0.2%-from-peg, whichever fires first
//   D  Earlier dip zone — starts at 0.3% below peg instead of 0.5%
//   E  D + C combined — dip zone from 0.3% plus quick +0.3% profit exit
//
// Run: bun run replay/tuning-comparison.ts

import { runReplay, conservativeExit } from "./replay-core.js"
import type { Candle } from "./replay-core.js"
import { summariseHistory, buildHistoryStats } from "../lib/agent/history.js"
import type { HistoryEntry, ApiSummary } from "../lib/agent/history.js"
import { decide } from "../lib/agent/rules.js"
import type { OpenTrade, ExitStatus } from "../lib/agent/rules.js"
import {
  DIP_ZONE_START_PCT,
  DEEP_DEPEG_PCT,
  TAKE_PROFIT_DISTANCE_PCT,
  SOURCE_DISAGREE_SPREAD_PCT,
  CHRONIC_HOURS,
  MAX_POSITION_USD,
  MAX_TRADE_DAYS,
} from "../lib/agent/config.js"
import { writeFileSync } from "fs"

// ── Fee model ─────────────────────────────────────────────────────────────────
// 0.05% per side → fee = (entryValue + exitValue) * 0.0005
//                       = (2 * sizeUsd + grossPnl) * 0.0005

const FEE_RATE   = 0.0005
const STOP_PCT   = 0.03
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

function fee(grossPnl: number, sizeUsd: number): number {
  return (2 * sizeUsd + grossPnl) * FEE_RATE
}

// ── Shared trade summary ───────────────────────────────────────────────────────

type TradeSummary = {
  entryPrice: number
  exitPrice:  number
  status:     ExitStatus
  grossPnl:   number
  netPnl:     number
  sizeUsd:    number
  // staged-buy extras (null for normal trades)
  stage1Entry: number | null
  stage2Entry: number | null
}

type EventResult = {
  event:    string
  trades:   TradeSummary[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const toIso = (ms: number) => new Date(ms).toISOString()
const fmtP  = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`

// ── Run normal variant (A / C / D) via runReplay ──────────────────────────────

function runNormal(
  candles:              Candle[],
  coin:                 string,
  relax:                boolean,
  takeProfitDistancePct = TAKE_PROFIT_DISTANCE_PCT,
  dipZoneStartPct?:     number,
  quickProfitPct?:      number,
): TradeSummary[] {
  const res = runReplay({
    candles,
    stopPct:  STOP_PCT,
    maxDays:  MAX_TRADE_DAYS,
    peg:      1.0,
    coin,
    relaxSourceCheck:     relax,
    suppressRepeatDip:    false,  // Rule B always ON
    takeProfitDistancePct,
    dipZoneStartPct,
    quickProfitPct,
  })
  return res.trades.map(t => {
    const g = t.pnlUsd
    const s = MAX_POSITION_USD
    return {
      entryPrice:  t.entryPrice,
      exitPrice:   t.exitPrice,
      status:      t.status,
      grossPnl:    g,
      netPnl:      g - fee(g, s),
      sizeUsd:     s,
      stage1Entry: null,
      stage2Entry: null,
    }
  })
}

// ── Staged-buy replay (variants B and E) ─────────────────────────────────────
// Stage 1: buy 30% when price enters dip zone — guards: deep-depeg, sources,
//          chronic, repeat-dip. Falling-fast is intentionally NOT checked.
// Stage 2: add 70% when normal decide() says BUY.
// Average entry = totalCost / totalUnits (exact, no approximation).

type StagedOpen = {
  stage1Ms:     number
  stage1Entry:  number
  stage2Ms:     number | null
  stage2Entry:  number | null
  avgEntry:     number
  totalUsd:     number
  fullyOpen:    boolean
}

function runStagedReplay(
  candles:              Candle[],
  coin:                 string,
  relax:                boolean,
  takeProfitDistancePct = TAKE_PROFIT_DISTANCE_PCT,
): TradeSummary[] {
  const STAGE1_USD = MAX_POSITION_USD * 0.3  // $300
  const STAGE2_USD = MAX_POSITION_USD * 0.7  // $700

  const trades: TradeSummary[] = []
  let open: StagedOpen | null = null

  for (let i = 0; i < candles.length; i++) {
    const c     = candles[i]!
    const nowMs = c.ts

    // Build rolling 3-day history window
    const histEntries: HistoryEntry[] = candles
      .slice(0, i + 1)
      .filter(h => h.ts >= nowMs - THREE_DAYS_MS)
      .map(h => ({ created_at: new Date(h.ts).toISOString(), price: h.historyPrice }))
    const summarised = summariseHistory(histEntries, nowMs)

    let src = { ...c.pricesBySource }
    if (relax && Object.keys(src).length === 1) {
      const [k, v] = Object.entries(src)[0]!
      src = { [k]: v, [`${k}_echo`]: v }
    }

    const apiSummary: ApiSummary = { medianPrice: c.median, sources: src, ...summarised }
    const histStats = buildHistoryStats(apiSummary, nowMs)

    const srcVals    = Object.values(src)
    const spread     = srcVals.length >= 2
      ? (Math.max(...srcVals) - Math.min(...srcVals)) / Math.min(...srcVals)
      : Infinity
    const sourcesAgree = srcVals.length >= 2 && spread < SOURCE_DISAGREE_SPREAD_PCT

    // ── 1. Exit check ──────────────────────────────────────────────────────────
    if (open !== null) {
      const fakeTrade: OpenTrade = {
        coin, peg: 1.0,
        entry:    open.avgEntry,
        sizeUsd:  open.totalUsd,
        openedAt: new Date(open.stage1Ms),
      }
      const exit = conservativeExit(
        fakeTrade, c.median, c.low_median, c.high_median,
        new Date(nowMs), STOP_PCT, MAX_TRADE_DAYS, takeProfitDistancePct,
      )
      if (exit.status !== "open") {
        const g = exit.profitUsd
        const s = open.totalUsd
        trades.push({
          entryPrice:  open.avgEntry,
          exitPrice:   exit.exitPrice,
          status:      exit.status,
          grossPnl:    g,
          netPnl:      g - fee(g, s),
          sizeUsd:     s,
          stage1Entry: open.stage1Entry,
          stage2Entry: open.stage2Entry,
        })
        open = null
      }
    }

    // ── 2. Stage 2: top up to full if decide() says BUY ───────────────────────
    if (open !== null && !open.fullyOpen) {
      const ev = {
        coin, peg: 1.0,
        medianPrice: c.median,
        pricesBySource: src,
        largeTransferCount24h: 0,
        largeTransferTotalUsd24h: 0,
        openPositionsCount: 1,
        history: histStats,
      }
      const res = decide(ev, { takeProfitDistancePct })
      if (res.decision === "buy") {
        const totalUnits = STAGE1_USD / open.stage1Entry + STAGE2_USD / c.median
        open.stage2Ms    = nowMs
        open.stage2Entry = c.median
        open.avgEntry    = (STAGE1_USD + STAGE2_USD) / totalUnits
        open.totalUsd    = MAX_POSITION_USD
        open.fullyOpen   = true
      }
    }

    // ── 3. Stage 1: enter 30% if flat and dip-zone conditions met ─────────────
    if (open === null) {
      const depegPct  = (1.0 - c.median) / 1.0
      const inZone    = depegPct >= DIP_ZONE_START_PCT && depegPct <= DEEP_DEPEG_PCT
      const isChronic = histStats.hoursOffPeg !== null
        && histStats.hoursOffPeg > CHRONIC_HOURS
        && depegPct >= DIP_ZONE_START_PCT
      const isRepeat  = histStats.hadPriorDipCycle === true

      if (inZone && sourcesAgree && !isChronic && !isRepeat) {
        open = {
          stage1Ms:    nowMs,
          stage1Entry: c.median,
          stage2Ms:    null,
          stage2Entry: null,
          avgEntry:    c.median,
          totalUsd:    STAGE1_USD,
          fullyOpen:   false,
        }
      }
    }
  }

  // Force-close anything still open at window end
  if (open !== null) {
    const last = candles[candles.length - 1]!
    const g    = (open.totalUsd / open.avgEntry) * last.median - open.totalUsd
    const s    = open.totalUsd
    trades.push({
      entryPrice:  open.avgEntry,
      exitPrice:   last.median,
      status:      "open",
      grossPnl:    g,
      netPnl:      g - fee(g, s),
      sizeUsd:     s,
      stage1Entry: open.stage1Entry,
      stage2Entry: open.stage2Entry,
    })
  }

  return trades
}

// ── Fetch USDC candles ────────────────────────────────────────────────────────

console.log("═".repeat(72))
console.log("  TUNING COMPARISON  —  USDC Mar 2023 + UST May 2022")
console.log("═".repeat(72))
console.log("\nFetching USDC candles (Bitstamp + Bitfinex)…")

const bsResp = await fetch(
  "https://www.bitstamp.net/api/v2/ohlc/usdcusd/?step=3600&start=1678233600&limit=240",
)
if (!bsResp.ok) throw new Error(`Bitstamp HTTP ${bsResp.status}`)
const bsBody = await bsResp.json() as {
  data: { ohlc: Array<{ timestamp: string; high: string; low: string; close: string }> }
}
const bsRaw = bsBody.data.ohlc

type BfxCandle = [number, number, number, number, number, number]
const bfxUsdcResp = await fetch(
  "https://api-pub.bitfinex.com/v2/candles/trade:1h:tUDCUSD/hist" +
  "?start=1678233600000&end=1679097600000&limit=1000&sort=1",
)
const bfxUsdcRaw = bfxUsdcResp.ok ? (await bfxUsdcResp.json() as BfxCandle[]) : []
const bfxUsdcByTs = new Map(bfxUsdcRaw.map(c => [c[0], { close: c[2], high: c[3], low: c[4] }]))

const med2 = (a: number, b: number | null) => b !== null ? (a + b) / 2 : a
const usdcCandles: Candle[] = bsRaw.map(c => {
  const ts  = +c.timestamp * 1000
  const bfx = bfxUsdcByTs.get(ts) ?? null
  return {
    ts,
    median:         med2(+c.close, bfx?.close ?? null),
    low_median:     med2(+c.low,   bfx?.low   ?? null),
    high_median:    med2(+c.high,  bfx?.high  ?? null),
    pricesBySource: bfx
      ? { bitstamp: +c.close, bitfinex: bfx.close }
      : { bitstamp: +c.close },
    historyPrice: +c.close,
  }
})
console.log(`  ${usdcCandles.length} candles  ${toIso(usdcCandles[0]!.ts).slice(0, 10)} → ${toIso(usdcCandles[usdcCandles.length - 1]!.ts).slice(0, 10)}`)

// ── Fetch UST candles ─────────────────────────────────────────────────────────

console.log("\nFetching UST candles (Binance + Bitfinex)…")

const UST_START = 1651708800000
const UST_END   = 1653004800000

type BinanceKline = [number, string, string, string, string, ...unknown[]]
let binanceUst: BinanceKline[] | null = null
try {
  const r = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=USTUSDT&interval=1h` +
    `&startTime=${UST_START}&endTime=${UST_END}&limit=1000`,
  )
  if (r.ok) {
    const raw = await r.json() as BinanceKline[]
    if (raw.length > 5) {
      binanceUst = raw
      console.log(`  ✓ Binance USTUSDT: ${raw.length} candles  first=$${(+raw[0]![4]).toFixed(4)}  last=$${(+raw[raw.length - 1]![4]).toFixed(4)}`)
    }
  }
} catch (_) { /* skip */ }

let bfxUstByTs: Map<number, { close: number; high: number; low: number }> | null = null
try {
  const r = await fetch(
    `https://api-pub.bitfinex.com/v2/candles/trade:1h:tTERRAUST:USD/hist` +
    `?start=${UST_START}&end=${UST_END}&limit=1000&sort=1`,
  )
  if (r.ok) {
    const raw = await r.json() as BfxCandle[] | { error?: string }
    if (Array.isArray(raw) && raw.length > 5 && raw[0]![2] > 0.5 && raw[raw.length - 1]![2] < 0.5) {
      bfxUstByTs = new Map(raw.map(c => [c[0], { close: c[2], high: c[3], low: c[4] }]))
      console.log(`  ✓ Bitfinex tTERRAUST:USD: ${raw.length} candles  first=$${raw[0]![2].toFixed(4)}  last=$${raw[raw.length-1]![2].toFixed(4)}`)
    }
  }
} catch (_) { /* skip */ }

let ustCandles: Candle[] | null = null
let ustRelax = false

if (binanceUst !== null && bfxUstByTs !== null) {
  ustCandles = binanceUst.map(k => {
    const ts  = k[0]; const close = +k[4]; const high = +k[2]; const low = +k[3]
    const bfx = bfxUstByTs!.get(ts) ?? null
    return {
      ts,
      median:         med2(close, bfx?.close ?? null),
      low_median:     med2(low,   bfx?.low   ?? null),
      high_median:    med2(high,  bfx?.high  ?? null),
      pricesBySource: bfx ? { binance: close, bitfinex: bfx.close } : { binance: close },
      historyPrice: close,
    }
  })
  const two = ustCandles.filter(c => Object.keys(c.pricesBySource).length >= 2).length
  console.log(`  Dual-source: ${two}/${ustCandles.length} hours`)
} else if (binanceUst !== null) {
  ustCandles = binanceUst.map(k => ({
    ts: k[0], median: +k[4], low_median: +k[3], high_median: +k[2],
    pricesBySource: { binance: +k[4] }, historyPrice: +k[4],
  }))
  ustRelax = true
  console.log("  Single-source what-if mode (Binance only)")
} else {
  console.log("  ✗ No UST data — UST event will be skipped")
}

// ── Run all variants ──────────────────────────────────────────────────────────

console.log("\nRunning variants…")

type VariantResult = { variant: string; results: EventResult[] }
const allResults: VariantResult[] = []

function addResult(variant: string, event: string, trades: TradeSummary[]) {
  let vr = allResults.find(v => v.variant === variant)
  if (!vr) { vr = { variant, results: [] }; allResults.push(vr) }
  vr.results.push({ event, trades })
}

// Variant A — Baseline
addResult("A baseline",    "USDC 2023", runNormal(usdcCandles, "USDC", false))
if (ustCandles) addResult("A baseline", "UST 2022",  runNormal(ustCandles,  "UST",  ustRelax))

// Variant B — Staged buy (0.5% dip zone, 0.2% TP)
addResult("B staged-buy",  "USDC 2023", runStagedReplay(usdcCandles, "USDC", false))
if (ustCandles) addResult("B staged-buy", "UST 2022",  runStagedReplay(ustCandles,  "UST",  ustRelax))

// Variant C — Quick profit: +0.3% above entry OR 0.2%-from-peg, whichever fires first
addResult("C quick+0.3%",  "USDC 2023", runNormal(usdcCandles, "USDC", false, TAKE_PROFIT_DISTANCE_PCT, undefined, 0.003))
if (ustCandles) addResult("C quick+0.3%", "UST 2022", runNormal(ustCandles, "UST", ustRelax, TAKE_PROFIT_DISTANCE_PCT, undefined, 0.003))

// Variant D — Earlier dip zone (0.3%)
addResult("D zone-0.3%",   "USDC 2023", runNormal(usdcCandles, "USDC", false, TAKE_PROFIT_DISTANCE_PCT, 0.003))
if (ustCandles) addResult("D zone-0.3%", "UST 2022", runNormal(ustCandles,  "UST",  ustRelax, TAKE_PROFIT_DISTANCE_PCT, 0.003))

// Variant E — D + C combined: dip zone 0.3% + quick +0.3% profit exit
addResult("E zone+quick",   "USDC 2023", runNormal(usdcCandles, "USDC", false, TAKE_PROFIT_DISTANCE_PCT, 0.003, 0.003))
if (ustCandles) addResult("E zone+quick", "UST 2022", runNormal(ustCandles, "UST", ustRelax, TAKE_PROFIT_DISTANCE_PCT, 0.003, 0.003))

// ── Print + collect summary ───────────────────────────────────────────────────

function summarise(trades: TradeSummary[]) {
  const wins   = trades.filter(t => t.status === "won").length
  const losses = trades.filter(t => t.status === "lost").length
  const timeouts = trades.filter(t => t.status === "timed_out").length
  const totalGross = trades.reduce((s, t) => s + t.grossPnl, 0)
  const totalNet   = trades.reduce((s, t) => s + t.netPnl, 0)
  const avgNet     = trades.length > 0 ? totalNet / trades.length : 0
  const bestEntry  = trades.length > 0 ? Math.min(...trades.map(t => t.entryPrice)) : null
  return { n: trades.length, wins, losses, timeouts, totalGross, totalNet, avgNet, bestEntry }
}

// ── Console table ─────────────────────────────────────────────────────────────

const CW = [16, 10, 3, 6, 10, 10, 11, 12]
const H  = ["Variant", "Event", "#", "W/L", "Best Entry", "Gross P&L", "Net P&L", "Avg Net/trade"]
const padR = (s: string, n: number) => s.slice(0, n).padEnd(n)
const padL = (s: string, n: number) => s.slice(0, n).padStart(n)
const sep  = CW.map(w => "─".repeat(w)).join("─┼─")

console.log("\n" + "═".repeat(sep.length + 4))
console.log("  TUNING COMPARISON  (Rule B ON, 3% stop, 0.05%/side fee)")
console.log("═".repeat(sep.length + 4))
console.log("  " + CW.map((w, i) => padR(H[i]!, w)).join(" │ "))
console.log("  " + sep)

const mdRows: string[] = []
mdRows.push(`| ${"Variant".padEnd(16)} | ${"Event".padEnd(10)} | # | W/L    | Best Entry  | Gross P&L   | Net P&L     | Avg Net/trade |`)
mdRows.push(`| ${"-".repeat(16)} | ${"-".repeat(10)} | - | ------ | ----------- | ----------- | ----------- | ------------- |`)

for (const vr of allResults) {
  let first = true
  for (const er of vr.results) {
    const s = summarise(er.trades)
    const wl = s.n === 0 ? "—" : `${s.wins}W/${s.losses}L${s.timeouts > 0 ? `/${s.timeouts}T` : ""}`
    const be = s.bestEntry !== null ? `$${s.bestEntry.toFixed(4)}` : "—"
    const cols = [
      padR(first ? vr.variant : "", CW[0]!),
      padR(er.event,    CW[1]!),
      padL(s.n === 0 ? "—" : String(s.n), CW[2]!),
      padR(wl,          CW[3]!),
      padL(be,          CW[4]!),
      padL(s.n === 0 ? "—" : fmtP(s.totalGross), CW[5]!),
      padL(s.n === 0 ? "—" : fmtP(s.totalNet),   CW[6]!),
      padL(s.n === 0 ? "—" : fmtP(s.avgNet),     CW[7]!),
    ]
    console.log("  " + cols.join(" │ "))
    mdRows.push(`| ${vr.variant.padEnd(16)} | ${er.event.padEnd(10)} | ${s.n === 0 ? "—" : s.n} | ${wl.padEnd(6)} | ${be.padEnd(11)} | ${(s.n === 0 ? "—" : fmtP(s.totalGross)).padEnd(11)} | ${(s.n === 0 ? "—" : fmtP(s.totalNet)).padEnd(11)} | ${(s.n === 0 ? "—" : fmtP(s.avgNet)).padEnd(13)} |`)
    first = false
  }
  console.log("  " + sep)
}

// ── Staged-buy individual trade detail ───────────────────────────────────────

console.log("\n── Staged-buy detail (variant B) ─────────────────────────────────────────")
for (const vr of allResults.filter(v => v.variant.startsWith("B"))) {
  for (const er of vr.results) {
    if (er.trades.length === 0) {
      console.log(`  ${vr.variant}  ${er.event}: no trades`)
      continue
    }
    console.log(`  ${vr.variant}  ${er.event}:`)
    for (let i = 0; i < er.trades.length; i++) {
      const t = er.trades[i]!
      const s1 = t.stage1Entry !== null ? `stage1=$${t.stage1Entry.toFixed(4)}` : ""
      const s2 = t.stage2Entry !== null ? `stage2=$${t.stage2Entry.toFixed(4)}` : "stage2=none"
      console.log(`    trade ${i + 1}: ${s1} ${s2}  avg=$${t.entryPrice.toFixed(4)}  size=$${t.sizeUsd.toFixed(0)}  exit=$${t.exitPrice.toFixed(4)}  ${t.status}  gross=${fmtP(t.grossPnl)}  net=${fmtP(t.netPnl)}`)
    }
  }
}

// ── Write markdown ────────────────────────────────────────────────────────────

const md: string[] = []
md.push("# Tuning Comparison")
md.push("")
md.push("Rule B ON in every variant. Stop-loss 3%. Max hold 7 days. Trading fee 0.05%/side (0.1% round trip).")
md.push("")
md.push("## Variants")
md.push("")
md.push("| Label | Description |")
md.push("| ----- | ----------- |")
md.push("| A baseline | Current rules — no changes |")
md.push("| B staged-buy | Buy 30% on first dip-zone entry (ignores falling-fast guard); add 70% when normal BUY fires |")
md.push("| C quick+0.3% | Exit at +0.3% above entry price OR normal 0.2%-from-peg target, whichever fires first |")
md.push("| D zone-0.3% | Dip zone starts at 0.3% below peg (default 0.5%) |")
md.push("| E zone+quick | D + C combined: dip zone from 0.3% plus quick +0.3%-above-entry profit exit |")
md.push("")
md.push("## Results")
md.push("")
md.push(...mdRows)
md.push("")
md.push("## Staged-buy trade detail (variant B)")
md.push("")
for (const vr of allResults.filter(v => v.variant.startsWith("B"))) {
  md.push(`### ${vr.variant}`)
  md.push("")
  for (const er of vr.results) {
    md.push(`**${er.event}**`)
    md.push("")
    if (er.trades.length === 0) {
      md.push("No trades.")
    } else {
      md.push("| # | Stage 1 | Stage 2 | Avg Entry | Size | Exit | Status | Gross | Net |")
      md.push("| - | ------- | ------- | --------- | ---- | ---- | ------ | ----- | --- |")
      for (let i = 0; i < er.trades.length; i++) {
        const t  = er.trades[i]!
        const s1 = t.stage1Entry !== null ? `$${t.stage1Entry.toFixed(4)}` : "—"
        const s2 = t.stage2Entry !== null ? `$${t.stage2Entry.toFixed(4)}` : "none"
        md.push(`| ${i+1} | ${s1} | ${s2} | $${t.entryPrice.toFixed(4)} | $${t.sizeUsd.toFixed(0)} | $${t.exitPrice.toFixed(4)} | ${t.status} | ${fmtP(t.grossPnl)} | ${fmtP(t.netPnl)} |`)
      }
    }
    md.push("")
  }
}

const mdPath = new URL("tuning-comparison.md", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
writeFileSync(mdPath, md.join("\n"))
console.log(`\nResults written to replay/tuning-comparison.md`)
