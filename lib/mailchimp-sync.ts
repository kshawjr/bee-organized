// lib/mailchimp-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ONE place Bee Hub adds people to a location's Mailchimp audience.
// The batch (syncWebsiteLeadsToMailchimp) is called only by POST
// /api/mailchimp/sync (the "Sync now" button). One person at a time
// (addOneLeadToMailchimp, at the bottom, FL-137/135) is called only after an
// owner's choice — or the 35-day auto-close's — is saved (lib/nurture-choice.ts).
//
// FL-75 SLICE 6 (2026-11-25) rebuilt this. It used to push "website leads",
// one PUT at a time. It now sends the people the owner ticked on "Who goes to
// Mailchimp" (slice 5), in batches. In order, every time:
//
// 1. KEVIN'S SWITCH, before anything else. mailchimp_sync_live is the
//    fail-closed per-location switch, flipped by hand. Off means this returns a
//    zero report and makes NO request at all. Same for a missing connection or
//    audience. It lives here, not in a screen or a route, so a bare POST cannot
//    get round it.
//
// 2. THE FLOWS, read live (lib/mailchimp-flows.ts). Tested 2026-11-25: an add
//    starts a live "Contact signs up" flow within 5 seconds and sends its email.
//    Kevin's ruling: REFUSE while any flow that starts when someone is added is
//    live (reason 'signup_flows_live', naming each one). Refuse too when the
//    flows can't be read (reason 'mailchimp_unreadable') — "couldn't check" is
//    never "nothing live". The flows are read again right before EVERY batch,
//    and again right before that batch's tags are added; if anything changed,
//    the run stops there.
//
// 3. WHO, recomputed live — never from anything saved. loadReview reads the
//    audience (GET), every Bee Hub record, the shared no-marketing list and the
//    owner's saved choices, and applies the slice 1 rules. A saved tick is only
//    a choice among people who can be offered right now; nobody who said no,
//    is in the Recycle Bin, or is already in Mailchimp is ever in the set.
//    On top of that, the no-marketing list is checked AGAIN on the final
//    addresses just before sending, and archived Mailchimp contacts are read
//    and left out.
//
// 4. THE FIRST-SYNC CONFIRMATION. Until a run has finished completely for this
//    location (locations.mailchimp_first_sync_at is set — only by a run that
//    finished everything; unreadable counts as not set),
//    nothing is sent unless the caller's `confirm` names the exact count, the
//    audience, and the state of the flows (a fingerprint) that the owner was
//    shown. Anything else gets 'needs_confirmation' with the current numbers.
//    A half-finished first sync is still a first sync: carrying on asks again,
//    for what is left.
//
// 5. NEVER CHANGE ANYONE ALREADY IN MAILCHIMP. The add is Mailchimp's batch
//    subscribe, POST /lists/{id}, with update_existing: false. Proven at Test
//    Location on 2026-11-25: re-adding an UNSUBSCRIBED contact this way is
//    refused ("already a list member", ERROR_CONTACT_EXISTS) and their status
//    and last-changed time do not move. People already in Mailchimp are left
//    out before the call anyway; the flag is the second lock.
//    This file never PUTs or PATCHes a member and never sends `status` for an
//    existing one.
//
// 6. TAGS carry over (project type, source, live client status, the record's
//    own tags, including the location's own). A tag that starts a LIVE flow in
//    Mailchimp is held back unless the owner said yes to that tag, one by one,
//    on this run's confirmation (Kevin's ruling). Tags only go on people this
//    run added.
//
// 7. SCALE AND HALF-DONE. 500 people per call (Mailchimp's batch limit),
//    one call at a time. 429 and 5xx are retried (Retry-After honoured, then
//    1s/2s/4s); after three retries the run STOPS. The run also stops before
//    it runs out of time (the route has 60 seconds). A stopped run reports
//    complete: false, how many were added and how many are left, and writes a
//    'partial' row — never 'complete'. Pressing Sync now again carries on:
//    everyone already added is now in Mailchimp, so the live read leaves them
//    out, and Mailchimp itself refuses a second add of the same address. A
//    batch retried after a lost answer may come back "already a member" for
//    people the first try added; those are counted as added, never twice.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'crypto'
import { supabaseService } from './supabase-service'
import { loadSaidNoSet } from './marketing-no-list'
import { apiBase } from './mailchimp'
import { mapLeadToPerson } from './people-mapper'
import { readFlows, FLOWS_UNREADABLE_WORDS, HOW_TO_PAUSE, type FlowsRead, type Flow } from './mailchimp-flows'
import { loadReview, type ReviewLoad } from './mailchimp-review-load'
import { isIncluded, matchedByPhone } from './mailchimp-review'
import { emailKey } from './mailchimp-rules'
import { scrub } from './mailchimp-audience-look'
import { mailchimpOpenFor } from './mailchimp-rollout'
// clientStatus.js is an untyped pure JS module — typed at the boundary, same
// as lib/hub-all-overview.ts does, so the arguments stay checked.
import { deriveClientStatus as deriveClientStatusUntyped } from '@/components/hive/shared/clientStatus'
import { loadRefusals, recordRefusal, clearRefusal, recordSaidNo, classifyRefusal, isHeld, type Refusal } from './mailchimp-refusals'
const deriveClientStatus = deriveClientStatusUntyped as (
  person: any,
  openClientIds: Set<string> | null,
  nowMs?: number,
  wonClientIds?: Set<string> | null,
) => string

export const MD5_OF_LOWERCASED_EMAIL = (email: string): string =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex')

export const BATCH_SIZE = 500
export const MAX_RETRIES = 3
export const TIME_BUDGET_MS = 45_000
// The location's "first sync fully finished" date (migrations/
// mailchimp_progress_dates.sql). It replaces a sync_log run record that
// sync_log's own rules refused, so it never landed (Kevin's ruling, option B,
// 2026-11-26: sync_log is not widened).
export const FIRST_SYNC_DATE = 'mailchimp_first_sync_at'

