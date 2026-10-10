# PegCheck Agent – Chainlink CRE Workflow

A stablecoin practice-trading agent (pretend money only) that explains every decision.

---

## What it does each run

Triggered by a CRON schedule, the workflow runs four steps:

1. **Fetch PegCheck data** — calls `https://pegcheck.uk/api/prices` for the current USDC median price and per-source prices, then `https://pegcheck.uk/api/price-history?slug=usdc&days=1` for recent price history. The raw history is summarised on each CRE node (1-hour change, 24-hour change, bounce from low, time since last peg) to stay under the 25 KB consensus limit. Nodes must reach agreement via **identical** aggregation before the result proceeds.

2. **Read Chainlink on-chain** — calls `latestRoundData()` on the Chainlink USDC/USD feed (`0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6`) on Ethereum mainnet via an EVM read capability. The 8-decimal `int256` answer is decoded with viem.

3. **Cross-check** — compares the PegCheck median against the Chainlink on-chain price. A diff > 0.5% is flagged as a source-disagreement danger signal.

4. **Decide** — feeds all evidence into the rules engine (`lib/agent/rules.ts`), which scores danger (0–100) and opportunity (0–100) separately and outputs one of:
   - **BUY** — dip zone confirmed, sources agree, price bouncing or fresh, danger score below opportunity score
   - **WATCH** — interesting but not clear enough to enter
   - **AVOID** — deep depeg (> 5%), sources disagree, chronic off-peg (> 72 h), or still falling fast

   Every point added to either score comes with a plain-English reason. If a BUY is triggered, the agent also outputs entry price, take-profit, stop-loss, and position size (max $1,000 of a $10,000 pretend bankroll).

---

## Two sides of the same coin

**StableGuard** (sister project) monitors for depegs and defends against them — it is a guardian.

**PegCheck Agent** looks at the same signal from the other side: a stablecoin dipping below peg is a risk, but also a potential opportunity to buy cheap and sell when it recovers. Both projects share the same underlying price data; they just ask opposite questions about it.

---

## Running the simulation

