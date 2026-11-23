// lib/network/partner-drip-send.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 4 (2026-11-22) — THE PARTNER SENDER. Sends the next
// email of a partner sequence (Email 500 / 501, or 502) to a referral
// partner, from the location, and moves the partner on.
//
// It runs the client sender's code for everything the two have in common
// (lib/drip-send-shared.ts: the step and its template, the location, the
// interface-active gate, the step's wording and shape, the button, the look,
// when the next email goes, what a refused send means) and the one partner
// path for the finished email (lib/network/partner-email.ts buildPartnerEmail:
// body + signature + layout + the unsubscribe footer). The client sender
// (lib/drip-send.ts) is unchanged in what it does, byte for byte
// (lib/network/client-drip-send-bytes.test.ts).
//
// Tracking is partner_drip_progress only. The client tracking table is never
// read or written here.
//
// THE RULES, each one a lock:
//   · who: partnerCanReceive (lib/network/partner-email-eligibility.ts) is
//     asked before the email is built and again right before it goes. It asks
//     the database, which knows about an unsubscribe by link, by an owner's
//     mark, and at ANY location with the same address. No email address → no
//     send. Fails closed. Every skip is logged with its reason.
//   · the footer: every email is built by buildPartnerEmail, which cannot be
//     called without the unsubscribe link and the postal address, and the
//     finished email is checked for both before it goes. No key, no postal
//     address, no app address → HELD, never sent without.
//   · who signs: the location's primary owner if they are active AT THIS
//     LOCATION, else the location itself (resolveEmailSigner with no
//     assignee — a partner has none). {{location_owner_name}} is that same
//     person, or blank: it never names someone who is not on the location.
//   · the button: a client booking link (Discovery, In-home, Video, the
//     owner's booking link) is refused here, the second lock behind the save
//     route (app/api/drip-path-steps/[stepId]).
//   · NEVER TWICE: before the email goes, the row is CLAIMED — moved on to the
//     next step (or completed) by ONE conditional update that only matches
//     the row exactly as it was read (active, this step, this due time). Two
//     runs at the same moment both read the row; the database lets only one
//     update match, and the other sends nothing. The unique (partner,
//     sequence) constraint means a partner is on a sequence once. If the send
//     is then refused, the claim is handed back (due again on the next run).
//     The price: if the process dies between the claim and Resend, that one
//     email is not sent rather than sent twice.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'
import { sendEmail, renderTemplate } from '@/lib/resend'
import { blockedOnMissingRate } from '@/lib/rate-guard'
import { dripStepDecision } from '@/lib/drip-followups'
import { extrasFromRow, locationEmailOptionsFromRow } from '@/lib/email-send-options'
import { hasSignatureTag } from '@/lib/email-signature'
import { resolveEmailSigner } from '@/lib/email-signature-resolve'
import { escHtml } from '@/lib/email-escape'
import { unsubscribePathFor } from '@/lib/marketing-consent'
import { type BrandedEmailContext } from '@/lib/drip-email-layout'
import { partnerRenderContext } from '@/lib/partner-merge-tags'
import { isPartnerPathKey } from '@/lib/partner-sequences'
import {
  classifySendFailure,
  emailLook,
  guardBodyOf,
  loadSendLocation,
  loadSequenceStep,
  locationCanSend,
  planNextStep,
  renderStepButton,
  stepContent,
} from '@/lib/drip-send-shared'
import { partnerCanReceive, partnerSendBlockReason, type PartnerSendKind } from './partner-email-eligibility'
import { ensurePartnerUnsubscribeToken } from './partner-unsubscribe'
import { buildPartnerEmail, partnerButtonIsClientBooking, CLIENT_BOOKING_LINK_TAGS } from './partner-email'

export const PARTNER_PROGRESS_TABLE = 'partner_drip_progress'
const PROGRESS_COLUMNS = 'id, partner_id, drip_path_id, path_key, current_step, status, next_send_at, last_sent_at'

// Hard cap per run, like the client cron's.
export const PARTNER_BATCH_LIMIT = 100

export type PartnerProgressRow = {
  id: string
  partner_id: string
  drip_path_id: string
  path_key: string
  current_step: number
  status: string
  next_send_at: string | null
  last_sent_at: string | null
}