// ── Tags ──────────────────────────────────────────────────────
// project_type + source + the LIVE derived client status + the lead's tag
// LABELS from the lead_tags junction (tag_lookup_id → lookups.label — the
// same resolution _hub-page.tsx does; leads.tags the COLUMN is a write-orphan
// nothing populates, so it is deliberately not read here). Trimmed, empties
// dropped, deduplicated case-insensitively (first casing wins, so 'Moving'
// beats a later 'moving' rather than sending Mailchimp both).
export function buildMemberTags(args: {
  projectType?: string | null
  source?: string | null
  clientStatus?: string | null
  leadTags?: unknown
}): string[] {
  const raw: Array<string | null | undefined> = [
    args.projectType,
    args.source,
    args.clientStatus,
    ...(Array.isArray(args.leadTags) ? args.leadTags : []),
  ]
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of raw) {
    if (typeof t !== 'string') continue
    const trimmed = t.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

export type SyncRefusal =
  | 'sync_not_enabled' | 'not_connected' | 'no_audience' | 'location_not_found'
  | 'mailchimp_unreadable' | 'signup_flows_live' | 'beehub_unreadable' | 'choices_not_ready'
  | 'no_list_unreadable' | 'needs_confirmation'

export type FlowLine = { name: string; status: string; start: string; subjects?: string[] }
export type HeldTag = { tag: string; flows: string[]; people: number }

export type SyncReport = {
  ran: boolean
  // ran:false — every reason means ZERO writes to Mailchimp on this call.
  reason?: SyncRefusal
  words?: string
  // reason 'signup_flows_live': each live flow that must be paused, and how.
  mustPause?: FlowLine[]
  howToPause?: string
  // reason 'needs_confirmation': what the first sync WOULD do. Echo count,
  // listId and flows back as `confirm` (plus tagsOk for any held tag allowed).
  confirm?: {
    count: number
    listId: string
    listName: string | null
    flows: string
    pausedFlows: FlowLine[]
    heldTags: HeldTag[]
    // Who is NOT in `count`, for the one quiet line under it (2026-11-26):
    // archived people left unticked, and people held on the refused list.
    leftOut: { archived: number; refused: number }
  }
  first?: boolean
  complete?: boolean          // ran: every batch done, every tag applied
  stopReason?: string         // complete:false — why it stopped
  pushed: number              // added to Mailchimp on this run
  alreadyThere: number        // Mailchimp said "already a member"; left exactly as they were
  skipped: number             // new to Mailchimp but unticked by the owner
  failed: number              // Mailchimp refused this address on this run (e.g. looks fake) — kept in mailchimp_refusals
  saidNo: number              // Mailchimp said this person said no (unsubscribed, deleted, a compliance block) — now on the no-marketing list. Never a bounce.
  heldBack: number            // not sent: Mailchimp refused them before (lib/mailchimp-refusals.ts) and nothing has changed
  remaining: number           // ticked, not yet tried because the run stopped
  tagsHeld: string[]          // tags not carried: they start a live flow
  errors: Array<{ email_key: string; error: string }>
}

export type SyncConfirm = { count: number; listId: string; flows: string; tagsOk?: string[] }

const emptyReport = (): Omit<SyncReport, 'ran'> => ({ pushed: 0, alreadyThere: 0, skipped: 0, failed: 0, saidNo: 0, heldBack: 0, remaining: 0, tagsHeld: [], errors: [] })
const refuse = (reason: SyncRefusal, extra: Partial<SyncReport> = {}): SyncReport => ({ ran: false, reason, ...emptyReport(), ...extra })

const flowLine = (f: Flow): FlowLine => ({ name: f.name, status: f.status, start: f.startWords, subjects: f.subjects || [] })

type Deps = {
  db?: any
  fetchImpl?: (url: string, init: any) => Promise<any>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  loadReviewImpl?: (locationId: string, deps: any) => Promise<ReviewLoad>
  readFlowsImpl?: (args: any) => Promise<FlowsRead>
  loadSuppressed?: (emails: readonly unknown[]) => Promise<Set<string>>
  budgetMs?: number
  batchSize?: number
}

// Kept under its old name: the route and its tests call it. It no longer
// sends only website leads — see the header.
export async function syncWebsiteLeadsToMailchimp(
  locationUuid: string,
  opts: { confirm?: SyncConfirm | null } = {},
  deps: Deps = {},
): Promise<SyncReport> {
  const db = deps.db || supabaseService
  const doFetch = deps.fetchImpl || ((url: string, init: any) => fetch(url, init) as any)
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now || (() => Date.now())
  const started = now()
  const budget = deps.budgetMs ?? TIME_BUDGET_MS
  const batchSize = deps.batchSize || BATCH_SIZE
  const flowsOf = deps.readFlowsImpl || readFlows
  const reviewOf = deps.loadReviewImpl || loadReview
  const saidNoOf = deps.loadSuppressed || loadSaidNoSet

  // ── 1. The switch ───────────────────────────────────────────
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, location_id, mailchimp_connected, mailchimp_access_token, mailchimp_server_prefix, mailchimp_list_id, mailchimp_list_name, mailchimp_sync_live')
    .eq('id', locationUuid)
    .maybeSingle()
  if (locErr || !loc) return refuse('location_not_found')
  if (!loc.mailchimp_connected || !loc.mailchimp_access_token || !loc.mailchimp_server_prefix) return refuse('not_connected')
  if (!loc.mailchimp_list_id) return refuse('no_audience')
  // False means false — nothing is sent, nothing is read.
  if (!loc.mailchimp_sync_live) return refuse('sync_not_enabled')

  const token = loc.mailchimp_access_token as string
  const prefix = loc.mailchimp_server_prefix as string
  const base = apiBase(prefix)
  const listId = loc.mailchimp_list_id as string
  const listName = (loc.mailchimp_list_name as string) || null
  const clean = (t: unknown) => scrub(String(t ?? ''), token)

  // ── 2. The flows, live ──────────────────────────────────────
  const readNowFlows = () => flowsOf({ token, serverPrefix: prefix, listId, fetchImpl: doFetch, sleep })
  const flows = await readNowFlows()
  if (!flows.ok) return refuse('mailchimp_unreadable', { words: FLOWS_UNREADABLE_WORDS })
  if (flows.mustPause.length) {
    return refuse('signup_flows_live', { mustPause: flows.mustPause.map(flowLine), howToPause: HOW_TO_PAUSE })
  }

  // ── 3. Who, live ────────────────────────────────────────────
  // The no-marketing list must be readable. loadSaidNoSet treats a missing
  // table as "nobody said no"; for sending, that is a guess, so check first.
  {
    const probe = await db.from('marketing_unsubscribes').select('email_normalized', { count: 'exact', head: true })
    if (probe?.error) return refuse('no_list_unreadable', { words: 'The no-marketing list could not be read, so nothing was sent.' })
  }
  const review = await reviewOf(locationUuid, { db: deps.db, fetchImpl: deps.fetchImpl, sleep: deps.sleep, loadSuppressed: deps.loadSuppressed, withLeadIds: true })
  if (!review.ok) return refuse('beehub_unreadable', { words: review.words })
  if (review.mailchimpWords || !review.model.mailchimpKnown) return refuse('mailchimp_unreadable', { words: review.mailchimpWords || FLOWS_UNREADABLE_WORDS })
  if (!review.choicesReady) return refuse('choices_not_ready', { words: 'Saving choices isn’t switched on yet, so nothing was sent.' })

  const model = review.model
  const groupChoice: Record<string, 'in' | 'out' | null> = {}
  for (const g of model.groups) groupChoice[g.key] = g.choice
  const sameSet = matchedByPhone(model.phone)
  const offered = model.people.filter((p) => !sameSet.has(p.k))
  let sendSet = offered.filter((p) => isIncluded(p, groupChoice))
  const skipped = offered.length - sendSet.length

  // Belt and braces, right before sending: the no-marketing list again, and
  // Mailchimp's archived contacts (an archived contact can be re-added, which
  // would undo the owner's archiving — so they are never in the set).
  {
    const saidNo = await saidNoOf(sendSet.map((p) => p.e))
    const archived = await readArchivedKeys({ base, listId, token, doFetch, sleep })
    if (!archived.ok) return refuse('mailchimp_unreadable', { words: FLOWS_UNREADABLE_WORDS })
    sendSet = sendSet.filter((p) => !saidNo.has(p.k) && !archived.keys.has(p.k))
  }
  // Who Mailchimp refused before (lib/mailchimp-refusals.ts, 2026-11-26): an
  // invalid address — or one refused HOLD_AFTER times — is not sent again
  // until its address is edited or the owner presses Try again. Counted, so
  // the result line says so. Unreadable (migration not run) = nobody held.
  const refusals = await loadRefusals(locationUuid, { db })
  const refusedBefore: Map<string, Refusal> = refusals.ok ? refusals.byKey : new Map()
  const heldBack = sendSet.filter((p) => isHeld(refusedBefore.get(p.k))).length
  sendSet = sendSet.filter((p) => !isHeld(refusedBefore.get(p.k)))
  sendSet.sort((a, b) => a.k.localeCompare(b.k))

  // ── 4. Tags, and which are held ─────────────────────────────
  // Live records only (lib/mailchimp-review-load.ts leaves the Recycle Bin out;
  // the rows are checked again below, right before anything is sent).
  const idsByKey: Record<string, string[]> = { ...(review.leadIdsByKey || {}) }
  // People an earlier run added whose tags did not land ('tags_pending'):
  // they are in Mailchimp now, so they are not in sendSet, but their tags are
  // still owed. They are finished first, and a run is never 'complete' while
  // any is left.
  const pendingRes = await db.from('leads').select('id, email').eq('location_uuid', locationUuid).not('is_junk', 'is', true).like('mailchimp_sync_error', 'tags_pending:%')
  if (pendingRes?.error) throw new Error(`tags_pending read failed: ${pendingRes.error.message}`)
  const repair: Array<{ k: string; e: string }> = []
  {
    const seen = new Set(sendSet.map((p) => p.k))
    for (const r of pendingRes?.data || []) { const k = emailKey(r.email); if (k && !seen.has(k)) { seen.add(k); repair.push({ k, e: String(r.email).trim() }) } }
  }
  const sendIds = [...sendSet, ...repair].flatMap((p) => idsByKey[p.k] || [])
  const { rowsById, tagsById } = await loadRowsAndTags(db, sendIds, now())
  // THE RECYCLE BIN (2026-11-26): a record put in the bin since the read above,
  // or gone, is dropped here — it gives no tags, is never stamped or written,
  // and an address left with no live record is not sent at all.
  for (const k of Object.keys(idsByKey)) idsByKey[k] = idsByKey[k].filter((id) => rowsById[id] && rowsById[id].is_junk !== true)
  const hasLive = (p: { k: string }) => (idsByKey[p.k] || []).length > 0
  sendSet = sendSet.filter(hasLive)
  for (let j = repair.length - 1; j >= 0; j--) if (!hasLive(repair[j])) repair.splice(j, 1)
  const tagsByKey = new Map<string, string[]>()
  for (const p of [...sendSet, ...repair]) {
    const all: string[] = []
    for (const id of idsByKey[p.k] || []) all.push(...(tagsById[id] || []))
    tagsByKey.set(p.k, buildMemberTags({ leadTags: all }))
  }
  const liveTagFlows = new Map<string, string[]>()     // lower(tag) → flow names
  for (const f of flows.tagFlows) if (f.tag) liveTagFlows.set(f.tag.toLowerCase(), [...(liveTagFlows.get(f.tag.toLowerCase()) || []), f.name])
  const heldTags: HeldTag[] = []
  {
    const counts = new Map<string, { tag: string; n: number }>()
    for (const tags of Array.from(tagsByKey.values())) for (const t of tags) {
      const lc = t.toLowerCase()
      if (!liveTagFlows.has(lc)) continue
      const c = counts.get(lc) || { tag: t, n: 0 }; c.n++; counts.set(lc, c)
    }
    for (const [lc, c] of Array.from(counts.entries())) heldTags.push({ tag: c.tag, flows: liveTagFlows.get(lc) || [], people: c.n })
    heldTags.sort((a, b) => a.tag.localeCompare(b.tag))
  }

  // Kevin's known condition (lib/mailchimp-flows.ts KEVIN_KNOWN_FLOW_TAGS — his
  // word, not Mailchimp's): "Profile Quiz - Welcome Flow" only emails people
  // tagged "Profile Quiz". It is safe ONLY while nobody in this sync would get
  // that tag (any capitals). If anyone would, refuse exactly as for any live
  // sign-up flow, and name it. Nothing has been sent at this point.
  for (const c of flows.kevinConditional || []) {
    const lc = c.tag.toLowerCase()
    const wouldTag = [...sendSet, ...repair].filter((p) => (tagsByKey.get(p.k) || []).some((t) => t.toLowerCase() === lc)).length
    if (wouldTag > 0) {
      return refuse('signup_flows_live', {
        mustPause: [flowLine(c.flow)], howToPause: HOW_TO_PAUSE,
        words: `“${c.flow.name}” emails everyone tagged “${c.tag}”, and Bee Hub would send that tag to ${wouldTag === 1 ? '1 person' : `${wouldTag} people`}. Pause it first.`,
      })
    }
  }

  // ── 5. First sync? Then the confirmation ────────────────────
  // Its own read. If it can't be read (the migration not run yet), this IS a
  // first sync: guessing "not first" is the unconfirmed mass add this exists
  // to stop.
  const firstDone = await db.from('locations').select('mailchimp_first_sync_at').eq('id', locationUuid).maybeSingle()
  const first = !!firstDone?.error || !firstDone?.data?.mailchimp_first_sync_at

  let tagsOk = new Set<string>()
  // The first sync always asks — even with nobody to send (2026-11-27,
  // FL-131 bug): saying yes is how the owner finishes the set-up, and that
  // date is what starts the ongoing sync. So an unconfirmed call never sets
  // it, at any count; a confirmed 0 sets it below. (A run that only finishes
  // tags owed from a first send that stopped partway goes on as before.)
  if (first && (sendSet.length > 0 || repair.length === 0)) {
    const c = opts.confirm
    const confirmed = !!c && c.count === sendSet.length && c.listId === listId && c.flows === flows.fingerprint
    if (!confirmed) {
      return refuse('needs_confirmation', {
        first: true,
        confirm: {
          count: sendSet.length, listId, listName, flows: flows.fingerprint, pausedFlows: flows.signupFlows.map(flowLine), heldTags,
          leftOut: { archived: offered.filter((p) => p.g === 'archived' && !isIncluded(p, groupChoice)).length, refused: heldBack },
        },
        skipped,
      })
    }
    tagsOk = new Set((c!.tagsOk || []).map((t) => String(t).trim().toLowerCase()))
  }
  const tagsHeld = heldTags.filter((h) => !tagsOk.has(h.tag.toLowerCase())).map((h) => h.tag)
  const carry = (tags: string[]) => tags.filter((t) => !liveTagFlows.has(t.toLowerCase()) || tagsOk.has(t.toLowerCase()))

  if (sendSet.length === 0 && repair.length === 0) {
    // Nobody needed sending. On the first sync (confirmed above) the set-up
    // is finished all the same: the date is saved, once.
    if (first) {
      const set = await db.from('locations').update({ mailchimp_first_sync_at: new Date(now()).toISOString() })
        .eq('id', locationUuid).is('mailchimp_first_sync_at', null).select('id')
      if (set?.error) return { ran: true, first, complete: false, stopReason: `record_not_saved: ${clean(set.error.message)}`, ...emptyReport(), skipped, heldBack, tagsHeld }
    }
    return { ran: true, first, complete: true, ...emptyReport(), skipped, heldBack, tagsHeld }
  }

  // ── 6. Send ─────────────────────────────────────────────────
  const report: SyncReport = { ran: true, first, complete: false, ...emptyReport(), skipped, heldBack, tagsHeld }
  const segments = new SegmentCache({ base, listId, token, doFetch, sleep })
  const stampNow = () => new Date(now()).toISOString()
  const idsFor = (keys: Iterable<string>) => Array.from(keys).flatMap((k) => idsByKey[k] || [])
  // Tags for people Bee Hub added; one call per tag per 500 people.
  const applyTags = async (people: Array<{ k: string; e: string }>): Promise<string | null> => {
    const byTag = new Map<string, { name: string; emails: string[] }>()
    for (const p of people) for (const t of carry(tagsByKey.get(p.k) || [])) {
      const lc = t.toLowerCase(); const g = byTag.get(lc) || { name: t, emails: [] }; g.emails.push(p.e); byTag.set(lc, g)
    }
    for (const g of Array.from(byTag.values())) {
      const ok = await segments.addMembers(g.name, g.emails)
      if (!ok.ok) return `tags_failed (${g.name}): ${clean(ok.detail)}`
    }
    return null
  }
  // Right before EVERY Mailchimp write: the flows again. Any change stops the run.
  const flowsStillSame = async () => {
    const fresh = await readNowFlows()
    return fresh.ok && fresh.fingerprint === flows.fingerprint && fresh.mustPause.length === 0
  }

  let i = 0
  let stopReason: string | null = null
  try {
  // Owed tags first.
  if (repair.length) {
    if (!(await flowsStillSame())) stopReason = 'flows_changed'
    else {
      const fail = await applyTags(repair)
      if (fail) stopReason = fail
      else await writeLeads(db, idsFor(repair.map((p) => p.k)), { mailchimp_synced_at: stampNow(), mailchimp_sync_error: null, updated_at: stampNow() })
    }
  }
  for (; !stopReason && i < sendSet.length; i += batchSize) {
    if (now() - started > budget) { stopReason = 'time'; break }
    if (!(await flowsStillSame())) { stopReason = 'flows_changed'; break }

    const chunk = sendSet.slice(i, i + batchSize)
    const res = await mcWrite(doFetch, sleep, token, 'POST', `${base}lists/${encodeURIComponent(listId)}`, {
      members: chunk.map((p) => {
        const row = (idsByKey[p.k] || []).map((id) => rowsById[id]).find(Boolean) || {}
        return { email_address: p.e, status: 'subscribed', merge_fields: { FNAME: String(row.first_name || '').trim(), LNAME: String(row.last_name || '').trim() } }
      }),
      update_existing: false,
    })
    if (!res.ok) { stopReason = `batch_failed: ${clean(res.detail)}`; break }

    const added = new Set<string>()
    for (const m of res.body?.new_members || []) { const k = emailKey(m?.email_address); if (k) added.add(k) }
    if (Number(res.body?.total_updated || 0) > 0 || (res.body?.updated_members || []).length) {
      // Cannot happen with update_existing:false. If Mailchimp ever says it
      // did, stop at once and say so.
      stopReason = 'mailchimp_reported_an_update'; break
    }
    const already = new Set<string>()
    const failed = new Map<string, string>()
    const failedKind = new Map<string, { kind: 'invalid' | 'temporary'; code: string | null }>()
    const saidNoHere = new Map<string, string>()
    for (const e of res.body?.errors || []) {
      const k = emailKey(e?.email_address); if (!k) continue
      if (e?.error_code === 'ERROR_CONTACT_EXISTS') {
        // After a retried call, "already a member" is our own first try landing.
        if (res.attempts > 1) added.add(k); else already.add(k)
        continue
      }
      const text = clean(e?.error || e?.error_code || 'refused')
      const kind = classifyRefusal(e?.error_code, e?.error)
      // A "no" (Kevin, 2026-11-26) goes on the no-marketing list below.
      if (kind === 'said_no') saidNoHere.set(k, text)
      else { failed.set(k, text); failedKind.set(k, { kind: kind === 'invalid' ? 'invalid' : 'temporary', code: e?.error_code ? String(e.error_code) : null }) }
    }

    // Tags for the people this batch added. Adding a tag is a write that can
    // start a flow, so the flows are read once more right before it: if
    // anything changed since the batch went (a tag flow switched on, say), no
    // tag is added, the tags stay owed ('tags_pending') and the run stops.
    const toTag = chunk.filter((p) => added.has(p.k))
    const anyTags = toTag.some((p) => carry(tagsByKey.get(p.k) || []).length > 0)
    const tagFail = !anyTags ? null : !(await flowsStillSame()) ? 'flows_changed' : await applyTags(toTag)

    const stamp = stampNow()
    if (tagFail) {
      await writeLeads(db, idsFor(added), { mailchimp_status: 'subscribed', mailchimp_sync_error: `tags_pending: ${tagFail}`.slice(0, 500), updated_at: stamp })
    } else {
      await writeLeads(db, idsFor(added), { mailchimp_synced_at: stamp, mailchimp_status: 'subscribed', mailchimp_sync_error: null, updated_at: stamp })
    }
    await writeLeads(db, idsFor(already), { mailchimp_synced_at: stamp, mailchimp_status: 'already_in_mailchimp', mailchimp_sync_error: null, updated_at: stamp })
    for (const [k, msg] of Array.from(saidNoHere.entries())) {
      const email = chunk.find((p) => p.k === k)?.e || k
      if (await recordSaidNo(locationUuid, listId, email, msg, { db })) {
        report.saidNo++
        await writeLeads(db, idsByKey[k] || [], { mailchimp_sync_error: `said_no_in_mailchimp: ${msg}`.slice(0, 500), updated_at: stamp })
      } else {
        // The list could not be written (its function is not there yet): keep
        // it as a refusal, so it is still remembered and shown.
        failed.set(k, msg); failedKind.set(k, { kind: 'temporary', code: null })
      }
    }
    for (const [k, msg] of Array.from(failed.entries())) {
      await writeLeads(db, idsByKey[k] || [], { mailchimp_sync_error: msg.slice(0, 500), updated_at: stamp })
      if (refusals.ok) await recordRefusal(locationUuid, k, { ...failedKind.get(k)!, text: msg }, stamp, refusedBefore.get(k), { db })
      if (report.errors.length < 25) report.errors.push({ email_key: k, error: msg })
    }
    // Refused before, added now (Try again, or a temporary refusal that cleared).
    if (refusals.ok) for (const k of Array.from(added)) if (refusedBefore.has(k)) await clearRefusal(locationUuid, k, { db })
    report.pushed += added.size
    report.alreadyThere += already.size
    report.failed += failed.size
    if (tagFail) { stopReason = tagFail; i += batchSize; break }
  }
  } catch (err: any) {
    // Something broke mid-run (a Bee Hub write, say). Whatever already went
    // to Mailchimp stays there; the run is recorded as partial, never complete.
    stopReason = `error: ${clean(err?.message || err).slice(0, 300)}`
  }
  report.remaining = Math.max(0, sendSet.length - Math.min(i, sendSet.length))
  report.complete = !stopReason && report.remaining === 0
  if (stopReason) report.stopReason = stopReason

  // Only a run that finished EVERYTHING sets the first-sync date, and only
  // once (never moved by a later run). A run that stopped partway sets
  // nothing, so the next press asks again — for the people still to go.
  if (first && report.complete) {
    const set = await db.from('locations').update({ mailchimp_first_sync_at: stampNow() })
      .eq('id', locationUuid).is('mailchimp_first_sync_at', null).select('id')
    if (set?.error) {
      // Everything went, but the date did not land: say so; the next press
      // will simply ask for confirmation again (with nothing left to send).
      report.stopReason = `record_not_saved: ${clean(set.error.message)}`
    }
  }
  // The run's summary, for Vercel's logs (no addresses, no token).
  console.info('[mailchimp-push]', JSON.stringify({ location: loc.location_id || locationUuid, first, complete: report.complete, added: report.pushed, already: report.alreadyThere, failed: report.failed, said_no: report.saidNo, held_back: report.heldBack, remaining: report.remaining, skipped, tags_held: tagsHeld, stop: report.stopReason || null }))
  return report
}

// ── Mailchimp writes, with retries ────────────────────────────
async function mcWrite(doFetch: any, sleep: (ms: number) => Promise<void>, token: string, method: 'POST', url: string, body: unknown):
  Promise<{ ok: true; body: any; attempts: number } | { ok: false; detail: string }> {
  for (let attempt = 0; ; attempt++) {
    let res: any
    try {
      res = await doFetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
    } catch (err: any) {
      if (attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt); continue }
      return { ok: false, detail: String(err?.message || err) }
    }
    const text = await res.text().catch(() => '')
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch { parsed = { detail: text.slice(0, 200) } }
    if (res.status >= 200 && res.status < 300) return { ok: true, body: parsed, attempts: attempt + 1 }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const after = Number(res.headers?.get?.('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt)
      continue
    }
    return { ok: false, detail: `http ${res.status}: ${String(parsed?.detail || parsed?.title || '').slice(0, 200)}` }
  }
}

async function mcGet(doFetch: any, sleep: (ms: number) => Promise<void>, token: string, url: string): Promise<{ ok: true; body: any } | { ok: false }> {
  for (let attempt = 0; ; attempt++) {
    let res: any
    try { res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }) }
    catch { if (attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt); continue } return { ok: false } }
    const text = await res.text().catch(() => '')
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch { parsed = null }
    if (res.status >= 200 && res.status < 300 && parsed) return { ok: true, body: parsed }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt); continue }
    return { ok: false }
  }
}

