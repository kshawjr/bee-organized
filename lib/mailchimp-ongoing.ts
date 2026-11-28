// lib/mailchimp-ongoing.ts
//
// FL-131: THE ONGOING MAILCHIMP SYNC. After a location's set-up is finished,
// anyone new in its Mailchimp list comes into Bee Hub, however they got there
// (website form, the profile quiz, added by hand, another program), and is
// greeted by Bee Hub's own greeting email — never by Mailchimp.
//
// KEVIN'S RULES (2026-11-27)
//   • The one-time set-up import stays silent. It is untouched, and it never
//     loads this file (lib/mailchimp-ongoing.test.ts proves it).
//   • "After setup" = joined Mailchimp after the location's first send to
//     Mailchimp finished (locations.mailchimp_first_sync_at — the guided
//     set-up's last step). No date → this does nothing for that location.
//     Everyone who joined before is the set-up import's, and stays silent.
//   • Picked up at once when Mailchimp notifies Bee Hub
//     (app/api/mailchimp/webhook), and by an hourly sweep
//     (app/api/cron/mailchimp-sweep) — the real safety net. Both run this
//     same function for the whole location.
//   • Greeted 24 hours from their Mailchimp join time, not from pickup. Up to
//     72 hours after joining they are still greeted; after that, never, and
//     the reason is saved on the record. The greeting itself checks the 72
//     hours again when it would be sent (lib/welcome-email.ts).
//   • Never greeted: unsubscribed in Mailchimp; added to Mailchimp by Jobber
//     (Mailchimp's own "added by", read fresh for each person); past clients
//     (the greeting's own check).
//   • First one wins. The record's id is fixed by the location and the
//     Mailchimp member, so when the notification and the sweep race, the
//     database refuses the second; only the run that made the person decides
//     their greeting, and the greeting can only ever be set once.
//   • Test Location only before roll-out (lib/mailchimp-rollout.ts).
//
// The only thing this may set in motion is the greeting (scheduleWelcomeEmail
// and skipWelcomeEmail). No drip, no lead alert, no team chat post, nothing to
// Jobber — lib/mailchimp-ongoing.test.ts walks every file this loads and
// fails if any other sender is named.
//
// MY CALLS, flagged to Kevin
//   • Someone whose phone matches a Bee Hub person under another email is
//     NOT brought in by this (it is the set-up's "same person?" question, for
//     the owner). Counted in the run's result.
//   • When Mailchimp's "added by" cannot be read, the person is not brought
//     in this time; the next run tries again (well inside 72 hours).
//   • A past-client check that cannot be answered leaves the person ungreeted.

import { createHash } from 'node:crypto'
import { supabaseService } from './supabase-service'
import { loadPull, applyPull, type MailchimpMember, type PullDecision } from './mailchimp-pull'
import { scrub } from './mailchimp-audience-look'
import { mailchimpOpenFor } from './mailchimp-rollout'
import { MAILCHIMP_SIGNUP_SOURCE, isJobberSource, signupTooLate } from './mailchimp-signup-rules'
import { scheduleWelcomeEmail, skipWelcomeEmail } from './welcome-email'

