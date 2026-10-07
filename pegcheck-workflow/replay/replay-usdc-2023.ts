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

import { decide } from "../lib/agent/rules.js"
import type { Evidence, OpenTrade, ExitResult } from "../lib/agent/rules.js"
import { summariseHistory, buildHistoryStats } from "../lib/agent/history.js"
import type { HistoryEntry, ApiSummary } from "../lib/agent/history.js"
import {
  SOURCE_DISAGREE_SPREAD_PCT,
  TAKE_PROFIT_DISTANCE_PCT,
  STOP_LOSS_PCT,
  MAX_TRADE_DAYS,
} from "../lib/agent/config.js"
import { writeFileSync, mkdirSync } from "fs"

const USDC_PEG    = 1.0
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

const toIso  = (ms: number) => new Date(ms).toISOString()
const fmtPct = (n: number | null) => n !== null ? (n * 100).toFixed(4) : ""
const csvEsc = (s: string) => `"${s.replace(/"/g, '""')}"`

// ── Conservative exit ─────────────────────────────────────────────────────────
// Uses candle low to test stop-loss and candle high to test take-profit.
// If both thresholds are hit in the same hourly candle, stop-loss wins (worst case).
// Exit prices are pinned to the threshold level (not the raw low/high).
function conservativeExit(
  trade:        OpenTrade,
  closeMedian:  number,   // used for unrealised P&L while open and on timeout
  lowMedian:    number,
  highMedian:   number,
  now:          Date,
): ExitResult {
  const { peg, entry, sizeUsd, openedAt } = trade
  const units   = sizeUsd / entry
  const tp      = peg * (1 - TAKE_PROFIT_DISTANCE_PCT)
  const sl      = entry * (1 - STOP_LOSS_PCT)
  const elapsed = now.getTime() - openedAt.getTime()
  const pnl     = (p: number) => units * p - sizeUsd

  if (lowMedian <= sl)                          return { status: "lost",      exitPrice: sl,          profitUsd: pnl(sl) }
  if (highMedian >= tp)                         return { status: "won",       exitPrice: tp,          profitUsd: pnl(tp) }
  if (elapsed >= MAX_TRADE_DAYS * 86_400_000)  return { status: "timed_out", exitPrice: closeMedian, profitUsd: pnl(closeMedian) }
  return                                               { status: "open",      exitPrice: closeMedian, profitUsd: pnl(closeMedian) }
}

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
// Bitfinex format: [mts, open, close, high, low, volume]
const bitfinexRaw = await bitfinexResp.json() as Array<[number, number, number, number, number, number]>

type BfxOHLC = { close: number; high: number; low: number }
const bitfinexByTs = new Map<number, BfxOHLC>(
  bitfinexRaw.map(c => [c[0], { close: c[2], high: c[3], low: c[4] }]),
)

// ── 2. Align ─────────────────────────────────────────────────────────────────

type Candle = {
  ts: number
  // closes
  bitstamp: number; bitfinex: number | null; median: number
  // lows  (used to test stop-loss each hour)
  low_bitstamp: number; low_bitfinex: number | null; low_median: number
  // highs (used to test take-profit each hour)
  high_bitstamp: number; high_bitfinex: number | null; high_median: number
}

const med2 = (a: number, b: number | null) => b !== null ? (a + b) / 2 : a

