import type { TripDay } from '@rv/shared'
import type { RouteOutline, RouteOutlineDay } from './prompts/planTripSchema.js'

/**
 * Rebuilds the route outline from the days already written to the trip.
 *
 * The detail phase has always been given the WHOLE route as context — it is
 * what stops day 9's dinner being chosen as though days 8 and 10 did not
 * exist — and at generation time that context is simply the outline Claude
 * just produced. Detailing a day later has no such object to hand: by then
 * the outline exists only as the days themselves. So it is reconstructed,
 * and the reconstruction has to be faithful, because the alternative is a
 * detail call quietly reasoning about a different trip.
 *
 * Three things are worth stating about the mapping, all checked against the
 * code rather than assumed:
 *
 * - `overnight.name` is safe to use as the town. applyOvernightOptions moves
 *   the night onto a real campsite and rewrites lat/lng, campsiteSuggestion
 *   and type — but it spreads the existing stop and never touches `name`, so
 *   the name stays the outline's town rather than becoming "Camping Sunne".
 * - `highlightReason` is optional on a TripDay and required on an outline
 *   day, because days written before it existed have none. The day's own
 *   summary is the closest thing to it and is always present.
 * - `drive.fromTown`/`toTown` come from the stored leg's own endpoint names,
 *   which are the town names for the same reason.
 */
export function outlineFromDays(days: TripDay[]): RouteOutline {
  return {
    days: [...days]
      .sort((a, b) => a.index - b.index)
      .map(
        (day): RouteOutlineDay => ({
          index: day.index,
          date: day.date,
          type: day.type,
          overnight: {
            name: day.overnight.name,
            town: day.overnight.name,
            country: day.overnight.country,
            ...(day.overnight.campsiteSuggestion
              ? { campsiteSuggestion: day.overnight.campsiteSuggestion }
              : {}),
          },
          ...(day.drive
            ? {
                drive: {
                  fromTown: day.drive.fromName,
                  toTown: day.drive.toName,
                  slot: day.drive.slot,
                },
              }
            : {}),
          // min(1) on the schema, so never an empty string: the summary is
          // always present and is the same kind of sentence about the same
          // day. The last fallback exists only so a malformed legacy day
          // cannot fail a detail call for the days around it.
          highlightReason:
            day.highlightReason?.trim() ||
            day.summary?.trim() ||
            `Overnight in ${day.overnight.name}.`,
          ...(day.sights?.length ? { sights: day.sights } : {}),
        }),
      ),
  }
}
