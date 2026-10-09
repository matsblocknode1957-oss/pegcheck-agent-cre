import {
  DIP_ZONE_START_PCT,
  DEEP_DEPEG_PCT,
  TAKE_PROFIT_DISTANCE_PCT,
  STOP_LOSS_PCT,
  MAX_OPEN_POSITIONS,
  MAX_POSITION_USD,
  MAX_TRADE_DAYS,
  SOURCE_DISAGREE_SPREAD_PCT,
  CHRONIC_HOURS,
  FRESH_DIP_HOURS,
  FALLING_FAST_PCT,
  FALLING_PCT,
  BOUNCE_PCT,
  MIN_HISTORY_DAYS,
} from "./config.js";

export interface HistoryStats {
  hoursOffPeg: number | null;
  change1hPct: number | null;
  change24hPct: number | null;
  bounceFromLowPct: number | null;
  pctBelow7d: number | null;
  daysOfData: number | null;
  hadPriorDipCycle: boolean | null;
}

export interface Evidence {
  coin: string;
  peg: number;
  medianPrice: number;
  pricesBySource: Record<string, number>;
  largeTransferCount24h: number;
  largeTransferTotalUsd24h: number;
  openPositionsCount: number;
  history?: HistoryStats;
}

export interface ScoredCase {
  score: number;
  reasons: string[];
}

export interface BuyParams {
  sizeUsd: number;
  entry: number;
  takeProfit: number;
  stopLoss: number;
}

export type Decision = "buy" | "avoid" | "watch";

export interface DecideResult {
  decision: Decision;
  danger: ScoredCase;
  opportunity: ScoredCase;
  buy?: BuyParams;
}

export interface OpenTrade {
  coin: string;
  peg: number;
  entry: number;
  sizeUsd: number;
  openedAt: Date;
}

export type ExitStatus = "won" | "lost" | "timed_out" | "open";

export interface ExitResult {
  status: ExitStatus;
  exitPrice: number;
  profitUsd: number;
}

function priceSpread(prices: Record<string, number>): number {
  const vals = Object.values(prices);
  if (vals.length < 2) return 0;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return (hi - lo) / lo;
}

export interface DecideOverrides {
  dipZoneStartPct?:         number
  deepDepegPct?:            number
  takeProfitDistancePct?:   number
  stopLossPct?:             number
  sourceDisagreeSpreadPct?: number
  chronicHours?:            number
  freshDipHours?:           number
  fallingFastPct?:          number
  fallingPct?:              number
  bouncePct?:               number
  minHistoryDays?:          number
  maxOpenPositions?:        number
  maxPositionUsd?:          number
}

