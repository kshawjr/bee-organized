// lib/template-fork.ts
// ─────────────────────────────────────────────────────────────
// ONE definition of "which wording does this location actually send?".
//
// A corp master is a `templates` row with location_uuid IS NULL and a
// legacy_id (e.g. 'welcome', 'opp_closed_job_3mo'). A location customises it
// by DUPLICATING the row: the copy gets location_uuid SET and legacy_id NULL,
// because legacy_id is UNIQUE and reserved for masters. A fork therefore
// matches NEITHER master predicate — the only link back is cloned_from_id.
//
// THE RULE, in full:
//   own fork of THIS master, for THIS location, is_active, newest
//   updated_at wins (Duplicate can be pressed more than once)
//   — otherwise the master.
// Read errors fall back to the master rather than throwing: a template lookup
// failing should not stop a send that has a perfectly good default.
//
// WHY THIS FILE EXISTS (issue 240 step 8). The rule was implemented four
// times — lib/stage-emails.ts, lib/welcome-email.ts (private and unexported),
// inline in app/api/leads/[id]/timeline/route.ts, and client-side in
// buildEmailList. Step 8 adds the first WRITES on top of it, and four copies
// of a rule that decides what a client receives is how they drift. Extracted
// before any write path was built, deliberately as its own commit.
//
// The client-side copy in components/BeeHub.jsx cannot import this (it runs in
// the browser against an already-fetched array, not against supabaseService),
// so it stays a mirror — but it is now a mirror of ONE named thing rather than
// a fourth independent implementation. lib/beta-template-fork.test.ts pins the
// two against each other.

import { supabaseService } from './supabase-service'

export type TemplateFork = {
  subject: string | null
  body: string | null
}

type ForkRow = {
  subject: string | null
  body: string | null
  cloned_from_id: string
  updated_at: string | null
}

// Batch form: master id → its active fork for this location, newest first.
// Masters with no fork are simply absent from the map.
export async function resolveLocationTemplateForks(
  masterIds: string[],
  locationUuid: string | null | undefined,
  logPrefix = '[template-fork]',
): Promise<Map<string, TemplateFork>> {
  const out = new Map<string, TemplateFork>()
  if (!locationUuid || !masterIds.length) return out

  const { data, error } = await supabaseService
    .from('templates')
    .select('subject, body, cloned_from_id, updated_at')
    .eq('location_uuid', locationUuid)
    .eq('is_active', true)
    .in('cloned_from_id', masterIds)
    .order('updated_at', { ascending: false })

  if (error) {
    // Fall back to masters everywhere rather than failing the caller.
    console.warn(`${logPrefix} fork lookup failed — falling back to master`, {
      masterIds, locationUuid, error,
    })
    return out
  }

  // Ordered newest-first, so the FIRST row seen for a master is the winner.
  for (const row of (data ?? []) as ForkRow[]) {
    if (!row.cloned_from_id || out.has(row.cloned_from_id)) continue
    out.set(row.cloned_from_id, { subject: row.subject ?? null, body: row.body ?? null })
  }
  return out
}

// Single form — the shape both send paths want. Returns null when there is no
// fork, which every caller reads as "use the master".
//
// Deliberately issues its OWN query rather than delegating to the batch. The
// batch keys its map on cloned_from_id and so must select it; the single form
// already knows which master it asked about and does not. Routing the send
// paths through the batch would have changed the row shape they receive — the
// two live here together so the rule is still stated once, but the query the
// send paths make is byte-for-byte what it was before this extraction, which
// is the point on a step that changes what clients receive.
export async function resolveLocationTemplateFork(
  masterId: string,
  locationUuid: string | null | undefined,
  logPrefix = '[template-fork]',
): Promise<TemplateFork | null> {
  if (!locationUuid) return null
  const { data, error } = await supabaseService
    .from('templates')
    .select('subject, body')
    .eq('cloned_from_id', masterId)
    .eq('location_uuid', locationUuid)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) {
    console.warn(`${logPrefix} fork lookup failed — falling back to master`, {
      masterId, locationUuid, error,
    })
    return null
  }
  return data && data.length > 0 ? (data[0] as TemplateFork) : null
}

// The merge both send paths perform: fork wins field-by-field, master fills
// the gaps. Kept here so "which fields fork" is stated once — subject and body
// only. `name` deliberately does NOT fork: it is the touchpoint/timeline label
// and stays the master's, and the CAN-SPAM and branded-wrapper decisions stay
// keyed on the immutable stage_email_key, so an edited body can neither
// restyle a commercial email nor strip its footer.
export function mergeForkOverMaster<T extends { subject: string | null; body: string | null }>(
  master: T,
  fork: TemplateFork | null,
): { subject: string | null; body: string | null } {
  return {
    subject: fork?.subject ?? master.subject,
    body: fork?.body ?? master.body,
  }
}