**Prerequisites:** [CRE CLI](https://docs.chain.link/cre), [bun](https://bun.sh)

```bash
# from the repo root
bun install --cwd pegcheck-workflow   # first time only
cre workflow simulate pegcheck-workflow --target staging-settings
```

First create an empty `secrets.yaml` in the repo root (it is git-ignored; the simulation needs no real secrets).

The `workflow.yaml` in `pegcheck-workflow/` points the CLI at `main.ts`, `config.staging.json`, and the secrets file automatically.

**Real output (2026-10-06):**

```
[API] USDC median: 0.99994
[API] History entries: 769  oldest=2026-10-05T21:21:10Z  newest=2026-10-06T21:20:46Z  newestPrice=$0.9999335
[EVM] Chainlink USDC/USD on-chain: $0.99990411
━━━ PegCheck Agent Report ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USDC median price   (PegCheck) : $0.999940
USDC on-chain price (Chainlink): $0.999904
Prices agree within 0.5%       : true  (diff 0.0036%)
Decision                       : WATCH
Danger   score: 0/100
Opportunity score: 0/100
  [OPP]     No dip to buy (price is 0.01% from peg)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Illustrative example (not a real run)** — what the output looks like when a dip is detected:

```
Decision                       : BUY
Danger   score: 10/100
  [DANGER]  No price history to check
Opportunity score: 70/100
  [OPP]     Price is 1.20% below peg — in the dip zone 0.5%–5% (+38 pts)
  [OPP]     Sources agree: spread is 0.08% (under 1%)
  [OPP]     No $1M+ transfers in 24 h (+25 pts)
Buy params: entry=$0.988000  tp=$0.997996  sl=$0.958360  size=$1000
```

---

## SVB crash replay (March 2023)

A backtest script runs the exact same `decide()` and `checkExit()` rules over real hourly USDC prices from the Silicon Valley Bank collapse, hour by hour, with pretend money.

**How to run:**

```bash
cd pegcheck-workflow
bun replay          # fetches live historical data then writes replay/usdc-2023-03.csv
```

**Data sources:** Bitstamp USDCUSD and Bitfinex USDCUSD (both USD-quoted). Chainlink on-chain prices are not included — they require an archive RPC node. Kraken and Coinbase were tested and rejected (Kraken's OHLC API returns only recent candles; Coinbase's public endpoint returns 404).

**Exit method:** stop-loss is tested against the hourly candle low (median of both sources); take-profit is tested against the hourly high. If both thresholds are crossed in the same candle, the stop-loss is assumed to hit first (worst case). Exit prices are pinned to the threshold level, not the raw low or high.

**What the agent did:**

| Time (UTC) | Event |
|---|---|
| 11 Mar 03:00 | First AVOID — Bitfinex already at $0.960 while Bitstamp held $0.997; sources disagreed by 3.75%, danger +25 |
| 11 Mar 07:00 | Lowest point — median $0.869 (13.1% off peg), sources still split, danger 100/100 |
| 11 Mar 08:00–18:00 | AVOID throughout recovery attempt — deep depeg (>5%), sources periodically disagreed, still falling |
| 11 Mar 19:00 | **BUY at $0.950** — price back inside the 0.5%–5% dip zone, Bitstamp and Bitfinex within 0.92% of each other, 1-hour change turned positive, 10.7% above the day's low; danger 0/100, opportunity 100/100 |
| 13 Mar 16:00 | **Take-profit hit at $0.998** — hourly high crossed the $0.998 threshold; trade closed |
| **Result** | **+$50.05 on $1,000 pretend money** (5.0% in ~68 hours) |

One historical event, not proof of future results. The agent could easily have been stopped out if the low had dipped below $0.922 during the volatile March 12 consolidation; the closest call was $0.944 on March 12 07:00.

---

## Stop-loss comparison (USDC 2023 + UST 2022)

A second replay script runs both the SVB crash and the TerraUSD collapse across five stop-loss settings and shows every trade, not just the first.

**How to run:**

```bash
cd pegcheck-workflow
bun run replay/stop-comparison.ts   # fetches live historical data, prints table, writes replay/stop-comparison.md
```

Full results: [`pegcheck-workflow/replay/stop-comparison.md`](pegcheck-workflow/replay/stop-comparison.md)

**Data sources:**
- USDC — Bitstamp USDCUSD + Bitfinex USDCUSD (same as the SVB replay above)
- UST — Binance USTUSDT (note: USDT-quoted, not USD) + Bitfinex `tTERRAUST:USD`
  - `tUST:USD` on Bitfinex is Tether, not TerraUSD — the script tests both and reports which responded
  - Binance delisted USTUSDT around 13 May 2022; the window runs 5–13 May (193 candles)

**Headline results on a $1,000 position (with Rule B active):**

| Event | Stop setting | Total P&L |
|-------|-------------|-----------|
| USDC SVB Mar 2023 | any (3 %, 5 %, 10 %, none, hold) | **+$50** |
| UST Terra May 2022 | any (3 %, 5 %, 10 %, none, hold) | **+$4** |

**What the replay revealed — and what was fixed:**

Before the repeat-dip guard, the bot re-bought UST twice on 9 May as UST flickered back into the dip zone during its final collapse. Each re-buy was stopped out quickly under 3 %–10 % stops (total −$56 to −$96); without a stop the second trade rode UST to $0.28 (−$713). The Luna Foundation Guard's brief peg-defence bounce on 8 May (+$3.52) was the only trade worth keeping.

Rule B — "coin dipped, recovered to peg, dipping again within 72 h → AVOID" — blocks both re-buys by detecting the unstable dip-recovery-dip cycle. After Rule B, all stop settings yield the same result: +$3.52 from the May 7–8 trade only. See the **[Repeat-dip rule](#repeat-dip-rule-rule-b)** section below for the full comparison.

---

## Repeat-dip rule (Rule B)

To fix the UST re-buy problem revealed by the stop-loss comparison, three guard rules were tested against both events at the 3 % stop and at no stop:

- **Rule A** — 48 h cooldown after a stop-loss exit
- **Rule B** — if the coin dipped below peg, recovered to within 0.5 % of peg, then dips again within 72 h → AVOID (+50 danger)
- **Rule C** — Rule A + Rule B combined

| Rule | Stop | USDC 2023 | UST 2022 total |
|------|------|-----------|----------------|
| Baseline | 3 % | +$50.05 (won) | −$56.48 (3 trades) |
| Baseline | none | +$50.05 (won) | −$713.44 (2 trades) |
| Rule A | 3 % | +$50.05 (won) | −$26.48 (2 trades — trade 3 blocked by cooldown) |
| Rule A | none | +$50.05 (won) | −$713.44 (trade 2 not blocked — came after a **win**, not a stop-loss) |
| **Rule B** | **3 %** | **+$50.05 (won)** | **+$3.52 (1 trade only)** |
| **Rule B** | **none** | **+$50.05 (won)** | **+$3.52 (1 trade only)** |
| Rule C | 3 % | +$50.05 (won) | +$3.52 (same as B) |
| Rule C | none | +$50.05 (won) | +$3.52 (same as B) |

**Why Rule B, not Rule A:** UST trade 2 came after a **win** (the May 7–8 take-profit), not a stop-loss. Rule A's cooldown only activates after a stop-loss exit and cannot block it. Rule B detects the unstable pattern directly: `hadDipBeforePeg` in `history.ts` finds any prior dip-zone entry before the last at-peg timestamp; if that recovery was within 72 h, `hadPriorDipCycle` is set and `isRepeatDip` fires. Rule C adds no benefit over Rule B for these events.

**Why USDC 2023 is unaffected:** The SVB crash started from peg — there was no prior dip before the crash, so `hadPriorDipCycle` is never `true` during the recovery window. The single +$50 win is preserved exactly.

**Implemented:** Rule B only. No config changes. Files: `lib/agent/history.ts` (`hadDipBeforePeg`, `hadPriorDipCycle`), `lib/agent/rules.ts` (`isRepeatDip` — +50 danger, blocked from `canBuy`, forced into `mustAvoid`).

**How to reproduce:**

```bash
cd pegcheck-workflow
bun run replay/rule-comparison.ts
```

---

## AI debate

When the rules engine reaches a BUY, a three-voice LLM panel (Claude Haiku) runs as a sanity check before the result is logged:

- **Bull** — argues for entering the trade (≤ 40 words)
- **Bear** — argues against (≤ 40 words)
- **Judge** — weighs both sides and returns a verdict: BUY, WATCH, or AVOID (≤ 80 words)

The debate can only make the verdict *more* cautious — never less. If the rules engine says BUY, the Judge may downgrade to WATCH or AVOID, but it cannot override an engine AVOID to BUY. The rules engine always makes the final call.

The Judge is given ready-made dollar thresholds computed directly from the config constants (e.g. for a $1.00 peg: dip zone $0.9950–$0.9500, take-profit $0.9980, stop-loss 3% below entry). It is instructed to use only those figures and never calculate its own.

**Setup:** add your Anthropic API key to `secrets.yaml` in the repo root under the key `PEGCHECK_DEBATE_KEY`. The `secrets.yaml` file is git-ignored and never committed. Without a key the debate step is skipped and the rules-engine verdict stands unchanged.

---

## Replay testing

Five buy-rule variants were tested over an 18-coin stablecoin portfolio (max 3 open positions, hourly candles from March–October 2026) and two historical crash events to find a rule that protects against collapse scenarios without sacrificing normal-market performance.

**Portfolio results (18 coins, 3 slots, ~5 months, pretend $1 000/trade, 0.05 %/side fee):**

| Variant | Trades | W/L/TO | Net P&L | Max drawdown | Skipped |
|---------|--------|--------|---------|-------------|---------|
| A0 — no Rule B (baseline) | 98 | 56W/1L/39TO | +$147.94 | $31.00 | 222 |
| F+C — Rule B if ≥1.5% deep + chronic filter | 76 | 69W/0L/6TO | +$245.18 | $1.60 | 0 |
| **T — tiered (current)** | **76** | **69W/0L/6TO** | **+$245.18** | **$1.60** | **0** |

**Crash-dataset results ($1 000/trade, same settings):**

| Variant | UST May 2022 | USDC SVB Mar 2023 |
|---------|-------------|-------------------|
| A0 — baseline | −$59.45 (3t, 1W/2L) | +$49.03 (1W) |
| A — block all repeat dips | +$2.52 (1t, 1W) | +$49.03 (1W) |
| F+C | −$28.47 (2t, 1W/1L) | +$49.03 (1W) |
| **T — tiered** | **+$2.52 (1t, 1W)** | **+$49.03 (1W)** |

**Why variant T was chosen:**

Coins are split into two tiers:
- **STRICT** (algorithmic / synthetic / partly backed: ust, usdd, frax, dola, alusd, ethena) — full Rule A (block *any* repeat dip within 72 h) plus the chronic filter. These coins carry higher structural risk; the extra caution is worth the occasional missed re-entry.
- **BACKED** (fiat-backed and over-collateralised: usdc, usdt, pyusd, rlusd, fdusd, usdp, tusd, lusd, bold, mkusd, crvusd, gho, usds) — F+C only (Rule B suppressed for shallow dips ≥ 1.5%, plus chronic filter). Acute flash-crashes like USDC SVB are sudden and non-chronic, so the chronic filter does not block them.

T matches F+C on the normal-market portfolio (+$245.18) and avoids the UST losing re-entry that F+C cannot block — UST's second bad entry was only ~0.5% below peg, below F+C's 1.5% threshold. T closes that gap by not suppressing Rule B for STRICT coins.

**Caveats:**
- mkusd accounts for +$217 of the +$245 portfolio total. That concentration means the headline number is fragile to a single coin.
- Replay results use the exact same rules as the live agent but do not model slippage, liquidity depth, API latency, or failed consensus rounds.
- One good crash outcome (USDC SVB) and one avoided collapse (UST) are not enough data to call the tiering robust — they are the scenarios the rule was designed around.

Full replay scripts and per-coin breakdowns: [`own-data-replay` branch](../../tree/own-data-replay/pegcheck-workflow/replay/).

---

## Live version

The CRE workflow here is a simulation for the hackathon and does not record trades. The same rules run live inside PegCheck (pegcheck.uk) on its own scheduled job every few minutes, recording practice trades with pretend money to a database, so the agent builds a real track record.

---

## Status and known limits

| Item | Detail |
|---|---|
| **All trades are pretend** | No real funds are ever moved. |
| **Consensus mode** | Uses `identical` aggregation — all nodes must produce the exact same API summary. Switch to a median aggregation before any real-money deployment. |
| **On-chain transfer data** | `largeTransferCount24h` and `largeTransferTotalUsd24h` are hardcoded to `0` for now; on-chain transfer indexing is not yet wired up. |
| **USDC only** | The current config tracks USDC. The rules engine is coin-agnostic; other pegged assets can be added via config. |
| **Not financial advice** | This is a hackathon demo. Do not use it to make real trading decisions. |

---

## Hackathon

Built for **BLI Legal Tech Hackathon 2**, an entry for the **Chainlink CRE** and **autonomous agents** tracks.

- Chainlink CRE SDK: `@chainlink/cre-sdk ^1.6.0`
- On-chain data: Chainlink USDC/USD feed, Ethereum mainnet
- Off-chain data: [PegCheck](https://pegcheck.uk) price API
