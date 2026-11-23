// lib/network/partner-sequence-start.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 5 (2026-11-23) — START AND STOP A PARTNER ON A
// SEQUENCE, from their Network contact. The route is
// app/api/network/contacts/[id]/sequences; this file holds the rules so they
// can be tested on their own and against a real Postgres copy.
//
// THE BROWSER SENDS A SEQUENCE NAME (its key, e.g. "partner-introduction"),
// NEVER AN ID. Which copy is used is decided here, the same way a client is
// enrolled (lib/drip-lifecycle.ts startDrip): the location's own copy of that
// key if it has one that is switched on, else the company-wide master. No
// special case for masters: a master is what every location uses today.
//
// START REFUSES (each one asked here, on the server, before anything is written):
//   not_a_partner_sequence       a client sequence key, or anything that is not "partner-…"
//   sequence_not_found           no copy and no master of that key (removed)
//   sequence_paused              the only copy there is, is switched off
//   sequence_has_no_first_email  the sequence has no emails
//   sequence_wrong_location      the chosen copy belongs to another location
//                                (cannot be chosen by the lookup; second lock,
//                                and the database refuses it too)
//   partner_cannot_receive       no email address, unsubscribed (here or at any
//                                location with the same address), deleted
//   already_on_sequence          the partner is on it now
//   location_not_active          the location is not active on Bee Hub
//   not_a_referral_partner       the contact is not a Referral partner
// and the caller must be allowed to change Network records at the PARTNER's
// location (lib/network/route-access.ts), checked by the route.
//
// RESTARTING. A partner who finished or was stopped can be started again: the
// same row goes back to the FIRST email, sent again (the screen says so).
// A row the partner unsubscribed from can never be restarted (the database
// refuses it as well).
//
// STOP ends the sequence for that partner: the row is stopped, nothing more
// is sent. A send already under way when Stop is pressed cannot bring it back
// (lib/network/partner-drip-send.ts releaseClaim matches only its own claim).
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'
import { nextSendAt } from '@/lib/drip-time'
import { timingLabel } from '@/lib/email-timing'
import { isPartnerPathKey, PARTNER_SEQUENCES } from '@/lib/partner-sequences'
import { normalizeTypes } from './types'
import { partnerCanReceive, partnerSendBlockReason } from './partner-email-eligibility'
import { sendPartnerDripStep, PARTNER_PROGRESS_TABLE, type PartnerSendResult } from './partner-drip-send'

export const START_REFUSALS = [
  'not_a_partner_sequence', 'sequence_not_found', 'sequence_paused', 'sequence_has_no_first_email',
  'sequence_wrong_location', 'partner_cannot_receive', 'already_on_sequence', 'location_not_active', 'not_a_referral_partner',
] as const
export type StartRefusal = (typeof START_REFUSALS)[number]

// What each sequence is for, in the picker.
export const SEQUENCE_DESCRIPTIONS: Record<string, string> = {
  'partner-introduction': 'A thank-you right away, then a check-in three months later.',
  'partner-power-introduction': 'One email for a Power Partner, sent right away.',
}

type PathRow = { id: string; path_key: string; name: string | null; location_uuid: string | null; is_master: boolean | null; is_active: boolean | null }
type StepRow = { step_order: number; delay_days: number | null; delay_unit?: string | null; subject: string | null; is_active?: boolean | null; is_paused?: boolean | null; channel?: string | null }

const PATH_COLS = 'id, path_key, name, location_uuid, is_master, is_active'

/**
 * Which copy of `pathKey` a partner at `locationId` is put on: the location's
 * own copy if it has one switched on, else the master switched on — exactly
 * lib/drip-lifecycle.ts startDrip's two reads. When neither is on, says
 * whether one exists switched off (paused) or none exists (removed).
 */
