// lib/engagements.ts
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 engagement core: founding, attachment, stage
// derivation (docs/hive-phase1-engagements.md §3/§4, step 3 of §9).
//
// Dual-write phase: import + webhooks call into this module ADDITIVELY —
// every function here is designed to never throw out to its caller's
// happy path (callers wrap in try/catch and log), and leads.stage
// writes elsewhere are untouched. The board still reads leads.
//
// Stage authority: deriveEngagementStage is THE single source for
// engagement stage classification (ported from scripts/
// backfill-engagements.mjs, which re-expressed the 447be62 rules).
// When the read-flip lands (step 4), nothing else may classify.
//
// ENGAGEMENT_STAGE_RANK is engagement-only and intentionally separate
// from jobber-import.ts STAGE_RANK (lead stages) — do not merge them
// (§2: new rank table, engagement-only).
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { writeSyncLog } from './sync-log'
import { isUnbookedJobStatus } from './jobber-import'
import { resolveLeadAssignees } from './lead-assignment'
import { ENGAGEMENT_STAGE_RANK as RAW_ENGAGEMENT_STAGE_RANK } from '@/components/hive/shared/stageRank'
import { invoicesFullyPaid } from '@/components/hive/shared/engagementStatus'

export type EngagementStage =
  | 'Request'
  | 'Estimate'
  | 'Job in Progress'
  | 'Final Processing'
  | 'Closed Won'
  | 'Closed Lost'

export type FoundedBy = 'request' | 'quote' | 'job' | 'manual'

export type EngagementChildTable = 'service_requests' | 'quotes' | 'jobs' | 'invoices' | 'assessments'

// Rank + terminality live in the PURE module components/hive/shared/
// stageRank.js so client code (stageConfig.js) never has to import this
// file — importing lib/engagements.ts client-side pulls the Supabase
// service client into the browser bundle and crashes at module load
// (2026-07-03 incident). Re-exported here for server-side consumers.
export const ENGAGEMENT_STAGE_RANK =
  RAW_ENGAGEMENT_STAGE_RANK as Record<EngagementStage, number>

// Opening stage per founded_by (§3 rule 6).
export const OPENING_STAGE: Record<FoundedBy, EngagementStage> = {
  request: 'Request',
  quote:   'Estimate',
  job:     'Job in Progress',
  manual:  'Request',
}

export const NURTURING_AGE_MS = 30 * 24 * 60 * 60 * 1000

const ts = (v: any) => (v ? new Date(v).getTime() : 0)

// ── stage derivation (single source) ──────────────────────────────
//
// mode 'live' (default): stale >30d chains stay in their live stage —
// closing quiet engagements is the nurture cron's job (step 5), which
// owns the sequence + day-90 auto-close. mode 'backfill' additionally
// applies the §5 stale-close rules (Ruling A / decision 14) for
// historical imports where no sequence should ever fire.
//
// closeWonOnDone (default true): whether a done + all-paid booked job
// AUTO-resolves to Closed Won. IMPORT-ONLY auto-close (2026-07-11): the
// bulk import (backfill) auto-closes historical wrapped-up deals to Won
// so owners never click through years of completed jobs. LIVE paths
// (webhook, panel-open drift) pass false: the same done+all-paid deal
// rests at Final Processing (rank 3) so the panel's "Ready to close —
// Mark won" button surfaces (canCloseWon = Final Processing + fully
// paid) and the user runs the close-won wizard — that's where the
// satisfaction / review / re-engage / confetti steps live, which live
// deals must go through. Default true keeps the honest classification
// for callers that WANT the true terminal (reopen re-derive; the stale-
// Lost import-artifact recovery in the advance/drift paths below).

export type EngagementChildren = {
  sr: { requested_at?: string | null; created_at?: string | null } | null
  quotes: Array<{ status?: string | null; sent_at?: string | null; approved_at?: string | null; created_at?: string | null }>
  jobs: Array<{ status?: string | null; completed_at?: string | null; scheduled_start?: string | null; created_at?: string | null }>
  invoices: Array<{ status?: string | null; paid_at?: string | null; issued_at?: string | null; created_at?: string | null }>
}

export type DerivedStage = {
  stage: EngagementStage
  closed_reason?: string
  closed_at?: string
}

export const engagementJobDone = (j: { status?: string | null; completed_at?: string | null }) =>
  !!j.completed_at || (j.status || '').toLowerCase().includes('complet')

// Unbooked jobs (jobs.status 'unscheduled' / 'action_required' /
// 'on_hold' — JOB_STATUS in lib/jobber-import.ts) have no visit booked:
// agreed-but-unbooked or ran-out-of-visits work, the job-side twin of a
// sent quote — NOT current work. They must not hold an engagement at
// 'Job in Progress' nor block Won/Final Processing when booked jobs are
// done; an engagement whose only jobs are unbooked classifies like its
// quotes (Estimate live; stale-close eligible in backfill mode).
// completed_at wins over the label.
const jobUnbooked = (j: { status?: string | null; completed_at?: string | null }) =>
  !j.completed_at && isUnbookedJobStatus(j.status)

const quoteActivity = (q: { sent_at?: string | null; approved_at?: string | null; created_at?: string | null }) =>
  Math.max(ts(q.approved_at), ts(q.sent_at), ts(q.created_at))