// ── The fixed record id (first one wins) ────────────────────
// A UUID made from the location and the Mailchimp member (Mailchimp's member
// id is the same person for the life of the list). Same inputs, same id.
export function signupLeadId(locationUuid: string, memberId: string): string {
  const h = createHash('sha256').update(`bee-hub mailchimp signup v1:${locationUuid}:${memberId}`).digest('hex')
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// ── Who is greeted (pure) ───────────────────────────────────
export type NotGreetedReason = 'unsubscribed' | 'added_by_jobber' | 'too_late'
export type Greeting = { greet: true; from: string } | { greet: false; reason: NotGreetedReason }
export function greetingFor(args: { unsubscribed: boolean; source: string; joinedAt: string; nowMs: number }): Greeting {
  if (args.unsubscribed) return { greet: false, reason: 'unsubscribed' }
  if (isJobberSource(args.source)) return { greet: false, reason: 'added_by_jobber' }
  if (signupTooLate(args.joinedAt, args.nowMs)) return { greet: false, reason: 'too_late' }
  return { greet: true, from: args.joinedAt }
}

// Joined strictly after the set-up finished.
export function joinedAfter(joinedAt: unknown, cutoff: unknown): boolean {
  const j = Date.parse(String(joinedAt ?? '')), c = Date.parse(String(cutoff ?? ''))
  return Number.isFinite(j) && Number.isFinite(c) && j > c
}

// ── Mailchimp's "added by", read fresh for one person (GET only) ──
export async function readAddedBy(
  loc: { token: string; prefix: string; listId: string }, memberId: string, fetchImpl?: any,
): Promise<{ ok: true; source: string; status: string } | { ok: false; detail: string }> {
  const f = fetchImpl || ((u: string, i: any) => fetch(u, i))
  const url = `https://${loc.prefix}.api.mailchimp.com/3.0/lists/${encodeURIComponent(loc.listId)}/members/${encodeURIComponent(memberId)}?fields=id,status,source`
  try {
    const res = await f(url, { method: 'GET', headers: { Authorization: `Bearer ${loc.token}` }, cache: 'no-store' })
    const body = await res.text()
    if (res.status !== 200) return { ok: false, detail: scrub(`Mailchimp answered ${res.status}: ${body}`, loc.token) }
    const j = JSON.parse(body)
    if (typeof j?.source !== 'string' || typeof j?.status !== 'string') return { ok: false, detail: 'no source in the answer' }
    return { ok: true, source: j.source, status: j.status }
  } catch (e: any) {
    return { ok: false, detail: scrub(e?.message || e, loc.token) }
  }
}

// ── One run, for one location ───────────────────────────────
export type OngoingResult =
  | { ok: false; reason: string; detail?: string }
  | {
      ok: true
      setupFinishedAt: string
      newSinceSetup: number
      created: number
      greeted: number
      notGreeted: Record<NotGreetedReason | 'returning_client' | 'check_failed' | 'schedule_failed', number>
      alreadyThere: number
      sourceUnreadable: number
      failed: number
      heldForOwner: number
    }

export async function runOngoing(
  locationUuid: string,
  deps: { db?: any; fetchImpl?: any; now?: () => number; trigger?: 'webhook' | 'sweep' } = {},
): Promise<OngoingResult> {
  if (!mailchimpOpenFor(locationUuid)) return { ok: false, reason: 'not_open' }
  const db = deps.db || supabaseService
  const now = deps.now || Date.now

  const { data: loc, error: locErr } = await db.from('locations')
    .select('id, mailchimp_first_sync_at, mailchimp_access_token, mailchimp_server_prefix, mailchimp_list_id')
    .eq('id', locationUuid).maybeSingle()
  if (locErr || !loc) return { ok: false, reason: 'location_unreadable', detail: locErr?.message }
  if (!loc.mailchimp_first_sync_at) return { ok: false, reason: 'setup_not_finished' }
  const cutoff: string = loc.mailchimp_first_sync_at

  const loaded = await loadPull(locationUuid, { db, fetchImpl: deps.fetchImpl })
  if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail }

  const fresh = loaded.plan.decisions.filter((d) => joinedAfter(d.member.joinedAt, cutoff))
  const creates = fresh.filter((d): d is Extract<PullDecision, { kind: 'create' }> => d.kind === 'create')
  const out = {
    ok: true as const, setupFinishedAt: cutoff, newSinceSetup: creates.length, created: 0, greeted: 0,
    notGreeted: { unsubscribed: 0, added_by_jobber: 0, too_late: 0, returning_client: 0, check_failed: 0, schedule_failed: 0 },
    alreadyThere: 0, sourceUnreadable: 0, failed: 0,
    heldForOwner: fresh.filter((d) => d.kind === 'held').length,
  }
  const runId = `mailchimp-signup:${new Date(now()).toISOString()}:${deps.trigger || 'sweep'}`
  const mc = { token: loc.mailchimp_access_token, prefix: loc.mailchimp_server_prefix, listId: loc.mailchimp_list_id }

  for (const d of creates) {
    const m: MailchimpMember = d.member
    const addedBy = await readAddedBy(mc, m.id, deps.fetchImpl)
    if (!addedBy.ok) { out.sourceUnreadable++; continue }
    if (addedBy.status === 'cleaned') continue
    const unsubscribed = d.unsubscribed || addedBy.status === 'unsubscribed'

    const [r] = await applyPull({ decisions: [{ ...d, unsubscribed }], counts: loaded.plan.counts }, loaded.location, {
      db, runId, tags: loaded.tags, by: null,
      leadIdFor: (x) => signupLeadId(locationUuid, x.id),
      importSource: MAILCHIMP_SIGNUP_SOURCE,
      saidNoWords: 'unsubscribed in Mailchimp (found by the ongoing sync)',
    })
    if (!r) { out.failed++; continue }
    if (r.outcome === 'already_there') { out.alreadyThere++; continue }
    if (r.outcome !== 'created' && r.outcome !== 'created_unsubscribed') { out.failed++; continue }
    out.created++
    const leadId = r.leadId as string

    // Only the run that made the person gets here: their greeting is decided once.
    const g = greetingFor({ unsubscribed, source: addedBy.source, joinedAt: m.joinedAt as string, nowMs: now() })
    if (!g.greet) {
      await skipWelcomeEmail(leadId, g.reason, null)
      out.notGreeted[g.reason]++
      continue
    }
    const set = await scheduleWelcomeEmail(leadId, { import_source: MAILCHIMP_SIGNUP_SOURCE, paid_amount: 0 }, { from: g.from })
    if (set === 'scheduled') out.greeted++
    else if (set === 'returning_client') { await skipWelcomeEmail(leadId, 'returning_client', null); out.notGreeted.returning_client++ }
    else if (set === 'check_failed') out.notGreeted.check_failed++
    else out.notGreeted.schedule_failed++
  }
  return out
}

// ── Where this runs ─────────────────────────────────────────
// Every location the roll-out list opens. (Today: Test Location only.)
export { MAILCHIMP_OPEN_LOCATIONS as ONGOING_LOCATIONS } from './mailchimp-rollout'
