import type Anthropic from '@anthropic-ai/sdk'

export type ClaudeCallType =
  | 'highlights'
  | 'outline'
  | 'detail'
  /** One section of one day, filled on request — see daySectionPrompt. */
  | 'daySection'
  | 'reconcileDetail'
  | 'rescan'
  | 'overnight'
  | 'countryGuide'

/**
 * Structured stdout log (Cloud Functions ships this to Cloud Logging for
 * free — no Firestore writes, no new UI) for every Claude call this app
 * makes. Queryable by callType/tripId in the GCP console, e.g.
 * `jsonPayload.event="claude_usage" jsonPayload.tripId="…"`, to see which
 * call types and trips are actually driving cost.
 *
 * `elapsedMs` was added after two wrong guesses in a row about why a search
 * took four minutes (see querySearch.ts). Tokens alone can't tell you
 * whether the time went on web searches, on generating a long answer, or on
 * a retry — duration beside outputTokens, webSearchRequests and attempt
 * distinguishes all three, from a single real search, without guessing.
 */
export function logClaudeUsage(params: {
  callType: ClaudeCallType
  tripId?: string
  attempt: number
  elapsedMs: number
  response: Anthropic.Message
}): void {
  const { callType, tripId, attempt, elapsedMs, response } = params
  // Optional chaining rather than trusting `usage` to always be present:
  // this is best-effort observability, not something a generation should
  // ever fail over — a response shape this doesn't expect (e.g. a test
  // double that only stubs the fields its assertions check) should degrade
  // to zeros, never throw and take the real call down with it.
  const usage = response.usage
  console.log(
    JSON.stringify({
      event: 'claude_usage',
      callType,
      tripId,
      model: response.model,
      attempt,
      elapsedMs,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      webSearchRequests: usage?.server_tool_use?.web_search_requests ?? 0,
    }),
  )
}
