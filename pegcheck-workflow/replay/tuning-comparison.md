# Tuning Comparison

Rule B ON in every variant. Stop-loss 3%. Max hold 7 days. Trading fee 0.05%/side (0.1% round trip).

## Variants

| Label | Description |
| ----- | ----------- |
| A baseline | Current rules — no changes |
| B staged-buy | Buy 30% on first dip-zone entry (ignores falling-fast guard); add 70% when normal BUY fires |
| C quick+0.3% | Exit at +0.3% above entry price OR normal 0.2%-from-peg target, whichever fires first |
| D zone-0.3% | Dip zone starts at 0.3% below peg (default 0.5%) |
| E zone+quick | D + C combined: dip zone from 0.3% plus quick +0.3%-above-entry profit exit |

## Results

| Variant          | Event      | # | W/L    | Best Entry  | Gross P&L   | Net P&L     | Avg Net/trade |
| ---------------- | ---------- | - | ------ | ----------- | ----------- | ----------- | ------------- |
| A baseline       | USDC 2023  | 1 | 1W/0L  | $0.9504     | +$50.05     | +$49.03     | +$49.03       |
| A baseline       | UST 2022   | 1 | 1W/0L  | $0.9945     | +$3.52      | +$2.52      | +$2.52        |
| B staged-buy     | USDC 2023  | 1 | 1W/0L  | $0.9649     | +$34.36     | +$33.34     | +$33.34       |
| B staged-buy     | UST 2022   | 1 | 1W/0L  | $0.9898     | +$8.25      | +$7.25      | +$7.25        |
| C quick+0.3%     | USDC 2023  | 14 | 14W/0L | $0.9504     | +$42.00     | +$27.98     | +$2.00        |
| C quick+0.3%     | UST 2022   | 1 | 1W/0L  | $0.9945     | +$3.00      | +$2.00      | +$2.00        |
| D zone-0.3%      | USDC 2023  | 3 | 3W/0L  | $0.9504     | +$53.19     | +$50.16     | +$16.72       |
| D zone-0.3%      | UST 2022   | 1 | 1W/0L  | $0.9945     | +$3.52      | +$2.52      | +$2.52        |
| E zone+quick     | USDC 2023  | 16 | 16W/0L | $0.9504     | +$45.14     | +$29.11     | +$1.82        |
| E zone+quick     | UST 2022   | 1 | 1W/0L  | $0.9945     | +$3.00      | +$2.00      | +$2.00        |

## Staged-buy trade detail (variant B)

### B staged-buy

**USDC 2023**

| # | Stage 1 | Stage 2 | Avg Entry | Size | Exit | Status | Gross | Net |
| - | ------- | ------- | --------- | ---- | ---- | ------ | ----- | --- |
| 1 | $0.9504 | $0.9712 | $0.9649 | $1000 | $0.9980 | won | +$34.36 | +$33.34 |

**UST 2022**

| # | Stage 1 | Stage 2 | Avg Entry | Size | Exit | Status | Gross | Net |
| - | ------- | ------- | --------- | ---- | ---- | ------ | ----- | --- |
| 1 | $0.9945 | $0.9878 | $0.9898 | $1000 | $0.9980 | won | +$8.25 | +$7.25 |
