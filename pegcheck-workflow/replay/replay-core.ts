// Shared replay engine — parameterised stop-loss and timeout.
// Import runReplay here; keep exchange-specific fetch logic in the caller.

import { decide } from "../lib/agent/rules.js"
import type { Evidence, OpenTrade, HistoryStats, ExitStatus, DecideResult } from "../lib/agent/rules.js"
import { summariseHistory, buildHistoryStats } from "../lib/agent/history.js"
import type { HistoryEntry, ApiSummary } from "../lib/agent/history.js"
import { SOURCE_DISAGREE_SPREAD_PCT, TAKE_PROFIT_DISTANCE_PCT } from "../lib/agent/config.js"

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

// Generic candle — exchange field names live in the caller
export type Candle = {
  ts:             number
  median:         number
  low_median:     number
  high_median:    number
  pricesBySource: Record<string, number>
  historyPrice:   number   // primary-source close, used to build the history window
}

export type TradeRecord = {
  entryTime:  string
  entryPrice: number
  exitTime:   string
  exitPrice:  number
  status:     ExitStatus
  pnlUsd:     number
}

// Per-candle state — enough to reconstruct the CSV in replay-usdc-2023.ts
export type CandleState = {
  ts:           number
  result:       DecideResult
  sourcesAgree: boolean
  histStats:    HistoryStats
  tradeOpen:    boolean       // is a trade open at end of this candle (post-exit, post-buy)
  entryPrice:   number | null // currently open trade entry (null when flat)
  exitStatus:   ExitStatus | ""
  exitPrice:    number | null // only set when trade closes this candle
  pnlUsd:       number | null // unrealised P&L when open; realised P&L on close candle
}

export type ReplayResult = {
  trades:       TradeRecord[]
  totalPnl:     number
  candleStates: CandleState[]
}

export type ReplayConfig = {
  candles:                Candle[]
  stopPct:                number | null  // null = no stop-loss
  maxDays:                number | null  // null = no timeout
  peg?:                   number
  coin?:                  string
  relaxSourceCheck?:      boolean        // single-source what-if: echo lone source so sourcesAgree fires
  stopLossCooldown?:      boolean        // Rule A: block buy for 48 h after a stop-loss exit
  suppressRepeatDip?:     boolean        // baseline testing: override hadPriorDipCycle to null
  takeProfitDistancePct?: number         // override TP threshold (default: TAKE_PROFIT_DISTANCE_PCT)
  dipZoneStartPct?:       number         // override dip zone start passed to decide()
  quickProfitPct?:        number         // also exit when price is this % above entry (whichever TP fires first)
}

export function conservativeExit(
  trade:                 OpenTrade,
  closeMedian:           number,
  lowMedian:             number,
  highMedian:            number,
  now:                   Date,
  stopPct:               number | null,
  maxDays:               number | null,
  takeProfitDistancePct: number = TAKE_PROFIT_DISTANCE_PCT,
  quickProfitPct?:       number,
): { status: ExitStatus; exitPrice: number; profitUsd: number } {
  const { peg, entry, sizeUsd, openedAt } = trade
  const units    = sizeUsd / entry
  const normalTp = peg * (1 - takeProfitDistancePct)
  const tp       = quickProfitPct !== undefined
    ? Math.min(normalTp, entry * (1 + quickProfitPct))
    : normalTp
  const sl       = stopPct !== null ? entry * (1 - stopPct) : null
  const elapsed = now.getTime() - openedAt.getTime()
  const pnl     = (p: number) => units * p - sizeUsd

  if (sl !== null && lowMedian <= sl)
    return { status: "lost",      exitPrice: sl,          profitUsd: pnl(sl) }
  if (highMedian >= tp)
    return { status: "won",       exitPrice: tp,          profitUsd: pnl(tp) }
  if (maxDays !== null && elapsed >= maxDays * 86_400_000)
    return { status: "timed_out", exitPrice: closeMedian, profitUsd: pnl(closeMedian) }
  return         { status: "open",      exitPrice: closeMedian, profitUsd: pnl(closeMedian) }
}

const COOLDOWN_48H_MS = 48 * 60 * 60 * 1000

