/**
 * What to say when Google Places answered a search meant for Claude.
 *
 * Reported 2026-08-28, from a lay-by at Lake Garda: *"The results seem to be
 * based solely on Google Maps results again?"* They were — and the code was
 * working exactly as designed. Production logs from that minute:
 *
 *     {"event":"query_search","source":"places","finds":8,"claudeMs":560,
 *      "claudeError":"400 … Your credit balance is too low to access the
 *      Anthropic API."}
 *
 * The Claude-first order was intact, Claude refused in half a second, and
 * the fallback quietly did its job. But a silent fallback looks EXACTLY like
 * the regression reported four days earlier — same generic blurbs, same
 * missing photos — and telling the two apart took a Cloud Logging query,
 * which is not available to someone parked on an Italian lakeside.
 *
 * So the result now says which engine answered and why. Not an error: eight
 * real places nearby are worth having, and withholding them to make a point
 * about billing would be the wrong trade on the road. An explanation beside
 * results that are visibly poorer than usual.
 */
import type { PlanMeta } from '@rv/shared'

export type SearchSource = 'claude' | 'places'
export type ClaudeFailureKind = NonNullable<PlanMeta['rescanLastClaudeFailure']>

/**
 * Each kind earns its own sentence only where the ANSWER differs: a card to
 * top up, a key to fix, a minute to wait, a retry. Everything else stays
 * "it failed", because a guess dressed as a diagnosis is worse than none.
 */
const REASONS: Record<ClaudeFailureKind, string> = {
  credit:
    'the richer search is out of API credit — top it up in the Anthropic console and it comes back on its own',
  auth: 'the richer search was refused its key — that one needs fixing in the deployment',
  'rate-limit':
    'the richer search is rate-limited at the moment — worth trying again in a minute',
  timeout: 'the richer search took too long — worth trying again',
  other: 'the richer search could not be reached',
}

/**
 * The note to show under a set of results, or null when there is nothing to
 * explain.
 *
 * `source: 'places'` with NO failure is deliberately its own sentence:
 * Claude ran and proposed nothing, which is a real answer about the ground
 * rather than an outage, and the two must never read the same.
 */
export function searchSourceNote(
  source: SearchSource | undefined,
  claudeFailure?: ClaudeFailureKind,
): string | null {
  if (source !== 'places') return null
  if (!claudeFailure) {
    return 'Google Maps results — the richer search had nothing to add here.'
  }
  return `Google Maps results, with Google's own descriptions: ${REASONS[claudeFailure]}.`
}
