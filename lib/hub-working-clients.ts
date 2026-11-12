// lib/hub-working-clients.ts
// ─────────────────────────────────────────────────────────────
// Clients at scale, slice 2 — nobody being worked is missing from the list.
//
// THE PROBLEM. The page loads a location's newest 5,000 clients
// (app/_hub-page.tsx MAX_LEADS). At Philadelphia Suburbs that leaves 13,931
// out of the Client List. Nearly all of them are old imported contacts
// (Nurturing) — but a client with an open job, or who has paid, was missing
// too, simply because their record is old.
//
// THE FIX. On a cut-off load ONLY, also load every older client who belongs
// in a band other than Nurturing. Who that is can be read without loading
// everyone, because each such band has a small, direct marker:
//
//   Active       an open engagement              engagements (no ceiling)
//   Client       a Closed Won engagement         engagements
//   Past         paid history                    leads.paid_amount > 0
//   No contact   no email and no phone           leads.email / leads.phone
//   New /        an open enquiry: a hand-entered  leads.import_source = 'manual'
//   Attempting   or website lead, or anyone who   touchpoints 'Webform resubmission'
//                filled in the website form again
//
// Those markers are CANDIDATES, not verdicts: a hand-entered lead that was
// closed long ago is Nurturing. The page maps the candidates like any other
// lead and keepWorkingClients() then asks the ONE derivation the list itself
// uses (deriveClientStatus) and drops whoever it calls Nurturing. So nobody is
// dragged in by a marker alone, and this file never decides a band.
//
// A LOCATION UNDER THE CEILING IS UNTOUCHED. With `truncated` false this
// makes no query at all and hands back nothing to add — 45 of 46 locations.
//
// THE FENCE. Every leads read here goes through applyLeadActiveFilter (not
// junk, not archived — the page load's own rule) and .eq('location_uuid').
// Engagement and touchpoint rows only ever supply candidate IDS; an id only
// becomes a loaded client by coming back through that fenced leads read.
// ─────────────────────────────────────────────────────────────

import { applyLeadActiveFilter } from './lead-suppression'
import { WEBFORM_RESUBMISSION_LABEL } from './enquiry-exit'
import { isTerminalStage } from './engagement-rollup'
import { deriveClientStatus as deriveClientStatusUntyped } from '@/components/hive/shared/clientStatus'

const deriveClientStatus = deriveClientStatusUntyped as (
  person: any, openClientIds: Set<string> | null, nowMs?: number, wonClientIds?: Set<string> | null
) => string

// Payload guard, not a data policy. Philadelphia Suburbs needs 8 today. Past
// this the result is marked incomplete and the screen stops claiming the
// bands are whole.
export const WORKING_CLIENTS_MAX = 2000
const PAGE = 1000
const ID_CHUNK = 100

export type WorkingClients = {
  /** Lead rows to load in addition to the newest 5,000. */
  extraRows: any[]
  extraIds: Set<string>
  /** Clients with an open engagement at this location (for the derivation). */
  openClientIds: Set<string>
  /** Every not-junk, not-archived client at the location. Null if not counted. */
  totalActive: number | null
  /** created_at of the oldest client the ordinary load holds. */
  loadedBackTo: string | null
  /** False when a read failed or the guard was hit: the bands may be short. */
  complete: boolean
}

const NOTHING = (): WorkingClients => ({
  extraRows: [], extraIds: new Set(), openClientIds: new Set(), totalActive: null, loadedBackTo: null, complete: true,
})

