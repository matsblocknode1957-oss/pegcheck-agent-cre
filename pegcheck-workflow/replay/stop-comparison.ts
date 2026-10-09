// Stop-loss comparison across two depeg events and five stop settings.
//
// Events
//   USDC SVB Crash   — March 2023   Bitstamp USDCUSD + Bitfinex USDCUSD
//   UST Terra Crash  — May 2022     Binance USTUSDT (primary) + Bitfinex TerraUSD if found
//
// Sources are tested at runtime; the script reports which ones responded.
// If only one UST source is available the 2-source buy rule is relaxed
// ("single-source what-if mode") — the lone price is echoed as a second feed
// so sourcesAgree can fire. This is labelled clearly in the output.
//
// Stop settings (applied to both events)
//   1.  3% stop,  7-day timeout   (live-bot default)
//   2.  5% stop,  7-day timeout
//   3. 10% stop,  7-day timeout
//   4. no stop,   7-day timeout
//   5. hold forever — no stop, no timeout, mark-to-market at last candle

import { runReplay } from "./replay-core.js"
import type { Candle } from "./replay-core.js"
import { writeFileSync, mkdirSync } from "fs"

const toIso = (ms: number) => new Date(ms).toISOString()
const med2  = (a: number, b: number | null) => b !== null ? (a + b) / 2 : a

// ── Stop settings ─────────────────────────────────────────────────────────────

type StopSetting = { label: string; stopPct: number | null; maxDays: number | null }

const STOP_SETTINGS: StopSetting[] = [
  { label: "3% stop, 7d timeout",  stopPct: 0.03, maxDays: 7 },
  { label: "5% stop, 7d timeout",  stopPct: 0.05, maxDays: 7 },
  { label: "10% stop, 7d timeout", stopPct: 0.10, maxDays: 7 },
  { label: "no stop, 7d timeout",  stopPct: null, maxDays: 7 },
  { label: "hold forever",         stopPct: null, maxDays: null },
]

// ── USDC — Bitstamp + Bitfinex (March 2023) ───────────────────────────────────

console.log("═".repeat(72))
console.log("  STOP-LOSS COMPARISON  —  USDC Mar 2023 + UST May 2022")
console.log("═".repeat(72))
console.log("\n── USDC SVB Crash  (2023-03-08 → +10 days) ─────────────────────────────")

console.log("  Fetching Bitstamp USDCUSD 1h…")
const bsResp = await fetch(
  "https://www.bitstamp.net/api/v2/ohlc/usdcusd/?step=3600&start=1678233600&limit=240",
)
if (!bsResp.ok) throw new Error(`Bitstamp HTTP ${bsResp.status}`)
const bsBody = await bsResp.json() as {
  data: { ohlc: Array<{ timestamp: string; high: string; low: string; close: string }> }
}
const bsRaw = bsBody.data.ohlc

console.log("  Fetching Bitfinex USDCUSD 1h…")
const bfxUsdcResp = await fetch(
  "https://api-pub.bitfinex.com/v2/candles/trade:1h:tUDCUSD/hist" +
  "?start=1678233600000&end=1679097600000&limit=1000&sort=1",
)
type BfxCandle = [number, number, number, number, number, number]
const bfxUsdcRaw = bfxUsdcResp.ok
  ? (await bfxUsdcResp.json() as BfxCandle[])
  : []
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

const usdcSingleSrc = usdcCandles.filter(c => Object.keys(c.pricesBySource).length < 2).length
const usdcTwoSrc    = usdcCandles.length - usdcSingleSrc
console.log(`  ${usdcCandles.length} candles  (${usdcTwoSrc} two-source, ${usdcSingleSrc} single-source)`)

// ── UST — Binance + Bitfinex candidates (May 2022) ────────────────────────────

console.log("\n── UST Terra Collapse  (2022-05-05 → 2022-05-20) ───────────────────────")
console.log("  Testing data sources…")

const UST_START = 1651708800000   // 2022-05-05 00:00 UTC
const UST_END   = 1653004800000   // 2022-05-20 00:00 UTC

// Binance kline format: [openTime, open, high, low, close, ...]
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
    } else {
      console.log(`  ✗ Binance USTUSDT: only ${raw.length} candles returned — skipping`)
    }
  } else {
    console.log(`  ✗ Binance USTUSDT: HTTP ${r.status}`)
  }
} catch (e) {
  console.log(`  ✗ Binance USTUSDT: ${e}`)
}

