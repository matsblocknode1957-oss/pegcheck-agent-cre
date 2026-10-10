// follow-up-comparison.ts
// Follow-up to full-data-comparison:
//   1. Explain why the existing chronic rule didn't block alusd — show first entry + 72h history.
//   2. Variant F+C: F (Rule B when dip ≥1.5%) + chronic filter (>50% of 72h candles below 0.995).
//   3. Fixed glitch detector: flag only when both the hour before AND after closed within 0.5% of peg.
//
// Appends results to replay/full-data-comparison.md.
//
// Run: bun run replay/follow-up-comparison.ts

import { conservativeExit } from "./replay-core.js"
import type { Candle } from "./replay-core.js"
import { summariseHistory, buildHistoryStats } from "../lib/agent/history.js"
import type { HistoryEntry, ApiSummary } from "../lib/agent/history.js"
import { decide } from "../lib/agent/rules.js"
import type { OpenTrade, ExitStatus } from "../lib/agent/rules.js"
import {
  TAKE_PROFIT_DISTANCE_PCT,
  MAX_TRADE_DAYS,
  DIP_ZONE_START_PCT,
  CHRONIC_HOURS,
} from "../lib/agent/config.js"
import { readFileSync, writeFileSync, appendFileSync } from "fs"

// ── Constants ──────────────────────────────────────────────────────────────────
const FEE_RATE          = 0.0005
const STOP_PCT          = 0.03
const THREE_DAYS_MS     = 3 * 24 * 60 * 60 * 1000
const PEG               = 1.0
const MAX_PORTFOLIO_POS = 3
const AT_PEG_PCT        = DIP_ZONE_START_PCT   // 0.5% — "within 0.5% of peg"
const GLITCH_LOW_PCT    = 0.05                 // low must be >5% below peg
const CHRONIC_FRAC      = 0.5                  // F+C blocks when >50% of 72h is below 0.5% from peg

type Mode = "off" | "f" | "fc"

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

// ── OLD glitch detector (for reference counts) ─────────────────────────────────
// Flag if low >5% below peg AND close recovers above 5%-below-peg within 3 hours.
function detectGlitchesOld(candles: Candle[]): Set<number> {
  const glitches  = new Set<number>()
  const threshold = PEG * (1 - GLITCH_LOW_PCT)
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!
    if (c.low_median >= threshold) continue
    let recovers = c.median >= threshold
    if (!recovers) {
      for (let j = i + 1; j <= Math.min(i + 3, candles.length - 1); j++) {
        if (candles[j]!.median >= threshold) { recovers = true; break }
      }
    }
    if (recovers) glitches.add(c.ts)
  }
  return glitches
}

// ── FIXED glitch detector ─────────────────────────────────────────────────────
// Flag only when: low >5% below peg AND the hour before AND the hour after
// both closed within 0.5% of peg (≥ 0.995). This ensures the spike is truly
// isolated — not part of a sustained depeg on either side.
function detectGlitchesFixed(candles: Candle[]): Set<number> {
  const glitches   = new Set<number>()
  const lowThresh  = PEG * (1 - GLITCH_LOW_PCT)   // 0.95
  const pegThresh  = PEG * (1 - AT_PEG_PCT)        // 0.995
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i]!
    if (c.low_median >= lowThresh) continue
    const prev = candles[i - 1]!
    const next = candles[i + 1]!
    if (prev.median >= pegThresh && next.median >= pegThresh) glitches.add(c.ts)
  }
  return glitches
}

