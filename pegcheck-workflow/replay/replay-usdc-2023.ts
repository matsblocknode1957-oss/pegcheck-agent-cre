// USDC SVB crash replay — March 2023
//
// Sources used:
//   - Bitstamp USDCUSD (USD-quoted)  — full window from 2023-03-08
//   - Bitfinex USDCUSD (USD-quoted)  — full window from ~2023-03-10 (first candle varies by exchange volume)
//
// NOT included:
//   - Chainlink on-chain USDC/USD feed: would require an archive RPC node; not available here
//   - Binance USDCUSDT: USDT-quoted and only starts 2023-03-11 14:00 UTC (dropped in favour of Bitfinex)
//
// Kraken and Coinbase were tested and rejected: Kraken's OHLC `since` param is a pagination
// cursor (returns last 720 candles as of today, not historical data) and Coinbase's public
// candles endpoint returns 404.
//
// Exit method: stop-loss tested against hourly low_median; take-profit tested against hourly
// high_median. If both thresholds are crossed in the same candle, stop-loss is assumed to
// hit first (worst case). Exit prices are pinned to the threshold level, not the raw low/high.

import { runReplay } from "./replay-core.js"
import type { Candle, CandleState } from "./replay-core.js"
import { STOP_LOSS_PCT, MAX_TRADE_DAYS } from "../lib/agent/config.js"
import { writeFileSync, mkdirSync } from "fs"

const USDC_PEG = 1.0

const toIso  = (ms: number) => new Date(ms).toISOString()
const fmtPct = (n: number | null) => n !== null ? (n * 100).toFixed(4) : ""
const csvEsc = (s: string) => `"${s.replace(/"/g, '""')}"`

// Exchange-specific raw candle (preserved for CSV column names)
type RawCandle = {
  ts:             number
  bitstamp:       number
  bitfinex:       number | null
  median:         number
  low_bitstamp:   number
  low_bitfinex:   number | null
  low_median:     number
  high_bitstamp:  number
  high_bitfinex:  number | null
  high_median:    number
}

const med2 = (a: number, b: number | null) => b !== null ? (a + b) / 2 : a

// ── 1. Fetch ──────────────────────────────────────────────────────────────────

console.log("Fetching Bitstamp USDCUSD 1h  (2023-03-08 → +10 days)…")
const bitstampResp = await fetch(
  "https://www.bitstamp.net/api/v2/ohlc/usdcusd/?step=3600&start=1678233600&limit=240",
)
if (!bitstampResp.ok) throw new Error(`Bitstamp HTTP ${bitstampResp.status}`)
const bitstampBody = await bitstampResp.json() as {
  data: { ohlc: Array<{ timestamp: string; open: string; high: string; low: string; close: string }> }
}
const bitstampRaw = bitstampBody.data.ohlc

console.log("Fetching Bitfinex USDCUSD 1h  (2023-03-08 → 2023-03-18)…")
const bitfinexResp = await fetch(
  "https://api-pub.bitfinex.com/v2/candles/trade:1h:tUDCUSD/hist" +
  "?start=1678233600000&end=1679097600000&limit=1000&sort=1",
)
if (!bitfinexResp.ok) throw new Error(`Bitfinex HTTP ${bitfinexResp.status}`)
type BfxOHLC = { close: number; high: number; low: number }
const bitfinexRaw = await bitfinexResp.json() as Array<[number, number, number, number, number, number]>
const bitfinexByTs = new Map<number, BfxOHLC>(
  bitfinexRaw.map(c => [c[0], { close: c[2], high: c[3], low: c[4] }]),
)

// ── 2. Build candles ──────────────────────────────────────────────────────────

const rawCandles: RawCandle[] = bitstampRaw.map(c => {
  const ts  = +c.timestamp * 1000
  const bfx = bitfinexByTs.get(ts) ?? null
  return {
    ts,
    bitstamp:      +c.close,
    bitfinex:      bfx?.close ?? null,
    median:        med2(+c.close,  bfx?.close ?? null),
    low_bitstamp:  +c.low,
    low_bitfinex:  bfx?.low ?? null,
    low_median:    med2(+c.low,    bfx?.low   ?? null),
    high_bitstamp: +c.high,
    high_bitfinex: bfx?.high ?? null,
    high_median:   med2(+c.high,   bfx?.high  ?? null),
  }
})

const candles: Candle[] = rawCandles.map(rc => ({
  ts:          rc.ts,
  median:      rc.median,
  low_median:  rc.low_median,
  high_median: rc.high_median,
  pricesBySource: rc.bitfinex !== null
    ? { bitstamp: rc.bitstamp, bitfinex: rc.bitfinex }
    : { bitstamp: rc.bitstamp },
  historyPrice: rc.bitstamp,
}))

