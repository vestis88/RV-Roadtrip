/**
 * Whether a callable rejection carries a message the server actually wrote.
 *
 * Extracted 2026-08-18, on the third screen to need it. The explore search
 * learned this on 2026-08-12, the rescan on 2026-08-16, and the Countries tab
 * had never learned it at all — it replaced every failure, including ones
 * written specifically for the traveler, with "Could not research that right
 * now — please try again."
 *
 * Only codes our own callables raise are trusted. Everything else a callable
 * can fail with — 'unavailable', 'cancelled', and the bare 'internal' the
 * Firebase SDK produces for a fetch that never completed — carries the code
 * string as its message, which is not something to put on a screen.
 */
const SERVER_AUTHORED_CODES = new Set([
  'functions/failed-precondition',
  'functions/internal',
  'functions/invalid-argument',
  'functions/not-found',
  'functions/permission-denied',
  'functions/unauthenticated',
])

/**
 * The server's own account of a failure, or null when it did not give one.
 *
 * Null is a real answer and callers must have something to say for it: a
 * rejection with no cause in it means the request never reached a server that
 * could explain itself — a dropped connection, or a container that died
 * before replying. See exploreCandidateActions.exploreFailureMessage for what
 * that case deserves.
 */
export function serverAuthoredMessage(error: unknown): string | null {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  if (typeof code !== 'string' || !SERVER_AUTHORED_CODES.has(code)) return null
  // A message that is just the code repeated back says nothing a traveler can
  // use — and it reached the screen anyway, as the single word "internal",
  // because this once rejected only the exact uppercase spelling. The
  // Firebase client emits either casing depending on the path.
  const named = typeof message === 'string' ? message.trim() : ''
  const codeWord = code.replace(/^functions\//, '')
  if (
    named === '' ||
    named.toLowerCase() === codeWord.toLowerCase() ||
    named.toLowerCase() === code.toLowerCase()
  ) {
    return null
  }
  return named
}

/** True when the callable ran out of time rather than failing outright. */
export function isDeadlineExceeded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'functions/deadline-exceeded'
}