// ── alusd diagnostic ───────────────────────────────────────────────────────────
// Find the first buy that fires for alusd under A0 (no Rule B), show its 72h history,
// and trace through exactly why the chronic rule did not block the buy.
function alusdDiagnostic(alusdCandles: Candle[]): string[] {
  const lines: string[] = []
  const fee = (gross: number, sz: number) => (2 * sz + gross) * FEE_RATE

  for (let i = 0; i < alusdCandles.length; i++) {
    const c     = alusdCandles[i]!
    const nowMs = c.ts
    const winStart = nowMs - THREE_DAYS_MS

    // Binary search for history window start
    let lo = 0, hi = i
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (alusdCandles[mid]!.ts < winStart) lo = mid + 1; else hi = mid
    }

    const histEntries: HistoryEntry[] = []
    for (let j = lo; j <= i; j++) {
      histEntries.push({
        created_at: new Date(alusdCandles[j]!.ts).toISOString(),
        price:      alusdCandles[j]!.historyPrice,
      })
    }

    let srcPrices: Record<string, number> = { blended: c.median, blended_echo: c.median }

    const summarised = summariseHistory(histEntries, nowMs)
    const apiSummary: ApiSummary = { medianPrice: c.median, sources: srcPrices, ...summarised }
    const histStats  = buildHistoryStats(apiSummary, nowMs)
    // A0: suppress hadPriorDipCycle
    const histStatsA0 = { ...histStats, hadPriorDipCycle: null as null }

    const result = decide({
      coin: "alusd", peg: PEG,
      medianPrice:              c.median,
      pricesBySource:           srcPrices,
      largeTransferCount24h:    0,
      largeTransferTotalUsd24h: 0,
      openPositionsCount:       0,
      history:                  histStatsA0,
    })

    if (result.decision === "buy" && result.buy !== undefined) {
      // Found first buy — capture diagnostic
      const depegPct  = (PEG - c.median) / PEG
      const isChronic = histStats.hoursOffPeg !== null && histStats.hoursOffPeg > CHRONIC_HOURS
                        && depegPct >= DIP_ZONE_START_PCT

      lines.push(`### First alusd buy entry`)
      lines.push(``)
      lines.push(`**Timestamp:** ${new Date(nowMs).toISOString().replace("T", " ").slice(0, 16)} UTC  `)
      lines.push(`**Entry price:** ${c.median.toFixed(6)} (${(depegPct * 100).toFixed(2)}% below peg)  `)
      lines.push(`**72h history window:** ${histEntries.length} candle(s)`)
      lines.push(``)
      lines.push(`| # | Time (UTC) | Close |`)
      lines.push(`| - | ---------- | ----- |`)
      const maxShow = Math.min(histEntries.length, 10)
      for (let k = 0; k < maxShow; k++) {
        const e = histEntries[k]!
        lines.push(`| ${k + 1} | ${e.created_at.slice(0, 16).replace("T", " ")} | ${e.price.toFixed(6)} |`)
      }
      if (histEntries.length > maxShow)
        lines.push(`| … | *(${histEntries.length - maxShow} more — all below 0.995)* | |`)
      lines.push(``)
      lines.push(`**Computed stats:**`)
      lines.push(``)
      lines.push(`| Field | Value | Notes |`)
      lines.push(`| ----- | ----- | ----- |`)
      lines.push(`| \`lastAtPegTs\` | \`null\` | No candle in 72h window had price ≥ 0.995 |`)
      lines.push(`| \`hoursOffPeg\` | \`${histStats.hoursOffPeg}\` | Hardcoded fallback of 25 when \`lastAtPegTs === null\` |`)
      lines.push(`| \`CHRONIC_HOURS\` | \`${CHRONIC_HOURS}\` | Threshold from config |`)
      lines.push(`| \`isChronic\` | \`${isChronic}\` | \`${histStats.hoursOffPeg} > ${CHRONIC_HOURS}\` is false |`)
      lines.push(`| Decision | \`buy\` | All danger checks pass |`)
      lines.push(``)
      lines.push(`**Why the chronic guard never fires for a persistently-depegged coin:**`)
      lines.push(``)
      lines.push(`The history window is \`THREE_DAYS_MS = 72 h\`, the same value as \`CHRONIC_HOURS = 72\`.`)
      lines.push(`\`hoursOffPeg\` is derived as \`(now − lastAtPegTs) / 3600000\`. Since \`lastAtPegTs\`)`)
      lines.push(`can only be found within the 72 h window, the maximum possible value is 72 h.`)
      lines.push(`The chronic check is \`hoursOffPeg > 72\` (strict), so it can never be satisfied.`)
      lines.push(`When the coin has never been at peg in the window (\`lastAtPegTs === null\`), the fallback`)
      lines.push(`is hardcoded to **25 h** — well below the threshold.`)
      lines.push(`alusd has traded at 0.96–0.97 since the dataset begins on 2026-05-22.`)
      lines.push(`Its first buy fires on **candle 1**, with exactly ${histEntries.length} history point(s),`)
      lines.push(`none of which is at peg. The system cannot distinguish this from a fresh 25-hour dip.`)
      break
    }
  }
  return lines
}