// Mailchimp's archived contacts, by address. GET only; a failed read fails.
async function readArchivedKeys(a: { base: string; listId: string; token: string; doFetch: any; sleep: (ms: number) => Promise<void> }):
  Promise<{ ok: true; keys: Set<string> } | { ok: false }> {
  const keys = new Set<string>()
  for (let offset = 0; ; offset += 1000) {
    const r = await mcGet(a.doFetch, a.sleep, a.token, `${a.base}lists/${encodeURIComponent(a.listId)}/members?status=archived&count=1000&offset=${offset}&fields=total_items,members.email_address`)
    if (!r.ok) return { ok: false }
    const rows = Array.isArray(r.body?.members) ? r.body.members : null
    const total = Number(r.body?.total_items)
    if (!rows || !Number.isFinite(total)) return { ok: false }
    for (const m of rows) { const k = emailKey(m?.email_address); if (k) keys.add(k) }
    if (!rows.length || offset + rows.length >= total) return { ok: true, keys }
  }
}

// Tags are static segments. Read once, created when missing, members added
// 500 at a time. Adding a tag never changes anyone's status.
class SegmentCache {
  private ids: Map<string, string> | null = null
  constructor(private a: { base: string; listId: string; token: string; doFetch: any; sleep: (ms: number) => Promise<void> }) {}
  private async load(): Promise<boolean> {
    if (this.ids) return true
    const ids = new Map<string, string>()
    for (let offset = 0; ; offset += 1000) {
      const r = await mcGet(this.a.doFetch, this.a.sleep, this.a.token, `${this.a.base}lists/${encodeURIComponent(this.a.listId)}/segments?type=static&count=1000&offset=${offset}&fields=total_items,segments.id,segments.name`)
      if (!r.ok) return false
      const rows = Array.isArray(r.body?.segments) ? r.body.segments : []
      for (const s of rows) ids.set(String(s.name || '').trim().toLowerCase(), String(s.id))
      if (!rows.length || offset + rows.length >= Number(r.body?.total_items || 0)) break
    }
    this.ids = ids
    return true
  }
  async addMembers(name: string, emails: string[]): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (!(await this.load())) return { ok: false, detail: 'tags could not be read' }
    const lc = name.trim().toLowerCase()
    let id = this.ids!.get(lc)
    if (!id) {
      const made = await mcWrite(this.a.doFetch, this.a.sleep, this.a.token, 'POST', `${this.a.base}lists/${encodeURIComponent(this.a.listId)}/segments`, { name: name.trim(), static_segment: [] })
      if (!made.ok || !made.body?.id) return { ok: false, detail: made.ok ? 'no tag id' : made.detail }
      id = String(made.body.id); this.ids!.set(lc, id)
    }
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const r = await mcWrite(this.a.doFetch, this.a.sleep, this.a.token, 'POST', `${this.a.base}lists/${encodeURIComponent(this.a.listId)}/segments/${encodeURIComponent(id)}`, { members_to_add: emails.slice(i, i + BATCH_SIZE) })
      if (!r.ok) return { ok: false, detail: r.detail }
    }
    return { ok: true }
  }
}