const singleSourceHours = rawCandles.filter(c => c.bitfinex === null).length
console.log(`\nAligned ${rawCandles.length} hourly candles`)
console.log(`  ${toIso(rawCandles[0]!.ts)} → ${toIso(rawCandles[rawCandles.length - 1]!.ts)}`)
console.log(`  Two-source: ${rawCandles.length - singleSourceHours}  |  Single-source (Bitfinex absent): ${singleSourceHours}`)

// ── 3. Replay ─────────────────────────────────────────────────────────────────

const { trades, candleStates } = runReplay({
  candles,
  stopPct:  STOP_LOSS_PCT,
  maxDays:  MAX_TRADE_DAYS,
  peg:      USDC_PEG,
  coin:     "USDC",
})

// ── 4. Build CSV rows ──────────────────────────────────────────────────────────

type Row = Record<string, string>

const rows: Row[] = rawCandles.map((c, i) => {
  const s   = candleStates[i]!
  const ago = s.sourcesAgree ? "true" : "false"

  const topReasons = [
    ...s.result.danger.reasons.slice(0, 2),
    ...s.result.opportunity.reasons.slice(0, 1),
  ].join(" | ").replace(/,/g, ";")

  return {
    timestamp:           toIso(c.ts),
    price_bitstamp:      c.bitstamp.toFixed(5),
    price_bitfinex:      c.bitfinex      !== null ? c.bitfinex.toFixed(5)      : "",
    median_price:        c.median.toFixed(5),
    low_bitstamp:        c.low_bitstamp.toFixed(5),
    low_bitfinex:        c.low_bitfinex  !== null ? c.low_bitfinex.toFixed(5)  : "",
    low_median:          c.low_median.toFixed(5),
    high_bitstamp:       c.high_bitstamp.toFixed(5),
    high_bitfinex:       c.high_bitfinex !== null ? c.high_bitfinex.toFixed(5) : "",
    high_median:         c.high_median.toFixed(5),
    change1h_pct:        fmtPct(s.histStats.change1hPct),
    change24h_pct:       fmtPct(s.histStats.change24hPct),
    hours_off_peg:       s.histStats.hoursOffPeg !== null ? s.histStats.hoursOffPeg.toFixed(2) : "",
    bounce_from_low_pct: fmtPct(s.histStats.bounceFromLowPct),
    sources_agree:       ago,
    decision:            s.result.decision,
    danger_score:        String(s.result.danger.score),
    opportunity_score:   String(s.result.opportunity.score),
    top_reasons:         csvEsc(topReasons),
    trade_open:          String(s.tradeOpen),
    trade_entry:         s.entryPrice !== null ? s.entryPrice.toFixed(5) : "",
    exit_status:         s.exitStatus,
    exit_price:          s.exitStatus ? (s.exitPrice?.toFixed(5) ?? "") : "",
    pnl_usd:             s.pnlUsd !== null ? s.pnlUsd.toFixed(2) : "",
  }
})

// ── 5. Write CSV ──────────────────────────────────────────────────────────────

const CSV_COMMENTS = [
  "# USDC SVB Crash Replay — March 2023",
  "# Sources: Bitstamp USDCUSD (USD-quoted) + Bitfinex USDCUSD (USD-quoted)",
  "# NOT INCLUDED: Chainlink on-chain prices (archive RPC node required — not tested in replay)",
  "# Tested but rejected: Kraken (returns only last 720 candles; no historical access); Coinbase (404)",
  `# Single-source hours: ${singleSourceHours} of ${rawCandles.length} (Bitfinex absent; 1-source danger rule fires)`,
  "# Exit method: exits tested against hourly lows/highs; stop assumed first if both hit in same candle",
  "# All decisions produced by decide() in lib/agent/rules.ts — no replay-specific decision logic",
]

const headers = Object.keys(rows[0]!).join(",")
const csvBody = rows.map(r => Object.values(r).join(",")).join("\n")

