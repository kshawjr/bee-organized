// lib/auto-close.ts
// ─────────────────────────────────────────────────────────────
// Auto-close stale enquiries (Kevin's ruling, 2026-09-03).
//
// An enquiry — a website or hand-entered lead, or a Jobber client who filled
// in the website form again — that has had NO EXIT for AUTO_CLOSE_DAYS closes
// itself as Closed Lost, reason "No response". The clock runs from the latest
// of: the enquiry date, the last logged reach-out, the last reopen. The exits
// are the SAME three the Inbox rule will use, so the two can never disagree
// about who is closed:
//
//   1. Jobber: a service request, quote or job dated after the enquiry (or a
//      request / job id stamped on the lead when there was no resubmission).
//      NEVER the bare jobber_client_id — the import stamps one when it adopts
//      a website lead by email, and that person was never sent anywhere.
//   2. Network: a partners row pointing at the lead that was a MOVE
//      (is_customer false). An "add" leaves the person a live enquiry.
//   3. Close: an engagement Closed Won / Closed Lost AFTER the enquiry. A
//      Jobber client closed Lost on import in July who fills in the form in
//      August is a new enquiry.
//
// Never touched, by construction:
//   · the corporate transfer queue (loc_other) — unrouted enquiries are
//     Kevin's to route, not to close — and the test location (loc_test).
//     Both are dropped by slug before anything else is read.
//   · locations whose lifecycle is paused or subscription inactive (the same
//     predicate lib/read-only-access uses): nobody there can act on a close.
//   · a lead whose live drip row is unpaused — a send is due, so the drip
//     finishes first. Paused rows do not hold the close; the close stops them.
//   · a lead with open Jobber work (a non-manual open engagement, or a manual
//     one with a request / quote / job attached): that is being worked.
//
// What a close writes — the "Close, not interested" wizard, step for step:
//   · the open manual, childless engagement(s) go Closed Lost; when there is
//     none, one is founded already closed (founded_by 'manual', title from
//     the ENQUIRY month, not today's).
//   · nothing on the lead row. leads.stage stays as a human close leaves it.
//   · one stage_change touchpoint with no actor (user_id null).
//   · the same three cancels the wizard fires: stop live drips, cancel
//     scheduled stage emails, cancel a pending welcome email.
//   · one sync_log row per close, tagged [engagement:auto-close].
//
// Nothing here can email anyone: no module that sends is imported, and the
// three cancels only write cancelled_at / stopped_at. lib/auto-close.test.ts
// pins that with a spy on lib/resend and on fetch.
//
// The cron route (app/api/cron/auto-close) owns auth, dry-run and the limit.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { stopActiveDripsForLead } from './drip-lifecycle'
import { cancelStageEmails } from './stage-emails'
import { cancelPendingWelcomeEmail } from './welcome-email'
import { writeSyncLog } from './sync-log'

export const AUTO_CLOSE_DAYS = 35
export const AUTO_CLOSE_REASON = 'No response'
export const AUTO_CLOSE_TOUCHPOINT_LABEL = `Closed automatically: no response after ${AUTO_CLOSE_DAYS} days`
export const EXCLUDED_LOCATION_SLUGS = ['loc_other', 'loc_test'] as const
export const RESUBMISSION_LABEL = 'Webform resubmission'

const TERMINAL = new Set(['Closed Won', 'Closed Lost'])
const DAY_MS = 24 * 60 * 60 * 1000
// A request the send-to-jobber route writes lands a few hundred ms after the
// enquiry it answers; the minute of slack keeps that from reading as "before".
const SLACK_MS = 60 * 1000
const CHUNK = 200
const PAGE = 1000

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type SpareReason =
  | 'reach_out_recent'
  | 'reopened_recent'
  | 'location_paused'
  | 'drip_send_due'
  | 'open_jobber_work'

export interface StaleEnquiry {
  leadId: string
  name: string | null
  locationId: string
  locationUuid: string
  enquiryAt: string
  lastActivityAt: string
  ageDays: number
  /** Open manual, childless engagements that the close will move to Closed Lost. */
  openEngagementIds: string[]
}

export interface SparedEnquiry {
  leadId: string
  name: string | null
  locationId: string
  enquiryAt: string
  lastActivityAt: string
  ageDays: number
  reason: SpareReason
}

export interface StaleScan {
  cutoffIso: string
  /** Enquiries the run would close, oldest activity first. */
  toClose: StaleEnquiry[]
  /** Past the clock by enquiry date, but held by a guard. */
  spared: SparedEnquiry[]
}

