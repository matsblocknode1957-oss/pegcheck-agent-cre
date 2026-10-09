# Stop-Loss Comparison

_Generated 2026-10-09_

## Events

**USDC SVB Crash — March 2023**  
Sources: Bitstamp USDCUSD + Bitfinex USDCUSD  
Window: 2023-03-08 → 2023-03-17  
(240 hourly candles — 232 two-source, 8 single-source)

**UST Terra Collapse — May 2022**  
Sources: Binance USTUSDT + Bitfinex tTERRAUST:USD (175/193 hours dual-source)  
Window: 2022-05-05 → 2022-05-13  
(193 hourly candles)

## Results

### USDC SVB Mar-2023

| Stop Setting | # | Entry Time | Entry $ | Exit Time | Exit $ | Result | P&L / $1k |
|-------------|---|-----------|---------|-----------|--------|--------|----------|
| 3% stop, 7d timeout | 1 | 2023-03-11 19:00 | $0.9504 | 2023-03-13 16:00 | $0.9980 | won | +$50.05 |
| 5% stop, 7d timeout | 1 | 2023-03-11 19:00 | $0.9504 | 2023-03-13 16:00 | $0.9980 | won | +$50.05 |
| 10% stop, 7d timeout | 1 | 2023-03-11 19:00 | $0.9504 | 2023-03-13 16:00 | $0.9980 | won | +$50.05 |
| no stop, 7d timeout | 1 | 2023-03-11 19:00 | $0.9504 | 2023-03-13 16:00 | $0.9980 | won | +$50.05 |
| hold forever | 1 | 2023-03-11 19:00 | $0.9504 | 2023-03-13 16:00 | $0.9980 | won | +$50.05 |

### UST May-2022

| Stop Setting | # | Entry Time | Entry $ | Exit Time | Exit $ | Result | P&L / $1k |
|-------------|---|-----------|---------|-----------|--------|--------|----------|
| 3% stop, 7d timeout | 1 | 2022-05-07 21:00 | $0.9945 | 2022-05-08 15:00 | $0.9980 | won | +$3.52 |
|  | 2 | 2022-05-09 05:00 | $0.9949 | 2022-05-09 18:00 | $0.9650 | lost | -$30.00 |
|  | 3 | 2022-05-09 19:00 | $0.9534 | 2022-05-09 21:00 | $0.9248 | lost | -$30.00 |
| | | | | | **TOTAL** | | **-$56.48** |
| 5% stop, 7d timeout | 1 | 2022-05-07 21:00 | $0.9945 | 2022-05-08 15:00 | $0.9980 | won | +$3.52 |
|  | 2 | 2022-05-09 05:00 | $0.9949 | 2022-05-09 18:00 | $0.9451 | lost | -$50.00 |
|  | 3 | 2022-05-09 19:00 | $0.9534 | 2022-05-09 21:00 | $0.9057 | lost | -$50.00 |
| | | | | | **TOTAL** | | **-$96.48** |
| 10% stop, 7d timeout | 1 | 2022-05-07 21:00 | $0.9945 | 2022-05-08 15:00 | $0.9980 | won | +$3.52 |
|  | 2 | 2022-05-09 05:00 | $0.9949 | 2022-05-09 21:00 | $0.8954 | lost | -$100.00 |
| | | | | | **TOTAL** | | **-$96.48** |
| no stop, 7d timeout | 1 | 2022-05-07 21:00 | $0.9945 | 2022-05-08 15:00 | $0.9980 | won | +$3.52 |
|  | 2 | 2022-05-09 05:00 | $0.9949 | 2022-05-13 00:00 | $0.2816 | open | -$716.96 |
| | | | | | **TOTAL** | | **-$713.44** |
| hold forever | 1 | 2022-05-07 21:00 | $0.9945 | 2022-05-08 15:00 | $0.9980 | won | +$3.52 |
|  | 2 | 2022-05-09 05:00 | $0.9949 | 2022-05-13 00:00 | $0.2816 | open | -$716.96 |
| | | | | | **TOTAL** | | **-$713.44** |

## Key

| Result | Meaning |
|--------|---------|
| **won** | Price recovered to within 0.2% of peg before stop or timeout |
| **lost** | Stop-loss hit — price fell to entry × (1 − stop%) |
| **timed_out** | Neither stop nor take-profit hit within the day limit; exited at median close |
| **open** | Hold-forever: no stop, no timeout; P&L is mark-to-market at last candle in window |
| **no signal** | Bot never issued a buy — price either skipped the dip zone, was falling too fast, crossed into deep depeg (>5%), or sources disagreed |

**Exit method**: stop-loss is tested against hourly `low_median`; take-profit against `high_median`.
If both thresholds are crossed in the same candle, stop wins (conservative / worst-case).
Exit prices are pinned to the threshold, not the raw low/high.

**Position size**: $1,000 (`MAX_POSITION_USD` from `config.ts` — not changed for replay).