// Bitfinex note: on Bitfinex "UST" = Tether (tUSTUSD / tUST:USD).
// TerraUSD was listed under a different symbol — try known candidates.
let bitfinexUstByTs: Map<number, { close: number; high: number; low: number }> | null = null
let bitfinexUstTicker = ""
const bfxUstCandidates = [
  { sym: "tTERRAUST:USD", note: "TerraUSD long-form symbol" },
  { sym: "tUST:USD",       note: "short alias — CAUTION: may be Tether on Bitfinex" },
]
for (const { sym, note } of bfxUstCandidates) {
  try {
    const r = await fetch(
      `https://api-pub.bitfinex.com/v2/candles/trade:1h:${sym}/hist` +
      `?start=${UST_START}&end=${UST_END}&limit=1000&sort=1`,
    )
    if (r.ok) {
      const raw = await r.json() as BfxCandle[] | { error?: string }
      if (Array.isArray(raw) && raw.length > 5) {
        const first = raw[0]![2]
        const last  = raw[raw.length - 1]![2]
        // Sanity: TerraUSD should start near $1 and crash toward $0
        const looksCrashed = first > 0.5 && last < 0.5
        const verdict = looksCrashed ? "← looks like the crash ✓" : "← does NOT look like UST crash"
        console.log(`  ✓ Bitfinex ${sym} (${note}): ${raw.length} candles  first=$${first.toFixed(4)}  last=$${last.toFixed(4)}  ${verdict}`)
        if (bitfinexUstByTs === null && looksCrashed) {
          bitfinexUstByTs  = new Map(raw.map(c => [c[0], { close: c[2], high: c[3], low: c[4] }]))
          bitfinexUstTicker = sym
        }
      } else if (Array.isArray(raw)) {
        console.log(`  ✗ Bitfinex ${sym} (${note}): only ${raw.length} candles`)
      } else {
        console.log(`  ✗ Bitfinex ${sym} (${note}): API error response`)
      }
    } else {
      console.log(`  ✗ Bitfinex ${sym} (${note}): HTTP ${r.status}`)
    }
  } catch (e) {
    console.log(`  ✗ Bitfinex ${sym} (${note}): ${e}`)
  }
}

// Build UST candles
let ustCandles:           Candle[] | null = null
let ustRelaxSourceCheck = false
let ustSourceLabel      = ""

