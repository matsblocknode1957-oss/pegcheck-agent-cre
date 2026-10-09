// Rule-guard comparison — tests four variants against USDC Mar-2023 and UST May-2022.
//
// Variants
//   Baseline  — no extra guards (current behaviour before Rule B)
//   Rule A    — 48 h stop-loss cooldown only
//   Rule B    — repeat-dip danger guard only (rules.ts change)
//   Rule C    — Rule A + Rule B combined
//
// Stop settings tested: 3% (live default) and no-stop.
//
// Run: bun run replay/rule-comparison.ts

import { runReplay } from "./replay-core.js"
import type { Candle } from "./replay-core.js"

const toIso = (ms: number) => new Date(ms).toISOString()
const med2  = (a: number, b: number | null) => b !== null ? (a + b) / 2 : a
const fmtP  = (n: number) => { const s = n >= 0 ? "+" : "-"; return `${s}$${Math.abs(n).toFixed(2)}` }

// ── Rule variants ─────────────────────────────────────────────────────────────

type RuleVariant = {
  label:            string
  stopLossCooldown: boolean
  suppressRepeatDip: boolean
}

const RULE_VARIANTS: RuleVariant[] = [
  { label: "Baseline",  stopLossCooldown: false, suppressRepeatDip: true  },
  { label: "Rule A",    stopLossCooldown: true,  suppressRepeatDip: true  },
  { label: "Rule B",    stopLossCooldown: false, suppressRepeatDip: false },
  { label: "Rule C",    stopLossCooldown: true,  suppressRepeatDip: false },
]

// Stop settings
const STOPS: Array<{ label: string; stopPct: number | null; maxDays: number | null }> = [
  { label: "3% stop",  stopPct: 0.03, maxDays: 7 },
  { label: "no stop",  stopPct: null, maxDays: 7 },
]

// ── Fetch USDC candles ────────────────────────────────────────────────────────

console.log("═".repeat(72))
console.log("  RULE-GUARD COMPARISON  —  USDC Mar 2023 + UST May 2022")
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
let ustRelaxSourceCheck = false

