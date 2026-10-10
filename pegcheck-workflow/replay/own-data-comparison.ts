// own-data-comparison.ts
// Replay on live price data: mkusd, bold, usdp, usdc — 30 Aug to 9 Oct 2026.
// Single blended price per hour; source check relaxed (echoes lone source).
// Fee: 0.05%/side. Stop-loss: 3%. Max hold: 7 days.
//
// Variants:
//   A0  Current rules, Rule B OFF (baseline)
//   A   Current rules, current Rule B (dip-recover-dip within 72 h)
//   B   Refined Rule B — only blocks if new dip low < previous dip low (lower lows)
//   C   B + no-progress exit (sell if trade ≥ 48 h open and price ≥ entry)
//   D   B + dip zone from 0.3% instead of 0.5%
//   E   B + C + D combined
//
// Run modes: (i) each coin individually; (ii) portfolio — 4 coins share max 3 slots.
//
// Run: bun run replay/own-data-comparison.ts

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
const NOPROGRESS_MS     = 48 * 60 * 60 * 1000
const MAX_PORTFOLIO_POS = 3
const PEG               = 1.0

// ── Types ─────────────────────────────────────────────────────────────────────

type ExtStatus = ExitStatus | "no_progress"

type TradeSummary = {
  entryTime:  string
  exitTime:   string
  entryPrice: number
  exitPrice:  number
  status:     ExtStatus
  grossPnl:   number
  netPnl:     number
  hoursHeld:  number
}

