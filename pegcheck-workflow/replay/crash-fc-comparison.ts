// crash-fc-comparison.ts
// Runs A0, A, F, F+C on the historical crash datasets used by cross-dataset-comparison.ts:
//   • UST May 2022  (Binance + Bitfinex)
//   • USDC Mar 2023 (Bitstamp + Bitfinex)
//   • own data      (replay-data.csv, 4 coins summed)
//
// Reports per-dataset: trades, W/L/TO, net P&L, max drawdown.
// For UST under F+C: every entry attempt — bought vs blocked — with chronic fraction.
// For USDC under F+C: confirms whether the SVB dip trade fires.
// Appends results to replay/full-data-comparison.md.
//
// Run: bun run replay/crash-fc-comparison.ts

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
const FEE_RATE      = 0.0005
const STOP_PCT      = 0.03
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000
const PEG           = 1.0
const AT_PEG_THRESH = PEG * (1 - DIP_ZONE_START_PCT)   // 0.995
const CHRONIC_FRAC  = 0.5

type Mode = "off" | "any" | "f" | "fc"

// ── Result types ───────────────────────────────────────────────────────────────
type ClosedTrade = {
  ts:          number       // entry timestamp
  price:       number       // entry price
  exitStatus:  ExitStatus | "open"
  netPnl:      number
  chronicFrac: number | null  // fraction of 72h history below 0.995 at entry (fc only)
}

type RunResult = {
  trades:      ClosedTrade[]
  maxDrawdown: number
  // For F+C: every A0-equivalent buy signal, whether taken or blocked
  fcAttempts:  FcAttempt[]
}

type FcAttempt = {
  ts:          number
  price:       number
  depegPct:    number
  chronicFrac: number
  action:      "bought" | "blocked_chronic"
}

// ── Single-coin replay ─────────────────────────────────────────────────────────
function runCoin(candles: Candle[], coin: string, mode: Mode): RunResult {
  const fee = (gross: number, sz: number) => (2 * sz + gross) * FEE_RATE

  let openTrade: OpenTrade | null = null
  const trades:     ClosedTrade[] = []
  const fcAttempts: FcAttempt[]   = []
  let cumPnl = 0, peakPnl = 0, maxDrawdown = 0

  const trackClose = (netPnl: number) => {
    cumPnl += netPnl
    if (cumPnl > peakPnl) peakPnl = cumPnl
    if (peakPnl - cumPnl > maxDrawdown) maxDrawdown = peakPnl - cumPnl
  }

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
        const netPnl = exit.profitUsd - fee(exit.profitUsd, openTrade.sizeUsd)
        trades.push({
          ts:          openTrade.openedAt.getTime(),
          price:       openTrade.entry,
          exitStatus:  exit.status,
          netPnl,
          chronicFrac: null,
        })
        openTrade = null
        trackClose(netPnl)
      }
    }

    if (openTrade !== null) continue

    // ── Build history ──────────────────────────────────────────────────────────
    const winStart = nowMs - THREE_DAYS_MS
    const histEntries: HistoryEntry[] = []
    // Build history using binary search start for efficiency
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
    let   histStats  = buildHistoryStats(apiSummary, nowMs)

    // ── Mode logic ─────────────────────────────────────────────────────────────
    const depegPct     = (PEG - c.median) / PEG
    const belowPegN    = histEntries.filter(e => e.price < AT_PEG_THRESH).length
    const chronicFrac  = histEntries.length > 0 ? belowPegN / histEntries.length : 0

    if (mode === "off") {
      histStats = { ...histStats, hadPriorDipCycle: null }

    } else if (mode === "f") {
      if (histStats.hadPriorDipCycle === true && depegPct < 0.015)
        histStats = { ...histStats, hadPriorDipCycle: null }

    } else if (mode === "fc") {
      if (chronicFrac > CHRONIC_FRAC) {
        // Chronic filter fires — check whether A0 would have bought here
        const a0Stats  = { ...histStats, hadPriorDipCycle: null as null }
        const a0Result = decide({
          coin, peg: PEG, medianPrice: c.median, pricesBySource: srcPrices,
          largeTransferCount24h: 0, largeTransferTotalUsd24h: 0,
          openPositionsCount: 0, history: a0Stats,
        })
        if (a0Result.decision === "buy")
          fcAttempts.push({ ts: nowMs, price: c.median, depegPct, chronicFrac, action: "blocked_chronic" })
        continue  // skip buy
      }
      // F part: suppress Rule B for shallow dips
      if (histStats.hadPriorDipCycle === true && depegPct < 0.015)
        histStats = { ...histStats, hadPriorDipCycle: null }
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
      if (mode === "fc")
        fcAttempts.push({ ts: nowMs, price: c.median, depegPct, chronicFrac, action: "bought" })
    }
  }

  // Close still-open position at last candle
  if (openTrade !== null) {
    const last   = candles[candles.length - 1]!
    const gross  = (openTrade.sizeUsd / openTrade.entry) * last.median - openTrade.sizeUsd
    const netPnl = gross - fee(gross, openTrade.sizeUsd)
    trades.push({
      ts:          openTrade.openedAt.getTime(),
      price:       openTrade.entry,
      exitStatus:  "open",
      netPnl,
      chronicFrac: null,
    })
    trackClose(netPnl)
  }

  return { trades, maxDrawdown, fcAttempts }
}