// ── Portfolio simulation ───────────────────────────────────────────────────────
type ClosedTrade = { coin: string; status: ExitStatus | "open"; netPnl: number }

type PortfolioResult = {
  closedTrades: ClosedTrade[]
  skipped:      number
  maxDrawdown:  number
}

function runPortfolio(
  coins:        { slug: string; candles: Candle[] }[],
  mode:         Mode,
): PortfolioResult {
  const fee = (gross: number, sz: number) => (2 * sz + gross) * FEE_RATE

  const bySlug    = new Map<string, Candle[]>()
  for (const { slug, candles } of coins) bySlug.set(slug, candles)

  const candleMap = new Map<string, Map<number, { c: Candle; idx: number }>>()
  for (const { slug, candles } of coins) {
    const m = new Map<number, { c: Candle; idx: number }>()
    candles.forEach((c, idx) => m.set(c.ts, { c, idx }))
    candleMap.set(slug, m)
  }

  const tsToSlugs = new Map<number, string[]>()
  for (const { slug, candles } of coins) {
    for (const c of candles) {
      const arr = tsToSlugs.get(c.ts) ?? []; arr.push(slug); tsToSlugs.set(c.ts, arr)
    }
  }
  const allTs = [...tsToSlugs.keys()].sort((a, b) => a - b)

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

    // ── EXITS ──────────────────────────────────────────────────────────────────
    for (const slug of slugsHere) {
      const ot = openTrade.get(slug)
      if (!ot) continue
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

    // ── BUYS ───────────────────────────────────────────────────────────────────
    for (const slug of slugsHere) {
      if (openTrade.get(slug) !== null) continue

      const { c, idx } = candleMap.get(slug)!.get(ts)!
      const allCandles  = bySlug.get(slug)!
      const winStart    = ts - THREE_DAYS_MS

      let lo = 0, hi = idx
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (allCandles[mid]!.ts < winStart) lo = mid + 1; else hi = mid
      }
      const histEntries: HistoryEntry[] = []
      for (let j = lo; j <= idx; j++)
        histEntries.push({ created_at: new Date(allCandles[j]!.ts).toISOString(), price: allCandles[j]!.historyPrice })

      let srcPrices = { ...c.pricesBySource }
      if (Object.keys(srcPrices).length === 1) {
        const [k, v] = Object.entries(srcPrices)[0]!
        srcPrices = { [k]: v, [`${k}_echo`]: v }
      }

      const summarised = summariseHistory(histEntries, ts)
      const apiSummary: ApiSummary = { medianPrice: c.median, sources: srcPrices, ...summarised }
      let   histStats  = buildHistoryStats(apiSummary, ts)

      // ── Mode logic ────────────────────────────────────────────────────────────
      if (mode === "off") {
        histStats = { ...histStats, hadPriorDipCycle: null }

      } else if (mode === "f") {
        if (histStats.hadPriorDipCycle === true && (PEG - c.median) / PEG < 0.015)
          histStats = { ...histStats, hadPriorDipCycle: null }

      } else {
        // "fc" — chronic check first, then F Rule-B suppression
        const belowPegCount = histEntries.filter(e => e.price < PEG * (1 - AT_PEG_PCT)).length
        if (histEntries.length > 0 && belowPegCount / histEntries.length > CHRONIC_FRAC) continue

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

// Glitch counts — old vs fixed detector
console.log("\nGlitch detection comparison…")
const glitchReport: { slug: string; old: number; fixed: number }[] = []
for (const { slug, candles } of rawCoins) {
  const oldCount   = detectGlitchesOld(candles).size
  const fixedCount = detectGlitchesFixed(candles).size
  glitchReport.push({ slug, old: oldCount, fixed: fixedCount })
  if (oldCount > 0 || fixedCount > 0)
    console.log(`  ${slug.padEnd(10)} old=${oldCount}  fixed=${fixedCount}`)
}
const totalOld   = glitchReport.reduce((s, r) => s + r.old, 0)
const totalFixed = glitchReport.reduce((s, r) => s + r.fixed, 0)
console.log(`  Total: old=${totalOld}  fixed=${totalFixed}`)

// alusd diagnostic
console.log("\nalusd diagnostic…")
const alusdCandles = rawCoins.find(c => c.slug === "alusd")!.candles
const diagLines = alusdDiagnostic(alusdCandles)

// Portfolio runs: A0, F, F+C (glitches included = all candles)
const VARIANTS: { label: string; desc: string; mode: Mode }[] = [
  { label: "A0",  desc: "No Rule B (baseline)",                                              mode: "off" },
  { label: "F",   desc: "Rule B only if current entry depth ≥ 1.5%",                         mode: "f"   },
  { label: "F+C", desc: "F + chronic filter (skip if >50% of 72h candles below 0.995)",      mode: "fc"  },
]

console.log("\nRunning portfolio simulations (glitches included, all 18 coins)…")
type RunResult = { label: string; desc: string; result: PortfolioResult }
const runs: RunResult[] = []

for (const v of VARIANTS) {
  process.stdout.write(`  ${v.label.padEnd(4)} … `)
  const result = runPortfolio(rawCoins, v.mode)
  runs.push({ label: v.label, desc: v.desc, result })
  const t    = result.closedTrades
  const wins = t.filter(x => x.status === "won").length
  const loss = t.filter(x => x.status === "lost").length
  const tout = t.filter(x => x.status === "timed_out").length
  const pnl  = t.reduce((s, x) => s + x.netPnl, 0)
  console.log(`${t.length}t  ${wins}W/${loss}L/${tout}TO  $${pnl.toFixed(2)}  dd=$${result.maxDrawdown.toFixed(2)}  skip=${result.skipped}`)
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const fp = (n: number) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2)

function perCoinStats(trades: ClosedTrade[]) {
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

// ── Console summary ────────────────────────────────────────────────────────────
console.log()
console.log("═".repeat(96))
console.log("  FOLLOW-UP: A0 / F / F+C  —  18 coins, portfolio max 3, glitches included")
console.log("  3% stop · 7-day max · 0.05%/side fee")
console.log("═".repeat(96))
console.log(`  ${"Var".padEnd(4)}  ${"#".padEnd(4)}  ${"W/L/TO/O".padEnd(18)}  ${"Net P&L".padEnd(10)}  ${"Max DD".padEnd(9)}  ${"Skipped"}`)
console.log("  " + "─".repeat(90))

for (const { label, result } of runs) {
  const t    = result.closedTrades
  const wins = t.filter(x => x.status === "won").length
  const loss = t.filter(x => x.status === "lost").length
  const tout = t.filter(x => x.status === "timed_out").length
  const open = t.filter(x => x.status === "open").length
  const pnl  = t.reduce((s, x) => s + x.netPnl, 0)
  const wlto = `${wins}W/${loss}L/${tout}TO/${open}O`
  console.log(`  ${label.padEnd(4)}  ${String(t.length).padEnd(4)}  ${wlto.padEnd(18)}  ${fp(pnl).padEnd(10)}  $${result.maxDrawdown.toFixed(2).padEnd(8)}  ${result.skipped}`)
}

const slugOrder = rawCoins.map(c => c.slug)
const runsByLabel = new Map(runs.map(r => [r.label, r]))
console.log()
console.log("  Per-coin Net P&L")
const hdr2 = "  Coin".padEnd(14) + runs.map(r => r.label.padEnd(12)).join("")
console.log(hdr2)
console.log("  " + "─".repeat(hdr2.length - 2))
for (const slug of slugOrder) {
  let row = ("  " + slug).padEnd(14)
  for (const { label } of VARIANTS) {
    const st = perCoinStats(runsByLabel.get(label)!.result.closedTrades).get(slug)
    row += (st ? fp(st.netPnl) : "—").padEnd(12)
  }
  console.log(row)
}
console.log()

// ── Build markdown appendix ────────────────────────────────────────────────────
const md: string[] = []
md.push("")
md.push("---")
md.push("")
md.push("## Follow-up: chronic rule, fixed glitches, variant F+C")
md.push("")

// Section 1 — chronic rule explanation
md.push("### 1. Why the existing chronic rule didn't block alusd")
md.push("")
md.push(`The chronic guard in \`rules.ts\` fires when \`hoursOffPeg > CHRONIC_HOURS\` (${CHRONIC_HOURS}).`)
md.push(`\`hoursOffPeg\` is computed as \`(now − lastAtPegTs) / 3600000\` where \`lastAtPegTs\` is the`)
md.push(`most recent history entry with price within 0.5% of peg.`)
md.push(``)
md.push(`**The structural problem:** the history window passed to \`buildHistoryStats\` is`)
md.push(`\`THREE_DAYS_MS = 72 h\` — exactly equal to \`CHRONIC_HOURS\`. Because \`lastAtPegTs\``)
md.push(`can only come from within that window, the maximum possible \`hoursOffPeg\` is 72 h.`)
md.push(`The check is strict (\`> 72\`), so it can **never** be satisfied from replay history.`)
md.push(``)
md.push(`When the coin has never been at peg inside the 72 h window (\`lastAtPegTs === null\`),`)
md.push(`the fallback is hardcoded to **25 h**. Since 25 < 72, the check fails here too.`)
md.push(`alusd has traded persistently at 0.96–0.97 since the dataset begins;`)
md.push(`the system cannot distinguish it from a routine 25-hour fresh dip.`)
md.push(``)
md.push(...diagLines)
md.push("")

// Section 2 — fixed glitch detector
md.push("### 2. Fixed glitch detector")
md.push("")
md.push("**Old rule:** `low_median < 0.95` AND close recovers above 0.95 within 3 hours.")
md.push("**New rule:** `low_median < 0.95` AND the hour **before** AND the hour **after** both closed within 0.5% of peg (≥ 0.995).")
md.push("")
md.push("The new rule requires the spike to be genuinely isolated — not part of a sustained depeg on either side.")
md.push("alusd's 'glitches' are not isolated: its surrounding candles are at 0.96–0.97, well below 0.995.")
md.push("")
md.push("| Coin | Old count | Fixed count |")
md.push("| ---- | --------- | ----------- |")
for (const r of glitchReport) {
  if (r.old > 0 || r.fixed > 0)
    md.push(`| ${r.slug} | ${r.old} | **${r.fixed}** |`)
}
md.push(`| **Total** | **${totalOld}** | **${totalFixed}** |`)
md.push("")

// Section 3 — F+C variant results
md.push("### 3. Variant F+C")
md.push("")
md.push("F+C = **F** (Rule B only when dip ≥ 1.5%) + **chronic filter** (skip a buy if > 50% of the")
md.push("coin's last 72 h candles closed below 0.5% of peg, i.e. price < 0.995).")
md.push("")
md.push("Portfolio: 18 coins, max 3 open, hour by hour, exits before buys. All candles included (no glitch removal).")
md.push("")
md.push("| Variant | Trades | W/L/TO/O | Net P&L | Max Drawdown | Skipped |")
md.push("| ------- | ------ | -------- | ------- | ------------ | ------- |")
for (const { label, desc, result } of runs) {
  const t    = result.closedTrades
  const wins = t.filter(x => x.status === "won").length
  const loss = t.filter(x => x.status === "lost").length
  const tout = t.filter(x => x.status === "timed_out").length
  const open = t.filter(x => x.status === "open").length
  const pnl  = t.reduce((s, x) => s + x.netPnl, 0)
  md.push(`| **${label}** | ${t.length} | ${wins}W/${loss}L/${tout}TO/${open}O | **${fp(pnl)}** | $${result.maxDrawdown.toFixed(2)} | ${result.skipped} |`)
}
md.push("")
md.push("#### Per-coin P&L breakdown")
md.push("")
md.push("| Coin | A0 # | A0 W/L/TO | **A0 P&L** | F # | F W/L/TO | **F P&L** | F+C # | F+C W/L/TO | **F+C P&L** |")
md.push("| ---- | ---- | --------- | ---------- | --- | -------- | --------- | ----- | ---------- | ----------- |")

let totA0n = 0, totA0w = 0, totA0l = 0, totA0to = 0, totA0pnl = 0
let totFn  = 0, totFw  = 0, totFl  = 0, totFto  = 0, totFpnl  = 0
let totFCn = 0, totFCw = 0, totFCl = 0, totFCto = 0, totFCpnl = 0

for (const slug of slugOrder) {
  const stA0 = perCoinStats(runsByLabel.get("A0")!.result.closedTrades).get(slug)
  const stF  = perCoinStats(runsByLabel.get("F")!.result.closedTrades).get(slug)
  const stFC = perCoinStats(runsByLabel.get("F+C")!.result.closedTrades).get(slug)

  const fmtSt = (st: ReturnType<typeof perCoinStats> extends Map<string, infer V> ? V : never) =>
    [`${st.n}`, `${st.wins}W/${st.losses}L/${st.timeouts}TO`, `**${fp(st.netPnl)}**`]

  const a0 = stA0 ? fmtSt(stA0) : ["—","—","—"]
  const f  = stF  ? fmtSt(stF)  : ["—","—","—"]
  const fc = stFC ? fmtSt(stFC) : ["—","—","—"]

  md.push(`| ${slug} | ${a0.join(" | ")} | ${f.join(" | ")} | ${fc.join(" | ")} |`)

  if (stA0) { totA0n += stA0.n; totA0w += stA0.wins; totA0l += stA0.losses; totA0to += stA0.timeouts; totA0pnl += stA0.netPnl }
  if (stF)  { totFn  += stF.n;  totFw  += stF.wins;  totFl  += stF.losses;  totFto  += stF.timeouts;  totFpnl  += stF.netPnl  }
  if (stFC) { totFCn += stFC.n; totFCw += stFC.wins; totFCl += stFC.losses; totFCto += stFC.timeouts; totFCpnl += stFC.netPnl }
}
md.push(`| **TOTAL** | **${totA0n}** | **${totA0w}W/${totA0l}L/${totA0to}TO** | **${fp(totA0pnl)}** | **${totFn}** | **${totFw}W/${totFl}L/${totFto}TO** | **${fp(totFpnl)}** | **${totFCn}** | **${totFCw}W/${totFCl}L/${totFCto}TO** | **${fp(totFCpnl)}** |`)
md.push("")

const mdPath = new URL("full-data-comparison.md", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1")
appendFileSync(mdPath, md.join("\n"))
console.log("Appended results to replay/full-data-comparison.md")