// sent: true — the email went. Otherwise `error` says why not:
//   SKIPPED (the partner may not be emailed; the row is stopped, except a
//   failed check, which is retried):  blocked_<reason>
//   HELD (row untouched, retried next run): missing_rate, missing_subject,
//     no_partner_name, client_booking_button, client_booking_tag,
//     no_postal_address, no_app_url, no_unsubscribe_link, location_not_active,
//     location_sender_*, send: …
//   NOT OURS TO SEND: already_claimed (another run has it), not_due
//   STOPPED: invalid_recipient
export type PartnerSendResult = { sent: boolean; error?: string; advanced_to_step?: number; completed?: boolean }

const BLOCK_STOPS = new Set(['not_found', 'unsubscribed', 'deleted', 'no_email', 'address_unsubscribed'])

function log(event: string, details: Record<string, unknown>) {
  console.warn(`[partner-send] ${event}`, details)
}

/** The rows due now, oldest first. */
export async function duePartnerRows(limit = PARTNER_BATCH_LIMIT) {
  return supabaseService
    .from(PARTNER_PROGRESS_TABLE)
    .select(PROGRESS_COLUMNS)
    .eq('status', 'active')
    .lte('next_send_at', new Date().toISOString())
    .order('next_send_at', { ascending: true })
    .limit(limit)
}

/** One partner sequence row, by id, if it is due now (the Start button's inline send, slice 5). */
export async function sendPartnerDripStep(progressId: string): Promise<PartnerSendResult> {
  const { data, error } = await supabaseService
    .from(PARTNER_PROGRESS_TABLE)
    .select(PROGRESS_COLUMNS)
    .eq('id', progressId)
    .eq('status', 'active')
    .lte('next_send_at', new Date().toISOString())
    .maybeSingle()
  if (error) return { sent: false, error: `progress_lookup: ${error.message}` }
  if (!data) return { sent: false, error: 'not_due' }
  return sendPartnerDripStepForRow(data as PartnerProgressRow)
}

