// app/api/admin/feedback/analysis/route.ts
//
// GET /api/admin/feedback/analysis — the per-item analysis for the triage
// screen. Issue 307 step 3.
//
// Returns { analyses, clusters, computedAt, cached }. The screen asks for this
// once when it opens; lib/feedback-analysis owns every judgement and this route
// owns only the reads that feed it.
//
// ─── ELEVATED ONLY ────────────────────────────────────────────────────
// super_admin / admin, matching /api/admin/feedback's own ELEVATED_ROLES. This
// is deliberately NARROWER than that route, which also lets owner and manager
// read their own location: the analysis names files, quotes internal
// mechanisms, and reports fleet-wide counts across every franchise. None of
// that is owner-facing, so there is no location-scoped branch here at all —
// not a filtered one, none.
//
// ─── WHAT IS CACHED, WHERE, AND HOW IT INVALIDATES ────────────────────
// Kevin chose analyse-on-open over a nightly job: nightly is instant but stale,
// and this list moves fast — one audit pass closed twenty items in an evening.
// So the work happens on open, and the cache exists only to stop a second open
// thirty seconds later paying for it again.
//
//   WHERE — module-level memory in this route. Not Redis, not a table: the
//   value is derivable from data we already hold, so a cold instance simply
//   recomputes. Nothing is persisted, so nothing can go stale in storage, and
//   there is no schema for it (step 3 adds no columns).
//
//   KEY — analysisSignature(items): every open item's id + updated_at + status.
//   The feedback_items_updated_at trigger guarantees updated_at moves on any
//   triage write, so a verdict, a reply, a status change or a new arrival all
//   change the signature and the next open recomputes. That is the invalidation
//   — it is not time-based and it cannot miss an item change.
//
//   TTL — a floor under production drift, which is the half the signature does
//   NOT cover. Fleet counts move as jobs and engagements change even when no
//   feedback item does, so the entry expires regardless after ANALYSIS_TTL_MS.
//
//   SCOPE — one entry. The only caller is the triage screen and it always asks
//   the same question, so a map keyed by anything would be a map with one row.
//
// ─── WHY THE READS LOOK LIKE THIS ─────────────────────────────────────
// PostgREST aggregates are disabled on this project, so a fleet count cannot be
// a select count(). Every count here is therefore composed in JS from rows
// scoped as narrowly as the shape allows — never a full-table sweep — and each
// query is chunked and capped. If a count would exceed its cap the probe gets
// NO fleet number rather than a truncated one, because a count that silently
// undercounts is worse than an absent count: it would reorder the screen.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isClosedFeedback } from '@/lib/feedback-queues'
import { buildPlacementIndex, type ScreenMapEntry } from '@/lib/feedback-placement'
import {
  analyseItem, clusterAnalyses, analysisSignature,
  type ItemAnalysis, type AnalysisCluster, type AnalysisEvidence,
  type NamedLeadEvidence, type FleetImpact, extractNames,
} from '@/lib/feedback-analysis'
import screenMap from '@/docs/screen-map.json'
// issue 309 — drafts for whatever this deployment appears to have answered.
import { linkCommitToItems, buildReplyDraft, type ReplyDraft } from '@/lib/feedback-reply-draft'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const maxDuration = 60

const ELEVATED_ROLES = ['super_admin', 'admin']

const ANALYSIS_TTL_MS = 10 * 60 * 1000
/** Above this many rows a composed count is refused rather than truncated. */
const COUNT_CAP = 4000
const CHUNK = 100

const index = buildPlacementIndex((screenMap as { entries: ScreenMapEntry[] }).entries)

type CacheEntry = {
  signature: string
  computedAt: number
  analyses: ItemAnalysis[]
  clusters: AnalysisCluster[]
  drafts: ReplyDraft[]
}
let CACHE: CacheEntry | null = null