async function writeLeads(db: any, ids: string[], patch: Record<string, unknown>) {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await db.from('leads').update(patch).in('id', ids.slice(i, i + 200))
    if (error) throw new Error(`lead write-back failed: ${error.message}`)
  }
}

// ── Each record's tags (the hub-all-overview recipe) ──────────
// The status tag must be the LIVE derivation, so fetch what it reads: each
// lead's engagements (open → Active, won → Client, any → settles Nurturing),
// reach-out touchpoints, Jobber child rows and Network moves — the same inputs
// the Hub ships, so the tag agrees with what the Hub shows. Chunked .in().
async function loadRowsAndTags(db: any, ids: string[], nowMs: number): Promise<{ rowsById: Record<string, any>; tagsById: Record<string, string[]> }> {
  const { rowsById, tagsById } = await loadRowsAndTagsWithStatus(db, ids, nowMs)
  return { rowsById, tagsById }
}
// The same, plus each record's live client status (the one-person add reads
// it to refuse anyone who is still a request).
async function loadRowsAndTagsWithStatus(db: any, ids: string[], nowMs: number): Promise<{ rowsById: Record<string, any>; tagsById: Record<string, string[]>; statusById: Record<string, string> }> {
  const rowsById: Record<string, any> = {}
  const tagsById: Record<string, string[]> = {}
  const statusById: Record<string, string> = {}
  if (!ids.length) return { rowsById, tagsById, statusById }
  const openIds = new Set<string>()
  const wonIds = new Set<string>()
  const engagementCounts: Record<string, number> = {}
  const lastClosedByLead: Record<string, string> = {}
  const srByLead: Record<string, any[]> = {}
  const quotesByLead: Record<string, any[]> = {}
  const jobsByLead: Record<string, any[]> = {}
  const networkMoved = new Set<string>()
  const touchByLead: Record<string, any[]> = {}
  const leadTagRows: Array<{ lead_id: string; tag_lookup_id: string }> = []
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const [leadRes, engRes, touchRes, tagRes, srRes, quoteRes, jobRes, partnerRes] = await Promise.all([
      db.from('leads').select('*').in('id', chunk),
      db.from('engagements').select('client_id, stage, closed_at').in('client_id', chunk),
      // ⚠️ `kind`, not `type` — the COLUMN is touchpoints.kind.
      db.from('touchpoints').select('lead_id, kind, label, occurred_at').in('lead_id', chunk),
      db.from('lead_tags').select('lead_id, tag_lookup_id').in('lead_id', chunk),
      db.from('service_requests').select('lead_id, requested_at, created_at').in('lead_id', chunk),
      db.from('quotes').select('lead_id, created_at').in('lead_id', chunk),
      db.from('jobs').select('lead_id, created_at').in('lead_id', chunk),
      db.from('partners').select('customer_lead_id, is_customer').is('deleted_at', null).in('customer_lead_id', chunk),
    ])
    for (const [name, r] of [['leads', leadRes], ['engagements', engRes], ['touchpoints', touchRes], ['lead_tags', tagRes], ['service_requests', srRes], ['quotes', quoteRes], ['jobs', jobRes], ['partners', partnerRes]] as const) {
      if ((r as any).error) throw new Error(`${name} read failed: ${(r as any).error.message}`)
    }
    for (const l of leadRes.data || []) rowsById[l.id] = l
    for (const e of engRes.data || []) {
      engagementCounts[e.client_id] = (engagementCounts[e.client_id] || 0) + 1
      if (e.stage === 'Closed Won') wonIds.add(e.client_id)
      if (e.stage !== 'Closed Won' && e.stage !== 'Closed Lost') openIds.add(e.client_id)
      else if (e.closed_at && (!lastClosedByLead[e.client_id] || e.closed_at > lastClosedByLead[e.client_id])) lastClosedByLead[e.client_id] = e.closed_at
    }
    for (const t of touchRes.data || []) (touchByLead[t.lead_id] ||= []).push(t)
    leadTagRows.push(...(tagRes.data || []))
    for (const s of srRes.data || []) (srByLead[s.lead_id] ||= []).push(s)
    for (const q of quoteRes.data || []) (quotesByLead[q.lead_id] ||= []).push(q)
    for (const j of jobRes.data || []) (jobsByLead[j.lead_id] ||= []).push(j)
    for (const p of partnerRes.data || []) if (p.is_customer !== true && p.customer_lead_id) networkMoved.add(String(p.customer_lead_id))
  }
  // Tag definitions ONCE for the whole run — one .in() read, never per lead.
  const tagLabelById: Record<string, string> = {}
  const tagLookupIds = Array.from(new Set(leadTagRows.map((r) => r.tag_lookup_id)))
  if (tagLookupIds.length > 0) {
    const { data: lookupRows, error: lookupErr } = await db.from('lookups').select('id, label').in('id', tagLookupIds)
    if (lookupErr) throw new Error(`lookups read failed: ${lookupErr.message}`)
    for (const r of lookupRows || []) tagLabelById[r.id] = r.label
  }
  const labelsByLead: Record<string, string[]> = {}
  for (const r of leadTagRows) { const label = tagLabelById[r.tag_lookup_id]; if (label) (labelsByLead[r.lead_id] ||= []).push(label) }
  for (const id of ids) {
    const row = rowsById[id]
    if (!row) continue
    const person = mapLeadToPerson(row, {
      touchpoints: touchByLead[id] || [],
      engagement_count: engagementCounts[id] || 0,
      service_requests: srByLead[id] || [],
      quotes: quotesByLead[id] || [],
      jobs: jobsByLead[id] || [],
      last_closed_at: lastClosedByLead[id] || null,
      network_moved: networkMoved.has(id),
    })
    const status = deriveClientStatus(person, openIds, nowMs, wonIds)
    statusById[id] = status
    tagsById[id] = buildMemberTags({ projectType: row.project_type, source: row.source, clientStatus: status, leadTags: labelsByLead[id] || [] })
  }
  return { rowsById, tagsById, statusById }
}