/** Every due partner email, up to the cap. What the cron calls. */
export async function runPartnerDripBatch(limit = PARTNER_BATCH_LIMIT): Promise<{
  considered: number; sent: number; skipped: number; held: number; failed: number
  errors: Array<{ id: string; reason: string }>
  queryError?: string
}> {
  const out = { considered: 0, sent: 0, skipped: 0, held: 0, failed: 0, errors: [] as Array<{ id: string; reason: string }> }
  const { data, error } = await duePartnerRows(limit)
  if (error) return { ...out, queryError: error.message }
  const rows = (data ?? []) as PartnerProgressRow[]
  out.considered = rows.length
  for (const row of rows) {
    let r: PartnerSendResult
    try {
      r = await sendPartnerDripStepForRow(row)
    } catch (err) {
      r = { sent: false, error: `threw: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (r.sent) out.sent++
    else if (!r.error || r.error.startsWith('blocked_') || r.error === 'already_claimed' || r.error === 'not_due' ||
             r.error === 'step_removed' || r.error === 'step_paused' || r.error === 'non_email_channel') out.skipped++
    else if (HELD.has(r.error) || r.error.startsWith('location_sender') || r.error === 'location_reply_to_invalid') out.held++
    else { out.failed++; out.errors.push({ id: row.id, reason: r.error }) }
  }
  return out
}
const HELD = new Set(['sequence_paused', 'missing_rate', 'missing_subject', 'no_partner_name', 'client_booking_button', 'client_booking_tag',
  'no_postal_address', 'no_app_url', 'no_unsubscribe_link', 'location_not_active', 'sender_config_missing'])

/** May this partner be emailed now? The gate, and the reason for the log. */
async function blockReason(partnerId: string, kind: PartnerSendKind): Promise<string | null> {
  if (await partnerCanReceive(supabaseService, partnerId, kind)) return null
  return (await partnerSendBlockReason(supabaseService, partnerId)) ?? 'check_failed'
}

export async function sendPartnerDripStepForRow(row: PartnerProgressRow): Promise<PartnerSendResult> {
  const kind: PartnerSendKind = row.current_step <= 1 ? 'start' : 'step'
  if (row.status !== 'active' || !row.next_send_at) return { sent: false, error: 'not_due' }

  // The sequence: a partner sequence only, never a client one.
  const { data: path, error: pathErr } = await supabaseService
    .from('drip_paths')
    .select('id, path_key, location_uuid, is_active')
    .eq('id', row.drip_path_id)
    .maybeSingle()
  if (pathErr || !path) return { sent: false, error: `path_lookup: ${pathErr?.message ?? 'missing'}` }
  if (!isPartnerPathKey(path.path_key)) {
    log('refused: not a partner sequence', { progressId: row.id, pathKey: path.path_key })
    return { sent: false, error: 'not_a_partner_sequence' }
  }
  // A PAUSED SEQUENCE (switched off) sends nothing: HELD, row untouched, so it
  // carries on by itself when switched back on. The second lock behind Start,
  // which refuses a paused sequence (slice 5). Only an explicit false holds;
  // a sequence row always has the column.
  if ((path as { is_active?: boolean | null }).is_active === false) {
    log('held: the sequence is paused', { progressId: row.id, pathId: path.id })
    return { sent: false, error: 'sequence_paused' }
  }

  // The partner.
  const { data: partner, error: partnerErr } = await supabaseService
    .from('partners')
    .select('id, location_id, name, first_name, network_types, email')
    .eq('id', row.partner_id)
    .maybeSingle()
  if (partnerErr) return { sent: false, error: `partner_lookup: ${partnerErr.message}` }

  // LOCK 1: may they be emailed at all? (unsubscribed here or anywhere, no
  // address, deleted, gone). Skipped quietly, with the reason logged; the row
  // is stopped so it stops coming back, except when the check itself failed.
  const blocked = partner ? await blockReason(partner.id, kind) : 'not_found'
  if (blocked) {
    log('skipped: partner may not be emailed', { progressId: row.id, partnerId: row.partner_id, reason: blocked })
    if (BLOCK_STOPS.has(blocked)) {
      await supabaseService
        .from(PARTNER_PROGRESS_TABLE)
        .update({ status: 'stopped', stopped_at: new Date().toISOString(), stopped_reason: `blocked_${blocked}` })
        .eq('id', row.id)
        .eq('status', 'active')
    }
    return { sent: false, error: `blocked_${blocked}` }
  }
  const p = partner!

  // A location's copy belongs to that location; a partner gets their own
  // location's emails only (the database refuses the row otherwise too).
  if (path.location_uuid && path.location_uuid !== p.location_id) {
    log('refused: sequence belongs to another location', { progressId: row.id })
    return { sent: false, error: 'wrong_location' }
  }

  const { data: loc, error: locErr } = await loadSendLocation(p.location_id)
  if (locErr || !loc) return { sent: false, error: `loc_lookup: ${locErr?.message ?? 'missing'}` }
  if (!locationCanSend(loc)) return { sent: false, error: 'location_not_active' }

  const { data: step, error: stepErr } = await loadSequenceStep(path.id, row.current_step)
  if (stepErr || !step) return { sent: false, error: `step_lookup: ${stepErr?.message ?? 'missing'}` }

  // Removed / paused emails are passed over exactly as for a client (the
  // first always sends). The client "follow-ups off" switch is a client
  // setting and is not applied to partners.
  const extras = extrasFromRow(step as Record<string, unknown>)
  if ((step as any).channel !== 'email') return advanceWithoutSending(row, path.id, loc.timezone, 'non_email_channel')
  const decision = dripStepDecision({
    stepOrder: row.current_step,
    stepActive: (step as { is_active?: boolean | null }).is_active,
    followupsOff: false,
    stepPaused: extras.isPaused,
  })
  if (decision === 'skip_removed') return advanceWithoutSending(row, path.id, loc.timezone, 'step_removed')
  if (decision === 'skip_paused') return advanceWithoutSending(row, path.id, loc.timezone, 'step_paused')

  const { subjectSource, bodySource, bodyFormat } = stepContent(step as Record<string, unknown>)
  if (!bodySource) return { sent: false, error: 'no_body_source' }
  const guardBody = guardBodyOf(bodySource, extras.buttonLink)

  // LOCK (second of two): a client booking link on a partner email's button.
  if (partnerButtonIsClientBooking(extras.buttonLink)) {
    log('held: button points at a client booking link', { progressId: row.id, step: row.current_step })
    return { sent: false, error: 'client_booking_button' }
  }
  // …or in its wording: a partner email fills no booking link, so the
  // sentence would read "Book here ()".
  if (CLIENT_BOOKING_LINK_TAGS.some((t) => `${subjectSource ?? ''}\n${bodySource}`.includes(t))) {
    log('held: wording quotes a client booking link', { progressId: row.id, step: row.current_step })
    return { sent: false, error: 'client_booking_tag' }
  }
  if (blockedOnMissingRate({ subject: subjectSource, body: guardBody }, loc.rate_per_hour)) {
    log('held: email quotes {{rate_per_hour}} but the location rate is blank', { progressId: row.id })
    return { sent: false, error: 'missing_rate' }
  }

  // Who signs, and whose name {{location_owner_name}} is: the primary owner
  // if active at this location, else nobody (the location signs).
  const signer = await resolveEmailSigner({ locationId: loc.id, locationName: loc.name, assigneeUserId: null })
  const ownerName = signer.reason === 'primary_owner' ? signer.signer?.full_name?.trim() || null : null

  const ctx = partnerRenderContext({
    partner: { name: p.name, first_name: p.first_name, network_types: p.network_types },
    location: { name: loc.name, phone: loc.phone, city: loc.city, state: loc.state, rate_per_hour: loc.rate_per_hour, reviews_link: loc.reviews_link },
    locationOwnerName: ownerName,
  })
  if (/\{\{partner_name\}\}/.test(`${subjectSource ?? ''}\n${bodySource}`) && !ctx.partner_name) {
    log('held: the partner has no name to greet', { progressId: row.id })
    return { sent: false, error: 'no_partner_name' }
  }
  const rendered = renderTemplate({ subject: subjectSource, body: bodySource }, ctx, { signatureMarker: true, bodyFormat })
  if (!rendered.subject.trim()) {
    log('held: email subject is blank', { progressId: row.id })
    return { sent: false, error: 'missing_subject' }
  }
  const renderedButton = renderStepButton(extras, ctx)
  const emailOptions = locationEmailOptionsFromRow(loc as Record<string, unknown>)
  const brand: BrandedEmailContext = {
    location_name: loc.name,
    location_phone: loc.phone,
    reviews_link: loc.reviews_link,
    signature: hasSignatureTag(bodySource) ? signer.signature : null,
    ...emailLook(emailOptions, rendered, renderedButton, extras),
    bodyFormat,
  }

  // The footer's two required pieces, before anything is claimed.
  const postalAddress = (process.env.MARKETING_POSTAL_ADDRESS || '').trim()
  if (!postalAddress) {
    log('held: MARKETING_POSTAL_ADDRESS is not set', { progressId: row.id })
    return { sent: false, error: 'no_postal_address' }
  }
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) {
    log('held: no app address for the unsubscribe link', { progressId: row.id })
    return { sent: false, error: 'no_app_url' }
  }

  // LOCK 1 again, right before it goes.
  const blockedNow = await blockReason(p.id, kind)
  if (blockedNow) {
    log('skipped: partner may not be emailed', { progressId: row.id, partnerId: p.id, reason: blockedNow })
    return { sent: false, error: `blocked_${blockedNow}` }
  }
  const token = await ensurePartnerUnsubscribeToken(p.id)
  if (!token) {
    log('held: no unsubscribe link could be made', { progressId: row.id })
    return { sent: false, error: 'no_unsubscribe_link' }
  }
  const unsubscribeUrl = `${base}${unsubscribePathFor(token)}`
  const email = buildPartnerEmail({ renderedBody: rendered.body, brand, unsubscribeUrl, postalAddress })
  if (!email.text.includes(unsubscribeUrl) || !email.text.includes(postalAddress) ||
      !email.html.includes(escHtml(unsubscribeUrl)) || !email.html.includes(escHtml(postalAddress))) {
    log('held: the finished email is missing its unsubscribe footer', { progressId: row.id })
    return { sent: false, error: 'footer_missing' }
  }

  // NEVER TWICE: claim the row, then send.
  const plan = await planNextStep(path.id, row.current_step, loc.timezone)
  if (plan.kind === 'lookup_failed') return { sent: false, error: 'next_step_lookup' }
  const claimedAt = new Date().toISOString()
  const claim = await claimRow(row, plan, claimedAt)
  if (!claim.ok) return { sent: false, error: claim.error }

  const result = await sendEmail({
    locationId: loc.id,
    to: (p.email as string).trim(),
    subject: rendered.subject,
    html: email.html,
    text: email.text,
    email_kind: 'partner_drip',
  })

  if (!result.success) {
    const failure = classifySendFailure(result)
    log('send refused', { progressId: row.id, kind: failure.kind, error: failure.ownerMessage })
    if (failure.kind === 'terminal') {
      await onlyOurClaim(supabaseService
        .from(PARTNER_PROGRESS_TABLE)
        .update({ status: 'stopped', stopped_at: new Date().toISOString(), stopped_reason: 'invalid_recipient',
                  current_step: row.current_step, completed_at: null, last_sent_at: row.last_sent_at, next_send_at: null })
        .eq('id', row.id), plan, claimedAt)
      return { sent: false, error: 'invalid_recipient' }
    }
    await releaseClaim(row, plan, claimedAt)
    if (failure.kind === 'sender_domain') return { sent: false, error: 'location_sender_domain_unverified' }
    if (failure.kind === 'reply_to') return { sent: false, error: 'location_reply_to_invalid' }
    if (failure.kind === 'sender_config_missing') return { sent: false, error: 'sender_config_missing' }
    return { sent: false, error: `send: ${result.error}` }
  }

  return plan.kind === 'next'
    ? { sent: true, advanced_to_step: plan.stepOrder }
    : { sent: true, completed: true }
}

// The claim: ONE conditional update. It matches only the row exactly as it
// was read — still active, still on this step, still due at this time — so of
// two runs holding the same row, only the first update matches.
async function claimRow(
  row: PartnerProgressRow,
  plan: { kind: 'last' } | { kind: 'next'; stepOrder: number; sendAt: Date },
  claimedAt: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const patch = plan.kind === 'next'
    ? { current_step: plan.stepOrder, next_send_at: plan.sendAt.toISOString(), last_sent_at: claimedAt }
    : { status: 'completed', completed_at: claimedAt, next_send_at: null, last_sent_at: claimedAt }
  const { data, error } = await supabaseService
    .from(PARTNER_PROGRESS_TABLE)
    .update(patch)
    .eq('id', row.id)
    .eq('status', 'active')
    .eq('current_step', row.current_step)
    .eq('next_send_at', row.next_send_at as string)
    .select('id')
  if (error) {
    // The database refuses an active row for a partner who may not be
    // emailed (migrations/partner_emails.sql section 7): nothing sends.
    log('claim refused', { progressId: row.id, error: error.message })
    return { ok: false, error: /partner_cannot_receive/.test(error.message) ? 'blocked_by_database' : `claim: ${error.message}` }
  }
  if (!Array.isArray(data) || data.length !== 1) {
    log('skipped: another run already has this email', { progressId: row.id, step: row.current_step })
    return { ok: false, error: 'already_claimed' }
  }
  return { ok: true }
}

// Hand the claim back after a refused send: the same step, due again now (so
// the next run retries it). Matches only a row STILL EXACTLY IN OUR CLAIMED
// STATE (onlyOurClaim): if anything moved it since — the owner pressed Stop
// while Resend was answering, the partner unsubscribed — nothing matches and
// the row stays as they left it. Stop can never be undone by a failing send.
// The due time it gives back is not the one any other run read, so a run
// still holding the old row can never match it.
type ClaimPlan = { kind: 'last' } | { kind: 'next'; stepOrder: number; sendAt: Date }
async function releaseClaim(row: PartnerProgressRow, plan: ClaimPlan, claimedAt: string): Promise<void> {
  const { error } = await onlyOurClaim(supabaseService
    .from(PARTNER_PROGRESS_TABLE)
    .update({ status: 'active', current_step: row.current_step, completed_at: null, last_sent_at: row.last_sent_at, next_send_at: claimedAt })
    .eq('id', row.id), plan, claimedAt)
  if (error) log('could not hand the claim back', { progressId: row.id, error: error.message })
}

// The row exactly as claimRow left it: its status, step, due time and the
// claim's own time. Any other state (stopped, unsubscribed, moved on) is not ours.
function onlyOurClaim<Q extends { eq: (c: string, v: unknown) => Q }>(q: Q, plan: ClaimPlan, claimedAt: string): Q {
  const ours = q.eq('last_sent_at', claimedAt)
  return plan.kind === 'next'
    ? ours.eq('status', 'active').eq('current_step', plan.stepOrder).eq('next_send_at', plan.sendAt.toISOString())
    : ours.eq('status', 'completed').eq('completed_at', claimedAt)
}

// Removed / paused / not an email: move on without sending, through the same
// claim (so two runs never both move it on).
async function advanceWithoutSending(row: PartnerProgressRow, pathId: string, tz: string | null, why: string): Promise<PartnerSendResult> {
  const plan = await planNextStep(pathId, row.current_step, tz)
  if (plan.kind === 'lookup_failed') return { sent: false, error: 'next_step_lookup' }
  const claim = await claimRow(row, plan, new Date().toISOString())
  if (!claim.ok) return { sent: false, error: claim.error }
  return plan.kind === 'next' ? { sent: false, error: why, advanced_to_step: plan.stepOrder } : { sent: false, error: why, completed: true }
}
