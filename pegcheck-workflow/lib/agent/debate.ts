import type { Decision, DecideResult, Evidence } from "./rules.js"

export type DebateResult = {
  bull:        string    // logged only — argument for entering the trade
  bear:        string    // logged only — argument against entering the trade
  verdict:     Decision  // consensus-eligible; clamped to ≤ rules-engine caution level
  explanation: string    // logged only — judge's one-paragraph reasoning
}

// Caution ordering: avoid (0) is most cautious, buy (2) least cautious.
// Debate verdict can only move in the cautious direction.
const CAUTION: Record<Decision, number> = { avoid: 0, watch: 1, buy: 2 }

function clampVerdict(proposed: string, rulesDecision: Decision): Decision {
  const norm = proposed.toLowerCase().trim()
  const valid: Decision[] = ["buy", "watch", "avoid"]
  const safe: Decision = valid.includes(norm as Decision) ? (norm as Decision) : rulesDecision
  return CAUTION[safe] <= CAUTION[rulesDecision] ? safe : rulesDecision
}

export type AnthropicRequestBody = {
  model:       string
  max_tokens:  number
  temperature: number
  messages:    Array<{ role: string; content: string }>
}

export function buildDebateRequest(
  evidence: Evidence,
  result:   DecideResult,
): AnthropicRequestBody {
  const depegPct  = ((evidence.peg - evidence.medianPrice) / evidence.peg * 100).toFixed(2)
  const dangerStr = result.danger.reasons.length      ? result.danger.reasons.join("; ")      : "none"
  const oppStr    = result.opportunity.reasons.length  ? result.opportunity.reasons.join("; ") : "none"

  const prompt =
    `You are a stablecoin dip-trading debate panel. Analyse this opportunity and reply ONLY with valid JSON — no markdown, no prose outside the JSON object.\n\n` +
    `Coin: ${evidence.coin}\n` +
    `Price: $${evidence.medianPrice.toFixed(4)} (${depegPct}% from $${evidence.peg.toFixed(2)} peg)\n` +
    `Rules-engine verdict: ${result.decision.toUpperCase()} — danger ${result.danger.score}/100, opportunity ${result.opportunity.score}/100\n` +
    `Danger reasons:      ${dangerStr}\n` +
    `Opportunity reasons: ${oppStr}\n\n` +
    `Reply with exactly this structure:\n` +
    `{"bull":"<≤40 words arguing to buy the dip>","bear":"<≤40 words arguing against>","verdict":"<BUY|WATCH|AVOID>","explanation":"<≤80 words from the judge>"}\n\n` +
    `Constraints on verdict:\n` +
    `- if rules-engine said AVOID → verdict must be AVOID\n` +
    `- if rules-engine said WATCH → verdict may be WATCH or AVOID only\n` +
    `- if rules-engine said BUY   → verdict may be BUY, WATCH, or AVOID`

  return {
    model:       "claude-haiku-4-5-20251001",
    max_tokens:  600,
    temperature: 0,
    messages:    [{ role: "user", content: prompt }],
  }
}

export function parseDebateResponse(
  rawApiResponse: unknown,
  rulesDecision:  Decision,
  log?: (msg: string) => void,
): DebateResult {
  const fallback: DebateResult = {
    bull: "(unavailable)", bear: "(unavailable)",
    verdict: rulesDecision, explanation: "(unavailable)",
  }

  try {
    const resp = rawApiResponse as {
      content?:    Array<{ type: string; text: string }>
      error?:      { type: string; message: string }
      stop_reason?: string
    }
    if (resp.error) return fallback

    const raw      = resp.content?.[0]?.text ?? ""
    // Strip ```json fences, then extract the outermost { … }
    const stripped = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim()
    const start    = stripped.indexOf("{")
    const end      = stripped.lastIndexOf("}")
    const jsonStr  = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped

    let parsed: { bull?: string; bear?: string; verdict?: string; explanation?: string }
    try {
      parsed = JSON.parse(jsonStr) as typeof parsed
    } catch {
      log?.(`[DEBATE] parse failed — stop_reason=${resp.stop_reason ?? "unknown"} text=${raw.slice(0, 200)}`)
      return fallback
    }

    return {
      bull:        (parsed.bull        ?? fallback.bull).slice(0, 200),
      bear:        (parsed.bear        ?? fallback.bear).slice(0, 200),
      verdict:     clampVerdict(parsed.verdict ?? "", rulesDecision),
      explanation: (parsed.explanation ?? fallback.explanation).slice(0, 400),
    }
  } catch {
    return fallback
  }
}
