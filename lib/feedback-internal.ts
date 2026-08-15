// lib/feedback-internal.ts
//
// ONE definition of "this row is internal", and the fail-soft plumbing that
// lets the owner-facing reads filter on it BEFORE the migration has run.
// Issue 247 step 1.
//
// WHY A COLUMN AND NOT A REUSE OF SOMETHING EXISTING.
//   · `type` is CHECK-constrained to ('bug','feature'). The internal list also
//     holds decisions ("Decide what happens to 9 locations with no Stripe
//     record") and hazards ("past-due touchpoints will burst-email"). Widening
//     that CHECK to carry a VISIBILITY meaning would conflate "what kind of
//     work is this" with "who may see it" — two axes that must vary freely.
//   · `location_id` cannot carry it either, and that is the whole point of this
//     issue — see below.
//
// WHAT location_id MEANS, AND WHY THAT FORCED THIS COLUMN.
// On insert (app/api/feedback POST) location_id is copied from the SUBMITTER's
// hub_users.location_id. It has always meant "the location this was submitted
// from". The owner read filters `.eq('location_id', <their location>)`, which
// today is exactly "what my location submitted" — because owners are the only
// filers, the two readings are indistinguishable.
//
// The moment an internal item carries a location TAG (which is the point — that
// tag is how "Kevin already logged this" and "Ankur just reported it" line up as
// one visible overlap), the two readings diverge and the existing predicate
// starts publishing internal work to owners.
//
// This flag is what re-separates them. It does NOT require a second
// subject-location column: internal rows are excluded from owner reads
// WHOLESALE, so location_id's second meaning is never observable to an owner.
// One boolean restores the original guarantee and unlocks the tag.
//
// FAILS SOFT — AND WHY THAT IS NOT A HOLE.
// migrations/feedback_items_internal.sql is HELD (Kevin runs migrations; the
// system is live), so this code must work before the column exists. When it is
// absent the filtered query errors 42703/PGRST204 and we retry WITHOUT the
// filter.
//
// That is safe by construction, not by optimism: if the column does not exist,
// no row can be internal, so `is_internal = false` is vacuously true for every
// row and dropping it changes nothing. The retry is also SELF-CORRECTING for a
// misdetected error — if the failure was really about some other column, the
// retry fails on that same column too and the caller gets the error, never a
// silently unfiltered list. The only way the retry can succeed is if removing
// this filter is what fixed it.

// Does this error mean the is_internal column isn't there yet?
//
// Stricter than lib/feedback-context's isMissingContextColumn, deliberately:
// that one accepts a bare 42703/PGRST204 because a false positive there is
// benign (a report files without its context pointer). Here a false positive
// would skip a VISIBILITY filter, so we require the column to be NAMED. Both
// error shapes do name it —
//   PostgREST: "Could not find the 'is_internal' column of 'feedback_items'
//              in the schema cache"  (PGRST204)
//   Postgres:  "column feedback_items.is_internal does not exist"  (42703)
export function isMissingInternalColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const msg = String(e.message ?? '').toLowerCase()
  if (!msg.includes('is_internal')) return false
  const code = String(e.code ?? '')
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    msg.includes('column') ||
    msg.includes('schema cache')
  )
}

// Is this row internal? Absent or null reads as NOT internal — the pre-migration
// state, where no row can be internal because the column does not exist. Only an
// explicit `true` hides a row.
export function isInternalItem(
  item: { is_internal?: unknown } | null | undefined,
): boolean {
  return item?.is_internal === true
}

// Run a read that references is_internal, retrying once without it when the
// column has not been migrated yet.
//
// `attempt` is called with filterInternal=true first. It must build the SAME
// query both ways apart from the is_internal reference, so the retry differs in
// exactly one predicate and nothing else.
//
// internalSupported reports which path answered, so a caller can log the
// pre-migration case without changing what it returns.
export async function withInternalFallback<T>(
  attempt: (filterInternal: boolean) => Promise<{ data: T | null; error: unknown }>,
): Promise<{ data: T | null; error: unknown; internalSupported: boolean }> {
  const first = await attempt(true)
  if (!first.error) return { ...first, internalSupported: true }
  if (isMissingInternalColumn(first.error)) {
    const retry = await attempt(false)
    return { ...retry, internalSupported: false }
  }
  // A real error. Surface it — never fall through to an unfiltered read.
  return { ...first, internalSupported: true }
}