export async function choosePartnerPath(locationId: string, pathKey: string):
  Promise<{ ok: true; path: PathRow } | { ok: false; error: 'sequence_not_found' | 'sequence_paused' | 'lookup_failed' }> {
  const copy = await supabaseService.from('drip_paths').select(PATH_COLS)
    .eq('location_uuid', locationId).eq('path_key', pathKey).eq('is_active', true).maybeSingle()
  if (copy.error) return { ok: false, error: 'lookup_failed' }
  if (copy.data) return { ok: true, path: copy.data as PathRow }
  const master = await supabaseService.from('drip_paths').select(PATH_COLS)
    .eq('is_master', true).eq('path_key', pathKey).eq('is_active', true).maybeSingle()
  if (master.error) return { ok: false, error: 'lookup_failed' }
  if (master.data) return { ok: true, path: master.data as PathRow }
  // Neither is on. Is there one switched off (here or the master)?
  const [offCopy, offMaster] = await Promise.all([
    supabaseService.from('drip_paths').select('id').eq('location_uuid', locationId).eq('path_key', pathKey).eq('is_active', false).limit(1),
    supabaseService.from('drip_paths').select('id').eq('is_master', true).eq('path_key', pathKey).eq('is_active', false).limit(1),
  ])
  if (offCopy.error || offMaster.error) return { ok: false, error: 'lookup_failed' }
  const any = (r: { data: unknown }) => Array.isArray(r.data) ? r.data.length > 0 : !!r.data
  return { ok: false, error: any(offCopy) || any(offMaster) ? 'sequence_paused' : 'sequence_not_found' }
}

async function stepsOf(pathId: string) {
  return supabaseService.from('drip_path_steps')
    .select('step_order, delay_days, delay_unit, subject, is_active, is_paused, channel')
    .eq('drip_path_id', pathId)
    .order('step_order', { ascending: true })
}

export type StartResult =
  | { ok: true; progressId: string; pathId: string; usedCopy: 'location' | 'master'; restarted: boolean; firstEmail: PartnerSendResult | null }
  | { ok: false; status: number; error: StartRefusal | 'contact_not_found' | 'lookup_failed' | 'start_failed'; reason?: string | null }

/**
 * Start `partnerId` on the sequence named `pathKey`. The caller (the route)
 * has already checked who is asking; this checks everything about the
 * partner, the location and the sequence, then writes ONE row (or restarts
 * the partner's finished/stopped row) and sends the first email if it is due
 * now (the same send the hourly job makes; the claim means never twice).
 */