// ═════════════════════════════════════════════════════════════════════════
// ONE PERSON, ADDED BECAUSE AN OWNER SAID SO (FL-137/135, Kevin 2026-11-28)
// ═════════════════════════════════════════════════════════════════════════
// Send to Jobber's "Add to Mailchimp" box, the Closed Lost box, the 35-day
// auto-close and the Nurturing tab's "Send to Mailchimp" box all end here.
// Every lock the batch above has, for one person, in the same order:
//   · Test Location only before roll-out (lib/mailchimp-rollout.ts).
//   · The owner chose them: leads.mailchimp_choice is 'in'. Nobody else, ever.
//   · Never while they are still a request (an open enquiry in the Inbox).
//   · Kevin's switch, the connection, the audience; and the set-up must be
//     finished (before that, the set-up's own screen covers everyone).
//   · REFUSED WHILE ANY SIGN-UP FLOW IS LIVE (Kevin, 2026-11-28: one person
//     or many — Mailchimp would send its own welcome). Unreadable flows are
//     a refusal too. Read again right before the add and before any tag.
//   · Never the Recycle Bin, never anyone who said no (their record, the
//     shared no-marketing list), never an address Mailchimp keeps refusing.
//   · Never changes anyone already in Mailchimp: their address is looked up
//     first, and the add is update_existing: false.
//   · Tags that start a live flow are held back (nobody is here to say yes).
// Nothing here emails anyone from Bee Hub.