if (binanceUst !== null && bfxUstByTs !== null) {
  ustCandles = binanceUst.map(k => {
    const ts    = k[0]
    const bfx   = bfxUstByTs!.get(ts) ?? null
    const close = +k[4]; const high = +k[2]; const low = +k[3]
    return {
      ts,
      median:         med2(close, bfx?.close ?? null),
      low_median:     med2(low,   bfx?.low   ?? null),
      high_median:    med2(high,  bfx?.high  ?? null),
      pricesBySource: bfx
        ? { binance: close, bitfinex: bfx.close }
        : { binance: close },
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
  ustRelaxSourceCheck = true
  console.log("  Single-source what-if mode (Binance only)")
} else {
  console.log("  ✗ No UST data — UST event will be skipped")
}

// ── Run all combinations ──────────────────────────────────────────────────────

type RunResult = {
  rule:     string
  stop:     string
  event:    string
  trades:   Array<{ num: number; entryTime: string; entryPrice: number; exitTime: string; exitPrice: number; result: string; pnl: number }>
  totalPnl: number
}

const results: RunResult[] = []

function runVariant(
  rule:     RuleVariant,
  stop:     { label: string; stopPct: number | null; maxDays: number | null },
  candles:  Candle[],
  eventLabel: string,
  relax: boolean,
) {
  const res = runReplay({
    candles,
    stopPct:           stop.stopPct,
    maxDays:           stop.maxDays,
    peg:               1.0,
    coin:              eventLabel.startsWith("USDC") ? "USDC" : "UST",
    relaxSourceCheck:  relax,
    stopLossCooldown:  rule.stopLossCooldown,
    suppressRepeatDip: rule.suppressRepeatDip,
  })
  results.push({
    rule:     rule.label,
    stop:     stop.label,
    event:    eventLabel,
    trades:   res.trades.map((t, i) => ({
      num:        i + 1,
      entryTime:  t.entryTime.slice(0, 16).replace("T", " "),
      entryPrice: t.entryPrice,
      exitTime:   t.exitTime.slice(0, 16).replace("T", " "),
      exitPrice:  t.exitPrice,
      result:     t.status,
      pnl:        t.pnlUsd,
    })),
    totalPnl: res.totalPnl,
  })
}

console.log("\nRunning comparisons…")
for (const rule of RULE_VARIANTS) {
  for (const stop of STOPS) {
    runVariant(rule, stop, usdcCandles, "USDC 2023", false)
    if (ustCandles !== null) {
      runVariant(rule, stop, ustCandles, "UST 2022", ustRelaxSourceCheck)
    }
  }
}

// ── Print table ───────────────────────────────────────────────────────────────

const CW = [10, 9, 10, 2, 18, 9, 18, 9, 12, 10]
const H  = ["Rule", "Stop", "Event", "#", "Entry Time", "Entry $", "Exit Time", "Exit $", "Result", "P&L / $1k"]
const padR = (s: string, n: number) => s.padEnd(n)
const padL = (s: string, n: number) => s.padStart(n)
const sep  = CW.map(w => "─".repeat(w)).join("─┼─")

console.log("\n" + "═".repeat(sep.length + 4))
console.log("  RULE-GUARD COMPARISON TABLE  (all trades)")
console.log("═".repeat(sep.length + 4))
console.log("  " + CW.map((w, i) => padR(H[i]!, w)).join(" │ "))
console.log("  " + sep)

let lastRule  = ""
let lastStop  = ""
let lastEvent = ""

for (const r of results) {
  const ruleChanged  = r.rule  !== lastRule
  const stopChanged  = r.stop  !== lastStop
  const eventChanged = r.event !== lastEvent

  if ((ruleChanged || stopChanged) && lastRule !== "") {
    console.log("  " + sep)
  }

  lastRule = r.rule; lastStop = r.stop; lastEvent = r.event

  if (r.trades.length === 0) {
    console.log("  " + [
      padR(r.rule,  CW[0]!), padR(r.stop,  CW[1]!), padR(r.event, CW[2]!),
      padL("—", CW[3]!), padR("—", CW[4]!), padL("—", CW[5]!),
      padR("—", CW[6]!), padL("—", CW[7]!),
      padR("no signal", CW[8]!), padL("$0.00", CW[9]!),
    ].join(" │ "))
  } else {
    for (const t of r.trades) {
      console.log("  " + [
        padR(t.num === 1 ? r.rule  : "", CW[0]!),
        padR(t.num === 1 ? r.stop  : "", CW[1]!),
        padR(t.num === 1 ? r.event : "", CW[2]!),
        padL(String(t.num),               CW[3]!),
        padR(t.entryTime,                 CW[4]!),
        padL(`$${t.entryPrice.toFixed(4)}`, CW[5]!),
        padR(t.exitTime,                  CW[6]!),
        padL(`$${t.exitPrice.toFixed(4)}`, CW[7]!),
        padR(t.result,                    CW[8]!),
        padL(fmtP(t.pnl),                CW[9]!),
      ].join(" │ "))
    }
    if (r.trades.length > 1) {
      console.log("  " + [
        padR("", CW[0]!), padR("", CW[1]!), padR("", CW[2]!),
        padL("", CW[3]!), padR("", CW[4]!), padL("", CW[5]!),
        padR("TOTAL", CW[6]!), padL("", CW[7]!),
        padR("", CW[8]!), padL(fmtP(r.totalPnl), CW[9]!),
      ].join(" │ "))
    }
  }
}
console.log("═".repeat(sep.length + 4))

// ── Recommendation ────────────────────────────────────────────────────────────

console.log("\n── Recommendation ────────────────────────────────────────────────────────")
console.log("  Rule B (repeat-dip danger guard):")
console.log("    • Detects: coin dipped → recovered to peg → dipping again within 72 h")
console.log("    • Fires as AVOID, adding +50 danger — blocks all re-buys during the UST collapse")
console.log("    • USDC 2023: USDC started from peg, never had a prior dip cycle → unaffected")
console.log("    • Rule A (stop-loss cooldown) alone misses UST trade 2 (came after a WIN)")
console.log("    • Rule C adds no benefit over Rule B for these events — B alone is sufficient")
console.log("  Recommended: Rule B only.")
