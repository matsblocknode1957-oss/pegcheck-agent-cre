// full-data-comparison.ts
// 18-coin portfolio replay (max 3 open positions, hour by hour).
// Variants: A0 (no Rule B), A (current Rule B), F (Rule B only when dip ≥1.5%).
// Run twice: with data-glitch candles included and removed.
//
// Glitch = candle whose low_median is >5% below peg AND the close recovers
// above that threshold within 3 hours (intra-hour flash crash / bad tick).
// When skipped: the candle is invisible to both exits and buys,
// and is excluded from price history used for buy decisions.
//
// Run: bun run replay/full-data-comparison.ts

import { conservativeExit } from "./replay-core.js"
import type { Candle } from "./replay-core.js"
import { summariseHistory, buildHistoryStats } from "../lib/agent/history.js"
import type { HistoryEntry, ApiSummary } from "../lib/agent/history.js"
import { decide } from "../lib/agent/rules.js"
import type { OpenTrade, ExitStatus } from "../lib/agent/rules.js"
import { TAKE_PROFIT_DISTANCE_PCT, MAX_TRADE_DAYS } from "../lib/agent/config.js"
import { readFileSync, writeFileSync } from "fs"

// ── Constants ──────────────────────────────────────────────────────────────────
const FEE_RATE          = 0.0005
const STOP_PCT          = 0.03
const THREE_DAYS_MS     = 3 * 24 * 60 * 60 * 1000
const PEG               = 1.0
const MAX_PORTFOLIO_POS = 3
const GLITCH_LOW_PCT    = 0.05   // low must be >5% below peg
const GLITCH_RECOVER_H  = 3      // recovers above threshold within this many hours

type Mode = "off" | "any" | "f"

// ── CSV loader ─────────────────────────────────────────────────────────────────
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

// ── Glitch detection ───────────────────────────────────────────────────────────
// A candle is a glitch if its intra-hour low is >5% below peg AND the close
// recovers above the threshold within the same or the next 3 candles.
function detectGlitches(candles: Candle[]): Set<number> {
  const glitches  = new Set<number>()
  const threshold = PEG * (1 - GLITCH_LOW_PCT)   // 0.95
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!
    if (c.low_median >= threshold) continue
    let recovers = c.median >= threshold
    if (!recovers) {
      for (let j = i + 1; j <= Math.min(i + GLITCH_RECOVER_H, candles.length - 1); j++) {
        if (candles[j]!.median >= threshold) { recovers = true; break }
      }
    }
    if (recovers) glitches.add(c.ts)
  }
  return glitches
}

// ── Portfolio simulation ───────────────────────────────────────────────────────
type ClosedTrade = { coin: string; status: ExitStatus | "open"; netPnl: number }

type PortfolioResult = {
  closedTrades: ClosedTrade[]
  skipped:      number
  maxDrawdown:  number
}