export function deriveEngagementStage(
  children: EngagementChildren,
  opts: { mode?: 'live' | 'backfill'; nowMs?: number; closeWonOnDone?: boolean; closeOnArchivedQuote?: boolean } = {},
): DerivedStage {
  const mode = opts.mode ?? 'live'
  const now = opts.nowMs ?? Date.now()
  const closeWonOnDone = opts.closeWonOnDone ?? true
  const { sr, quotes, jobs, invoices } = children

  const bookedJobs = jobs.filter(j => !jobUnbooked(j))
  const unbookedJobs = jobs.filter(jobUnbooked)

  // #117 — archived-quote close. An archived quote is Jobber's lost/dead
  // state (quote-status-map.ts: ARCHIVED → 'archived'). When EVERY quote on
  // the engagement is archived and nothing has advanced past them — no jobs
  // at all (booked or unbooked), no invoices — the deal is dead: Closed Lost.
  //
  //   · second, non-archived quote → every(archived) false → not closed
  //   · a job (booked or unbooked) → jobs.length guard → not closed
  //     (and a booked job already outranks this via the branch below)
  //   · an invoice (even jobless, rule 6) → invoices.length guard → not closed
  //   · already terminal → the CALLER's forward-only rank guard blocks it
  //     (Closed Lost rank ties Closed Won — never overwrites either)
  //
  // Gated behind closeOnArchivedQuote (default OFF) so ONLY the automated
  // advance path (maybeAdvanceEngagementStage — webhook + import) triggers
  // it. The manual-reopen route and panel-open drift recovery call this in
  // live mode DIRECTLY and must NOT auto-close: reopening is a human
  // decision, and if live mode always re-closed an archived-quote deal a
  // reopen could never take (#117 §5). The forward-only rank guard also
  // makes un-archive a no-op — a re-derived Estimate never outranks the
  // Closed Lost, so nothing auto-reopens.
  if (
    opts.closeOnArchivedQuote &&
    quotes.length > 0 &&
    jobs.length === 0 &&
    invoices.length === 0 &&
    quotes.every(q => (q.status || '').toLowerCase() === 'archived')
  ) {
    return {
      stage: 'Closed Lost',
      closed_reason: 'quote_archived',
      closed_at: new Date(now).toISOString(),
    }
  }

  if (bookedJobs.length > 0) {
    if (bookedJobs.some(j => !engagementJobDone(j))) return { stage: 'Job in Progress' }
    // ≥1 invoice AND all paid → the job is wrapping up settled. THE single
    // predicate (invoicesFullyPaid, engagementStatus.js) the panel's
    // Close-Won gate also reads — so import and UI can never disagree on
    // what "fully paid" means.
    if (invoicesFullyPaid(invoices)) {
      // AUTO-close to Won is IMPORT-ONLY (closeWonOnDone). In LIVE contexts
      // the deal rests at Final Processing instead — same rank-3 outcome as
      // "complete + owing" — so the panel's Mark-won button + wizard drive
      // the terminal move, not an automatic write.
      if (closeWonOnDone) {
        const lastPaidAt = Math.max(0, ...invoices.map(i => ts(i.paid_at)))
        return {
          stage: 'Closed Won',
          closed_reason: 'won',
          closed_at: new Date(lastPaidAt || now).toISOString(),
        }
      }
      return { stage: 'Final Processing' }
    }
    // Complete + owing, or complete + never invoiced: money loose end.
    return { stage: 'Final Processing' }
  }

  // Unbooked jobs classify with the quotes: same live stage, same
  // backfill staleness clock (Ruling A extends — an estimate the client
  // agreed to but never booked is no more a live deal than one they
  // never answered).
  if (quotes.length > 0 || unbookedJobs.length > 0) {
    if (mode === 'backfill') {
      const last = Math.max(
        ...quotes.map(quoteActivity),
        ...unbookedJobs.map(j => ts(j.created_at)),
      )
      if (now - last > NURTURING_AGE_MS) {
        // Ruling A (decision 14): unanswered old estimate is not a live deal.
        return { stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: new Date(now).toISOString() }
      }
    }
    return { stage: 'Estimate' }
  }

  if (mode === 'backfill' && sr) {
    const t = ts(sr.requested_at) || ts(sr.created_at)
    if (!t || now - t > NURTURING_AGE_MS) {
      return { stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: new Date(now).toISOString() }
    }
  }
  return { stage: 'Request' }
}