export function runReplay({
  candles,
  stopPct,
  maxDays,
  peg  = 1.0,
  coin = "STABLE",
  relaxSourceCheck      = false,
  stopLossCooldown      = false,
  suppressRepeatDip     = false,
  takeProfitDistancePct = TAKE_PROFIT_DISTANCE_PCT,
  dipZoneStartPct,
  quickProfitPct,
}: ReplayConfig): ReplayResult {
  const trades:       TradeRecord[] = []
  const candleStates: CandleState[] = []
  let openTrade: OpenTrade | null = null
  let lastStopLossExitMs: number | null = null

  for (let i = 0; i < candles.length; i++) {
    const c     = candles[i]!
    const nowMs = c.ts

    const historyEntries: HistoryEntry[] = candles
      .slice(0, i + 1)
      .filter(h => h.ts >= nowMs - THREE_DAYS_MS)
      .map(h => ({ created_at: new Date(h.ts).toISOString(), price: h.historyPrice }))

    const summarised = summariseHistory(historyEntries, nowMs)

    // In single-source what-if mode, echo the lone price so sourcesAgree can fire
    let srcPrices = { ...c.pricesBySource }
    if (relaxSourceCheck && Object.keys(srcPrices).length === 1) {
      const [k, v] = Object.entries(srcPrices)[0]!
      srcPrices = { [k]: v, [`${k}_echo`]: v }
    }

    const summary: ApiSummary = { medianPrice: c.median, sources: srcPrices, ...summarised }
    const rawHistStats = buildHistoryStats(summary, nowMs)
    const histStats = suppressRepeatDip
      ? { ...rawHistStats, hadPriorDipCycle: null }
      : rawHistStats

    const srcVals      = Object.values(srcPrices)
    const spread       = srcVals.length >= 2
      ? (Math.max(...srcVals) - Math.min(...srcVals)) / Math.min(...srcVals)
      : Infinity
    const sourcesAgree = srcVals.length >= 2 && spread < SOURCE_DISAGREE_SPREAD_PCT

    // ── Exit check ──────────────────────────────────────────────────────────
    let exitStatus: ExitStatus | "" = ""
    let exitPrice:  number | null   = null
    let pnlUsd:     number | null   = null

    if (openTrade !== null) {
      const exit = conservativeExit(
        openTrade, c.median, c.low_median, c.high_median, new Date(nowMs), stopPct, maxDays, takeProfitDistancePct, quickProfitPct,
      )
      pnlUsd    = exit.profitUsd
      exitPrice = exit.exitPrice
      if (exit.status !== "open") {
        exitStatus = exit.status
        if (exit.status === "lost") lastStopLossExitMs = nowMs
        trades.push({
          entryTime:  openTrade.openedAt.toISOString(),
          entryPrice: openTrade.entry,
          exitTime:   new Date(nowMs).toISOString(),
          exitPrice:  exit.exitPrice,
          status:     exit.status,
          pnlUsd:     exit.profitUsd,
        })
        openTrade = null
      }
    }

    // ── Decide ──────────────────────────────────────────────────────────────
    const evidence: Evidence = {
      coin,
      peg,
      medianPrice:              c.median,
      pricesBySource:           srcPrices,
      largeTransferCount24h:    0,
      largeTransferTotalUsd24h: 0,
      openPositionsCount:       openTrade !== null ? 1 : 0,
      history:                  histStats,
    }
    const result = decide(evidence, dipZoneStartPct !== undefined ? { dipZoneStartPct } : {})

    const inCooldown = stopLossCooldown && lastStopLossExitMs !== null
      && (nowMs - lastStopLossExitMs) < COOLDOWN_48H_MS

    if (result.decision === "buy" && openTrade === null && result.buy !== undefined && !inCooldown) {
      openTrade = {
        coin,
        peg,
        entry:    result.buy.entry,
        sizeUsd:  result.buy.sizeUsd,
        openedAt: new Date(nowMs),
      }
    }

    candleStates.push({
      ts:           nowMs,
      result,
      sourcesAgree,
      histStats,
      tradeOpen:    openTrade !== null,
      entryPrice:   openTrade?.entry ?? null,
      exitStatus,
      exitPrice:    exitStatus ? exitPrice : null,
      pnlUsd,
    })
  }

  // Trades still open at window end — mark to last candle median
  if (openTrade !== null) {
    const last  = candles[candles.length - 1]!
    const units = openTrade.sizeUsd / openTrade.entry
    const pnl   = units * last.median - openTrade.sizeUsd
    trades.push({
      entryTime:  openTrade.openedAt.toISOString(),
      entryPrice: openTrade.entry,
      exitTime:   new Date(last.ts).toISOString(),
      exitPrice:  last.median,
      status:     "open",
      pnlUsd:     pnl,
    })
  }

  return {
    trades,
    totalPnl:     trades.reduce((s, t) => s + t.pnlUsd, 0),
    candleStates,
  }
}