function runPortfolio(
  coins:        { slug: string; candles: Candle[]; glitchTs: Set<number> }[],
  mode:         Mode,
  skipGlitches: boolean,
): PortfolioResult {
  const fee = (gross: number, sz: number) => (2 * sz + gross) * FEE_RATE

  // slug → candle array
  const bySlug = new Map<string, Candle[]>()
  for (const { slug, candles } of coins) bySlug.set(slug, candles)

  // slug → (ts → {candle, idx in array})
  const candleMap = new Map<string, Map<number, { c: Candle; idx: number }>>()
  for (const { slug, candles } of coins) {
    const m = new Map<number, { c: Candle; idx: number }>()
    candles.forEach((c, idx) => m.set(c.ts, { c, idx }))
    candleMap.set(slug, m)
  }

  // slug → glitch timestamps
  const glitchMap = new Map<string, Set<number>>()
  for (const { slug, glitchTs } of coins) glitchMap.set(slug, glitchTs)

  // ts → slugs that have a candle there
  const tsToSlugs = new Map<number, string[]>()
  for (const { slug, candles } of coins) {
    for (const c of candles) {
      const arr = tsToSlugs.get(c.ts) ?? []; arr.push(slug); tsToSlugs.set(c.ts, arr)
    }
  }
  const allTs = [...tsToSlugs.keys()].sort((a, b) => a - b)

  // Mutable per-coin trade slot
  const openTrade = new Map<string, OpenTrade | null>()
  for (const { slug } of coins) openTrade.set(slug, null)

  let slotsUsed   = 0
  let skipped     = 0
  const closed: ClosedTrade[] = []
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

    // ── EXITS (free slots before considering new buys) ─────────────────────────
    for (const slug of slugsHere) {
      const ot = openTrade.get(slug)
      if (!ot) continue
      if (skipGlitches && glitchMap.get(slug)!.has(ts)) continue

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

    // ── BUYS ──────────────────────────────────────────────────────────────────
    for (const slug of slugsHere) {
      if (openTrade.get(slug) !== null) continue
      if (skipGlitches && glitchMap.get(slug)!.has(ts)) continue

      const { c, idx } = candleMap.get(slug)!.get(ts)!
      const allCandles  = bySlug.get(slug)!
      const gSet        = glitchMap.get(slug)!
      const winStart    = ts - THREE_DAYS_MS

      // Binary search for the start of the 3-day window
      let lo = 0, hi = idx
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (allCandles[mid]!.ts < winStart) lo = mid + 1; else hi = mid
      }

      const histEntries: HistoryEntry[] = []
      for (let j = lo; j <= idx; j++) {
        const h = allCandles[j]!
        if (skipGlitches && gSet.has(h.ts)) continue
        histEntries.push({ created_at: new Date(h.ts).toISOString(), price: h.historyPrice })
      }

      let srcPrices = { ...c.pricesBySource }
      if (Object.keys(srcPrices).length === 1) {
        const [k, v] = Object.entries(srcPrices)[0]!
        srcPrices = { [k]: v, [`${k}_echo`]: v }
      }

      const summarised = summariseHistory(histEntries, ts)
      const apiSummary: ApiSummary = { medianPrice: c.median, sources: srcPrices, ...summarised }
      let   histStats  = buildHistoryStats(apiSummary, ts)

      if (mode === "off") {
        histStats = { ...histStats, hadPriorDipCycle: null }
      } else if (mode === "f") {
        if (histStats.hadPriorDipCycle === true && (PEG - c.median) / PEG < 0.015)
          histStats = { ...histStats, hadPriorDipCycle: null }
      }

      const result = decide({
        coin: slug, peg: PEG,
        medianPrice:              c.median,
        pricesBySource:           srcPrices,
        largeTransferCount24h:    0,
        largeTransferTotalUsd24h: 0,
        openPositionsCount:       0,
        history:                  histStats,
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

  // Value any still-open positions at the last available close
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

// ── Main ───────────────────────────────────────────────────────────────────────
console.log("Loading candles…")
const rawCoins = loadBatches()
console.log(`  ${rawCoins.length} coins loaded`)
for (const { slug, candles } of rawCoins) {
  const first = new Date(candles[0]!.ts).toISOString().slice(0, 10)
  const last  = new Date(candles[candles.length - 1]!.ts).toISOString().slice(0, 10)
  console.log(`  ${slug.padEnd(10)} ${candles.length} candles  ${first} – ${last}`)
}

// Detect glitches
console.log("\nDetecting glitches (low >5% below peg, recovers within 3h)…")
const coinsWithGlitch = rawCoins.map(({ slug, candles }) => {
  const glitchTs = detectGlitches(candles)
  if (glitchTs.size > 0)
    console.log(`  ${slug.padEnd(10)} ${glitchTs.size} glitch candle(s)`)
  return { slug, candles, glitchTs }
})
const totalGlitches = coinsWithGlitch.reduce((s, c) => s + c.glitchTs.size, 0)
console.log(`  Total: ${totalGlitches} glitch candles across all coins`)

// Run all 6 combinations
const VARIANTS: { label: string; mode: Mode }[] = [
  { label: "A0", mode: "off" },
  { label: "A",  mode: "any" },
  { label: "F",  mode: "f"   },
]
const GLITCH_SETTINGS: { label: string; skip: boolean }[] = [
  { label: "with glitches",    skip: false },
  { label: "glitches removed", skip: true  },
]

type RunResult = {
  variant:  string
  glitch:   string
  result:   PortfolioResult
}
const runs: RunResult[] = []

console.log("\nRunning portfolio simulations…")
for (const v of VARIANTS) {
  for (const g of GLITCH_SETTINGS) {
    process.stdout.write(`  ${v.label} / ${g.label}… `)
    const result = runPortfolio(coinsWithGlitch, v.mode, g.skip)
    runs.push({ variant: v.label, glitch: g.label, result })
    const n    = result.closedTrades.length
    const wins = result.closedTrades.filter(t => t.status === "won").length
    const loss = result.closedTrades.filter(t => t.status === "lost").length
    const pnl  = result.closedTrades.reduce((s, t) => s + t.netPnl, 0)
    console.log(`${n}t  ${wins}W/${loss}L  $${pnl.toFixed(2)}  dd=$${result.maxDrawdown.toFixed(2)}  skip=${result.skipped}`)
  }
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const fp = (n: number) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2)

function perCoinStats(trades: ClosedTrade[]): Map<string, { n: number; wins: number; losses: number; timeouts: number; open: number; netPnl: number }> {
  const m = new Map<string, { n: number; wins: number; losses: number; timeouts: number; open: number; netPnl: number }>()
  for (const t of trades) {
    const s = m.get(t.coin) ?? { n: 0, wins: 0, losses: 0, timeouts: 0, open: 0, netPnl: 0 }
    s.n++
    if (t.status === "won")          s.wins++
    else if (t.status === "lost")    s.losses++
    else if (t.status === "timed_out") s.timeouts++
    else if (t.status === "open")    s.open++
    s.netPnl += t.netPnl
    m.set(t.coin, s)
  }
  return m
}

// ── Console table ──────────────────────────────────────────────────────────────
console.log()
console.log("═".repeat(100))
console.log("  FULL DATA COMPARISON  —  18 coins, portfolio max 3 open, A0 / A / F")
console.log("  3% stop · 7-day max · 0.05%/side fee")
console.log("═".repeat(100))
console.log(`  ${"Var".padEnd(3)}  ${"Glitches".padEnd(18)}  ${"#".padEnd(4)}  ${"W/L/T/O".padEnd(16)}  ${"Net P&L".padEnd(10)}  ${"Max DD".padEnd(9)}  ${"Skipped"}`)
console.log("  " + "─".repeat(96))
for (const { variant, glitch, result } of runs) {
  const t     = result.closedTrades
  const n     = t.length
  const wins  = t.filter(x => x.status === "won").length
  const loss  = t.filter(x => x.status === "lost").length
  const tout  = t.filter(x => x.status === "timed_out").length
  const open  = t.filter(x => x.status === "open").length
  const pnl   = t.reduce((s, x) => s + x.netPnl, 0)
  const wlto  = `${wins}W/${loss}L/${tout}TO/${open}O`
  console.log(`  ${variant.padEnd(3)}  ${glitch.padEnd(18)}  ${String(n).padEnd(4)}  ${wlto.padEnd(18)}  ${fp(pnl).padEnd(10)}  $${result.maxDrawdown.toFixed(2).padEnd(8)}  ${result.skipped}`)
}

// ── Per-coin breakdown ─────────────────────────────────────────────────────────
console.log()
console.log("  Per-coin Net P&L (portfolio runs)")
const runsByLabel = new Map<string, RunResult>()
for (const r of runs) runsByLabel.set(`${r.variant}/${r.glitch}`, r)

const slugOrder = rawCoins.map(c => c.slug)
const hdr = "  Coin".padEnd(14) +
  VARIANTS.flatMap(v =>
    GLITCH_SETTINGS.map(g => `${v.label}(${g.skip ? "ex" : "in"})`.padEnd(12))
  ).join("")
console.log(hdr)
console.log("  " + "─".repeat(hdr.length - 2))

for (const slug of slugOrder) {
  let row = ("  " + slug).padEnd(14)
  for (const v of VARIANTS) {
    for (const g of GLITCH_SETTINGS) {
      const key = `${v.label}/${g.label}`
      const rr  = runsByLabel.get(key)!
      const st  = perCoinStats(rr.result.closedTrades).get(slug)
      row += (st ? fp(st.netPnl) : "—").padEnd(12)
    }
  }
  console.log(row)
}
console.log()

// ── Markdown ───────────────────────────────────────────────────────────────────
const md: string[] = []
md.push("# Full Data Comparison")
md.push("")
md.push("18 coins · portfolio max 3 open positions · hour by hour · exits before buys.")
md.push("3% stop-loss · 7-day max hold · 0.05%/side fee · source check relaxed (single-source echoed).")
md.push("")
md.push("Coin set: " + rawCoins.map(c => c.slug).join(", "))
md.push("")
md.push("## Glitch candles detected")
md.push("")
md.push("Glitch = intra-hour low >5% below peg AND close recovers above that threshold within 3 hours.")
md.push("")
md.push("| Coin | Glitch candles |")
md.push("| ---- | -------------- |")
for (const { slug, glitchTs } of coinsWithGlitch) {
  if (glitchTs.size > 0)
    md.push(`| ${slug} | ${glitchTs.size} |`)
}
if (totalGlitches === 0) md.push("| *(none)* | — |")
md.push(`| **Total** | **${totalGlitches}** |`)
md.push("")
md.push("## Portfolio summary")
md.push("")
md.push("| Variant | Glitches | Trades | W/L/T/O | Net P&L | Max Drawdown | Skipped |")
md.push("| ------- | -------- | ------ | ------- | ------- | ------------ | ------- |")
for (const { variant, glitch, result } of runs) {
  const t    = result.closedTrades
  const n    = t.length
  const wins = t.filter(x => x.status === "won").length
  const loss = t.filter(x => x.status === "lost").length
  const tout = t.filter(x => x.status === "timed_out").length
  const open = t.filter(x => x.status === "open").length
  const pnl  = t.reduce((s, x) => s + x.netPnl, 0)
  md.push(`| **${variant}** | ${glitch} | ${n} | ${wins}W/${loss}L/${tout}TO/${open}O | **${fp(pnl)}** | $${result.maxDrawdown.toFixed(2)} | ${result.skipped} |`)
}
md.push("")
md.push("## Per-coin P&L breakdown")
md.push("")

for (const g of GLITCH_SETTINGS) {
  md.push(`### ${g.label.charAt(0).toUpperCase() + g.label.slice(1)}`)
  md.push("")
  md.push("| Coin | A0 # | A0 W/L/TO | **A0 P&L** | A # | A W/L/TO | **A P&L** | F # | F W/L/TO | **F P&L** |")
  md.push("| ---- | ---- | --------- | ---------- | --- | -------- | --------- | --- | -------- | --------- |")

  let totN: number[] = [0, 0, 0], totW: number[] = [0, 0, 0], totL: number[] = [0, 0, 0], totTO: number[] = [0, 0, 0], totPnl: number[] = [0, 0, 0]

  for (const slug of slugOrder) {
    const cells: string[] = []
    VARIANTS.forEach((v, vi) => {
      const key = `${v.label}/${g.label}`
      const st  = perCoinStats(runsByLabel.get(key)!.result.closedTrades).get(slug)
      if (st) {
        cells.push(String(st.n), `${st.wins}W/${st.losses}L/${st.timeouts}TO`, `**${fp(st.netPnl)}**`)
        totN[vi]!   += st.n
        totW[vi]!   += st.wins
        totL[vi]!   += st.losses
        totTO[vi]!  += st.timeouts
        totPnl[vi]! += st.netPnl
      } else {
        cells.push("—", "—", "—")
      }
    })
    md.push(`| ${slug} | ${cells.join(" | ")} |`)
  }
  // Totals row
  const totCells: string[] = []
  VARIANTS.forEach((_, vi) => {
    totCells.push(`**${totN[vi]}**`, `**${totW[vi]}W/${totL[vi]}L/${totTO[vi]}TO**`, `**${fp(totPnl[vi]!)}**`)
  })
  md.push(`| **TOTAL** | ${totCells.join(" | ")} |`)
  md.push("")
}

const mdPath = new URL("full-data-comparison.md", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1")
writeFileSync(mdPath, md.join("\n"))
console.log("Results written to replay/full-data-comparison.md")