export async function startPartnerSequence(args: { partnerId: string; pathKey: unknown; startedBy: string | null; sendNow?: boolean }): Promise<StartResult> {
  const { partnerId, startedBy } = args
  const pathKey = args.pathKey
  if (typeof pathKey !== 'string' || !isPartnerPathKey(pathKey)) return { ok: false, status: 400, error: 'not_a_partner_sequence' }

  const { data: partner, error: pErr } = await supabaseService.from('partners')
    .select('id, location_id, deleted_at, network_types').eq('id', partnerId).maybeSingle()
  if (pErr) return { ok: false, status: 500, error: 'lookup_failed' }
  if (!partner || (partner as any).deleted_at) return { ok: false, status: 404, error: 'contact_not_found' }
  const locationId = (partner as any).location_id as string
  if (!normalizeTypes((partner as any).network_types).includes('partner')) return { ok: false, status: 409, error: 'not_a_referral_partner' }

  const { data: loc, error: lErr } = await supabaseService.from('locations')
    .select('id, timezone, lifecycle_status').eq('id', locationId).maybeSingle()
  if (lErr) return { ok: false, status: 500, error: 'lookup_failed' }
  if (!loc || (loc as any).lifecycle_status !== 'active') return { ok: false, status: 409, error: 'location_not_active' }

  // The one eligibility check (asks the database; fails closed).
  if (!(await partnerCanReceive(supabaseService, partnerId, 'start'))) {
    return { ok: false, status: 409, error: 'partner_cannot_receive', reason: await partnerSendBlockReason(supabaseService, partnerId) }
  }

  const chosen = await choosePartnerPath(locationId, pathKey)
  if (!chosen.ok) return chosen.error === 'lookup_failed'
    ? { ok: false, status: 500, error: 'lookup_failed' }
    : { ok: false, status: 409, error: chosen.error }
  const path = chosen.path
  // Second lock (the lookup cannot pick it; the database refuses it too).
  if (!isPartnerPathKey(path.path_key)) return { ok: false, status: 400, error: 'not_a_partner_sequence' }
  if (path.location_uuid && path.location_uuid !== locationId) return { ok: false, status: 409, error: 'sequence_wrong_location' }

  // The first email is the lowest-numbered one (as for a client).
  const { data: steps, error: sErr } = await stepsOf(path.id)
  if (sErr) return { ok: false, status: 500, error: 'lookup_failed' }
  const first = ((steps ?? []) as StepRow[])[0]
  if (!first) return { ok: false, status: 409, error: 'sequence_has_no_first_email' }

  const delayDays = first.delay_days ?? 0
  const now = new Date()
  const next = delayDays === 0 ? now : nextSendAt({ from: now, tz: (loc as any).timezone ?? 'UTC', delayDays })

  // Already on it? One row per partner per sequence (the database's rule).
  const { data: existing, error: eErr } = await supabaseService.from(PARTNER_PROGRESS_TABLE)
    .select('id, status').eq('partner_id', partnerId).eq('path_key', path.path_key).maybeSingle()
  if (eErr) return { ok: false, status: 500, error: 'lookup_failed' }
  const fresh = {
    drip_path_id: path.id, current_step: first.step_order, status: 'active', next_send_at: next.toISOString(),
    last_sent_at: null, started_at: now.toISOString(), started_by: startedBy, stopped_at: null, stopped_reason: null, completed_at: null,
  }
  let progressId: string
  let restarted = false
  if (existing) {
    const st = (existing as any).status
    if (st === 'active') return { ok: false, status: 409, error: 'already_on_sequence' }
    if (st === 'unsubscribed') return { ok: false, status: 409, error: 'partner_cannot_receive', reason: 'unsubscribed' }
    // Finished or stopped: back to the first email. Matches only the row as
    // it was read, so two presses at once restart it once.
    const { data: upd, error: uErr } = await supabaseService.from(PARTNER_PROGRESS_TABLE)
      .update(fresh).eq('id', (existing as any).id).eq('status', st).select('id')
    if (uErr) return dbRefusal(uErr)
    if (!Array.isArray(upd) || upd.length !== 1) return { ok: false, status: 409, error: 'already_on_sequence' }
    progressId = (existing as any).id
    restarted = true
  } else {
    const { data: ins, error: iErr } = await supabaseService.from(PARTNER_PROGRESS_TABLE)
      .insert({ partner_id: partnerId, ...fresh }).select('id')
    if (iErr) return dbRefusal(iErr)
    progressId = (Array.isArray(ins) ? ins[0] : ins as any)?.id
    if (!progressId) return { ok: false, status: 500, error: 'start_failed' }
  }

  // The first email, now, if it is due now. The hourly job would send it at
  // :30 anyway; the claim means the two can never both send it.
  let firstEmail: PartnerSendResult | null = null
  if (args.sendNow !== false && next.getTime() <= Date.now()) {
    try { firstEmail = await sendPartnerDripStep(progressId) } catch (e) { firstEmail = { sent: false, error: `threw: ${e instanceof Error ? e.message : String(e)}` } }
  }
  return { ok: true, progressId, pathId: path.id, usedCopy: path.location_uuid ? 'location' : 'master', restarted, firstEmail }
}