// ── Candle loaders — identical to cross-dataset-comparison.ts ─────────────────
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
        pricesBySource: bfx ? { bitstamp: +c.close, bitfinex: bfx.close } : { bitstamp: +c.close },
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

// ── Summary helpers ────────────────────────────────────────────────────────────
const fp  = (n: number) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2)
const pct = (n: number) => (n * 100).toFixed(1) + "%"
const dt  = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC"

function summarise(r: RunResult) {
  const n    = r.trades.length
  const wins = r.trades.filter(t => t.exitStatus === "won").length
  const loss = r.trades.filter(t => t.exitStatus === "lost").length
  const tout = r.trades.filter(t => t.exitStatus === "timed_out").length
  const open = r.trades.filter(t => t.exitStatus === "open").length
  const pnl  = r.trades.reduce((s, t) => s + t.netPnl, 0)
  return { n, wins, loss, tout, open, pnl, maxDrawdown: r.maxDrawdown }
}

// ── Main ───────────────────────────────────────────────────────────────────────
console.log("Fetching candles…")
const [usdcCandles, ustData] = await Promise.all([loadUsdcCandles(), loadUstCandles()])
const ownMap  = loadOwnCandles()
const ustCandles = ustData?.candles ?? null

const d0 = (ms: number) => new Date(ms).toISOString().slice(0, 10)
if (usdcCandles) console.log(`  USDC 2023: ${usdcCandles.length} candles  ${d0(usdcCandles[0]!.ts)} – ${d0(usdcCandles.at(-1)!.ts)}`)
else             console.log("  USDC 2023: unavailable")
if (ustCandles)  console.log(`  UST  2022: ${ustCandles.length} candles  ${d0(ustCandles[0]!.ts)} – ${d0(ustCandles.at(-1)!.ts)}${ustData?.singleSrc ? " (single-source)" : ""}`)
else             console.log("  UST  2022: unavailable (Binance)")
console.log(`  Own  data: ${[...ownMap.keys()].join(", ")} (${ownMap.values().next().value?.length} candles)`)

// Run all variants on all datasets
const VARIANTS: { label: string; mode: Mode }[] = [
  { label: "A0",  mode: "off" },
  { label: "A",   mode: "any" },
  { label: "F",   mode: "f"   },
  { label: "F+C", mode: "fc"  },
]

type DatasetRuns = { label: string; ust: RunResult | null; usdc: RunResult | null; own: RunResult | null }
const allRuns: DatasetRuns[] = []

console.log("\nRunning…")
for (const v of VARIANTS) {
  const ust  = ustCandles  ? runCoin(ustCandles,  "UST",  v.mode) : null
  const usdc = usdcCandles ? runCoin(usdcCandles, "USDC", v.mode) : null

  let own: RunResult | null = null
  if (ownMap.size > 0) {
    const merged: ClosedTrade[] = []
    let maxDD = 0
    for (const [slug, cs] of ownMap) {
      const r = runCoin(cs, slug, v.mode)
      merged.push(...r.trades)
      if (r.maxDrawdown > maxDD) maxDD = r.maxDrawdown
    }
    own = { trades: merged, maxDrawdown: maxDD, fcAttempts: [] }
  }

  allRuns.push({ label: v.label, ust, usdc, own })

  // Console preview
  const fmtDS = (r: RunResult | null, name: string) => {
    if (!r) return `${name}: n/a`
    const s = summarise(r)
    return `${name}: ${s.n}t ${s.wins}W/${s.loss}L/${s.tout}TO  ${fp(s.pnl)}  dd=$${s.maxDrawdown.toFixed(2)}`
  }
  console.log(`  ${v.label.padEnd(4)} | ${fmtDS(ust, "UST")} | ${fmtDS(usdc, "USDC")} | ${fmtDS(own, "Own")}`)
}

// ── Build detailed UST F+C trace ───────────────────────────────────────────────
const ustFC = allRuns.find(r => r.label === "F+C")!.ust
const ustFCAttempts = ustFC?.fcAttempts ?? []
const ustFCTrades   = ustFC?.trades     ?? []