export function decide(evidence: Evidence, overrides: DecideOverrides = {}): DecideResult {
  const _DIP_ZONE_START_PCT       = overrides.dipZoneStartPct         ?? DIP_ZONE_START_PCT;
  const _DEEP_DEPEG_PCT           = overrides.deepDepegPct            ?? DEEP_DEPEG_PCT;
  const _TAKE_PROFIT_DISTANCE_PCT = overrides.takeProfitDistancePct   ?? TAKE_PROFIT_DISTANCE_PCT;
  const _STOP_LOSS_PCT            = overrides.stopLossPct             ?? STOP_LOSS_PCT;
  const _SOURCE_DISAGREE_SPREAD_PCT = overrides.sourceDisagreeSpreadPct ?? SOURCE_DISAGREE_SPREAD_PCT;
  const _CHRONIC_HOURS            = overrides.chronicHours            ?? CHRONIC_HOURS;
  const _FRESH_DIP_HOURS          = overrides.freshDipHours           ?? FRESH_DIP_HOURS;
  const _FALLING_FAST_PCT         = overrides.fallingFastPct          ?? FALLING_FAST_PCT;
  const _FALLING_PCT              = overrides.fallingPct              ?? FALLING_PCT;
  const _BOUNCE_PCT               = overrides.bouncePct               ?? BOUNCE_PCT;
  const _MIN_HISTORY_DAYS         = overrides.minHistoryDays          ?? MIN_HISTORY_DAYS;
  const _MAX_OPEN_POSITIONS       = overrides.maxOpenPositions        ?? MAX_OPEN_POSITIONS;
  const _MAX_POSITION_USD         = overrides.maxPositionUsd          ?? MAX_POSITION_USD;

  const {
    peg,
    medianPrice,
    pricesBySource,
    largeTransferCount24h,
    largeTransferTotalUsd24h,
    openPositionsCount,
    history,
  } = evidence;

  const depegPct = (peg - medianPrice) / peg;
  const sourceCount = Object.values(pricesBySource).length;
  const spread = priceSpread(pricesBySource);
  const sourcesAgree = sourceCount >= 2 && spread < _SOURCE_DISAGREE_SPREAD_PCT;
  const isDeepDepeg = depegPct > _DEEP_DEPEG_PCT;
  const isInDipZone = depegPct >= _DIP_ZONE_START_PCT && depegPct <= _DEEP_DEPEG_PCT;
  const atMaxPositions = openPositionsCount >= _MAX_OPEN_POSITIONS;

  const danger: ScoredCase = { score: 0, reasons: [] };
  const opportunity: ScoredCase = { score: 0, reasons: [] };

  // --- Danger scoring ---

  if (isDeepDepeg) {
    danger.score += 50;
    danger.reasons.push(
      `Price is ${(depegPct * 100).toFixed(1)}% below peg — deep depeg (limit is ${(_DEEP_DEPEG_PCT * 100).toFixed(0)}%)`
    );
  }

  if (sourceCount < 2) {
    danger.score += 25;
    danger.reasons.push(`Only ${sourceCount} price source — can't cross-check`);
  } else if (!sourcesAgree) {
    danger.score += 25;
    danger.reasons.push(
      `Sources disagree: spread is ${(spread * 100).toFixed(2)}% (limit is ${(_SOURCE_DISAGREE_SPREAD_PCT * 100).toFixed(0)}%)`
    );
  }

  // 1 pt per $50 M in large transfers, capped at 15
  const transferDangerPts = Math.min(15, Math.floor(largeTransferTotalUsd24h / 50_000_000));
  if (largeTransferCount24h > 0) {
    danger.score += transferDangerPts;
    danger.reasons.push(
      `${largeTransferCount24h} transfer(s) ≥$1M totalling $${(largeTransferTotalUsd24h / 1_000_000).toFixed(0)}M in 24 h (+${transferDangerPts} pts)`
    );
  }

  if (atMaxPositions) {
    danger.score += 10;
    danger.reasons.push(
      `Already at ${openPositionsCount}/${_MAX_OPEN_POSITIONS} open positions`
    );
  }

  // --- History-based danger ---

  let isChronic = false;
  let isFallingFast = false;
  let isRepeatDip = false;

  if (history === undefined) {
    danger.score += 10;
    danger.reasons.push("No price history to check");
  } else {
    isChronic = history.hoursOffPeg !== null && history.hoursOffPeg > _CHRONIC_HOURS && depegPct >= _DIP_ZONE_START_PCT;
    isFallingFast = history.change1hPct !== null && history.change1hPct <= -_FALLING_FAST_PCT;
    isRepeatDip = history.hadPriorDipCycle === true;

    if (isChronic) {
      danger.score += 35;
      danger.reasons.push(
        `Below peg for ${(history.hoursOffPeg! / 24).toFixed(1)} days — looks chronic, not a dip`
      );
    }

    if (isFallingFast) {
      danger.score += 25;
      danger.reasons.push(
        `Still falling fast: down ${(Math.abs(history.change1hPct!) * 100).toFixed(1)}% in the last hour`
      );
    } else if (history.change1hPct !== null && history.change1hPct <= -_FALLING_PCT) {
      danger.score += 10;
      danger.reasons.push(
        `Still slipping: down ${(Math.abs(history.change1hPct) * 100).toFixed(1)}% in the last hour`
      );
    }

    if (isRepeatDip) {
      danger.score += 50;
      danger.reasons.push(
        "Repeat-dip pattern: coin dipped, recovered to peg, dipping again within 72 h"
      );
    }

    if (history.daysOfData !== null && history.daysOfData < _MIN_HISTORY_DAYS) {
      danger.score += 10;
      danger.reasons.push(`Only ${history.daysOfData.toFixed(1)} days of price history`);
    }
  }

  // --- Opportunity scoring ---

  if (isInDipZone) {
    const zoneDepth =
      (depegPct - _DIP_ZONE_START_PCT) / (_DEEP_DEPEG_PCT - _DIP_ZONE_START_PCT);
    const dipPts = Math.round(20 + zoneDepth * 30); // 20–50 pts
    opportunity.score += dipPts;
    opportunity.reasons.push(
      `Price is ${(depegPct * 100).toFixed(2)}% below peg — in the dip zone ${(_DIP_ZONE_START_PCT * 100).toFixed(1)}%–${(_DEEP_DEPEG_PCT * 100).toFixed(0)}% (+${dipPts} pts)`
    );

    if (sourcesAgree) {
      opportunity.score += 25;
      opportunity.reasons.push(
        `Sources agree: spread is ${(spread * 100).toFixed(2)}% (under ${(_SOURCE_DISAGREE_SPREAD_PCT * 100).toFixed(0)}%)`
      );
    }

    // 25 pts if zero transfers, minus 5 per transfer seen
    const lowTransferPts = Math.max(0, 25 - largeTransferCount24h * 5);
    if (lowTransferPts > 0) {
      opportunity.score += lowTransferPts;
      opportunity.reasons.push(
        largeTransferCount24h === 0
          ? `No $1M+ transfers in 24 h (+${lowTransferPts} pts)`
          : `${largeTransferCount24h} large transfer(s) — still low activity (+${lowTransferPts} pts)`
      );
    }

    // History-based opportunity
    if (history !== undefined) {
      if (history.hoursOffPeg !== null && history.hoursOffPeg <= _FRESH_DIP_HOURS) {
        opportunity.score += 10;
        opportunity.reasons.push(
          `Fresh dip: was at peg ${history.hoursOffPeg.toFixed(1)} hours ago`
        );
      }
      if (
        history.bounceFromLowPct !== null &&
        history.bounceFromLowPct >= _BOUNCE_PCT &&
        history.change1hPct !== null &&
        history.change1hPct >= 0
      ) {
        opportunity.score += 10;
        opportunity.reasons.push(
          `Bouncing: up ${(history.bounceFromLowPct * 100).toFixed(1)}% from today's low`
        );
      }
    }
  } else if (!isDeepDepeg) {
    opportunity.reasons.push(
      `No dip to buy (price is ${(Math.abs(depegPct) * 100).toFixed(2)}% from peg)`
    );
  }

  // --- Cap scores ---

  danger.score = Math.min(100, danger.score);
  opportunity.score = Math.min(100, opportunity.score);

  // --- Decision ---

  const canBuy =
    isInDipZone &&
    sourcesAgree &&
    opportunity.score > danger.score &&
    !atMaxPositions &&
    history !== undefined &&
    !isChronic &&
    !isFallingFast &&
    !isRepeatDip;

  const mustAvoid =
    isDeepDepeg ||
    !sourcesAgree ||
    isChronic ||
    isRepeatDip ||
    (isInDipZone && danger.score > opportunity.score);

  let decision: Decision;
  if (canBuy) {
    decision = "buy";
  } else if (mustAvoid) {
    decision = "avoid";
  } else {
    decision = "watch";
  }

  const result: DecideResult = { decision, danger, opportunity };

  if (decision === "buy") {
    const entry = medianPrice;
    result.buy = {
      sizeUsd: _MAX_POSITION_USD,
      entry,
      takeProfit: peg * (1 - _TAKE_PROFIT_DISTANCE_PCT),
      stopLoss: entry * (1 - _STOP_LOSS_PCT),
    };
  }

  return result;
}