// ── founding ──────────────────────────────────────────────────────

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fallbackTitle = (t?: number) => {
  const d = t ? new Date(t) : new Date()
  return `Engagement – ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

async function logFounding(params: {
  locationSlug: string | null
  engagementId: string
  foundedBy: FoundedBy
  note: string
}) {
  // Fail-safe by design (writeSyncLog swallows errors) — a missing
  // sync_log row must never affect the founding itself.
  await writeSyncLog({
    location_id: params.locationSlug || 'unknown',
    entity_id: params.engagementId,
    entity_type: 'engagement',
    status: 'success',
    message: `[engagement:${params.foundedBy}] ${params.note}`,
  })
}

// Creates an engagement and writes engagement_id back onto the founding
// child row. Idempotent: if the founding child already carries an
// engagement_id, that engagement is returned and nothing is created.
//
// location_uuid is ALWAYS sourced from leads.location_uuid — never from
// slugs (the locations FK on engagements rejects garbage loudly, by
// design). A caller-supplied locationUuid is used only as a cross-check.
//
// created_at / stage_entered_at carry the FOUNDING CHILD's own date (SR
// requested_at, else the child row's created_at — both hold Jobber's
// createdAt, which every upsert carries across), falling back to now only
// when the child has no date. The bulk import founds engagements for
// years-old requests; stamping now there made every imported engagement
// read "came in today" on the board while the Inbox (leads.created_at)
// aged correctly, and pushed the 21-day pre-nurture cue out by the import
// offset. Live webhook foundings are unaffected in practice (child date ≈
// now) — and late foundings (a quote webhook founding for a pre-dual-write
// SR) now get the request's true date instead of the founding moment.
// params.openedAt overrides when a caller already knows the opening date.
export async function foundEngagement(params: {
  clientId: string
  locationUuid?: string | null
  foundedBy: FoundedBy
  title?: string | null
  stage?: EngagementStage
  foundingChildTable: EngagementChildTable
  foundingChildId: string
  note?: string
  openedAt?: string | null
}): Promise<{ id: string; created: boolean } | { error: string }> {
  const { clientId, foundedBy, foundingChildTable, foundingChildId } = params

  // Idempotency: founding child already linked → return its engagement.
  // SRs also carry their notes: request foundings seed the engagement's
  // description from the founding request's text (see below).
  // (plain-string select: the ternary defeats supabase-js's literal-type
  // parser, so the row comes back untyped — accessed via `any` below.)
  const childSelect: string = foundingChildTable === 'service_requests'
    ? 'id, engagement_id, notes, requested_at, created_at'
    : 'id, engagement_id, created_at'
  const { data: childRowRaw, error: childErr } = await supabaseService
    .from(foundingChildTable)
    .select(childSelect)
    .eq('id', foundingChildId)
    .maybeSingle()
  const childRow = childRowRaw as { id: string; engagement_id: string | null; notes?: string | null; requested_at?: string | null; created_at?: string | null } | null
  if (childErr) return { error: `founding child read: ${childErr.message}` }
  if (!childRow) return { error: `founding child not found: ${foundingChildTable}/${foundingChildId}` }
  if (childRow.engagement_id) return { id: childRow.engagement_id, created: false }

  const { data: lead, error: leadErr } = await supabaseService
    .from('leads')
    .select('id, location_uuid, location_id, name, request_details, project_type')
    .eq('id', clientId)
    .maybeSingle()
  if (leadErr || !lead) return { error: `lead read: ${leadErr?.message || 'not found'}` }
  if (!lead.location_uuid) return { error: `lead ${clientId} has no location_uuid` }
  if (params.locationUuid && params.locationUuid !== lead.location_uuid) {
    console.warn('[engagements] locationUuid mismatch — using leads.location_uuid', {
      clientId, passed: params.locationUuid, lead: lead.location_uuid,
    })
  }

  const nowIso = new Date().toISOString()
  // Opening date: explicit override, else SR requested_at, else the child
  // row's created_at; now only when the child carries no date at all. ts()
  // guards a malformed string (NaN never becomes a stored date).
  const openedMs =
    ts(params.openedAt) || ts(childRow.requested_at) || ts(childRow.created_at)
  const openedIso = openedMs ? new Date(openedMs).toISOString() : nowIso
  const stage = params.stage ?? OPENING_STAGE[foundedBy]
  // Request foundings arrive pre-described: the founding SR's own notes,
  // else the lead's webform text (leads.request_details — temporally
  // correct at founding time). Manual/quote/job foundings start blank.
  const description = foundedBy === 'request'
    ? (((childRow as any).notes || '').trim() || (lead.request_details || '').trim() || null)
    : null
  // Project type seeds the same way: authored on the lead pre-founding
  // (lead detail card), carried onto the work at request-founding. Quote/job
  // foundings skip it — the lead's type may describe earlier work.
  const projectType = foundedBy === 'request' ? ((lead.project_type || '').trim() || null) : null
  const { data: created, error: insErr } = await supabaseService
    .from('engagements')
    .insert({
      client_id: clientId,
      location_uuid: lead.location_uuid,
      stage,
      founded_by: foundedBy,
      title: params.title?.trim() || fallbackTitle(openedMs || undefined),
      ...(description ? { description } : {}),
      ...(projectType ? { project_type: projectType } : {}),
      stage_entered_at: openedIso,
      created_at: openedIso,
      updated_at: nowIso,
    })
    .select('id')
    .single()
  if (insErr || !created) return { error: `engagement insert: ${insErr?.message || 'no row'}` }

  // Link the founding child. Guard on engagement_id IS NULL so a
  // concurrent founding for the same child can't be overwritten — if we
  // lost that race, drop ours as debris-free as possible (best effort:
  // it stays unreferenced and visible to the step-2 debris check).
  const { data: linked } = await supabaseService
    .from(foundingChildTable)
    .update({ engagement_id: created.id })
    .eq('id', foundingChildId)
    .is('engagement_id', null)
    .select('id')
  if (!linked || linked.length === 0) {
    const { data: reread } = await supabaseService
      .from(foundingChildTable)
      .select('engagement_id')
      .eq('id', foundingChildId)
      .maybeSingle()
    if (reread?.engagement_id) {
      console.warn('[engagements] lost founding race — using winner', {
        foundingChildTable, foundingChildId, loser: created.id, winner: reread.engagement_id,
      })
      await supabaseService.from('engagements').delete().eq('id', created.id)
      return { id: reread.engagement_id, created: false }
    }
    return { error: `founding child link failed: ${foundingChildTable}/${foundingChildId}` }
  }

  // Carry the lead-level assignment onto the work. Never fatal. issue 149 —
  // when the lead never carried assignees, resolve against the CURRENT config
  // (same inputs intake used: the lead's project_type) instead of opening blank.
  await seedEngagementAssigneesFromLead(created.id, clientId, {
    locationUuid: lead.location_uuid,
    projectType: (lead.project_type || '').trim() || null,
  })

  await logFounding({
    locationSlug: lead.location_id,
    engagementId: created.id,
    foundedBy,
    note: params.note || `founded via ${foundingChildTable}/${foundingChildId} for lead ${clientId} at stage ${stage}`,
  })
  return { id: created.id, created: true }
}

// Manual founding (§3 rule 6, founded_by='manual') — the decoupled
// local write behind "Start new engagement" on a returning client.
// UNLIKE foundEngagement there is no founding child row and therefore
// no child-anchored idempotency: every call is a NEW engagement, which
// is exactly rule 1 (a second engagement is a distinct concurrent row,
// never a reuse). Send to Jobber is a separate, optional next step —
// the send route links the resulting service request back here via
// engagement_id, so the webhook's ensureEngagementForServiceRequest
// sees an already-founded SR and never founds a duplicate.
//
// Returns the full inserted row so callers can confirm the founding
// from the real write (never an optimistic stub) and merge it into
// board state in the shape _hub-page ships.
export async function foundManualEngagement(params: {
  clientId: string
  title?: string | null
  note?: string
}): Promise<{ engagement: Record<string, any>; created: true } | { error: string }> {
  const { clientId } = params

  const { data: lead, error: leadErr } = await supabaseService
    .from('leads')
    .select('id, location_uuid, location_id, name, is_junk')
    .eq('id', clientId)
    .maybeSingle()
  if (leadErr || !lead) return { error: `lead read: ${leadErr?.message || 'not found'}` }
  if (!lead.location_uuid) return { error: `lead ${clientId} has no location_uuid` }
  if (lead.is_junk === true) return { error: `lead ${clientId} is in the recycle bin` }

  const nowIso = new Date().toISOString()
  const { data: created, error: insErr } = await supabaseService
    .from('engagements')
    .insert({
      client_id: clientId,
      location_uuid: lead.location_uuid,
      stage: OPENING_STAGE.manual,
      founded_by: 'manual',
      title: params.title?.trim() || fallbackTitle(),
      stage_entered_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select('*')
    .single()
  if (insErr || !created) return { error: `engagement insert: ${insErr?.message || 'no row'}` }

  // Carry the lead-level assignment onto the work. Never fatal. issue 149 —
  // same empty-lead fallback as foundEngagement, but projectType is null on
  // purpose: a manual engagement declares no type of its own, and the lead's
  // stale project_type may describe earlier work (same reasoning the founding
  // notes give for skipping it on quote/job). With null the resolver lands on
  // the location owner (rule 1 or 3) — the right owner-of-record for hand-
  // started work — rather than routing new work to a past-type claimer.
  await seedEngagementAssigneesFromLead(created.id, clientId, {
    locationUuid: lead.location_uuid,
    projectType: null,
  })

  await logFounding({
    locationSlug: lead.location_id,
    engagementId: created.id,
    foundedBy: 'manual',
    note: params.note || `manual founding for lead ${clientId} at stage ${OPENING_STAGE.manual}`,
  })
  return { engagement: created, created: true }
}

// ── assignment carry-forward ──────────────────────────────────────
//
// Seed engagement_assignees from the LEAD's assignees at founding time.
//
// Assignment is decided when the lead lands (lib/lead-assignment.ts — the
// location's project-type recipient config, or the location owner), but at that
// moment there is no engagement to hang it on: work is founded later, by a
// request / quote / job, or by hand. This is the carry-forward — the same
// decision, moved onto the work the instant the work exists. Without it the
// EngagementPanel masthead would open empty on every engagement founded from an
// assigned lead, and the Jobber TEAM/CREW push would have nothing to send.
//
// IDEMPOTENT + NON-DESTRUCTIVE:
//   · Only ever seeds an engagement whose junction is EMPTY. A re-found or a
//     retry can't stomp a set someone has since edited in the masthead.
//   · The upsert ignores duplicates, so a concurrent seed is a no-op.
//   · Deliberately does NOT push to Jobber. Founding runs inside the import and
//     webhook paths, where a synchronous Jobber mutation per founded engagement
//     would be both slow and echo-prone; the first masthead edit pushes the set,
//     and lib/engagement-assignee-sync is idempotent on Jobber's side anyway.
//
// issue 149 — RESOLVE AT FOUNDING, not just at intake. The lead's assignment is
// decided at intake (lib/lead-assignment.ts), but leads that predate the resolver
// — or that resolved to nobody then — carry an EMPTY lead_assignees junction, so
// the verbatim carry-forward above would open the work with NOBODY and nothing
// would ever re-resolve against the location's current config. When the lead
// junction is empty AND a `fallback` is supplied, we run the SAME resolver intake
// would (owner, or the project-type claimers) and seed that instead of blank.
// This stays strictly EMPTY-ONLY: the engagement junction was already confirmed
// empty above and the lead junction is empty here, so a manual masthead edit can
// never be overwritten. A resolved user with a null jobber_user_id is a valid
// INTERNAL assignee — resolveJobberAssignment (lib/engagement-assignee-sync)
// already filters those out of the Jobber push, so this never reads as "assigned
// in Jobber." The resolver's own owner-fallback (rule 5) still returns [] loudly
// for a location with no resolvable owner, which lands us back at return 0.
//
// NEVER FATAL: founding has already committed and its caller's happy path must
// not depend on this. Every failure — including "lead_assignees does not exist
// yet" before migrations/lead_assignees.sql is applied — logs and returns 0.
export async function seedEngagementAssigneesFromLead(
  engagementId: string,
  leadId: string,
  fallback?: { locationUuid: string; projectType: string | null },
): Promise<number> {
  try {
    const { data: already, error: alreadyErr } = await supabaseService
      .from('engagement_assignees')
      .select('hub_user_id')
      .eq('engagement_id', engagementId)
      .limit(1)
    if (alreadyErr) throw new Error(alreadyErr.message)
    if ((already || []).length > 0) return 0

    const { data: leadRows, error: leadErr } = await supabaseService
      .from('lead_assignees')
      .select('hub_user_id, created_at')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: true })
    if (leadErr) throw new Error(leadErr.message)

    let ids = (leadRows || []).map((r: any) => r.hub_user_id).filter(Boolean)

    // issue 149 — empty lead junction: re-resolve against the current config
    // rather than open unassigned. Empty-only (both junctions confirmed empty).
    if (ids.length === 0 && fallback) {
      const resolved = await resolveLeadAssignees({
        locationUuid: fallback.locationUuid,
        projectType: fallback.projectType,
      })
      ids = resolved.hubUserIds.filter(Boolean)
    }

    if (ids.length === 0) return 0

    const { error: insErr } = await supabaseService.from('engagement_assignees').upsert(
      ids.map((hub_user_id: string) => ({ engagement_id: engagementId, hub_user_id })),
      { onConflict: 'engagement_id,hub_user_id', ignoreDuplicates: true },
    )
    if (insErr) throw new Error(insErr.message)
    return ids.length
  } catch (err: any) {
    console.warn(
      `[engagements] assignee carry-forward skipped for engagement ${engagementId} / lead ${leadId} — ${err?.message || err}`,
    )
    return 0
  }
}

// ── attachment ────────────────────────────────────────────────────

// Sets engagement_id if null. No-op when already set to the same
// engagement; warns (and does NOT overwrite) when set to a different
// one — that's a conflict signal for step-4 tooling, not a write.
export async function attachToEngagement(
  childTable: EngagementChildTable,
  childRowId: string,
  engagementId: string,
): Promise<{ attached: boolean; conflict?: boolean }> {
  const { data: row } = await supabaseService
    .from(childTable)
    .select('engagement_id')
    .eq('id', childRowId)
    .maybeSingle()
  if (!row) return { attached: false }
  if (row.engagement_id === engagementId) return { attached: false }
  if (row.engagement_id) {
    console.warn('[engagements] attach conflict — child already on a different engagement, not overwriting', {
      childTable, childRowId, existing: row.engagement_id, incoming: engagementId,
    })
    return { attached: false, conflict: true }
  }
  const { error } = await supabaseService
    .from(childTable)
    .update({ engagement_id: engagementId })
    .eq('id', childRowId)
    .is('engagement_id', null)
  if (error) {
    console.error('[engagements] attach failed', { childTable, childRowId, engagementId, error: error.message })
    return { attached: false }
  }
  return { attached: true }
}

// ── resolution (§3 rules 4/5, repeat-client gate rules 2/3) ────────

async function readEngagementIdOf(
  table: EngagementChildTable,
  id: string,
): Promise<string | null> {
  const { data } = await supabaseService
    .from(table)
    .select('engagement_id')
    .eq('id', id)
    .maybeSingle()
  return data?.engagement_id ?? null
}

// ── the ONE "is there an open engagement?" resolver (rule 5 / #67 / #94) ──
//
// Most-recent OPEN engagement for a client, or null. "Open" is the canonical
// predicate everywhere: stage NOT IN the two terminals (Closed Won/Lost share
// the top rank). This is the single shared policy behind three callers:
//   · resolveEngagementForChild rule-5 fallback (ambiguous quote/job)
//   · ensureEngagementForServiceRequest adoption guard (#67 — Send-to-Jobber /
//     webhook request adopting an empty manual container instead of duplicating)
//   · mergeResubmission (#94 — a returning webform client surfacing onto an
//     open engagement instead of founding a second card)
// One rule, not three drifting copies. founded_by rides along so the SR-
// adoption caller can require an empty *manual* container without a re-read.
export async function findOpenEngagementForClient(
  clientId: string,
): Promise<{ id: string; stage: EngagementStage; created_at: string | null; founded_by: FoundedBy | null } | null> {
  const { data } = await supabaseService
    .from('engagements')
    .select('id, stage, created_at, founded_by')
    .eq('client_id', clientId)
    .not('stage', 'in', '("Closed Won","Closed Lost")')
    .order('created_at', { ascending: false })
    .limit(1)
  return (data?.[0] as any) ?? null
}

// Most-recent engagement for a client REGARDLESS of stage — the terminal-
// inclusive twin of findOpenEngagementForClient. Used ONLY by the invoice
// rule-6 fallback (#98): a jobless invoice billed straight to a client whose
// engagements are ALL closed must still land its money on the latest deal.
// Deliberately NOT the open-engagement policy — #94 depends on
// findOpenEngagementForClient excluding terminals, so this stays separate.
async function findMostRecentEngagementForClient(
  clientId: string,
): Promise<{ id: string; stage: EngagementStage } | null> {
  const { data } = await supabaseService
    .from('engagements')
    .select('id, stage')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
  return (data?.[0] as any) ?? null
}

// True when the engagement already owns a service_request row. The 1-SR-per-
// engagement invariant (rule 1) is what makes the #67 adoption safe for bulk
// import: an SR-founded engagement always HAS its SR, so it is never adopted
// by a second SR — only an empty manual container (no SR) can be.
async function engagementHasServiceRequest(engagementId: string): Promise<boolean> {
  const { data } = await supabaseService
    .from('service_requests')
    .select('id')
    .eq('engagement_id', engagementId)
    .limit(1)
  return (data?.length ?? 0) > 0
}

// Resolve which engagement a quote/job/invoice belongs to, founding
// implicitly when the doc's fallback rules call for it. Returns the
// engagement id (attaching is the caller's move), or null when nothing
// is resolvable (logged).
export async function resolveEngagementForChild(params: {
  childTable: 'quotes' | 'jobs' | 'invoices'
  childId: string
  leadId: string
  serviceRequestId?: string | null
  quoteDbId?: string | null   // jobs only: Job.quote path
  jobDbId?: string | null     // invoices only
  title?: string | null
  locationSlug?: string | null
}): Promise<string | null> {
  const { childTable, childId, leadId } = params

  // Already attached (idempotent re-entry).
  const own = await readEngagementIdOf(childTable, childId)
  if (own) return own

  // 1. Hub-and-spoke: the service request's engagement.
  if (params.serviceRequestId) {
    const viaSr = await readEngagementIdOf('service_requests', params.serviceRequestId)
    if (viaSr) return viaSr
    // SR exists but has no engagement (predates dual-write, or webhook
    // ordering) — rule 1 says every request founds. Found it now.
    const { data: srRow } = await supabaseService
      .from('service_requests')
      .select('id, lead_id')
      .eq('id', params.serviceRequestId)
      .maybeSingle()
    if (srRow) {
      const founded = await foundEngagement({
        clientId: srRow.lead_id,
        foundedBy: 'request',
        title: params.title,
        foundingChildTable: 'service_requests',
        foundingChildId: srRow.id,
        note: `late founding: SR had no engagement when ${childTable}/${childId} arrived`,
      })
      if ('id' in founded) return founded.id
      console.error('[engagements] late SR founding failed', { srId: srRow.id, error: founded.error })
    }
  }

  // 2. Job.quote path: the quote's engagement.
  if (childTable === 'jobs' && params.quoteDbId) {
    const viaQuote = await readEngagementIdOf('quotes', params.quoteDbId)
    if (viaQuote) return viaQuote
  }

  // 3. Invoice via its job.
  if (childTable === 'invoices' && params.jobDbId) {
    const viaJob = await readEngagementIdOf('jobs', params.jobDbId)
    if (viaJob) return viaJob
  }

  // 4. Fallback (rule 5): most-recent-open engagement for this client — the
  //    ONE shared resolver (findOpenEngagementForClient).
  const openEng = await findOpenEngagementForClient(leadId)
  const priorCountRes = await supabaseService
    .from('engagements')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', leadId)
  const priorCount = priorCountRes.count ?? 0

  if (openEng) {
    await logFounding({
      locationSlug: params.locationSlug ?? null,
      engagementId: openEng.id,
      foundedBy: childTable === 'quotes' ? 'quote' : 'job',
      note: `ambiguous ${childTable}/${childId}: no resolvable parent — attached to most-recent-open engagement (rule 5)`,
    })
    return openEng.id
  }

  // 5. Invoices get no implicit founding (the founded_by CHECK has no
  //    'invoice' value by design). Rule 6 instead: an invoice is real money
  //    that must land on the client's deal even after every engagement has
  //    closed — a jobless invoice billed straight to a client whose only
  //    engagement is already Closed Won/Lost (KC #98) otherwise orphans off
  //    the card. Attach to the client's MOST-RECENT engagement of ANY stage.
  //    Safe because maybeAdvanceEngagementStage never moves a terminal stage,
  //    so this can't reopen a closed deal — it only surfaces the money.
  if (childTable === 'invoices') {
    const recentEng = await findMostRecentEngagementForClient(leadId)
    if (recentEng) {
      await logFounding({
        locationSlug: params.locationSlug ?? null,
        engagementId: recentEng.id,
        foundedBy: 'job',
        note: `invoice ${childId}: no job/SR and no open engagement — attached to most-recent engagement (stage ${recentEng.stage}) (rule 6)`,
      })
      return recentEng.id
    }
    console.error('[engagements] orphan invoice unresolvable — no job, no SR, no engagement at all', { childId, leadId })
    return null
  }
  const foundedBy: FoundedBy = childTable === 'quotes' ? 'quote' : 'job'
  const founded = await foundEngagement({
    clientId: leadId,
    foundedBy,
    title: params.title,
    foundingChildTable: childTable,
    foundingChildId: childId,
    note:
      `implicit founding: unlinked ${childTable}/${childId} with no open engagement (rule 5)` +
      (priorCount === 0
        ? ' — ANOMALY: client has zero prior engagements; first engagement should be request-founded (rule 2, tolerated on sync)'
        : ''),
  })
  if ('id' in founded) return founded.id
  console.error('[engagements] implicit founding failed', { childTable, childId, error: founded.error })
  return null
}

// ── stage advance ─────────────────────────────────────────────────

// Recompute the engagement's stage from its own children and apply it
// only when it is forward progress on ENGAGEMENT_STAGE_RANK. Also
// refreshes the money roll-ups (cheap, and keeps weekly billing live).
// Terminal stages never move (Closed Won/Lost share top rank) — with ONE
// exception: a machine-stamped stale close (closed_reason
// 'stale_on_import') yields to a derived Closed Won. Paid-in-full
// evidence beats the stale stamp: import/backfill order can close a
// quote-founded engagement as stale before its job + paid invoices
// attach, and without the override the rank tie traps it as Lost
// forever. Human closes (any other closed_reason) still never move.
//
// mode 'backfill' (bulk import path) additionally applies the §5
// stale-close rules — silent bookkeeping, no sequences. Webhooks use
// the default 'live' mode, where closing quiet engagements belongs to
// the step-5 nurture cron.
//
// AUTO-close to Won is IMPORT-ONLY (2026-07-11). Only the backfill (bulk
// import) caller lets a done + all-paid deal resolve to Closed Won; the
// LIVE webhook caller rests it at Final Processing so the panel's Mark-
// won button + close-won wizard drive the terminal move. The stale-Lost
// override is the deliberate exception: it recovers an IMPORT ARTIFACT
// (a machine 'stale_on_import' Lost with paid-in-full children — a mis-
// stamped historical deal), so it uses import semantics in every context
// and recovers straight to Won rather than stranding as Lost.
export async function maybeAdvanceEngagementStage(
  engagementId: string,
  opts: { mode?: 'live' | 'backfill' } = {},
): Promise<{ advanced: boolean; stage?: EngagementStage }> {
  const { data: eng } = await supabaseService
    .from('engagements')
    .select('id, stage, closed_reason')
    .eq('id', engagementId)
    .maybeSingle()
  if (!eng) return { advanced: false }

  const [srRes, quotesRes, jobsRes, invoicesRes] = await Promise.all([
    supabaseService.from('service_requests').select('requested_at, created_at').eq('engagement_id', engagementId).limit(1),
    supabaseService.from('quotes').select('status, sent_at, approved_at, created_at').eq('engagement_id', engagementId),
    supabaseService.from('jobs').select('status, completed_at, scheduled_start, created_at').eq('engagement_id', engagementId),
    supabaseService.from('invoices').select('status, total, paid_amount, balance_owing, paid_at, issued_at, created_at').eq('engagement_id', engagementId),
  ])
  const invoices = invoicesRes.data ?? []
  const mode = opts.mode ?? 'live'
  // Auto-close to Won is import-only: backfill (bulk import) gets it,
  // live (webhook) doesn't. The stale-Lost recovery is import-artifact
  // repair — it too takes import semantics so it recovers to Won in
  // every context and is never trapped as Lost.
  const staleLostRecoverable =
    eng.stage === 'Closed Lost' && eng.closed_reason === 'stale_on_import'
  const closeWonOnDone = mode === 'backfill' || staleLostRecoverable
  const derived = deriveEngagementStage({
    sr: srRes.data?.[0] ?? null,
    quotes: quotesRes.data ?? [],
    jobs: jobsRes.data ?? [],
    invoices,
    // #117: the automated advance path (webhook + import) is the ONE place
    // an archived quote closes the deal. Its own guard (all quotes archived,
    // no jobs, no invoices) makes it inert on job/invoice events. Reopen and
    // drift recovery call deriveEngagementStage directly WITHOUT this flag.
  }, { mode, closeWonOnDone, closeOnArchivedQuote: true })

  const num = (v: any) => (v == null ? 0 : Number(v) || 0)
  const patch: Record<string, any> = {
    total_invoiced: invoices.reduce((s, i) => s + num(i.total), 0),
    total_paid: invoices.reduce((s, i) => s + num(i.paid_amount), 0),
    balance_owing: invoices.reduce(
      (s, i) => s + (i.balance_owing != null ? num(i.balance_owing) : num(i.total) - num(i.paid_amount)), 0),
    updated_at: new Date().toISOString(),
  }

  const currentRank = ENGAGEMENT_STAGE_RANK[eng.stage as EngagementStage] ?? 0
  const newRank = ENGAGEMENT_STAGE_RANK[derived.stage] ?? 0
  // Override fires only when the stale-Lost recovery actually derives Won
  // (paid-in-full); a stale-Lost row with no paid evidence stays Lost.
  const staleLostOverride = staleLostRecoverable && derived.stage === 'Closed Won'
  const advance = newRank > currentRank || staleLostOverride

  if (advance) {
    patch.stage = derived.stage
    patch.stage_entered_at = new Date().toISOString()
    if (derived.closed_reason) patch.closed_reason = derived.closed_reason
    if (derived.closed_at) patch.closed_at = derived.closed_at
    if (derived.closed_reason === 'stale_on_import') {
      patch.closed_note = 'Closed automatically at import: no activity within 30 days (Ruling A for quote-only).'
    }
    if (derived.closed_reason === 'quote_archived') {
      patch.closed_note = 'Closed automatically: the quote was archived in Jobber (#117).'
    }
    if (staleLostOverride) patch.closed_note = null // the stale note is wrong on a Won row
  }

  const { error } = await supabaseService.from('engagements').update(patch).eq('id', engagementId)
  if (error) {
    console.error('[engagements] stage advance write failed', { engagementId, error: error.message })
    return { advanced: false }
  }
  return advance ? { advanced: true, stage: derived.stage } : { advanced: false }
}

// ── drift recovery (panel-open re-derive) ─────────────────────────

// The webhook's stage-advance is swallow-and-log by design and there is
// no reconciliation job — so a failed webhook write leaves a LINKED
// engagement's stored stage lagging what its child records prove. The
// engagement GET route calls this on panel open with the children it
// ALREADY fetched (no re-query): re-derive via deriveEngagementStage
// (live mode — the same authority the webhook uses) and apply the
// result only when it is FORWARD progress on ENGAGEMENT_STAGE_RANK.
//
// This is an AUTOMATED correction — it writes the stage directly and
// silently, exactly as the webhook would have. Like the webhook (a LIVE
// path) it does NOT auto-close to Won: a done + all-paid deal rests at
// Final Processing so the panel's Mark-won button + close-won wizard
// drive the terminal move (auto-close to Won is import-only, 2026-07-11).
// The lone exception is the stale-Lost recovery — an IMPORT ARTIFACT (a
// machine 'stale_on_import' Lost with paid-in-full children) recovers
// straight to Won under import semantics, never stranded as Lost.
//
// A stage_change touchpoint is written ONLY when the stage actually
// moved — a no-op re-derive (the overwhelmingly common panel open)
// writes nothing at all, not even updated_at.
export async function recoverEngagementStageDrift(
  engagement: { id: string; stage: string; client_id: string; location_uuid: string | null; closed_reason?: string | null },
  children: EngagementChildren,
): Promise<{ corrected: boolean; stage?: EngagementStage; patch?: Record<string, any> }> {
  const currentRank = ENGAGEMENT_STAGE_RANK[engagement.stage as EngagementStage] ?? 0
  // LIVE path: no auto-close to Won (closeWonOnDone false) — a done +
  // all-paid deal rests at Final Processing. The stale-Lost recovery is
  // the exception: an import artifact takes import semantics so paid-in-
  // full evidence recovers it to Won rather than stranding it as Lost.
  const staleLostRecoverable =
    engagement.stage === 'Closed Lost' && engagement.closed_reason === 'stale_on_import'
  const derived = deriveEngagementStage(children, { closeWonOnDone: staleLostRecoverable })
  const newRank = ENGAGEMENT_STAGE_RANK[derived.stage] ?? 0
  const staleLostOverride = staleLostRecoverable && derived.stage === 'Closed Won'
  if (newRank <= currentRank && !staleLostOverride) return { corrected: false }

  const nowIso = new Date().toISOString()
  const patch: Record<string, any> = {
    stage: derived.stage,
    stage_entered_at: nowIso,
    updated_at: nowIso,
  }
  if (derived.closed_reason) patch.closed_reason = derived.closed_reason
  if (derived.closed_at) patch.closed_at = derived.closed_at
  if (staleLostOverride) patch.closed_note = null // the stale note is wrong on a Won row

  const { error } = await supabaseService.from('engagements').update(patch).eq('id', engagement.id)
  if (error) {
    console.error('[engagements] drift recovery write failed', { engagementId: engagement.id, error: error.message })
    return { corrected: false }
  }

  // Trail: system touchpoint (user_id null — nobody clicked anything)
  // so the timeline explains the move, plus a sync_log breadcrumb for
  // the audit trail. Both fail-safe: the correction already committed.
  await supabaseService.from('touchpoints').insert({
    lead_id: engagement.client_id,
    location_uuid: engagement.location_uuid,
    engagement_id: engagement.id,
    kind: 'stage_change',
    label: `Stage: ${engagement.stage} → ${derived.stage}`,
    occurred_at: nowIso,
  })
  await writeSyncLog({
    location_id: 'unknown',
    entity_id: engagement.id,
    entity_type: 'engagement',
    status: 'success',
    message: `[engagement:drift] stage corrected on panel open: ${engagement.stage} → ${derived.stage} (stale after a missed webhook advance)`,
  })
  return { corrected: true, stage: derived.stage, patch }
}

// ── convenience: found-or-get for a service request (rule 1) ──────

// Every service request founds exactly one engagement. Used by the
// import route and REQUEST_* webhook paths; safe to call repeatedly.
export async function ensureEngagementForServiceRequest(
  serviceRequestId: string,
  leadId: string,
  opts: { title?: string | null } = {},
): Promise<{ id: string; created: boolean } | null> {
  const existing = await readEngagementIdOf('service_requests', serviceRequestId)
  if (existing) return { id: existing, created: false }

  // #67: before founding a fresh engagement, adopt an existing OPEN engagement
  // that is an EMPTY MANUAL CONTAINER — founded_by='manual' with no SR of its
  // own. That is precisely the "Start new engagement" / resubmission-founded
  // (#94) card awaiting its first Jobber request; a bare lead Send-to-Jobber
  // (no engagement_id passed) used to found a SECOND engagement beside it (the
  // duplicate Kevin found). Guarded tight so it never collapses the 1-SR-per-
  // engagement invariant bulk import relies on: an SR-founded engagement always
  // HAS its SR (engagementHasServiceRequest), so it is never adoptable, and a
  // second bare send after the container already adopted an SR founds anew. The
  // same shared resolver mergeResubmission (#94) uses — one policy, both paths.
  const open = await findOpenEngagementForClient(leadId)
  if (open && open.founded_by === 'manual' && !(await engagementHasServiceRequest(open.id))) {
    const { attached } = await attachToEngagement('service_requests', serviceRequestId, open.id)
    if (attached) {
      await logFounding({
        locationSlug: null,
        engagementId: open.id,
        foundedBy: 'request',
        note: `adopted SR ${serviceRequestId} into open manual engagement (no duplicate founded — #67)`,
      })
      return { id: open.id, created: false }
    }
    // attach lost a race / conflict — fall through to a clean founding.
  }

  const founded = await foundEngagement({
    clientId: leadId,
    foundedBy: 'request',
    title: opts.title,
    foundingChildTable: 'service_requests',
    foundingChildId: serviceRequestId,
  })
  if ('id' in founded) return founded
  console.error('[engagements] SR founding failed', { serviceRequestId, error: founded.error })
  return null
}