const candles: Candle[] = bitstampRaw.map(c => {
  const ts            = +c.timestamp * 1000
  const bfx           = bitfinexByTs.get(ts) ?? null
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

const singleSourceHours = candles.filter(c => c.bitfinex === null).length
console.log(`\nAligned ${candles.length} hourly candles`)
console.log(`  ${toIso(candles[0]!.ts)} → ${toIso(candles[candles.length - 1]!.ts)}`)
console.log(`  Two-source: ${candles.length - singleSourceHours}  |  Single-source (Bitfinex absent): ${singleSourceHours}`)

// ── 3. Replay ─────────────────────────────────────────────────────────────────

type Row = Record<string, string>
const rows: Row[] = []
let openTrade: OpenTrade | null = null

// Summary state
let firstAvoidDepeg: string | null = null
let lowestMedian     = Infinity
let lowestMedianTime = ""
let firstBuyTime: string | null = null
let firstBuyEntry: number | null = null
let closedTrade: { ts: string; exitPrice: number; status: string; pnl: number } | null = null

for (let i = 0; i < candles.length; i++) {
  const c     = candles[i]!
  const nowMs = c.ts

  // History: bitstamp closes within last 3 days (matches live agent days=3)
  const historyEntries: HistoryEntry[] = candles
    .slice(0, i + 1)
    .filter(h => h.ts >= nowMs - THREE_DAYS_MS)
    .map(h => ({ created_at: new Date(h.ts).toISOString(), price: h.bitstamp }))

  const summarised = summariseHistory(historyEntries, nowMs)

  const sourcePrices: Record<string, number> = { bitstamp: c.bitstamp }
  if (c.bitfinex !== null) sourcePrices.bitfinex = c.bitfinex

  const summary: ApiSummary = {
    medianPrice: c.median,
    sources:     sourcePrices,
    ...summarised,
  }

  const histStats = buildHistoryStats(summary, nowMs)

  // Spread for CSV (mirrors rules.ts priceSpread)
  const srcVals    = Object.values(sourcePrices)
  const spread     = srcVals.length >= 2
    ? (Math.max(...srcVals) - Math.min(...srcVals)) / Math.min(...srcVals)
    : Infinity
  const sourcesAgree = srcVals.length >= 2 && spread < SOURCE_DISAGREE_SPREAD_PCT

  // ── Conservative exit: low_median tests SL, high_median tests TP ──────────
  let exitStatus   = ""
  let exitPriceStr = ""
  let pnlStr       = ""

  if (openTrade !== null) {
    const exit = conservativeExit(openTrade, c.median, c.low_median, c.high_median, new Date(nowMs))
    pnlStr       = exit.profitUsd.toFixed(2)
    exitPriceStr = exit.exitPrice.toFixed(5)
    if (exit.status !== "open") {
      exitStatus = exit.status
      if (closedTrade === null) {
        closedTrade = { ts: toIso(nowMs), exitPrice: exit.exitPrice, status: exit.status, pnl: exit.profitUsd }
      }
      openTrade = null
    }
  }

  const evidence: Evidence = {
    coin: "USDC",
    peg:  USDC_PEG,
    medianPrice:              c.median,
    pricesBySource:           sourcePrices,
    largeTransferCount24h:    0,
    largeTransferTotalUsd24h: 0,
    openPositionsCount:       openTrade !== null ? 1 : 0,
    history:                  histStats,
  }

  const result = decide(evidence)

  // Open trade on BUY
  if (result.decision === "buy" && openTrade === null && result.buy !== undefined) {
    openTrade = {
      coin:     "USDC",
      peg:      USDC_PEG,
      entry:    result.buy.entry,
      sizeUsd:  result.buy.sizeUsd,
      openedAt: new Date(nowMs),
    }
    if (firstBuyTime === null) {
      firstBuyTime  = toIso(nowMs)
      firstBuyEntry = result.buy.entry
    }
  }

  // First AVOID from actual depeg (not just source-count issue)
  const depegPct = (USDC_PEG - c.median) / USDC_PEG
  if (result.decision === "avoid" && depegPct >= 0.005 && firstAvoidDepeg === null) {
    firstAvoidDepeg = toIso(nowMs)
  }

  if (c.median < lowestMedian) {
    lowestMedian     = c.median
    lowestMedianTime = toIso(nowMs)
  }

  // Top reasons: up to 2 danger + 1 opportunity, semicolons instead of commas
  const topReasons = [
    ...result.danger.reasons.slice(0, 2),
    ...result.opportunity.reasons.slice(0, 1),
  ].join(" | ").replace(/,/g, ";")

  rows.push({
    timestamp:           toIso(nowMs),
    price_bitstamp:      c.bitstamp.toFixed(5),
    price_bitfinex:      c.bitfinex      !== null ? c.bitfinex.toFixed(5)      : "",
    median_price:        c.median.toFixed(5),
    low_bitstamp:        c.low_bitstamp.toFixed(5),
    low_bitfinex:        c.low_bitfinex  !== null ? c.low_bitfinex.toFixed(5)  : "",
    low_median:          c.low_median.toFixed(5),
    high_bitstamp:       c.high_bitstamp.toFixed(5),
    high_bitfinex:       c.high_bitfinex !== null ? c.high_bitfinex.toFixed(5) : "",
    high_median:         c.high_median.toFixed(5),
    change1h_pct:        fmtPct(histStats.change1hPct),
    change24h_pct:       fmtPct(histStats.change24hPct),
    hours_off_peg:       histStats.hoursOffPeg !== null ? histStats.hoursOffPeg.toFixed(2) : "",
    bounce_from_low_pct: fmtPct(histStats.bounceFromLowPct),
    sources_agree:       String(sourcesAgree),
    decision:            result.decision,
    danger_score:        String(result.danger.score),
    opportunity_score:   String(result.opportunity.score),
    top_reasons:         csvEsc(topReasons),
    trade_open:          String(openTrade !== null),
    trade_entry:         openTrade !== null ? openTrade.entry.toFixed(5) : "",
    exit_status:         exitStatus,
    exit_price:          exitStatus ? exitPriceStr : "",
    pnl_usd:             pnlStr,
  })
}

// ── 4. Write CSV ──────────────────────────────────────────────────────────────

const CSV_COMMENTS = [
  "# USDC SVB Crash Replay — March 2023",
  "# Sources: Bitstamp USDCUSD (USD-quoted) + Bitfinex USDCUSD (USD-quoted)",
  "# NOT INCLUDED: Chainlink on-chain prices (archive RPC node required — not tested in replay)",
  "# Tested but rejected: Kraken (returns only last 720 candles; no historical access); Coinbase (404)",
  `# Single-source hours: ${singleSourceHours} of ${candles.length} (Bitfinex absent; 1-source danger rule fires)`,
  "# Exit method: exits tested against hourly lows/highs; stop assumed first if both hit in same candle",
  "# All decisions produced by decide() in lib/agent/rules.ts — no replay-specific decision logic",
]

const headers = Object.keys(rows[0]!).join(",")
const csvBody = rows.map(r => Object.values(r).join(",")).join("\n")

mkdirSync(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { recursive: true })
const outPath = new URL("usdc-2023-03.csv", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
writeFileSync(outPath, [...CSV_COMMENTS, headers, csvBody].join("\n") + "\n")
console.log(`\nWrote ${rows.length} rows → ${outPath}`)

// ── 5. Summary ────────────────────────────────────────────────────────────────

const lastCandle = candles[candles.length - 1]!
const unrealised = openTrade !== null
  ? (openTrade.sizeUsd / openTrade.entry) * lastCandle.median - openTrade.sizeUsd
  : null

console.log("\n" + "─".repeat(72))
console.log("  SVB Replay Summary — USDC/USD  March 2023")
console.log("─".repeat(72))
console.log("  Sources    : Bitstamp USDCUSD + Bitfinex USDCUSD  (both USD-quoted)")
console.log("             : Chainlink on-chain NOT included (archive RPC required)")
console.log("  Exit method: exits tested against hourly lows/highs; stop assumed first if both hit")
console.log(`  Coverage   : ${toIso(candles[0]!.ts).slice(0,10)} → ${toIso(lastCandle.ts).slice(0,10)}  (${candles.length} hourly candles)`)
console.log(`  Two-source : ${candles.length - singleSourceHours}/${candles.length} hours  |  single-source: ${singleSourceHours} (Bitfinex absent)`)
console.log("─".repeat(72))
console.log(`  First AVOID (depeg ≥0.5%)  : ${firstAvoidDepeg ?? "(none)"}`)
console.log(`  Lowest median price        : $${lowestMedian.toFixed(5)}  at ${lowestMedianTime}  (${((1 - lowestMedian) * 100).toFixed(1)}% off peg)`)
if (firstBuyTime !== null) {
  console.log(`  First BUY signal           : ${firstBuyTime}  entry=$${firstBuyEntry!.toFixed(5)}`)
} else {
  console.log("  First BUY signal           : none — signal never fired in window")
}
if (closedTrade !== null) {
  const sign = closedTrade.pnl >= 0 ? "+" : ""
  console.log(`  Trade exit                 : ${closedTrade.ts}  status=${closedTrade.status}  exit=$${closedTrade.exitPrice.toFixed(5)}  P&L=${sign}$${closedTrade.pnl.toFixed(2)}`)
} else if (openTrade !== null) {
  const sign = unrealised! >= 0 ? "+" : ""
  console.log(`  Trade exit                 : still open at window end  entry=$${openTrade.entry.toFixed(5)}  unrealised P&L=${sign}$${unrealised!.toFixed(2)}`)
} else {
  console.log("  Trade exit                 : —")
}
console.log("─".repeat(72))

// ── 6. Print target window rows (2023-03-10 18:00 → 2023-03-13 12:00 UTC) ────

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
