/**
 * Getting a JSON object out of a Claude response that was asked for JSON and
 * answered with a little more than that.
 *
 * Every prompt here ends with "Respond with JSON ONLY — no prose, no markdown
 * code fences", and the responses mostly comply. Mostly is the operative
 * word: the 30-day usage log behind salvageJsonPrefix showed 4 of 12
 * highlights runs needing their retry, and that is the tool-FREE path. A turn
 * that has just run web searches is far likelier to introduce its answer
 * ("Based on my searches, here are the standout stops near Sunne:") or to
 * sign off after it ("Let me know if you'd like me to widen the search!"),
 * because grounding an answer in sources is exactly the shape that invites
 * saying so.
 *
 * The highlights path was hardened against this in 2026-08-12 and the rescan
 * path never was — it kept `JSON.parse(stripCodeFences(text))`, which throws
 * on all three of the shapes above. That is the whole reason a rescan
 * "scanned for minutes and came up empty": the search worked, the write-up
 * arrived, and one sentence of politeness around it threw the entire run
 * away and bought a second full web search for another go at the same
 * ending. Collected here so there is one answer to this question instead of
 * four copies of half of one.
 */

export function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

/**
 * Cuts a syntactically broken response back to the longest prefix that IS
 * valid JSON, closing whatever containers are still open at that point.
 * Returns null when nothing parses.
 *
 * Exists because of a production failure on 2026-08-12 (explore highlights,
 * trip "Luxemburg"): Claude returned 5,609 characters of otherwise-complete
 * curation whose very last candidate was `{"town": "Bouillon", "country":
 * "BE", "why "}` — a key with no value. `JSON.parse` is all-or-nothing, so
 * one malformed field at the tail threw away every complete candidate
 * before it, both attempts failed the same way, and the whole callable
 * 500'd after paying for two Claude calls.
 *
 * Scans once, tracking string/escape state so a brace inside a `why`
 * sentence is never mistaken for structure, and records every point where a
 * container legitimately closed. Those points are then tried newest-first,
 * so the salvage keeps as much of the answer as possible; a trailing
 * sentence of prose after the closing brace (the other way a response
 * stops being parseable) is cut by the same mechanism.
 *
 * Deliberately NOT a general "repair any JSON" pass: it only ever truncates
 * at a boundary the model itself closed, so a salvaged document contains
 * only values Claude actually finished writing. Nothing is invented, and
 * the caller still validates the result against the real schema.
 */
export function salvageJsonPrefix(text: string): string | null {
  const cuts: { end: number; closers: string }[] = []
  const open: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') open.push('}')
    else if (char === '[') open.push(']')
    else if (char === '}' || char === ']') {
      // A mismatched closer means the damage is structural rather than a
      // truncated tail, and every cut point recorded so far sits inside a
      // container whose nesting we can no longer trust — nothing to salvage.
      if (open.pop() !== char) return null
      cuts.push({ end: i, closers: [...open].reverse().join('') })
    }
  }

  for (let i = cuts.length - 1; i >= 0; i--) {
    const candidate = text.slice(0, cuts[i].end + 1) + cuts[i].closers
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // This boundary sat inside the broken region; try an earlier one.
    }
  }
  return null
}

// Enough of the response to recognise what came back instead of JSON,
// without putting a whole survey in an error message a traveler may see.
const PREVIEW_LENGTH = 200

/**
 * The JSON object in a response, whatever Claude wrapped it in.
 *
 * Tries the response as given first, so a clean answer costs nothing; then
 * from the first `{`, which is what drops an introductory sentence; then
 * salvageJsonPrefix on that, which is what drops a sign-off or a truncated
 * tail. Throws only when there is genuinely no object in there, and says
 * what arrived instead — "Unexpected token 'B'" names a character, not a
 * problem.
 *
 * Never invents structure: everything it returns is a contiguous run of
 * characters Claude wrote, and the caller still validates it against a
 * schema.
 */
export function extractJsonObject(text: string): string {
  const stripped = stripCodeFences(text)
  if (parses(stripped)) return stripped

  const start = stripped.indexOf('{')
  if (start === -1) {
    throw new Error(
      `Claude answered with no JSON at all: "${preview(stripped)}"`,
    )
  }

  const body = stripped.slice(start)
  if (parses(body)) return body

  const salvaged = salvageJsonPrefix(body)
  if (salvaged !== null) return salvaged

  throw new Error(
    `Claude's answer contained no complete JSON object: "${preview(stripped)}"`,
  )
}

function parses(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > PREVIEW_LENGTH
    ? `${collapsed.slice(0, PREVIEW_LENGTH)}…`
    : collapsed
}