mkdirSync(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { recursive: true })
const outPath = new URL("usdc-2023-03.csv", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
writeFileSync(outPath, [...CSV_COMMENTS, headers, csvBody].join("\n") + "\n")
console.log(`\nWrote ${rows.length} rows → ${outPath}`)

// ── 6. Summary ────────────────────────────────────────────────────────────────

const lastCandle = rawCandles[rawCandles.length - 1]!
const firstTrade = trades[0] ?? null

let firstAvoidDepeg: string | null = null
let lowestMedian     = Infinity
let lowestMedianTime = ""

for (let i = 0; i < rawCandles.length; i++) {
  const c        = rawCandles[i]!
  const s        = candleStates[i]!
  const depegPct = (USDC_PEG - c.median) / USDC_PEG
  if (s.result.decision === "avoid" && depegPct >= 0.005 && firstAvoidDepeg === null) {
    firstAvoidDepeg = toIso(c.ts)
  }
  if (c.median < lowestMedian) {
    lowestMedian     = c.median
    lowestMedianTime = toIso(c.ts)
  }
}

console.log("\n" + "─".repeat(72))
console.log("  SVB Replay Summary — USDC/USD  March 2023")
console.log("─".repeat(72))
console.log("  Sources    : Bitstamp USDCUSD + Bitfinex USDCUSD  (both USD-quoted)")
console.log("             : Chainlink on-chain NOT included (archive RPC required)")
console.log("  Exit method: exits tested against hourly lows/highs; stop assumed first if both hit")
console.log(`  Coverage   : ${toIso(rawCandles[0]!.ts).slice(0,10)} → ${toIso(lastCandle.ts).slice(0,10)}  (${rawCandles.length} hourly candles)`)
console.log(`  Two-source : ${rawCandles.length - singleSourceHours}/${rawCandles.length} hours  |  single-source: ${singleSourceHours} (Bitfinex absent)`)
console.log("─".repeat(72))
console.log(`  First AVOID (depeg ≥0.5%)  : ${firstAvoidDepeg ?? "(none)"}`)
console.log(`  Lowest median price        : $${lowestMedian.toFixed(5)}  at ${lowestMedianTime}  (${((1 - lowestMedian) * 100).toFixed(1)}% off peg)`)

if (firstTrade !== null) {
  console.log(`  First BUY signal           : ${firstTrade.entryTime}  entry=$${firstTrade.entryPrice.toFixed(5)}`)
  if (firstTrade.status !== "open") {
    const sign = firstTrade.pnlUsd >= 0 ? "+" : ""
    console.log(`  Trade exit                 : ${firstTrade.exitTime}  status=${firstTrade.status}  exit=$${firstTrade.exitPrice.toFixed(5)}  P&L=${sign}$${firstTrade.pnlUsd.toFixed(2)}`)
  } else {
    const sign = firstTrade.pnlUsd >= 0 ? "+" : ""
    console.log(`  Trade exit                 : still open at window end  entry=$${firstTrade.entryPrice.toFixed(5)}  unrealised P&L=${sign}$${firstTrade.pnlUsd.toFixed(2)}`)
  }
} else {
  console.log("  First BUY signal           : none — signal never fired in window")
  console.log("  Trade exit                 : —")
}
console.log("─".repeat(72))

// ── 7. Print target window rows (2023-03-10 18:00 → 2023-03-13 12:00 UTC) ────

const winStart = new Date("2023-03-10T18:00:00Z").getTime()
const winEnd   = new Date("2023-03-13T12:00:00Z").getTime()
const winRows  = rows.filter(r => {
  const t = new Date(r.timestamp).getTime()
  return t >= winStart && t <= winEnd
})

const w = { ts: 17, bs: 9, bfx: 9, med: 9, lo: 9, hi: 9, h1: 7, hop: 7, ag: 6, dec: 7, d: 3, o: 3, ent: 9, ex: 8, pnl: 8 }
const pad  = (s: string, n: number) => s.padStart(n)
const padL = (s: string, n: number) => s.padEnd(n)

console.log(`\n── CSV rows  2023-03-10 18:00 → 2023-03-13 12:00 UTC ${"─".repeat(36)}`)
console.log(
  padL("timestamp",   w.ts) + "  " +
  pad("bitstamp",     w.bs) + "  " +
  pad("bitfinex",     w.bfx) + "  " +
  pad("median",       w.med) + "  " +
  pad("low_med",      w.lo) + "  " +
  pad("high_med",     w.hi) + "  " +
  pad("1h%",          w.h1) + "  " +
  pad("offPeg",       w.hop) + "  " +
  pad("agree",        w.ag) + "  " +
  padL("decision",    w.dec) + " " +
  pad("D",            w.d) + " " +
  pad("O",            w.o) + "  " +
  pad("entry",        w.ent) + "  " +
  pad("exit",         w.ex) + "  " +
  pad("P&L",          w.pnl),
)
console.log("─".repeat(118))

for (const r of winRows) {
  const ts  = r.timestamp.slice(0, 16).replace("T", " ")
  const ago = r.sources_agree === "true" ? "true " : "false"
  console.log(
    padL(ts,                  w.ts) + "  " +
    pad(r.price_bitstamp,     w.bs) + "  " +
    pad(r.price_bitfinex,     w.bfx) + "  " +
    pad(r.median_price,       w.med) + "  " +
    pad(r.low_median,         w.lo) + "  " +
    pad(r.high_median,        w.hi) + "  " +
    pad(r.change1h_pct,       w.h1) + "  " +
    pad(r.hours_off_peg,      w.hop) + "  " +
    pad(ago,                  w.ag) + "  " +
    padL(r.decision,          w.dec) + " " +
    pad(r.danger_score,       w.d) + " " +
    pad(r.opportunity_score,  w.o) + "  " +
    pad(r.trade_entry,        w.ent) + "  " +
    pad(r.exit_status,        w.ex) + "  " +
    pad(r.pnl_usd,            w.pnl),
  )
}