type LeadRow = {
  id: string
  name: string | null
  location_id: string | null
  location_uuid: string | null
  created_at: string
  import_source: string | null
  is_junk: boolean | null
  archived_at: string | null
  jobber_request_id: string | null
  jobber_job_id: string | null
}

const LEAD_COLS =
  'id, name, location_id, location_uuid, created_at, import_source, is_junk, archived_at, jobber_request_id, jobber_job_id'

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() || 0 : 0)
const chunks = <T,>(xs: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK))
  return out
}
const maxInto = (map: Map<string, number>, key: string, t: number) => {
  if (t > (map.get(key) ?? 0)) map.set(key, t)
}

async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw error
    const got = data ?? []
    rows.push(...got)
    if (got.length < PAGE) return rows
  }
}

/** Title for a founded-closed engagement: the month the ENQUIRY arrived. */
export function enquiryTitle(enquiryAtIso: string): string {
  const d = new Date(enquiryAtIso)
  return `Enquiry – ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function closedNote(enquiryAtIso: string, days = AUTO_CLOSE_DAYS): string {
  const d = new Date(enquiryAtIso)
  const label = `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  return `Closed automatically: no response ${days} days after the enquiry of ${label}.`
}

/**
 * Finds every enquiry whose clock has run out. Read-only.
 * `now` is injectable so the tests and a dry run compute against a fixed
 * instant; the cron passes nothing.
 */
