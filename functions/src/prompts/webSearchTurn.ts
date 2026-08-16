import type Anthropic from '@anthropic-ai/sdk'

/**
 * How many times a paused turn may be resumed before giving up.
 *
 * A server-side tool runs inside a sampling loop on Anthropic's side, and
 * when that loop hits its own iteration ceiling the turn comes back with
 * `stop_reason: "pause_turn"` — a partial answer with an explicit "ask me
 * again to continue". Handed straight to a JSON parser it is a guaranteed
 * failure: the object is cut off mid-write, parsing throws, and a merely
 * unfinished turn is reported as a malformed one.
 *
 * Three is generous for any of these calls. The cap exists so a
 * pathologically pausing turn cannot spin until the caller's deadline.
 */
const MAX_PAUSE_RESUMES = 3

/**
 * One Claude turn that uses a server-side tool, streamed and resumed.
 *
 * Every call in this app that reaches for `web_search` needs both of these
 * and none of them had both. Written once here after the rescan path spent
 * weeks failing for want of them, so the two calls that still legitimately
 * search — overnight candidates and the country guide — do not have to learn
 * it separately.
 *
 * STREAMED because the non-streaming path is what a long searching turn runs
 * out of: a single request has to complete inside the SDK's request timeout,
 * and several searches plus a full answer is exactly the shape that doesn't.
 * Streaming holds the connection open through the whole generation instead,
 * which is the documented remedy; `finalMessage()` hands back the same
 * assembled message `create()` would have returned, so nothing downstream
 * changes.
 *
 * RESUMED because a paused turn is not a finished one. To continue it you
 * re-send the conversation with the partial assistant turn appended and
 * nothing else — no "carry on" message, which would read as a fresh
 * instruction rather than a continuation.
 *
 * Note this is about surviving a searching turn, not about whether to search
 * at all. Web search suits a question whose answer genuinely lives on the
 * live web — current wild-camping law, this year's road tolls — and suits
 * "which bike park is best around here" so badly that it was removed from
 * the rescan path entirely. See rescanCorridor.ts's own note before adding
 * it anywhere new.
 */
export async function runWebSearchTurn(
  client: Anthropic,
  params: Omit<Anthropic.MessageStreamParams, 'stream'>,
): Promise<Anthropic.Message> {
  const turn = [...params.messages]
  let response: Anthropic.Message | undefined

  for (let resume = 0; resume <= MAX_PAUSE_RESUMES; resume++) {
    const stream = client.messages.stream({ ...params, messages: turn })
    response = await stream.finalMessage()
    if (response.stop_reason !== 'pause_turn') return response
    turn.push({ role: 'assistant', content: response.content })
  }

  // Out of resumes: hand back the last partial rather than throwing. The
  // caller's schema check is the right place to decide whether what arrived
  // is usable, and a truncated-but-parseable answer is still an answer.
  console.warn(
    `A searching turn paused ${MAX_PAUSE_RESUMES} times without finishing — using the partial turn`,
  )
  return response as Anthropic.Message
}