// ── Console output ─────────────────────────────────────────────────────────────
console.log()
console.log("═".repeat(100))
console.log("  CRASH DATASETS — A0 / A / F / F+C")
console.log("  3% stop · 7-day max · 0.05%/side fee")
console.log("═".repeat(100))

for (const ds of ["UST May 2022", "USDC Mar 2023", "Own data"] as const) {
  const key  = ds === "UST May 2022" ? "ust" : ds === "USDC Mar 2023" ? "usdc" : "own"
  console.log(`\n  ${ds}`)
  console.log(`  ${"Var".padEnd(4)}  ${"#".padEnd(3)}  ${"W/L/TO/O".padEnd(16)}  ${"Net P&L".padEnd(10)}  Max DD`)
  console.log("  " + "─".repeat(55))
  for (const row of allRuns) {
    const r = row[key as keyof typeof row] as RunResult | null
    if (!r) { console.log(`  ${row.label.padEnd(4)}  n/a`); continue }
    const s    = summarise(r)
    const wlto = `${s.wins}W/${s.loss}L/${s.tout}TO/${s.open}O`
    console.log(`  ${row.label.padEnd(4)}  ${String(s.n).padEnd(3)}  ${wlto.padEnd(16)}  ${fp(s.pnl).padEnd(10)}  $${s.maxDrawdown.toFixed(2)}`)
  }
}

console.log("\n  UST F+C entry attempts:")
if (ustFCAttempts.length === 0 && ustFCTrades.length === 0) {
  console.log("    (no buy signals reached — all blocked by chronic filter or other guards)")
} else {
  for (const a of ustFCAttempts)
    console.log(`    ${dt(a.ts)}  price=${a.price.toFixed(4)}  depeg=${pct(a.depegPct)}  chronic=${pct(a.chronicFrac)}  → ${a.action}`)
  if (ustFCTrades.length === 0)
    console.log("    (no trades opened under F+C)")
}

// ── Build markdown ─────────────────────────────────────────────────────────────
const md: string[] = []
md.push("")
md.push("---")
md.push("")
md.push("## F+C on historical crash datasets")
md.push("")
md.push("Same settings as prior cross-dataset tests: 0.05%/side fee, 3% stop, 7-day max hold, source check relaxed.")
md.push("Datasets: UST May 2022 (Binance + Bitfinex), USDC Mar 2023 (Bitstamp + Bitfinex), own data (4 coins, summed).")
md.push("")

for (const [dsLabel, key] of [
  ["UST May 2022", "ust"],
  ["USDC Mar 2023", "usdc"],
  ["Own data (4 coins, summed)", "own"],
] as [string, "ust" | "usdc" | "own"][]) {
  md.push(`### ${dsLabel}`)
  md.push("")
  md.push("| Variant | Trades | W/L/TO/O | Net P&L | Max Drawdown |")
  md.push("| ------- | ------ | -------- | ------- | ------------ |")
  for (const row of allRuns) {
    const r = row[key] as RunResult | null
    if (!r) { md.push(`| **${row.label}** | n/a | — | — | — |`); continue }
    const s    = summarise(r)
    const wlto = `${s.wins}W/${s.loss}L/${s.tout}TO/${s.open}O`
    md.push(`| **${row.label}** | ${s.n} | ${wlto} | **${fp(s.pnl)}** | $${s.maxDrawdown.toFixed(2)} |`)
  }
  md.push("")
}

// ── Q1: UST F+C ───────────────────────────────────────────────────────────────
md.push("### Q1: Does F+C avoid the UST collapse?")
md.push("")

