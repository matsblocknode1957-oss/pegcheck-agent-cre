import { DIP_ZONE_START_PCT } from "./config.js"
import type { HistoryStats } from "./rules.js"

export type HistoryEntry = {
  created_at: string
  price: number
}

export type ApiSummary = {
  medianPrice: number
  sources: Record<string, number>
  latestPrice: number
  latestTs: number
  oldestTs: number
  price1hAgo: number | null
  price24hAgo: number | null
  low24h: number | null
  lastAtPegTs: number | null
  historyCount: number
}

const USDC_PEG = 1.0

export function summariseHistory(
  history: HistoryEntry[],
  nowMs: number,
): Omit<ApiSummary, "medianPrice" | "sources"> {
  if (history.length === 0) {
    return {
      latestPrice: 0, latestTs: nowMs, oldestTs: nowMs,
      price1hAgo: null, price24hAgo: null, low24h: null,
      lastAtPegTs: null, historyCount: 0,
    }
  }

  const sorted = history
    .map(e => ({ ts: Date.parse(e.created_at), price: e.price }))
    .sort((a, b) => a.ts - b.ts)

  const oneHAgo = nowMs - 60 * 60 * 1000
  const dayAgo  = nowMs - 24 * 60 * 60 * 1000

  let price1hAgo:  number | null = null;  let minD1h  = Infinity
  let price24hAgo: number | null = null;  let minD24h = Infinity
  let low24h = Infinity
  let lastAtPegTs: number | null = null

  for (const e of sorted) {
    const d1h  = Math.abs(e.ts - oneHAgo)
    if (d1h  < minD1h)  { minD1h  = d1h;  price1hAgo  = e.price }
    const d24h = Math.abs(e.ts - dayAgo)
    if (d24h < minD24h) { minD24h = d24h; price24hAgo = e.price }
    if (e.ts >= dayAgo && e.price < low24h) low24h = e.price
    if (Math.abs(e.price - USDC_PEG) / USDC_PEG < DIP_ZONE_START_PCT) {
      if (lastAtPegTs === null || e.ts > lastAtPegTs) lastAtPegTs = e.ts
    }
  }

  return {
    latestPrice:  sorted[sorted.length - 1]!.price,
    latestTs:     sorted[sorted.length - 1]!.ts,
    oldestTs:     sorted[0]!.ts,
    price1hAgo,
    price24hAgo,
    low24h:       low24h < Infinity ? low24h : null,
    lastAtPegTs,
    historyCount: sorted.length,
  }
}

export function buildHistoryStats(s: ApiSummary, nowMs: number): HistoryStats {
  if (s.historyCount === 0) {
    return {
      hoursOffPeg: null, change1hPct: null, change24hPct: null,
      bounceFromLowPct: null, pctBelow7d: null, daysOfData: null,
    }
  }
  return {
    hoursOffPeg:      s.lastAtPegTs !== null
                        ? (nowMs - s.lastAtPegTs) / (1000 * 60 * 60)
                        : 25,
    change1hPct:      s.price1hAgo !== null && s.price1hAgo > 0
                        ? (s.latestPrice - s.price1hAgo) / s.price1hAgo
                        : null,
    change24hPct:     s.price24hAgo !== null && s.price24hAgo > 0
                        ? (s.latestPrice - s.price24hAgo) / s.price24hAgo
                        : null,
    bounceFromLowPct: s.low24h !== null && s.low24h > 0
                        ? (s.latestPrice - s.low24h) / s.low24h
                        : null,
    pctBelow7d:       null,
    daysOfData:       null,
  }
}