export type AddOneOutcome =
  | 'added' | 'already_there'
  | 'not_found' | 'not_open' | 'not_chosen' | 'still_an_enquiry' | 'recycle_bin' | 'no_email' | 'said_no'
  | 'sync_not_enabled' | 'not_connected' | 'no_audience' | 'setup_not_finished'
  | 'mailchimp_unreadable' | 'signup_flows_live' | 'no_list_unreadable' | 'held' | 'refused' | 'failed'

export type AddOneResult = { sent: boolean; outcome: AddOneOutcome; words: string; flows?: string[] }

export const ADD_ONE_WORDS: Record<AddOneOutcome, string> = {
  added: 'Added to Mailchimp.',
  already_there: 'Already in Mailchimp, so left exactly as they were.',
  not_found: 'Not sent to Mailchimp: this person could not be found.',
  not_open: 'Not sent to Mailchimp: Mailchimp is coming soon for this location.',
  not_chosen: 'Not sent to Mailchimp: nobody chose to send them.',
  still_an_enquiry: 'Not sent to Mailchimp: they are still a new enquiry in the Inbox.',
  recycle_bin: 'Not sent to Mailchimp: this person is in the Recycle Bin.',
  no_email: 'Not sent to Mailchimp: there is no email address for them.',
  said_no: 'Not sent to Mailchimp: they have said no to marketing emails.',
  sync_not_enabled: 'Not sent to Mailchimp: sending is not switched on for this location yet.',
  not_connected: 'Not sent to Mailchimp: Mailchimp is not connected.',
  no_audience: 'Not sent to Mailchimp: no Mailchimp audience is chosen.',
  setup_not_finished: 'Not sent to Mailchimp yet: finish the Mailchimp set-up first. It covers this person.',
  mailchimp_unreadable: 'Not sent to Mailchimp: Mailchimp could not be checked just now.',
  signup_flows_live: 'Not sent to Mailchimp: a welcome journey is switched on in Mailchimp, and it would email them. Pause it first.',
  no_list_unreadable: 'Not sent to Mailchimp: the no-marketing list could not be checked.',
  held: 'Not sent to Mailchimp: Mailchimp has refused this address before.',
  refused: 'Not sent to Mailchimp: Mailchimp refused this address.',
  failed: 'Not sent to Mailchimp: something went wrong. Nothing was changed there.',
}