export async function findStaleEnquiries(opts: { now?: Date; days?: number } = {}): Promise<StaleScan> {
  const now = opts.now ?? new Date()
  const days = opts.days ?? AUTO_CLOSE_DAYS
  const cutoffMs = now.getTime() - days * DAY_MS
  const cutoffIso = new Date(cutoffMs).toISOString()
  const excluded = new Set<string>(EXCLUDED_LOCATION_SLUGS)

  // ── 1. Enquiries ──────────────────────────────────────────────
  // Every "Webform resubmission" touchpoint (a repeat form on any lead,
  // Jobber clients included) — the latest one per lead is that lead's enquiry
  // date when it is later than created_at.
  const resubRows = await pageAll<{ lead_id: string; occurred_at: string }>((from, to) =>
    supabaseService
      .from('touchpoints')
      .select('lead_id, occurred_at')
      .eq('kind', 'system')
      .eq('label', RESUBMISSION_LABEL)
      .range(from, to),
  )
  const lastResub = new Map<string, number>()
  for (const r of resubRows) maxInto(lastResub, r.lead_id, ms(r.occurred_at))

  // Hand-entered / website leads old enough on created_at alone …
  const manualLeads = await pageAll<LeadRow>((from, to) =>
    supabaseService
      .from('leads')
      .select(LEAD_COLS)
      .eq('import_source', 'manual')
      .lte('created_at', cutoffIso)
      .range(from, to),
  )
  // … plus every lead with a resubmission (its enquiry date may be later
  // than created_at, or the lead may be a Jobber client).
  const manualIds = new Set(manualLeads.map((l) => l.id))
  const resubIds = Array.from(lastResub.keys()).filter((id) => !manualIds.has(id))
  const resubLeads: LeadRow[] = []
  for (const ids of chunks(resubIds)) {
    const { data, error } = await supabaseService.from('leads').select(LEAD_COLS).in('id', ids)
    if (error) throw error
    resubLeads.push(...((data ?? []) as LeadRow[]))
  }

  const candidates = [...manualLeads, ...resubLeads]
    .filter((l) => l.is_junk !== true && !l.archived_at && !!l.location_uuid && !!l.location_id)
    .filter((l) => !excluded.has(l.location_id as string))
    .map((l) => {
      const enquiryMs = Math.max(ms(l.created_at), lastResub.get(l.id) ?? 0)
      return { lead: l, enquiryMs, hadResub: lastResub.has(l.id) }
    })
    .filter((c) => c.enquiryMs > 0 && c.enquiryMs <= cutoffMs)

  if (candidates.length === 0) return { cutoffIso, toClose: [], spared: [] }

  // ── 2. Everything the exits and guards read, in chunks ────────
  const ids = candidates.map((c) => c.lead.id)
  const lastReach = new Map<string, number>()
  const lastReopen = new Map<string, number>()
  const work = new Map<string, { at: number; engagementId: string | null }[]>() // SR / quote / job per lead
  const networkMove = new Set<string>()
  const engagements = new Map<string, { id: string; stage: string; closed_at: string | null; founded_by: string | null }[]>()
  const dripUnpaused = new Set<string>()

  const push = (id: string, at: number, engagementId: string | null) => {
    const arr = work.get(id) ?? []
    arr.push({ at, engagementId })
    work.set(id, arr)
  }

  for (const chunk of chunks(ids)) {
    const [reach, reopen, srs, quotes, jobs, partners, engs, drips] = await Promise.all([
      supabaseService.from('touchpoints').select('lead_id, occurred_at').eq('kind', 'reach_out').in('lead_id', chunk),
      supabaseService.from('touchpoints').select('lead_id, occurred_at').eq('kind', 'stage_change').like('label', 'Reopened%').in('lead_id', chunk),
      supabaseService.from('service_requests').select('lead_id, requested_at, created_at, engagement_id').in('lead_id', chunk),
      supabaseService.from('quotes').select('lead_id, created_at, engagement_id').in('lead_id', chunk),
      supabaseService.from('jobs').select('lead_id, created_at, engagement_id').in('lead_id', chunk),
      supabaseService.from('partners').select('customer_lead_id, is_customer').is('deleted_at', null).in('customer_lead_id', chunk),
      supabaseService.from('engagements').select('id, client_id, stage, closed_at, founded_by').in('client_id', chunk),
      supabaseService.from('lead_drip_progress').select('lead_id, paused_at').is('stopped_at', null).is('completed_at', null).in('lead_id', chunk),
    ])
    for (const r of [reach, reopen, srs, quotes, jobs, partners, engs, drips]) if (r.error) throw r.error

    for (const t of reach.data ?? []) maxInto(lastReach, t.lead_id, ms(t.occurred_at))
    for (const t of reopen.data ?? []) maxInto(lastReopen, t.lead_id, ms(t.occurred_at))
    for (const s of srs.data ?? []) push(s.lead_id, ms(s.requested_at ?? s.created_at), s.engagement_id ?? null)
    for (const q of quotes.data ?? []) push(q.lead_id, ms(q.created_at), q.engagement_id ?? null)
    for (const j of jobs.data ?? []) push(j.lead_id, ms(j.created_at), j.engagement_id ?? null)
    for (const p of partners.data ?? []) if (p.is_customer !== true) networkMove.add(String(p.customer_lead_id))
    for (const e of engs.data ?? []) {
      const arr = engagements.get(e.client_id) ?? []
      arr.push({ id: e.id, stage: e.stage, closed_at: e.closed_at, founded_by: e.founded_by })
      engagements.set(e.client_id, arr)
    }
    for (const d of drips.data ?? []) if (!d.paused_at) dripUnpaused.add(d.lead_id)
  }

  const locationUuids = Array.from(new Set(candidates.map((c) => c.lead.location_uuid as string)))
  const pausedLocations = new Set<string>()
  for (const chunk of chunks(locationUuids)) {
    const { data, error } = await supabaseService
      .from('locations')
      .select('id, lifecycle_status, subscription_status')
      .in('id', chunk)
    if (error) throw error
    for (const loc of data ?? []) {
      if (loc.lifecycle_status === 'paused' || loc.subscription_status === 'inactive') pausedLocations.add(loc.id)
    }
  }

  // ── 3. Decide ─────────────────────────────────────────────────
  const toClose: StaleEnquiry[] = []
  const spared: SparedEnquiry[] = []

  for (const { lead, enquiryMs, hadResub } of candidates) {
    const since = enquiryMs - SLACK_MS
    const rows = work.get(lead.id) ?? []

    // Exit 1 — sent to Jobber after the enquiry.
    const jobberAfter =
      rows.some((w) => w.at >= since) ||
      (!hadResub && (!!lead.jobber_request_id || !!lead.jobber_job_id))
    if (jobberAfter) continue
    // Exit 2 — moved to the Network.
    if (networkMove.has(lead.id)) continue
    // Exit 3 — closed after the enquiry.
    const engs = engagements.get(lead.id) ?? []
    if (engs.some((e) => TERMINAL.has(e.stage) && ms(e.closed_at) >= since)) continue

    const lastActivityMs = Math.max(enquiryMs, lastReach.get(lead.id) ?? 0, lastReopen.get(lead.id) ?? 0)
    const base = {
      leadId: lead.id,
      name: lead.name,
      locationId: lead.location_id as string,
      enquiryAt: new Date(enquiryMs).toISOString(),
      lastActivityAt: new Date(lastActivityMs).toISOString(),
      ageDays: Math.floor((now.getTime() - lastActivityMs) / DAY_MS),
    }

    // Guards, in the order a reader would ask about them.
    if (lastActivityMs > cutoffMs) {
      const reason: SpareReason =
        (lastReopen.get(lead.id) ?? 0) >= (lastReach.get(lead.id) ?? 0) ? 'reopened_recent' : 'reach_out_recent'
      spared.push({ ...base, reason })
      continue
    }
    if (pausedLocations.has(lead.location_uuid as string)) {
      spared.push({ ...base, reason: 'location_paused' })
      continue
    }
    if (dripUnpaused.has(lead.id)) {
      spared.push({ ...base, reason: 'drip_send_due' })
      continue
    }
    const open = engs.filter((e) => !TERMINAL.has(e.stage))
    const openWithWork = open.some(
      (e) => e.founded_by !== 'manual' || rows.some((w) => w.engagementId === e.id),
    )
    if (openWithWork) {
      spared.push({ ...base, reason: 'open_jobber_work' })
      continue
    }

    toClose.push({
      ...base,
      locationUuid: lead.location_uuid as string,
      openEngagementIds: open.map((e) => e.id),
    })
  }

  toClose.sort((a, b) => ms(a.lastActivityAt) - ms(b.lastActivityAt))
  spared.sort((a, b) => ms(a.lastActivityAt) - ms(b.lastActivityAt))
  return { cutoffIso, toClose, spared }
}

