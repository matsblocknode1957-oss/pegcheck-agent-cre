export const BANKROLL_USD = 10_000;
export const MAX_POSITION_USD = 1_000;
export const MAX_OPEN_POSITIONS = 3;
export const DIP_ZONE_START_PCT = 0.005;        // 0.5% below peg
export const DEEP_DEPEG_PCT = 0.05;             // over 5% = "real trouble"
export const TAKE_PROFIT_DISTANCE_PCT = 0.002;  // close when within 0.2% of peg
export const STOP_LOSS_PCT = 0.03;              // 3% below entry
export const MAX_TRADE_DAYS = 7;
export const SOURCE_DISAGREE_SPREAD_PCT = 0.01; // 1% spread = unreliable
export const CHRONIC_HOURS = 72;
export const FRESH_DIP_HOURS = 24;
export const FALLING_FAST_PCT = 0.01;
export const FALLING_PCT = 0.005;
export const BOUNCE_PCT = 0.003;
export const MIN_HISTORY_DAYS = 2;
export const RULES_VERSION = "v3";

export type CoinTier = "STRICT" | "BACKED"

// STRICT: algorithmic, synthetic, or partly-backed — Rule B always applies.
// BACKED: fiat-reserved or over-collateralised — Rule B only fires for deep dips.
// Unknown coins default to STRICT (safer).
const BACKED_COINS = new Set([
  "usdc", "usdt", "pyusd", "rlusd", "fdusd", "usdp",
  "tusd", "lusd", "bold", "mkusd", "crvusd", "gho", "usds",
])
export function getCoinTier(coin: string): CoinTier {
  return BACKED_COINS.has(coin.toLowerCase()) ? "BACKED" : "STRICT"
}

export const REPEAT_DIP_MIN_DEPTH_BACKED_PCT = 0.015;  // 1.5% — Rule B threshold for BACKED coins