const STILL_AN_ENQUIRY = new Set(['New', 'Attempting'])

export async function addOneLeadToMailchimp(leadId: string, deps: Deps = {}): Promise<AddOneResult> {
  const db = deps.db || supabaseService
  const doFetch = deps.fetchImpl || ((url: string, init: any) => fetch(url, init) as any)
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now || (() => Date.now())
  const flowsOf = deps.readFlowsImpl || readFlows
  const saidNoOf = deps.loadSuppressed || loadSaidNoSet
  const out = (outcome: AddOneOutcome, extra: Partial<AddOneResult> = {}): AddOneResult => ({ sent: outcome === 'added', outcome, words: ADD_ONE_WORDS[outcome], ...extra })

  try {
    const { data: lead, error: leadErr } = await db.from('leads')
      .select('id, email, location_uuid, is_junk, archived_at, marketing_opt_out, marketing_unsubscribed_at, mailchimp_choice')
      .eq('id', leadId).maybeSingle()
    if (leadErr || !lead) return out('not_found')
    if (!mailchimpOpenFor(lead.location_uuid)) return out('not_open')
    if (lead.mailchimp_choice !== 'in') return out('not_chosen')
    if (lead.is_junk === true || lead.archived_at) return out('recycle_bin')
    const k = emailKey(lead.email)
    if (!k) return out('no_email')
    if (lead.marketing_opt_out === true || lead.marketing_unsubscribed_at) return out('said_no')

    const { data: loc, error: locErr } = await db.from('locations')
      .select('id, location_id, mailchimp_connected, mailchimp_access_token, mailchimp_server_prefix, mailchimp_list_id, mailchimp_sync_live, mailchimp_first_sync_at')
      .eq('id', lead.location_uuid).maybeSingle()
    if (locErr || !loc) return out('not_found')
    if (!loc.mailchimp_connected || !loc.mailchimp_access_token || !loc.mailchimp_server_prefix) return out('not_connected')
    if (!loc.mailchimp_list_id) return out('no_audience')
    if (!loc.mailchimp_sync_live) return out('sync_not_enabled')
    if (!loc.mailchimp_first_sync_at) return out('setup_not_finished')
    const token = loc.mailchimp_access_token as string
    const prefix = loc.mailchimp_server_prefix as string
    const base = apiBase(prefix)
    const listId = loc.mailchimp_list_id as string
    const clean = (t: unknown) => scrub(String(t ?? ''), token)

    // The flows, live. Any sign-up flow live → refuse, one person or many.
    const readNowFlows = () => flowsOf({ token, serverPrefix: prefix, listId, fetchImpl: doFetch, sleep })
    const flows = await readNowFlows()
    if (!flows.ok) return out('mailchimp_unreadable')
    if (flows.mustPause.length) return out('signup_flows_live', { flows: flows.mustPause.map((f) => f.name) })

    // Who they are now: their tags, and whether they are still a request.
    const { rowsById, tagsById, statusById } = await loadRowsAndTagsWithStatus(db, [leadId], now())
    const row = rowsById[leadId]
    if (!row || row.is_junk === true) return out('recycle_bin')
    if (STILL_AN_ENQUIRY.has(statusById[leadId])) return out('still_an_enquiry')
    const tags = tagsById[leadId] || []
    for (const c of flows.kevinConditional || []) {
      if (tags.some((t) => t.toLowerCase() === c.tag.toLowerCase())) return out('signup_flows_live', { flows: [c.flow.name] })
    }

    // The no-marketing list must be readable, then must not have them.
    const probe = await db.from('marketing_unsubscribes').select('email_normalized', { count: 'exact', head: true })
    if (probe?.error) return out('no_list_unreadable')
    if ((await saidNoOf([lead.email])).has(k)) return out('said_no')
    const refusals = await loadRefusals(lead.location_uuid, { db })
    const before = refusals.ok ? refusals.byKey.get(k) : undefined
    if (isHeld(before)) return out('held')

    // Already in Mailchimp, in any state (archived and unsubscribed too)? Leave them.
    const look = await mcGetStatus(doFetch, sleep, token, `${base}lists/${encodeURIComponent(listId)}/members/${MD5_OF_LOWERCASED_EMAIL(k)}?fields=status`)
    const stamp = () => new Date(now()).toISOString()
    if (look === 'unreadable') return out('mailchimp_unreadable')
    if (look === 'there') {
      await writeLeads(db, [leadId], { mailchimp_synced_at: stamp(), mailchimp_status: 'already_in_mailchimp', mailchimp_sync_error: null, updated_at: stamp() })
      return out('already_there')
    }

    const flowsStillSame = async () => {
      const fresh = await readNowFlows()
      return fresh.ok && fresh.fingerprint === flows.fingerprint && fresh.mustPause.length === 0
    }
    if (!(await flowsStillSame())) return out('signup_flows_live')
    const res = await mcWrite(doFetch, sleep, token, 'POST', `${base}lists/${encodeURIComponent(listId)}`, {
      members: [{ email_address: String(lead.email).trim(), status: 'subscribed', merge_fields: { FNAME: String(row.first_name || '').trim(), LNAME: String(row.last_name || '').trim() } }],
      update_existing: false,
    })
    if (!res.ok) { console.info('[mailchimp-add-one]', JSON.stringify({ outcome: 'failed', detail: clean(res.detail) })); return out('failed') }
    if (Number(res.body?.total_updated || 0) > 0 || (res.body?.updated_members || []).length) return out('failed')
    const added = (res.body?.new_members || []).some((m: any) => emailKey(m?.email_address) === k)
    const err = (res.body?.errors || []).find((e: any) => emailKey(e?.email_address) === k)
    if (!added) {
      if (err?.error_code === 'ERROR_CONTACT_EXISTS') {
        await writeLeads(db, [leadId], { mailchimp_synced_at: stamp(), mailchimp_status: 'already_in_mailchimp', mailchimp_sync_error: null, updated_at: stamp() })
        return out(res.attempts > 1 ? 'added' : 'already_there')
      }
      const text = clean(err?.error || err?.error_code || 'refused')
      const kind = classifyRefusal(err?.error_code, err?.error)
      if (kind === 'said_no') {
        await recordSaidNo(lead.location_uuid, listId, String(lead.email).trim(), text, { db })
        await writeLeads(db, [leadId], { mailchimp_sync_error: `said_no_in_mailchimp: ${text}`.slice(0, 500), updated_at: stamp() })
        return out('said_no')
      }
      await writeLeads(db, [leadId], { mailchimp_sync_error: text.slice(0, 500), updated_at: stamp() })
      if (refusals.ok) await recordRefusal(lead.location_uuid, k, { kind: kind === 'invalid' ? 'invalid' : 'temporary', code: err?.error_code ? String(err.error_code) : null, text }, stamp(), before, { db })
      return out('refused')
    }
    if (refusals.ok && before) await clearRefusal(lead.location_uuid, k, { db })

    // Tags: never one that starts a live flow; flows read again first.
    const liveTag = new Set(flows.tagFlows.map((f) => String(f.tag || '').toLowerCase()).filter(Boolean))
    const carry = tags.filter((t) => !liveTag.has(t.toLowerCase()))
    let tagFail: string | null = null
    if (carry.length) {
      if (!(await flowsStillSame())) tagFail = 'flows_changed'
      else {
        const segments = new SegmentCache({ base, listId, token, doFetch, sleep })
        for (const t of carry) { const r = await segments.addMembers(t, [String(lead.email).trim()]); if (!r.ok) { tagFail = `tags_failed (${t}): ${clean(r.detail)}`; break } }
      }
    }
    await writeLeads(db, [leadId], tagFail
      ? { mailchimp_status: 'subscribed', mailchimp_sync_error: `tags_pending: ${tagFail}`.slice(0, 500), updated_at: stamp() }
      : { mailchimp_synced_at: stamp(), mailchimp_status: 'subscribed', mailchimp_sync_error: null, updated_at: stamp() })
    console.info('[mailchimp-add-one]', JSON.stringify({ location: loc.location_id || lead.location_uuid, outcome: 'added', tags_held: tags.length - carry.length, tag_fail: tagFail }))
    return out('added')
  } catch (e: any) {
    console.error('[mailchimp-add-one] failed', String(e?.message || e).slice(0, 300))
    return out('failed')
  }
}

// GET one member: 200 → there; 404 → not there; anything else → unreadable.
async function mcGetStatus(doFetch: any, sleep: (ms: number) => Promise<void>, token: string, url: string): Promise<'there' | 'absent' | 'unreadable'> {
  for (let attempt = 0; ; attempt++) {
    let res: any
    try { res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }) }
    catch { if (attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt); continue } return 'unreadable' }
    if (res.status === 200) return 'there'
    if (res.status === 404) return 'absent'
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt); continue }
    return 'unreadable'
  }
}