type CoinState = {
  openTrade: OpenTrade | null
  trades:    TradeSummary[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcFee(grossPnl: number, sizeUsd: number): number {
  return (2 * sizeUsd + grossPnl) * FEE_RATE
}

function closeTrade(
  state:     CoinState,
  trade:     OpenTrade,
  nowMs:     number,
  exitPrice: number,
  gross:     number,
  status:    ExtStatus,
): void {
  state.trades.push({
    entryTime:  trade.openedAt.toISOString(),
    exitTime:   new Date(nowMs).toISOString(),
    entryPrice: trade.entry,
    exitPrice,
    status,
    grossPnl:  gross,
    netPnl:    gross - calcFee(gross, trade.sizeUsd),
    hoursHeld: (nowMs - trade.openedAt.getTime()) / 3_600_000,
  })
  state.openTrade = null
}

// ── CSV loader ────────────────────────────────────────────────────────────────

type RawTuple = [string, number, number, number, number] // [hourISO, open, high, low, close]

function loadCoinCandles(): Map<string, Candle[]> {
  const csvPath = new URL("data/replay-data.csv", import.meta.url)
    .pathname.replace(/^\/([A-Za-z]:)/, "$1")
  const raw   = readFileSync(csvPath, "utf8").trim()
  const lines = raw.split(/\r?\n/)
  const map   = new Map<string, Candle[]>()

  for (const line of lines.slice(1)) {
    const comma = line.indexOf(",")
    const slug  = line.slice(0, comma)
    let   json  = line.slice(comma + 1)
    if (json.startsWith('"') && json.endsWith('"'))
      json = json.slice(1, -1).replace(/""/g, '"')
    const tuples = JSON.parse(json) as RawTuple[]
    map.set(slug, tuples.map(([iso, , high, low, close]) => ({
      ts:             Date.parse(iso),
      median:         close,
      low_median:     low,
      high_median:    high,
      pricesBySource: { blended: close },
      historyPrice:   close,
    })))
  }
  return map
}

// ── Previous-dip-low (for refined Rule B) ────────────────────────────────────
// Returns the lowest close seen in the dip zone before lastAtPegTs, within 72 h.

function prevDipLow(
  sorted:          { ts: number; price: number }[],
  lastAtPegTs:     number,
  nowMs:           number,
  dipZoneStartPct: number,
): number | null {
  const windowStart = nowMs - REPEAT_DIP_WINDOW
  let low: number | null = null
  for (const e of sorted) {
    if (e.ts >= lastAtPegTs) break     // look only before the recovery
    if (e.ts < windowStart) continue   // outside the 72 h guard window
    if ((PEG - e.price) / PEG >= dipZoneStartPct)
      if (low === null || e.price < low) low = e.price
  }
  return low
}

// ── Exit step ─────────────────────────────────────────────────────────────────
// Stop-loss / take-profit / max-hold are checked first (highest priority).
// No-progress exit fires only when those haven't triggered.

function exitStep(
  c:              Candle,
  state:          CoinState,
  noProgressExit: boolean,
): void {
  const trade = state.openTrade
  if (trade === null) return

  const nowMs = c.ts
  const units = trade.sizeUsd / trade.entry

  const exit = conservativeExit(
    trade, c.median, c.low_median, c.high_median,
    new Date(nowMs), STOP_PCT, MAX_TRADE_DAYS, TAKE_PROFIT_DISTANCE_PCT,
  )
  if (exit.status !== "open") {
    closeTrade(state, trade, nowMs, exit.exitPrice, exit.profitUsd, exit.status)
    return
  }

  if (noProgressExit) {
    const elapsed = nowMs - trade.openedAt.getTime()
    if (elapsed >= NOPROGRESS_MS && c.median >= trade.entry) {
      const gross = units * c.median - trade.sizeUsd
      closeTrade(state, trade, nowMs, c.median, gross, "no_progress")
    }
  }
}

// ── Buy step ──────────────────────────────────────────────────────────────────
// Builds rolling 3-day history, applies Rule B strategy, calls decide().
// Returns true if the buy signal fired (regardless of canBuySlot).

function buyStep(
  c:                 Candle,
  coin:              string,
  allCandles:        Candle[],
  state:             CoinState,
  suppressRepeatDip: boolean,
  refinedRepeatDip:  boolean,
  dipZoneStartPct:   number,
  canBuySlot:        boolean,
): boolean {
  const nowMs = c.ts

  const historyEntries: HistoryEntry[] = allCandles
    .filter(h => h.ts >= nowMs - THREE_DAYS_MS && h.ts <= nowMs)
    .map(h => ({ created_at: new Date(h.ts).toISOString(), price: h.historyPrice }))

  const sorted = historyEntries
    .map(e => ({ ts: Date.parse(e.created_at), price: e.price }))
    .sort((a, b) => a.ts - b.ts)

  // Echo the single blended source so sourcesAgree fires (same approach as UST replay)
  const srcPrices = { blended: c.median, blended_echo: c.median }

  const summarised  = summariseHistory(historyEntries, nowMs)
  const apiSummary: ApiSummary = { medianPrice: c.median, sources: srcPrices, ...summarised }
  const rawStats    = buildHistoryStats(apiSummary, nowMs)

  let histStats = rawStats

  if (suppressRepeatDip) {
    histStats = { ...rawStats, hadPriorDipCycle: null }
  } else if (refinedRepeatDip && rawStats.hadPriorDipCycle === true && summarised.lastAtPegTs !== null) {
    // Refined Rule B: only block if candle's intra-hour low is strictly below the previous
    // dip cycle's lowest price — lower lows signal a collapsing coin; equal/higher = noise.
    const pdl        = prevDipLow(sorted, summarised.lastAtPegTs, nowMs, dipZoneStartPct)
    const isLowerLow = pdl !== null && c.low_median < pdl
    if (!isLowerLow) histStats = { ...rawStats, hadPriorDipCycle: null }
  }

  const evidence = {
    coin,
    peg:                      PEG,
    medianPrice:              c.median,
    pricesBySource:           srcPrices,
    largeTransferCount24h:    0,
    largeTransferTotalUsd24h: 0,
    openPositionsCount:       0, // coin-local; portfolio capacity enforced externally
    history:                  histStats,
  }
  const result     = decide(evidence, dipZoneStartPct !== DIP_ZONE_START_PCT ? { dipZoneStartPct } : {})
  const buyFired   = result.decision === "buy" && state.openTrade === null

  if (buyFired && canBuySlot && result.buy !== undefined) {
    state.openTrade = {
      coin, peg: PEG,
      entry:    result.buy.entry,
      sizeUsd:  result.buy.sizeUsd,
      openedAt: new Date(nowMs),
    }
  }

  return buyFired
}

// ── Per-coin variant run ──────────────────────────────────────────────────────

function runCoinVariant(
  candles:           Candle[],
  coin:              string,
  suppressRepeatDip: boolean,
  refinedRepeatDip:  boolean,
  noProgressExit:    boolean,
  dipZoneStartPct:   number,
): TradeSummary[] {
  const state: CoinState = { openTrade: null, trades: [] }

  for (const c of candles) {
    exitStep(c, state, noProgressExit)
    if (state.openTrade === null)
      buyStep(c, coin, candles, state, suppressRepeatDip, refinedRepeatDip, dipZoneStartPct, true)
  }

  if (state.openTrade !== null) {
    const last  = candles[candles.length - 1]!
    const trade = state.openTrade
    const gross = (trade.sizeUsd / trade.entry) * last.median - trade.sizeUsd
    closeTrade(state, trade, last.ts, last.median, gross, "open")
  }

  return state.trades
}

// ── Portfolio variant run ─────────────────────────────────────────────────────

type PortfolioResult = {
  coinTrades:     Map<string, TradeSummary[]>
  skippedSignals: number
}

function runPortfolioVariant(
  coinCandles:       Map<string, Candle[]>,
  suppressRepeatDip: boolean,
  refinedRepeatDip:  boolean,
  noProgressExit:    boolean,
  dipZoneStartPct:   number,
): PortfolioResult {
  const coins = [...coinCandles.keys()].sort()

  // Merged, sorted timestamp list
  const tsSet = new Set<number>()
  for (const cs of coinCandles.values()) for (const c of cs) tsSet.add(c.ts)
  const allTs = [...tsSet].sort((a, b) => a - b)

  const stateMap   = new Map(coins.map(c => [c, { openTrade: null, trades: [] } as CoinState]))
  const candleByTs = new Map(coins.map(c => [c, new Map(coinCandles.get(c)!.map(x => [x.ts, x]))]))

  let skippedSignals = 0

  for (const ts of allTs) {
    // Phase 1 — exits first, so freed slots are available for buys this hour
    for (const coin of coins) {
      const c = candleByTs.get(coin)!.get(ts)
      if (!c) continue
      exitStep(c, stateMap.get(coin)!, noProgressExit)
    }

    // Phase 2 — buys with shared slot budget
    let slotsAvail = MAX_PORTFOLIO_POS - [...stateMap.values()].filter(s => s.openTrade !== null).length
    for (const coin of coins) {
      const c = candleByTs.get(coin)!.get(ts)
      if (!c) continue
      const state = stateMap.get(coin)!
      if (state.openTrade !== null) continue

      const fired = buyStep(
        c, coin, coinCandles.get(coin)!, state,
        suppressRepeatDip, refinedRepeatDip, dipZoneStartPct,
        slotsAvail > 0,
      )
      if (fired) {
        if (slotsAvail > 0) slotsAvail--
        else skippedSignals++
      }
    }
  }

  // Force-close any positions still open at window end
  for (const coin of coins) {
    const state = stateMap.get(coin)!
    if (state.openTrade !== null) {
      const all  = coinCandles.get(coin)!
      const last = all[all.length - 1]!
      const t    = state.openTrade
      const gross = (t.sizeUsd / t.entry) * last.median - t.sizeUsd
      closeTrade(state, t, last.ts, last.median, gross, "open")
    }
  }

  return {
    coinTrades:     new Map(coins.map(c => [c, stateMap.get(c)!.trades])),
    skippedSignals,
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

type Summary = {
  n: number; wins: number; losses: number; timeouts: number; openEnd: number
  netPnl: number; avgHours: number
}

function summarise(trades: TradeSummary[]): Summary {
  return {
    n:        trades.length,
    wins:     trades.filter(t => t.status === "won").length,
    losses:   trades.filter(t => t.status === "lost").length,
    timeouts: trades.filter(t => t.status === "timed_out" || t.status === "no_progress").length,
    openEnd:  trades.filter(t => t.status === "open").length,
    netPnl:   trades.reduce((s, t) => s + t.netPnl, 0),
    avgHours: trades.length > 0
      ? trades.reduce((s, t) => s + t.hoursHeld, 0) / trades.length : 0,
  }
}

// ── Variant definitions ───────────────────────────────────────────────────────

type VariantDef = {
  label: string; desc: string
  suppressRepeatDip: boolean; refinedRepeatDip: boolean
  noProgressExit: boolean; dipZoneStartPct: number
}

const VARIANTS: VariantDef[] = [
  { label: "A0", desc: "Current rules, Rule B OFF",                 suppressRepeatDip: true,  refinedRepeatDip: false, noProgressExit: false, dipZoneStartPct: DIP_ZONE_START_PCT },
  { label: "A",  desc: "Current rules + current Rule B",            suppressRepeatDip: false, refinedRepeatDip: false, noProgressExit: false, dipZoneStartPct: DIP_ZONE_START_PCT },
  { label: "B",  desc: "Refined Rule B (lower lows only)",          suppressRepeatDip: false, refinedRepeatDip: true,  noProgressExit: false, dipZoneStartPct: DIP_ZONE_START_PCT },
  { label: "C",  desc: "B + no-progress exit (≥48 h, price ≥ entry)", suppressRepeatDip: false, refinedRepeatDip: true,  noProgressExit: true,  dipZoneStartPct: DIP_ZONE_START_PCT },
  { label: "D",  desc: "B + dip zone from 0.3%",                   suppressRepeatDip: false, refinedRepeatDip: true,  noProgressExit: false, dipZoneStartPct: 0.003 },
  { label: "E",  desc: "B + C + D (all three)",                    suppressRepeatDip: false, refinedRepeatDip: true,  noProgressExit: true,  dipZoneStartPct: 0.003 },
]

// ── Run ───────────────────────────────────────────────────────────────────────

const coinCandles = loadCoinCandles()
const coins       = [...coinCandles.keys()].sort()

console.log("═".repeat(72))
console.log("  OWN DATA COMPARISON  —  30 Aug – 9 Oct 2026")
console.log(`  Coins: ${coins.join(", ")}  |  ${coinCandles.get(coins[0]!)?.length} candles each`)
console.log("  Stop-loss 3% · Max hold 7 days · Fee 0.05%/side")
console.log("═".repeat(72))

// Per-coin
const perCoinRows: { variant: string; coin: string; s: Summary }[] = []
for (const v of VARIANTS) {
  for (const coin of coins) {
    const trades = runCoinVariant(
      coinCandles.get(coin)!, coin,
      v.suppressRepeatDip, v.refinedRepeatDip, v.noProgressExit, v.dipZoneStartPct,
    )
    perCoinRows.push({ variant: v.label, coin, s: summarise(trades) })
    process.stdout.write(".")
  }
}
console.log()

// Portfolio
const portfolioRows: {
  variant: string
  perCoin: Map<string, Summary>
  total:   Summary
  skipped: number
}[] = []

for (const v of VARIANTS) {
  const { coinTrades, skippedSignals } = runPortfolioVariant(
    coinCandles, v.suppressRepeatDip, v.refinedRepeatDip, v.noProgressExit, v.dipZoneStartPct,
  )
  const perCoin = new Map(coins.map(c => [c, summarise(coinTrades.get(c) ?? [])]))
  const allT: TradeSummary[] = []
  for (const ts of coinTrades.values()) allT.push(...ts)
  portfolioRows.push({ variant: v.label, perCoin, total: summarise(allT), skipped: skippedSignals })
  process.stdout.write(".")
}
console.log()

// ── Format helpers ────────────────────────────────────────────────────────────

const fP  = (n: number) => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2)
const fH  = (n: number) => n > 0 ? n.toFixed(0) + "h" : "—"
const wlStr = (s: Summary) =>
  s.n === 0 ? "—"
  : `${s.wins}W/${s.losses}L${s.timeouts ? "/" + s.timeouts + "T" : ""}${s.openEnd ? "/O" : ""}`

// ── Console tables ────────────────────────────────────────────────────────────

console.log("\n── Per-coin ───────────────────────────────────────────────────────────────")
console.log("  Var  Coin    #  W/L/T           Net P&L    Avg hold")
console.log("  " + "─".repeat(56))
let prevVar = ""
for (const r of perCoinRows) {
  if (r.variant !== prevVar && prevVar !== "") console.log("  " + "─".repeat(56))
  prevVar = r.variant
  const s = r.s
  console.log(
    `  ${r.variant.padEnd(4)} ${r.coin.padEnd(6)} ${String(s.n).padStart(2)}  ${wlStr(s).padEnd(16)} ${fP(s.netPnl).padStart(8)}  ${fH(s.avgHours).padStart(5)}`
  )
}

console.log("\n── Portfolio (4 coins, max 3 positions) ───────────────────────────────────")
console.log("  Var  Coin    #  W/L/T           Net P&L    Avg hold  Skip")
console.log("  " + "─".repeat(62))
for (const r of portfolioRows) {
  let first = true
  for (const coin of coins) {
    const s = r.perCoin.get(coin)!
    console.log(
      `  ${(first ? r.variant : "").padEnd(4)} ${coin.padEnd(6)} ${String(s.n).padStart(2)}  ${wlStr(s).padEnd(16)} ${fP(s.netPnl).padStart(8)}  ${fH(s.avgHours).padStart(5)}  ${first ? String(r.skipped) : ""}`
    )
    first = false
  }
  const t = r.total
  console.log(
    `       ${"TOTAL".padEnd(6)} ${String(t.n).padStart(2)}  ${wlStr(t).padEnd(16)} ${fP(t.netPnl).padStart(8)}  ${fH(t.avgHours).padStart(5)}`
  )
  console.log("  " + "─".repeat(62))
}

// ── Write markdown ────────────────────────────────────────────────────────────

const md: string[] = []

md.push("# Own Data Comparison")
md.push("")
md.push("Live price data: 30 Aug – 9 Oct 2026. Coins: mkusd, bold, usdp, usdc.")
md.push("Single blended price per hour (source check relaxed — lone source echoed).")
md.push("Fee: 0.05%/side (0.1% round-trip). Stop-loss: 3%. Max hold: 7 days.")
md.push("")
md.push("## Variants")
md.push("")
md.push("| Label | Description | Dip zone start |")
md.push("| ----- | ----------- | -------------- |")
for (const v of VARIANTS) {
  md.push(`| **${v.label}** | ${v.desc} | ${(v.dipZoneStartPct * 100).toFixed(1)}% below peg |`)
}
md.push("")
md.push("> **Refined Rule B** fires only when the current candle's intra-hour low is strictly below")
md.push("> the previous dip cycle's lowest close within the 72 h window.")
md.push("> Plain Rule B fires on any dip → recovery → dip pattern within 72 h, regardless of depth.")
md.push(">")
md.push("> **No-progress exit:** sell at close if the trade has been open ≥ 48 h AND current price ≥ entry.")
md.push("> Stop-loss and take-profit are still evaluated first on each candle.")
md.push("")

// Per-coin table
md.push("## Per-coin results")
md.push("")
md.push("| Variant | Coin | # | W/L/T | Net P&L | Avg hold |")
md.push("| ------- | ---- | - | ----- | ------- | -------- |")
for (const r of perCoinRows) {
  const s = r.s
  md.push(`| ${r.variant} | ${r.coin} | ${s.n || "—"} | ${wlStr(s)} | ${s.n ? fP(s.netPnl) : "—"} | ${fH(s.avgHours)} |`)
}
md.push("")

// Portfolio table
md.push("## Portfolio results (4 coins, max 3 open positions)")
md.push("")
md.push("Processed hour by hour in time order. Exits are processed before buys within each hour,")
md.push("so a slot freed by an exit is available to a new buy in the same hour.")
md.push("")
md.push("| Variant | Coin | # | W/L/T | Net P&L | Avg hold | Signals skipped |")
md.push("| ------- | ---- | - | ----- | ------- | -------- | --------------- |")
for (const r of portfolioRows) {
  let first = true
  for (const coin of coins) {
    const s = r.perCoin.get(coin)!
    md.push(`| ${first ? r.variant : ""} | ${coin} | ${s.n || "—"} | ${wlStr(s)} | ${s.n ? fP(s.netPnl) : "—"} | ${fH(s.avgHours)} | ${first ? String(r.skipped) : ""} |`)
    first = false
  }
  const t = r.total
  md.push(`| | **Total** | **${t.n || "—"}** | **${wlStr(t)}** | **${t.n ? fP(t.netPnl) : "—"}** | ${fH(t.avgHours)} | |`)
}
md.push("")

const mdPath = new URL("own-data-comparison.md", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1")
writeFileSync(mdPath, md.join("\n"))
console.log("\nResults written to replay/own-data-comparison.md")