if (binanceUst !== null && bitfinexUstByTs !== null) {
  ustCandles = binanceUst.map(k => {
    const ts    = k[0]
    const bfx   = bitfinexUstByTs!.get(ts) ?? null
    const close = +k[4]
    const high  = +k[2]
    const low   = +k[3]
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
  ustSourceLabel = `Binance USTUSDT + Bitfinex ${bitfinexUstTicker} (${two}/${ustCandles.length} hours dual-source)`
  console.log(`  → Dual-source mode: ${two}/${ustCandles.length} hours have both feeds`)
} else if (binanceUst !== null) {
  ustCandles = binanceUst.map(k => ({
    ts:             k[0],
    median:         +k[4],
    low_median:     +k[3],
    high_median:    +k[2],
    pricesBySource: { binance: +k[4] },
    historyPrice:   +k[4],
  }))
  ustRelaxSourceCheck = true
  ustSourceLabel = "Binance USTUSDT only — SINGLE-SOURCE WHAT-IF MODE (2-source buy rule relaxed)"
  console.log("  → Single-source what-if mode: only Binance available.")
  console.log("    The lone Binance price is echoed as a second feed so sourcesAgree can fire.")
  console.log("    This shows what would have happened with a confirming second source —")
  console.log("    it is NOT how the live bot behaves with a single price feed.")
} else {
  console.log("  ✗ No UST data sources returned usable data — UST event will be skipped")
}

if (ustCandles !== null) {
  console.log(`  ${ustCandles.length} candles  ${toIso(ustCandles[0]!.ts).slice(0,10)} → ${toIso(ustCandles[ustCandles.length-1]!.ts).slice(0,10)}`)
}

// ── Run all combinations ──────────────────────────────────────────────────────

type TradeRow = {
  event:      string
  stop:       string
  tradeNum:   number
  entryTime:  string
  entryPrice: number
  exitTime:   string
  exitPrice:  number
  result:     string
  pnlUsd:     number
}

type RunSummary = {
  event:    string
  stop:     string
  trades:   TradeRow[]
  totalPnl: number
}

const runs: RunSummary[] = []

function runEvent(
  eventLabel:       string,
  candles:          Candle[],
  peg:              number,
  coin:             string,
  relaxSourceCheck: boolean,
) {
  for (const s of STOP_SETTINGS) {
    const res = runReplay({ candles, stopPct: s.stopPct, maxDays: s.maxDays, peg, coin, relaxSourceCheck })
    const trades: TradeRow[] = res.trades.map((t, idx) => ({
      event:      eventLabel,
      stop:       s.label,
      tradeNum:   idx + 1,
      entryTime:  t.entryTime.slice(0, 16).replace("T", " "),
      entryPrice: t.entryPrice,
      exitTime:   t.exitTime.slice(0, 16).replace("T", " "),
      exitPrice:  t.exitPrice,
      result:     t.status,
      pnlUsd:     t.pnlUsd,
    }))
    runs.push({ event: eventLabel, stop: s.label, trades, totalPnl: res.totalPnl })
  }
}

console.log("\n── Running comparisons… ─────────────────────────────────────────────────")
runEvent("USDC SVB Mar-2023",  usdcCandles, 1.0, "USDC", false)
if (ustCandles !== null) {
  const label = ustRelaxSourceCheck ? "UST May-2022 (what-if)" : "UST May-2022"
  runEvent(label, ustCandles, 1.0, "UST", ustRelaxSourceCheck)
}

// ── Print terminal table ──────────────────────────────────────────────────────

const fmtP = (n: number) => {
  const sign = n >= 0 ? "+" : "-"
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

// columns: Event, Stop Setting, #, Entry Time, Entry$, Exit Time, Exit$, Result, P&L
const CW = [22, 22, 2, 18, 9, 18, 9, 12, 10]
const H  = ["Event", "Stop Setting", "#", "Entry Time", "Entry $", "Exit Time", "Exit $", "Result", "P&L / $1k"]

const padR = (s: string, n: number) => s.padEnd(n)
const padL = (s: string, n: number) => s.padStart(n)
const sep  = CW.map(w => "─".repeat(w)).join("─┼─")
const hdr  = CW.map((w, i) => padR(H[i]!, w)).join(" │ ")

console.log("\n" + "═".repeat(sep.length + 4))
console.log("  COMPARISON TABLE  (all trades)")
console.log("═".repeat(sep.length + 4))
console.log("  " + hdr)
console.log("  " + sep)

let lastEvent = ""
let lastStop  = ""
for (const run of runs) {
  if (run.event !== lastEvent && lastEvent !== "") console.log("  " + sep)
  lastEvent = run.event
  lastStop  = run.stop

  if (run.trades.length === 0) {
    console.log("  " + [
      padR(run.event, CW[0]!),
      padR(run.stop,  CW[1]!),
      padL("—",       CW[2]!),
      padR("—",       CW[3]!),
      padL("—",       CW[4]!),
      padR("—",       CW[5]!),
      padL("—",       CW[6]!),
      padR("no signal", CW[7]!),
      padL("$0.00",   CW[8]!),
    ].join(" │ "))
  } else {
    for (const t of run.trades) {
      console.log("  " + [
        padR(t.tradeNum === 1 ? run.event : "", CW[0]!),
        padR(t.tradeNum === 1 ? run.stop  : "", CW[1]!),
        padL(String(t.tradeNum),                CW[2]!),
        padR(t.entryTime,                       CW[3]!),
        padL(`$${t.entryPrice.toFixed(4)}`,     CW[4]!),
        padR(t.exitTime,                        CW[5]!),
        padL(`$${t.exitPrice.toFixed(4)}`,      CW[6]!),
        padR(t.result,                          CW[7]!),
        padL(fmtP(t.pnlUsd),                   CW[8]!),
      ].join(" │ "))
    }
    if (run.trades.length > 1) {
      console.log("  " + [
        padR("", CW[0]!),
        padR("", CW[1]!),
        padL("",              CW[2]!),
        padR("",              CW[3]!),
        padL("",              CW[4]!),
        padR("TOTAL",         CW[5]!),
        padL("",              CW[6]!),
        padR("",              CW[7]!),
        padL(fmtP(run.totalPnl), CW[8]!),
      ].join(" │ "))
    } else {
      // Single trade — show total inline as suffix note; already visible in P&L column
    }
  }
}
console.log("═".repeat(sep.length + 4))

// ── Write stop-comparison.md ──────────────────────────────────────────────────

const md: string[] = [
  "# Stop-Loss Comparison",
  "",
  `_Generated ${new Date().toISOString().slice(0, 10)}_`,
  "",
  "## Events",
  "",
  "**USDC SVB Crash — March 2023**  ",
  `Sources: Bitstamp USDCUSD + Bitfinex USDCUSD  `,
  `Window: ${toIso(usdcCandles[0]!.ts).slice(0,10)} → ${toIso(usdcCandles[usdcCandles.length-1]!.ts).slice(0,10)}  `,
  `(${usdcCandles.length} hourly candles — ${usdcTwoSrc} two-source, ${usdcSingleSrc} single-source)`,
  "",
]

if (ustCandles !== null) {
  md.push("**UST Terra Collapse — May 2022**  ")
  md.push(`Sources: ${ustSourceLabel}  `)
  md.push(`Window: ${toIso(ustCandles[0]!.ts).slice(0,10)} → ${toIso(ustCandles[ustCandles.length-1]!.ts).slice(0,10)}  `)
  md.push(`(${ustCandles.length} hourly candles)`)
  if (ustRelaxSourceCheck) {
    md.push("")
    md.push("> **Single-source what-if mode** — only Binance USTUSDT responded with usable data.")
    md.push("> The normal two-source buy rule requires two agreeing price feeds; Bitfinex does not list")
    md.push("> TerraUSD under any detected symbol (note: `tUST:USD` on Bitfinex is Tether, not TerraUSD).")
    md.push("> For this event the lone Binance price is echoed as a second feed so the algorithm can fire.")
    md.push("> Results show what _would_ have happened with a confirming second source.")
    md.push("> The live bot with a single feed would have issued **no buy** for every row below.")
  }
  md.push("")
}

md.push("## Results", "")

// One sub-section per run; markdown table per event block
let mdLastEvent = ""
for (const run of runs) {
  if (run.event !== mdLastEvent) {
    if (mdLastEvent !== "") md.push("")
    md.push(`### ${run.event}`, "")
    md.push("| Stop Setting | # | Entry Time | Entry $ | Exit Time | Exit $ | Result | P&L / $1k |")
    md.push("|-------------|---|-----------|---------|-----------|--------|--------|----------|")
    mdLastEvent = run.event
  }

  if (run.trades.length === 0) {
    md.push(`| ${run.stop} | — | — | — | — | — | no signal | $0.00 |`)
  } else {
    for (const t of run.trades) {
      const stopCol = t.tradeNum === 1 ? run.stop : ""
      md.push(`| ${stopCol} | ${t.tradeNum} | ${t.entryTime} | $${t.entryPrice.toFixed(4)} | ${t.exitTime} | $${t.exitPrice.toFixed(4)} | ${t.result} | ${fmtP(t.pnlUsd)} |`)
    }
    if (run.trades.length > 1) {
      md.push(`| | | | | | **TOTAL** | | **${fmtP(run.totalPnl)}** |`)
    }
  }
}

md.push(
  "",
  "## Key",
  "",
  "| Result | Meaning |",
  "|--------|---------|",
  "| **won** | Price recovered to within 0.2% of peg before stop or timeout |",
  "| **lost** | Stop-loss hit — price fell to entry × (1 − stop%) |",
  "| **timed_out** | Neither stop nor take-profit hit within the day limit; exited at median close |",
  "| **open** | Hold-forever: no stop, no timeout; P&L is mark-to-market at last candle in window |",
  "| **no signal** | Bot never issued a buy — price either skipped the dip zone, was falling too fast, crossed into deep depeg (>5%), or sources disagreed |",
  "",
  "**Exit method**: stop-loss is tested against hourly `low_median`; take-profit against `high_median`.",
  "If both thresholds are crossed in the same candle, stop wins (conservative / worst-case).",
  "Exit prices are pinned to the threshold, not the raw low/high.",
  "",
  "**Position size**: $1,000 (`MAX_POSITION_USD` from `config.ts` — not changed for replay).",
)

const mdPath = new URL("stop-comparison.md", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
mkdirSync(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { recursive: true })
writeFileSync(mdPath, md.join("\n") + "\n")
console.log(`\nWrote → ${mdPath}`)