function dbRefusal(err: { message?: string; code?: string }): StartResult {
  const m = err.message || ''
  if (err.code === '23505' || /partner_drip_progress_one_per_sequence/.test(m)) return { ok: false, status: 409, error: 'already_on_sequence' }
  if (/partner_cannot_receive/.test(m)) return { ok: false, status: 409, error: 'partner_cannot_receive', reason: (/partner_cannot_receive: (\w+)/.exec(m) || [])[1] ?? null }
  if (/partner_unsubscribe_is_final/.test(m)) return { ok: false, status: 409, error: 'partner_cannot_receive', reason: 'unsubscribed' }
  if (/partner_path_wrong_location/.test(m)) return { ok: false, status: 409, error: 'sequence_wrong_location' }
  if (/partner_path_required/.test(m)) return { ok: false, status: 400, error: 'not_a_partner_sequence' }
  console.error('[partner-sequence] start write failed', m)
  return { ok: false, status: 500, error: 'start_failed' }
}

export type StopResult =
  | { ok: true; emailInFlight: boolean; lastEmailInFlight: boolean }
  | { ok: false; status: number; error: 'not_a_partner_sequence' | 'not_on_sequence' | 'stop_failed' }

// AN EMAIL IN FLIGHT. The sender claims a row BEFORE it hands the email to
// Resend (lib/network/partner-drip-send.ts claimRow): for the next email the
// row stays "active" with last_sent_at = the claim time; for the LAST email
// it is marked "completed" (completed_at = the claim time). If the send then
// fails, the claim is handed back as "active" and the next run tries again.
// So Stop takes, in ONE update (no gap a hand-back can slip through):
//   · an "active" row, and
//   · a row that turned "completed" in the last STOP_IN_FLIGHT_MINUTES
//     (its last email may be in flight).
// Either way it becomes "stopped"; the hand-back then no longer matches (it
// needs the row exactly as claimed) and nothing more is sent. An email that
// was already with Resend may still arrive: the answer says so
// (emailInFlight), from the row's own claim times. A send never runs longer
// than its function's time limit: maxDuration 300 s on the partner cron
// (app/api/cron/send-partner-emails) and 60 s on the Start route, both well
// under this window.
export const STOP_IN_FLIGHT_MINUTES = 15

/**
 * Stop `partnerId` on the sequence named `pathKey`: nothing more is sent.
 * Works at any moment, also while an email of it is being sent (see above).
 */
export async function stopPartnerSequence(args: { partnerId: string; pathKey: unknown }): Promise<StopResult> {
  if (typeof args.pathKey !== 'string' || !isPartnerPathKey(args.pathKey)) return { ok: false, status: 400, error: 'not_a_partner_sequence' }
  const now = new Date()
  const since = new Date(now.getTime() - STOP_IN_FLIGHT_MINUTES * 60_000).toISOString()
  const { data, error } = await supabaseService.from(PARTNER_PROGRESS_TABLE)
    .update({ status: 'stopped', stopped_at: now.toISOString(), stopped_reason: 'owner_stopped', next_send_at: null })
    .eq('partner_id', args.partnerId).eq('path_key', args.pathKey)
    .or(`status.eq.active,and(status.eq.completed,completed_at.gte.${since})`)
    .select('id, completed_at, last_sent_at')
  if (error) { console.error('[partner-sequence] stop failed', error.message); return { ok: false, status: 500, error: 'stop_failed' } }
  const row = Array.isArray(data) ? (data[0] as { completed_at: string | null; last_sent_at: string | null } | undefined) : undefined
  if (!row) return { ok: false, status: 409, error: 'not_on_sequence' }
  // completed_at is only kept on a row that was "completed" (an active row has none).
  const lastEmailInFlight = !!row.completed_at
  const recent = (t: string | null) => !!t && Date.parse(t) >= Date.parse(since)
  return { ok: true, lastEmailInFlight, emailInFlight: lastEmailInFlight || recent(row.last_sent_at) }
}