export async function fetchWorkingClients(
  db: any,
  opts: { truncated: boolean; locationUuid: string | null | undefined; loadedRows: any[] | null | undefined },
): Promise<WorkingClients> {
  const out = NOTHING()
  // Under the ceiling — or with no single location to fence to — do nothing.
  if (!opts.truncated || !opts.locationUuid || !opts.loadedRows || opts.loadedRows.length === 0) return out
  const locationUuid = opts.locationUuid
  const loadedIds = new Set<string>(opts.loadedRows.map((r: any) => r.id))
  let loadedBackTo: string | null = null
  for (const r of opts.loadedRows) if (r.created_at && (loadedBackTo === null || r.created_at < loadedBackTo)) loadedBackTo = r.created_at
  out.loadedBackTo = loadedBackTo

  const fail = (what: string, message: string) => {
    out.complete = false
    console.error(`[hub-page] working-clients: ${what} failed for ${locationUuid}: ${message} — the Client List bands may be SHORT`)
  }
  const fenced = (q: any) => applyLeadActiveFilter(q).eq('location_uuid', locationUuid)

  // Candidate ids, in the order they matter if the guard ever bites.
  const open = new Set<string>(), won = new Set<string>(), resub = new Set<string>()
  const paid = new Set<string>(), noContact = new Set<string>(), manual = new Set<string>()

  const engagements = async () => {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('engagements').select('id, client_id, stage')
        .eq('location_uuid', locationUuid)
        .order('id', { ascending: true }).range(from, from + PAGE - 1)
      if (error) return fail('engagements read', error.message)
      for (const e of data || []) {
        if (!e.client_id) continue
        if (!isTerminalStage(e.stage)) open.add(e.client_id)
        else if (e.stage === 'Closed Won') won.add(e.client_id)
      }
      if ((data || []).length < PAGE) return
    }
  }
  const resubmissions = async () => {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('touchpoints').select('id, lead_id')
        .eq('location_uuid', locationUuid).eq('label', WEBFORM_RESUBMISSION_LABEL)
        .order('id', { ascending: true }).range(from, from + PAGE - 1)
      if (error) return fail('resubmission read', error.message)
      for (const t of data || []) if (t.lead_id) resub.add(t.lead_id)
      if ((data || []).length < PAGE) return
    }
  }
  // Older-than-the-load leads carrying a marker. Inclusive of the cut-off
  // timestamp (thousands of imported clients share one); already-loaded ids
  // are dropped below.
  const leadIds = async (what: string, into: Set<string>, narrow: (q: any) => any) => {
    for (let from = 0; ; from += PAGE) {
      let q = narrow(fenced(db.from('leads').select('id')))
      if (loadedBackTo) q = q.lte('created_at', loadedBackTo)
      const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1)
      if (error) return fail(`${what} read`, error.message)
      for (const r of data || []) into.add(r.id)
      if ((data || []).length < PAGE) return
      if (into.size >= WORKING_CLIENTS_MAX * 2) return fail(`${what} read`, 'too many candidates')
    }
  }
  const count = async () => {
    const { count: n, error } = await fenced(db.from('leads').select('id', { count: 'exact', head: true }))
    if (error) return fail('client count', error.message)
    out.totalActive = typeof n === 'number' ? n : null
  }

  await Promise.all([
    engagements(),
    resubmissions(),
    leadIds('paid-history', paid, (q) => q.gt('paid_amount', 0)),
    // No email AND no phone — two or-groups, which PostgREST ANDs together.
    leadIds('no-contact', noContact, (q) => q.or('email.is.null,email.eq.').or('phone.is.null,phone.eq.')),
    leadIds('enquiry', manual, (q) => q.eq('import_source', 'manual')),
    count(),
  ])
  out.openClientIds = open

  const wanted: string[] = []
  const seen = new Set<string>()
  for (const set of [open, won, resub, paid, noContact, manual]) {
    for (const id of Array.from(set)) {
      if (loadedIds.has(id) || seen.has(id)) continue
      seen.add(id); wanted.push(id)
    }
  }
  let ids = wanted
  if (ids.length > WORKING_CLIENTS_MAX) {
    fail('candidate set', `${ids.length} candidates is over the ${WORKING_CLIENTS_MAX} guard`)
    ids = ids.slice(0, WORKING_CLIENTS_MAX)
  }

  // The full rows — through the fence. This read is what makes an id a
  // client of THIS location that is neither junk nor archived.
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await fenced(db.from('leads').select('*')).in('id', ids.slice(i, i + ID_CHUNK))
    if (error) { fail('lead rows read', error.message); continue }
    for (const r of data || []) {
      if (loadedIds.has(r.id) || out.extraIds.has(r.id)) continue
      out.extraIds.add(r.id); out.extraRows.push(r)
    }
  }
  return out
}

// After the page has mapped every lead: drop the extra clients the list's own
// derivation calls Nurturing. Clients from the ordinary load are never
// touched, and with no extras the SAME array comes back.
export function keepWorkingClients<P extends { id: string }>(
  people: P[], working: Pick<WorkingClients, 'extraIds' | 'openClientIds'>, nowMs: number = Date.now(),
): P[] {
  if (working.extraIds.size === 0) return people
  return people.filter((p) =>
    !working.extraIds.has(p.id) || deriveClientStatus(p, working.openClientIds, nowMs, null) !== 'Nurturing')
}

// What the page tells the Client List about a cut-off load. Null on a
// complete load. `notListed` is how many clients are at the location but not
// in the list — every one of them Nurturing, which is only true (and only
// stated) when the working-clients read was complete; otherwise null and the
// screen says the list is partial without putting a number on a band.
export type ClientsCutoff = { loadedBackTo: string | null; notListed: number | null }

export function clientsCutoffFor(
  truncated: boolean, working: WorkingClients, listedCount: number,
): ClientsCutoff | null {
  if (!truncated) return null
  const exact = working.complete && typeof working.totalActive === 'number'
  return {
    loadedBackTo: working.loadedBackTo,
    notListed: exact ? Math.max(0, (working.totalActive as number) - listedCount) : null,
  }
}