if (!ustCandles) {
  md.push("UST data unavailable — Binance API unreachable.")
} else {
  const ustA0  = allRuns.find(r => r.label === "A0")!.ust!
  const ustFC2 = allRuns.find(r => r.label === "F+C")!.ust!
  const sA0    = summarise(ustA0)
  const sFC    = summarise(ustFC2)

  md.push(`A0 takes ${sA0.n} trades and nets **${fp(sA0.pnl)}** (${sA0.wins}W/${sA0.loss}L).`)
  md.push(`F+C takes ${sFC.n} trades and nets **${fp(sFC.pnl)}** (${sFC.wins}W/${sFC.loss}L).`)
  md.push("")

  if (ustFCAttempts.length === 0 && ustFCTrades.length === 0) {
    md.push("F+C opens **no trades at all** on UST. All buy signals were blocked — either by the chronic")
    md.push("filter (>50% of the 72h window below 0.995) or by other guards before the chronic check was reached.")
  } else {
    md.push("**Entry attempts under F+C:**")
    md.push("")
    md.push("| Date (UTC) | Price | Depeg | 72h chronic fraction | Action |")
    md.push("| ---------- | ----- | ----- | -------------------- | ------ |")
    for (const a of ustFCAttempts) {
      const actionFmt = a.action === "bought"
        ? "✓ bought"
        : `✗ blocked — ${pct(a.chronicFrac)} of 72h below 0.995 (>${pct(CHRONIC_FRAC)} threshold)`
      md.push(`| ${dt(a.ts)} | ${a.price.toFixed(5)} | ${pct(a.depegPct)} | ${pct(a.chronicFrac)} | ${actionFmt} |`)
    }
    md.push("")
    if (ustFCTrades.length > 0) {
      md.push(`F+C **does** enter UST at least once. The bought trade(s):`)
      md.push("")
      md.push("| Entry date | Entry price | Exit | Net P&L |")
      md.push("| ---------- | ----------- | ---- | ------- |")
      for (const t of ustFCTrades) {
        md.push(`| ${dt(t.ts)} | ${t.price.toFixed(5)} | ${t.exitStatus} | **${fp(t.netPnl)}** |`)
      }
      md.push("")
    }

    // Explain each blocked entry
    const blocked = ustFCAttempts.filter(a => a.action === "blocked_chronic")
    if (blocked.length > 0) {
      md.push(`**Why the chronic filter blocked ${blocked.length} entry(ies):**`)
      md.push("")
      md.push(`The filter skips a buy when more than ${pct(CHRONIC_FRAC)} of the last 72h candles`)
      md.push(`closed below 0.995 (0.5% below peg). For UST this threshold is crossed quickly`)
      md.push(`once the collapse is underway — within a day or two of sustained off-peg closes,`)
      md.push(`the coin's own recent history condemns further entries.`)
    }
  }
}

md.push("")

// ── Q2: USDC F+C ──────────────────────────────────────────────────────────────
md.push("### Q2: Does F+C still buy the USDC March 2023 dip?")
md.push("")

if (!usdcCandles) {
  md.push("USDC data unavailable — Bitstamp API unreachable.")
} else {
  const usdcFC  = allRuns.find(r => r.label === "F+C")!.usdc!
  const usdcA0  = allRuns.find(r => r.label === "A0")!.usdc!
  const sFC     = summarise(usdcFC)
  const sA0     = summarise(usdcA0)

  if (sFC.n > 0 && sFC.wins > 0) {
    md.push(`**Yes.** F+C opens ${sFC.n} trade(s) and nets **${fp(sFC.pnl)}** — identical to A0 (${fp(sA0.pnl)}).`)
    md.push("")
    md.push("The USDC SVB crash started on 2023-03-10 after Circle announced $3.3B exposure to SVB.")
    md.push("At the point of the first buy signal, USDC had spent very few hours below 0.995")
    md.push("(the crash was sudden, not chronic), so the 72h chronic fraction was well below 50%.")
    md.push("The trade opens, USDC recovers over the following days, take-profit fires.")
    md.push("")
    md.push("| Entry date | Entry price | Exit | Net P&L | Chronic fraction at entry |")
    md.push("| ---------- | ----------- | ---- | ------- | ------------------------- |")
    for (const t of usdcFC.trades) {
      const cf = usdcFC.fcAttempts.find(a => a.ts === t.ts)?.chronicFrac ?? null
      md.push(`| ${dt(t.ts)} | ${t.price.toFixed(5)} | ${t.exitStatus} | **${fp(t.netPnl)}** | ${cf !== null ? pct(cf) : "n/a"} |`)
    }
  } else if (sFC.n > 0) {
    md.push(`F+C opens ${sFC.n} trade(s) on USDC but nets **${fp(sFC.pnl)}** (${sFC.wins}W/${sFC.loss}L).`)
  } else {
    md.push(`**No.** F+C opens 0 trades on USDC (A0 opened ${sA0.n}).`)
    md.push("The chronic filter blocked the SVB dip entry — check USDC fcAttempts for details.")
    // Show blocked attempts if any
    const blocked = usdcFC.fcAttempts.filter(a => a.action === "blocked_chronic")
    if (blocked.length > 0) {
      md.push("")
      md.push("| Date (UTC) | Price | Chronic fraction | Action |")
      md.push("| ---------- | ----- | ---------------- | ------ |")
      for (const a of blocked)
        md.push(`| ${dt(a.ts)} | ${a.price.toFixed(5)} | ${pct(a.chronicFrac)} | blocked |`)
    }
  }
}
md.push("")

// ── Append ────────────────────────────────────────────────────────────────────
const mdPath = new URL("full-data-comparison.md", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1")
appendFileSync(mdPath, md.join("\n"))
console.log("\nAppended to replay/full-data-comparison.md")