export function checkExit(
  openTrade: OpenTrade,
  currentPrice: number,
  now: Date
): ExitResult {
  const { peg, entry, sizeUsd, openedAt } = openTrade;
  const units = sizeUsd / entry;
  const takeProfitPrice = peg * (1 - TAKE_PROFIT_DISTANCE_PCT);
  const stopLossPrice = entry * (1 - STOP_LOSS_PCT);
  const maxMs = MAX_TRADE_DAYS * 24 * 60 * 60 * 1000;
  const pnl = (price: number) => units * price - sizeUsd;

  if (currentPrice >= takeProfitPrice) {
    return { status: "won", exitPrice: currentPrice, profitUsd: pnl(currentPrice) };
  }
  if (currentPrice <= stopLossPrice) {
    return { status: "lost", exitPrice: currentPrice, profitUsd: pnl(currentPrice) };
  }
  if (now.getTime() - openedAt.getTime() >= maxMs) {
    return { status: "timed_out", exitPrice: currentPrice, profitUsd: pnl(currentPrice) };
  }
  return { status: "open", exitPrice: currentPrice, profitUsd: pnl(currentPrice) };
}

export function shouldRecord(evidence: Evidence): boolean {
  const depegPct = Math.abs(evidence.peg - evidence.medianPrice) / evidence.peg;
  return depegPct >= DIP_ZONE_START_PCT;
}