const chunks = <T,>(xs: T[], n = CHUNK): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export async function GET(_req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users').select('role').eq('id', user.id).single()
  if (!caller || !ELEVATED_ROLES.includes(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: rows, error } = await supabaseService
    .from('feedback_items')
    .select('id, type, title, description, status, updated_at, location_id, context, admin_response')
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[feedback analysis] read failed', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const open = (rows || []).filter(r => !isClosedFeedback(r.status))
  const signature = analysisSignature(open)

  if (CACHE && CACHE.signature === signature && Date.now() - CACHE.computedAt < ANALYSIS_TTL_MS) {
    return NextResponse.json({
      analyses: CACHE.analyses, clusters: CACHE.clusters, drafts: CACHE.drafts,
      computedAt: CACHE.computedAt, cached: true,
    })
  }

  const { analyses, clusters } = await computeAnalyses(open)
  const drafts = buildDeploymentDrafts(open, analyses)
  CACHE = { signature, computedAt: Date.now(), analyses, clusters, drafts }
  return NextResponse.json({ analyses, clusters, drafts, computedAt: CACHE.computedAt, cached: false })
}

// ─── Drafts for the current deployment (issue 309) ────────────────────
//
// WHERE THE COMMIT COMES FROM. Vercel exposes the deployed commit as system
// environment variables, so no git access and no GitHub call is needed. This
// sees the HEAD commit of the deployment only — a push carrying several
// commits shows just the last. That is an honest limit rather than a hidden
// one: this repo pushes direct to main one commit at a time (see CLAUDE.md),
// so head-only covers the normal case, and anything it misses simply produces
// no draft rather than a wrong one.
//
// NOTHING IS SENT HERE. A draft is text on a screen until Kevin edits it and
// presses Save, which PATCHes /api/admin/feedback/:id — the route that decides
// whether an email fires. There is no path from this function to an owner.
function buildDeploymentDrafts(open: any[], analyses: ItemAnalysis[]): ReplyDraft[] {
  const message = process.env.VERCEL_GIT_COMMIT_MESSAGE || ''
  if (!message.trim()) return []

  const byId = new Map(analyses.map(a => [a.itemId, a]))
  // Items already answered are not waiting on news.
  const waiting = open.filter(i => !String(i.admin_response || '').trim())
  const links = linkCommitToItems({ message, sha: process.env.VERCEL_GIT_COMMIT_SHA || null }, waiting)

  return links.map(link => {
    const item = waiting.find(i => i.id === link.itemId)!
    return buildReplyDraft({
      item,
      link,
      analysis: byId.get(link.itemId) || null,
      // The commit SUBJECT, in the owner's direction: it is the closest thing
      // to a plain-language description we have. The draft builder is what
      // keeps hashes and filenames out; this only supplies the sentence.
      whatChanged: subjectToPlain(message),
    })
  })
}

// The commit subject with its conventional-commit prefix removed. Not a
// paraphrase engine — if the result still looks like engineering, the draft
// falls back to its own generic sentence rather than shipping it.
function subjectToPlain(message: string): string | null {
  const subject = String(message || '').split('\n')[0].trim()
  const stripped = subject.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim()
  if (!stripped) return null
  if (/[\w/.-]+\.(ts|tsx|js|jsx|sql|json)\b/i.test(stripped)) return null
  if (/\b(issue\s*\d+|#\d+)\b/i.test(stripped)) return null
  return stripped.charAt(0).toUpperCase() + stripped.slice(1) + '.'
}

async function computeAnalyses(open: any[]) {
  const fleet = await computeFleetCounts()

  // ── Evidence: engagements named by an issue-249 context pointer.
  const engagementIds = open
    .map(i => i?.context?.engagement_id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  const engagements = await loadEngagementEvidence(engagementIds)

  // ── Evidence: names mentioned in descriptions, resolved against leads.
  const nameByItem = new Map<string, string[]>()
  const allNames = new Set<string>()
  for (const i of open) {
    const names = extractNames(i.description)
    if (names.length) {
      nameByItem.set(i.id, names)
      names.forEach(n => allNames.add(n))
    }
  }
  const resolved = await resolveNames(Array.from(allNames))

  // ── Evidence: outbound-email history per location that filed something.
  const locationIds = Array.from(new Set(open.map(i => i.location_id).filter(Boolean))) as string[]
  const sendsByLocation = await loadLocationSends(locationIds)

  const analyses = open.map(item => {
    const evidence: AnalysisEvidence = {
      engagement: item?.context?.engagement_id
        ? engagements.get(item.context.engagement_id) || null
        : null,
      namedLeads: (nameByItem.get(item.id) || []).map(n => resolved.get(n) || { query: n, found: false }),
      locationSends: item.location_id ? sendsByLocation.get(item.location_id) || null : null,
      fleet,
    }
    return analyseItem({ item, evidence, index })
  })

  return { analyses, clusters: clusterAnalyses(analyses) }
}

// ─── Engagement evidence ──────────────────────────────────────────────
// Only the engagements an item actually points at — never a sweep.
async function loadEngagementEvidence(ids: string[]) {
  const out = new Map<string, AnalysisEvidence['engagement']>()
  if (ids.length === 0) return out
  const unique = Array.from(new Set(ids))

  for (const batch of chunks(unique)) {
    const { data: engs } = await supabaseService
      .from('engagements').select('id, stage').in('id', batch)
    const { data: jobs } = await supabaseService
      .from('jobs').select('engagement_id, status').in('engagement_id', batch)
    const { data: quotes } = await supabaseService
      .from('quotes').select('engagement_id').in('engagement_id', batch)
    const { data: invoices } = await supabaseService
      .from('invoices').select('engagement_id, paid_at').in('engagement_id', batch)

    for (const e of engs || []) {
      const mine = (xs: any[]) => (xs || []).filter(x => x.engagement_id === e.id)
      const js = mine(jobs as any[])
      const is = mine(invoices as any[])
      out.set(e.id, {
        id: e.id,
        stage: e.stage ?? null,
        jobCount: js.length,
        archivedJobCount: js.filter(j => String(j.status || '').toLowerCase() === 'archived').length,
        quoteCount: mine(quotes as any[]).length,
        invoiceCount: is.length,
        paidInvoiceCount: is.filter(i => !!i.paid_at).length,
      })
    }
  }
  return out
}

// ─── Name resolution ──────────────────────────────────────────────────
// One ilike per name. Bounded by extractNames' cap of three per item, and a
// name is only looked up once across the whole run.
async function resolveNames(names: string[]) {
  const out = new Map<string, NamedLeadEvidence>()
  for (const name of names) {
    const { data } = await supabaseService
      .from('leads').select('id, name').ilike('name', name).limit(2)
    const hit = (data || [])[0]
    if (!hit) { out.set(name, { query: name, found: false }); continue }

    const { data: engs } = await supabaseService
      .from('engagements').select('stage').eq('client_id', hit.id)
    const all = engs || []
    const openEngs = all.filter(e => !isTerminalStage(e.stage))
    out.set(name, {
      query: name,
      found: true,
      id: hit.id,
      name: hit.name,
      openIsRequestOnly: openEngs.length > 0 && openEngs.every(e => e.stage === 'Request'),
      hasPriorClosed: all.some(e => isTerminalStage(e.stage)),
    })
  }
  return out
}

const isTerminalStage = (s: string | null | undefined) =>
  s === 'Closed Won' || s === 'Closed Lost'

// ─── Send history ─────────────────────────────────────────────────────
// "Client-facing" is defined by EXCLUSION — anything that is not one of the
// known staff-notification kinds counts as client-facing. That direction is
// deliberate: a new client-facing rail added later is counted immediately and
// the not-sent-by-hub probe correctly goes quiet, whereas an allow-list would
// keep asserting "we never mail your clients" after we had started to.
const STAFF_KINDS = new Set([
  'lead_notification', 'lead_notification_non_hub', 'lead_resubmission',
  'feedback_reply', 'invite', 'seat_invite',
])
async function loadLocationSends(locationIds: string[]) {
  const out = new Map<string, AnalysisEvidence['locationSends']>()
  if (locationIds.length === 0) return out
  for (const batch of chunks(locationIds)) {
    const { data } = await supabaseService
      .from('notification_log').select('location_id, email_kind').in('location_id', batch)
    for (const id of batch) {
      const mine = (data || []).filter(r => r.location_id === id)
      // No history at all is NOT evidence of anything — a location that has
      // never sent has also never been observed. Only a non-empty log can
      // support "this did not come from us".
      if (mine.length === 0) continue
      const kinds: Record<string, number> = {}
      let clientFacing = 0
      for (const r of mine) {
        const k = String(r.email_kind || '')
        kinds[k] = (kinds[k] || 0) + 1
        if (k && !STAFF_KINDS.has(k)) clientFacing++
      }
      out.set(id, { kinds, clientFacingCount: clientFacing })
    }
  }
  return out
}

// ─── Fleet counts ─────────────────────────────────────────────────────
// Computed once per run and shared by every probe. Each returns null rather
// than a number it could not stand behind.
async function computeFleetCounts(): Promise<Partial<Record<string, FleetImpact>>> {
  const [stuck, returning] = await Promise.all([
    countStuckFinalProcessing(),
    countReturningOutOfInbox(),
  ])
  const out: Partial<Record<string, FleetImpact>> = {}
  if (stuck) out['stuck-final-processing'] = stuck
  if (returning) out['returning-client-request-stage'] = returning
  return out
}

// Engagements frozen at Final Processing: an archived job, and no way to reach
// Closed Won because invoicesFullyPaid can never be true.
async function countStuckFinalProcessing(): Promise<FleetImpact | null> {
  const { data: fp, error } = await supabaseService
    .from('engagements').select('id').eq('stage', 'Final Processing').limit(COUNT_CAP)
  if (error || !fp) return null
  if (fp.length >= COUNT_CAP) return null
  const ids = fp.map(e => e.id)
  if (ids.length === 0) return { count: 0, unit: 'engagements', basis: 'no engagements at Final Processing' }

  const archived = new Set<string>()
  const invoiced = new Map<string, { total: number; paid: number }>()
  for (const batch of chunks(ids)) {
    const { data: jobs } = await supabaseService
      .from('jobs').select('engagement_id, status').in('engagement_id', batch)
    for (const j of jobs || []) {
      if (String(j.status || '').toLowerCase() === 'archived') archived.add(j.engagement_id)
    }
    const { data: invs } = await supabaseService
      .from('invoices').select('engagement_id, paid_at').in('engagement_id', batch)
    for (const i of invs || []) {
      const cur = invoiced.get(i.engagement_id) || { total: 0, paid: 0 }
      cur.total++
      if (i.paid_at) cur.paid++
      invoiced.set(i.engagement_id, cur)
    }
  }

  const count = ids.filter(id => {
    if (!archived.has(id)) return false
    const inv = invoiced.get(id)
    return !(inv && inv.total > 0 && inv.paid === inv.total)
  }).length

  return {
    count,
    unit: 'engagements',
    basis: 'at Final Processing, with an archived job, and no fully-paid invoice to unlock Mark won',
  }
}

// Returning clients whose only open engagement sits at Request — so they
// derive Active and leave the Inbox.
async function countReturningOutOfInbox(): Promise<FleetImpact | null> {
  const { data: openEngs, error } = await supabaseService
    .from('engagements').select('client_id, stage')
    .not('stage', 'in', '("Closed Won","Closed Lost")')
    .limit(COUNT_CAP)
  if (error || !openEngs) return null
  if (openEngs.length >= COUNT_CAP) return null

  const byClient = new Map<string, { open: number; request: number }>()
  for (const e of openEngs) {
    if (!e.client_id) continue
    const cur = byClient.get(e.client_id) || { open: 0, request: 0 }
    cur.open++
    if (e.stage === 'Request') cur.request++
    byClient.set(e.client_id, cur)
  }
  const requestOnly = Array.from(byClient.entries())
    .filter(([, v]) => v.open > 0 && v.open === v.request)
    .map(([id]) => id)
  if (requestOnly.length === 0) {
    return { count: 0, unit: 'returning clients', basis: 'no client has only Request-stage open work' }
  }

  const withPrior = new Set<string>()
  for (const batch of chunks(requestOnly)) {
    const { data } = await supabaseService
      .from('engagements').select('client_id, stage')
      .in('client_id', batch)
      .in('stage', ['Closed Won', 'Closed Lost'])
    for (const e of data || []) withPrior.add(e.client_id)
  }

  return {
    count: withPrior.size,
    unit: 'returning clients',
    basis: 'have a prior closed engagement and only Request-stage open work, so they derive Active and leave the Inbox',
  }
}