export interface CloseResult {
  leadId: string
  engagementIds: string[]
  /** true when no engagement existed and one was founded already closed. */
  founded: boolean
}

/**
 * Closes ONE stale enquiry. Throws on the engagement write (the caller
 * records the failure and moves on); everything after the engagement write
 * is fail-safe, exactly like the wizard's cancels.
 */
export async function closeStaleEnquiry(item: StaleEnquiry, opts: { now?: Date; days?: number } = {}): Promise<CloseResult> {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const days = opts.days ?? AUTO_CLOSE_DAYS
  const note = closedNote(item.enquiryAt, days)

  let engagementIds: string[]
  let founded = false

  if (item.openEngagementIds.length > 0) {
    const { error } = await supabaseService
      .from('engagements')
      .update({
        stage: 'Closed Lost',
        stage_entered_at: nowIso,
        closed_at: nowIso,
        closed_reason: AUTO_CLOSE_REASON,
        closed_note: note,
        updated_at: nowIso,
      })
      .in('id', item.openEngagementIds)
    if (error) throw error
    engagementIds = item.openEngagementIds
  } else {
    const { data, error } = await supabaseService
      .from('engagements')
      .insert({
        client_id: item.leadId,
        location_uuid: item.locationUuid,
        stage: 'Closed Lost',
        founded_by: 'manual',
        title: enquiryTitle(item.enquiryAt),
        stage_entered_at: nowIso,
        closed_at: nowIso,
        closed_reason: AUTO_CLOSE_REASON,
        closed_note: note,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select('id')
      .single()
    if (error || !data) throw error ?? new Error('engagement insert returned no row')
    engagementIds = [data.id]
    founded = true
  }

  // One stage_change touchpoint, no actor. Failure is non-fatal: the close
  // itself has committed, same as the human close route.
  const { error: tpError } = await supabaseService.from('touchpoints').insert({
    lead_id: item.leadId,
    location_uuid: item.locationUuid,
    engagement_id: engagementIds[0],
    kind: 'stage_change',
    label: AUTO_CLOSE_TOUCHPOINT_LABEL,
    user_id: null,
    occurred_at: nowIso,
  })
  if (tpError) console.error('[auto-close] touchpoint insert failed', { leadId: item.leadId, tpError })

  // The wizard's three cancels, reason closed_lost. Each swallows its own
  // errors and never sends anything.
  await Promise.all([
    stopActiveDripsForLead(item.leadId, 'closed_lost'),
    cancelStageEmails({ leadId: item.leadId, reason: 'closed_lost' }),
    cancelPendingWelcomeEmail(item.leadId, 'closed_lost'),
  ])

  await writeSyncLog({
    location_id: item.locationId,
    entity_id: engagementIds[0],
    entity_type: 'engagement',
    status: 'success',
    message:
      `[engagement:auto-close] Closed Lost reason=${AUTO_CLOSE_REASON}` +
      ` — lead ${item.leadId} enquiry ${item.enquiryAt} last activity ${item.lastActivityAt}` +
      ` (${item.ageDays}d)${founded ? ' — engagement founded closed' : ` — closed ${engagementIds.length} open`}`,
  })

  return { leadId: item.leadId, engagementIds, founded }
}
