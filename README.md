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

**Headline results on a $1,000 position:**

| Event | Stop setting | Total P&L |
|-------|-------------|-----------|
| USDC SVB Mar 2023 | any (3 %, 5 %, 10 %, none, hold) | **+$50** |
| UST Terra May 2022 | 3 % stop | **−$56** |
| UST Terra May 2022 | 5 % stop | **−$96** |
| UST Terra May 2022 | 10 % stop | **−$96** |
| UST Terra May 2022 | no stop | **−$713** |

**What the replay revealed — and what needs fixing:**

The bot got lucky on UST: it caught the Luna Foundation Guard's brief peg-defence bounce on 8 May (+$3.52), exited cleanly, then re-bought twice on 9 May as UST briefly flickered back into the dip zone during its final collapse. Each re-buy was stopped out quickly, so the stop-loss capped the damage — **the stop-loss is essential**; without it the loss on the second trade alone was −$717.

The deeper problem: after a stop-loss the bot immediately re-buys the moment price re-enters the dip zone, even during a collapse. A **cooldown after a stop-loss exit** (e.g. do not re-enter for N hours on the same coin) is the planned fix to prevent this pattern.

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
