import type { TripSettings } from '@rv/shared'

function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => isSameValue(item, b[i]))
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (key) => key in bObj && isSameValue(aObj[key], bObj[key]),
  )
}

/**
 * Folds a freshly-arrived server copy of a trip's settings into the copy the
 * settings form is currently showing.
 *
 * The form keeps its own local state so typing stays responsive and every
 * field can commit independently, but that state used to be read from the
 * trip exactly once, on mount. With Firestore's persistent local cache
 * enabled (see lib/firebase.ts), the first snapshot after a page load comes
 * from disk — so a trip edited on another device, or simply written after
 * that cache entry was last refreshed, renders from the stale cached copy
 * and then *stays* stale for the rest of the session, because the newer
 * server snapshot only updates the `trip` prop and never the form's own
 * state. That was invisible for the text fields (the stale copy usually
 * still had the right *names*) but not for coordinates: a start/finish
 * point whose lat/lng hadn't caught up kept failing hasRoute, so
 * "Generate overview"/"Generate full plan" refused to run on a trip whose
 * stored route was perfectly valid.
 *
 * Fields the traveler has edited in this mount are `dirty` and always win —
 * adopting the server copy for those would drop in-flight keystrokes, since
 * each field's write is echoed back a moment after it's made. Everything
 * else follows the server. Returns `local` unchanged when nothing differs,
 * so a caller can pass it straight to `setState` without causing a render.
 */
export function mergeRemoteSettings(
  local: TripSettings,
  remote: TripSettings,
  dirty: ReadonlySet<keyof TripSettings>,
): TripSettings {
  let changed = false
  const next = { ...local }
  for (const key of Object.keys(remote) as (keyof TripSettings)[]) {
    if (dirty.has(key)) continue
    if (isSameValue(local[key], remote[key])) continue
    next[key] = remote[key] as never
    changed = true
  }
  return changed ? next : local
}
