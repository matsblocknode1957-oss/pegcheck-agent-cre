# Own Data Comparison

Live price data: 30 Aug – 9 Oct 2026. Coins: mkusd, bold, usdp, usdc.
Single blended price per hour (source check relaxed — lone source echoed).
Fee: 0.05%/side (0.1% round-trip). Stop-loss: 3%. Max hold: 7 days.

## Variants

| Label | Description | Dip zone start |
| ----- | ----------- | -------------- |
| **A0** | Current rules, Rule B OFF | 0.5% below peg |
| **A** | Current rules + current Rule B | 0.5% below peg |
| **B** | Refined Rule B (lower lows only) | 0.5% below peg |
| **C** | B + no-progress exit (≥48 h, price ≥ entry) | 0.5% below peg |
| **D** | B + dip zone from 0.3% | 0.3% below peg |
| **E** | B + C + D (all three) | 0.3% below peg |

> **Refined Rule B** fires only when the current candle's intra-hour low is strictly below
> the previous dip cycle's lowest close within the 72 h window.
> Plain Rule B fires on any dip → recovery → dip pattern within 72 h, regardless of depth.
>
> **No-progress exit:** sell at close if the trade has been open ≥ 48 h AND current price ≥ entry.
> Stop-loss and take-profit are still evaluated first on each candle.

## Per-coin results

| Variant | Coin | # | W/L/T | Net P&L | Avg hold |
| ------- | ---- | - | ----- | ------- | -------- |
| A0 | bold | 3 | 1W/0L/1T/O | +$1.32 | 75h |
| A0 | mkusd | 23 | 23W/0L | +$83.11 | 6h |
| A0 | usdc | — | — | — | — |
| A0 | usdp | 4 | 3W/0L/O | +$7.97 | 56h |
| A | bold | 2 | 1W/0L/1T | +$2.57 | 86h |
| A | mkusd | 5 | 5W/0L | +$10.90 | 11h |
| A | usdc | — | — | — | — |
| A | usdp | 3 | 2W/0L/O | +$5.52 | 54h |
| B | bold | 3 | 1W/0L/1T/O | +$1.32 | 75h |
| B | mkusd | 17 | 17W/0L | +$46.09 | 6h |
| B | usdc | — | — | — | — |
| B | usdp | 4 | 3W/0L/O | +$7.68 | 55h |
| C | bold | 5 | 1W/0L/3T/O | +$0.02 | 39h |
| C | mkusd | 17 | 17W/0L | +$46.09 | 6h |
| C | usdc | — | — | — | — |
| C | usdp | 6 | 2W/0L/3T/O | +$8.47 | 33h |
| D | bold | 5 | 3W/0L/1T/O | +$3.28 | 62h |
| D | mkusd | 39 | 38W/0L/O | +$40.74 | 5h |
| D | usdc | — | — | — | — |
| D | usdp | 21 | 20W/0L/O | +$11.61 | 12h |
| E | bold | 6 | 3W/0L/2T/O | +$2.28 | 52h |
| E | mkusd | 39 | 38W/0L/O | +$40.74 | 5h |
| E | usdc | — | — | — | — |
| E | usdp | 22 | 19W/0L/2T/O | +$10.05 | 11h |

## Portfolio results (4 coins, max 3 open positions)

Processed hour by hour in time order. Exits are processed before buys within each hour,
so a slot freed by an exit is available to a new buy in the same hour.

| Variant | Coin | # | W/L/T | Net P&L | Avg hold | Signals skipped |
| ------- | ---- | - | ----- | ------- | -------- | --------------- |
| A0 | bold | 3 | 1W/0L/1T/O | +$1.32 | 75h | 0 |
|  | mkusd | 23 | 23W/0L | +$83.11 | 6h |  |
|  | usdc | — | — | — | — |  |
|  | usdp | 4 | 3W/0L/O | +$7.97 | 56h |  |
| | **Total** | **30** | **27W/0L/1T/O** | **+$92.40** | 20h | |
| A | bold | 2 | 1W/0L/1T | +$2.57 | 86h | 0 |
|  | mkusd | 5 | 5W/0L | +$10.90 | 11h |  |
|  | usdc | — | — | — | — |  |
|  | usdp | 3 | 2W/0L/O | +$5.52 | 54h |  |
| | **Total** | **10** | **8W/0L/1T/O** | **+$18.99** | 39h | |
| B | bold | 3 | 1W/0L/1T/O | +$1.32 | 75h | 0 |
|  | mkusd | 17 | 17W/0L | +$46.09 | 6h |  |
|  | usdc | — | — | — | — |  |
|  | usdp | 4 | 3W/0L/O | +$7.68 | 55h |  |
| | **Total** | **24** | **21W/0L/1T/O** | **+$55.09** | 23h | |
| C | bold | 5 | 1W/0L/3T/O | +$0.02 | 39h | 0 |
|  | mkusd | 17 | 17W/0L | +$46.09 | 6h |  |
|  | usdc | — | — | — | — |  |
|  | usdp | 6 | 2W/0L/3T/O | +$8.47 | 33h |  |
| | **Total** | **28** | **20W/0L/6T/O** | **+$54.58** | 18h | |
| D | bold | 5 | 3W/0L/1T/O | +$3.28 | 62h | 0 |
|  | mkusd | 39 | 38W/0L/O | +$40.74 | 5h |  |
|  | usdc | — | — | — | — |  |
|  | usdp | 21 | 20W/0L/O | +$11.61 | 12h |  |
| | **Total** | **65** | **61W/0L/1T/O** | **+$55.63** | 11h | |
| E | bold | 6 | 3W/0L/2T/O | +$2.28 | 52h | 0 |
|  | mkusd | 39 | 38W/0L/O | +$40.74 | 5h |  |
|  | usdc | — | — | — | — |  |
|  | usdp | 22 | 19W/0L/2T/O | +$10.05 | 11h |  |
| | **Total** | **67** | **60W/0L/4T/O** | **+$53.07** | 11h | |