/** What the contact sheet shows: the sequences that can be started, and where this partner is on each. */
export async function partnerSequencesView(partnerId: string, locationId: string) {
  const [blockReason, loc, rows] = await Promise.all([
    partnerSendBlockReason(supabaseService, partnerId),
    supabaseService.from('locations').select('lifecycle_status').eq('id', locationId).maybeSingle(),
    supabaseService.from(PARTNER_PROGRESS_TABLE)
      .select('id, drip_path_id, path_key, current_step, status, next_send_at, last_sent_at, started_at, stopped_at, stopped_reason, completed_at')
      .eq('partner_id', partnerId),
  ])
  if (loc.error || rows.error) return { error: (loc.error || rows.error)!.message }
  const sequences = []
  for (const s of PARTNER_SEQUENCES) {
    const chosen = await choosePartnerPath(locationId, s.pathKey)
    if (!chosen.ok) { sequences.push({ pathKey: s.pathKey, name: s.name, description: SEQUENCE_DESCRIPTIONS[s.pathKey] ?? '', available: false, why: chosen.error, emails: [] }); continue }
    const { data: steps } = await stepsOf(chosen.path.id)
    sequences.push({
      pathKey: s.pathKey, name: chosen.path.name || s.name, description: SEQUENCE_DESCRIPTIONS[s.pathKey] ?? '', available: true, why: null,
      copy: chosen.path.location_uuid ? 'location' : 'master',
      emails: ((steps ?? []) as StepRow[]).filter((x) => (x.channel ?? 'email') === 'email').map((x) => ({
        order: x.step_order, when: timingLabel(x.delay_days ?? 0, x.delay_unit), subject: x.subject || 'No subject',
        removed: x.is_active === false, paused: x.is_paused === true,
      })),
    })
  }
  const progress = []
  for (const r of (rows.data ?? []) as any[]) {
    const { data: steps } = await stepsOf(r.drip_path_id)
    const orders = ((steps ?? []) as StepRow[]).filter((x) => (x.channel ?? 'email') === 'email').map((x) => x.step_order)
    const total = orders.length
    const sent = r.status === 'completed' ? total : orders.filter((o) => o < r.current_step).length
    progress.push({
      pathKey: r.path_key, name: (PARTNER_SEQUENCES.find((s) => s.pathKey === r.path_key)?.name) ?? r.path_key,
      status: r.status, step: Math.min(total, sent + (r.status === 'active' ? 1 : 0)) || (total ? 1 : 0), total, sent,
      nextSendAt: r.status === 'active' ? r.next_send_at : null, lastSentAt: r.last_sent_at, startedAt: r.started_at,
      stoppedAt: r.stopped_at, stoppedReason: r.stopped_reason, completedAt: r.completed_at,
    })
  }
  return { canReceive: blockReason === null, blockReason, locationActive: (loc.data as any)?.lifecycle_status === 'active', sequences, progress }
}

// ── STUCK SEQUENCES ─────────────────────────────────────────────────────────
// A partner sequence that is active and whose next email is more than
// OVERDUE_MARGIN_HOURS late. The job runs every hour at :30, so an email due at
// 10:00 goes at 10:30; two hours late means at least one run passed it by (a
// hold, a failing send, the job not running). Counted, never acted on.
export const OVERDUE_MARGIN_HOURS = 2
export async function overduePartnerSequences(now = new Date()): Promise<{ count: number; oldestDue: string | null } | { error: string }> {
  const cutoff = new Date(now.getTime() - OVERDUE_MARGIN_HOURS * 3600_000).toISOString()
  const [c, o] = await Promise.all([
    supabaseService.from(PARTNER_PROGRESS_TABLE).select('id', { count: 'exact', head: true }).eq('status', 'active').lt('next_send_at', cutoff),
    supabaseService.from(PARTNER_PROGRESS_TABLE).select('next_send_at').eq('status', 'active').lt('next_send_at', cutoff).order('next_send_at', { ascending: true }).limit(1),
  ])
  if (c.error || o.error) return { error: (c.error || o.error)!.message }
  const oldest = Array.isArray(o.data) ? (o.data[0] as any)?.next_send_at ?? null : (o.data as any)?.next_send_at ?? null
  return { count: (c as any).count ?? 0, oldestDue: oldest }
}
