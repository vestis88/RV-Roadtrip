/**
 * Pacing advice that still describes days you have not driven yet.
 *
 * Reported 2026-08-31 with a screenshot: *"This list on top seems completely
 * obsolete!"* — five warnings about Day 1 (2026-08-20, Rothenburg ob der
 * Tauber), Day 2 (Neuschwanstein), Day 6 (Lake Lucerne)… read from a
 * campsite in Molveno on the 31st. Every one of them was true when it was
 * written and every one described a day eleven days behind the traveler, on
 * a route through Germany they had long since driven.
 *
 * The warnings are written once, by generation, and then simply persist:
 * `planMeta.pacingWarnings` has no idea time has passed. And pacing advice
 * is inherently about a decision — *"either the drive moves to another day
 * or the sight does"* — which is a decision you can only take before the
 * day happens. After it, the same sentence is not merely unhelpful, it is
 * asking you to rearrange the past.
 *
 * So the date each warning names is the thing that decides. A warning with
 * no parseable date is KEPT: the sentence-level warnings ("the second half
 * of the trip carries most of the driving") are about the shape of the whole
 * trip and never went stale, and guessing at a warning we cannot read would
 * throw away the useful ones to be tidy.
 */

/** `Day 1 (2026-08-20) drives 581 km…` — the shape generation writes. */
const DATED = /\((\d{4}-\d{2}-\d{2})\)/

export function livePacingWarnings(
  warnings: string[] | undefined,
  today: string,
): string[] {
  return (warnings ?? []).filter((warning) => {
    const date = DATED.exec(warning)?.[1]
    // Today still counts: the day is being lived, and moving this
    // afternoon's sight to tomorrow is a real option.
    return !date || date >= today
  })
}
