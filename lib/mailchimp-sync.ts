// lib/mailchimp-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// Issue 246 step 3A — push a location's ELIGIBLE website leads into its chosen
// Mailchimp audience. Manual trigger only: the /api/mailchimp/sync route (and
// nothing else) calls this. NO cron, no webhook, no back-catalog re-push.
//
// ── THE GATE, BEFORE ANYTHING ELSE ──────────────────────────────────────────
// mailchimp_sync_live is the fail-closed per-location switch, flipped by hand
// exactly like notifications_live. When it is FALSE this function returns a
// zero report with a reason and sends NOTHING — it does not "dry run", it does
// not warm up, it does not touch Mailchimp at all. Same for a missing
// connection or a missing audience: no half-configured location ever emits a
// network request from here.
//
// ── ELIGIBILITY IS THE CONSENT BASIS ────────────────────────────────────────
// source = 'Website' is the ONLY qualifying source: those people filled in the
// location's own form. Imported Jobber clients, manual entries, referrals —
// none of them asked to be marketed to, so none of them qualify, regardless of
// how good their email looks. On top of that: a real email, no marketing
// opt-out, no unsubscribe timestamp, and never previously synced
// (mailchimp_synced_at IS NULL — this step never re-pushes a synced row).
// is_junk rows are also excluded: the Recycle Bin is deletion-pending, and
// "we market to the trash" is not a sentence anyone wants to say.
//
// ── WHY PUT + status_if_new, AND NEVER `status` ─────────────────────────────
// PUT /lists/{id}/members/{hash} upserts. POST would 400 on an existing member;
// worse, a plain `status` field on the PUT would OVERWRITE the member's current
// state — re-subscribing someone who unsubscribed INSIDE Mailchimp, which is
// the one thing a sync must never do. status_if_new applies only when the
// member does not exist yet; an existing member keeps whatever status they
// have. Do not "improve" this to `status`.
//
// ── CLIENT STATUS COMES FROM THE DERIVATION, NOT THE COLUMN ─────────────────
// leads.client_status is a point-in-time snapshot and is stale. The live truth
// is deriveClientStatus(), fed through the REAL mapper — the same recipe
// lib/hub-all-overview.ts uses server-side, so the tag on a Mailchimp member
// agrees with what the Hub shows for that person BY CONSTRUCTION.
//
// ── FAILURE SHAPE ───────────────────────────────────────────────────────────
// Per-lead, never per-run: one bad email must not strand the other 80. Success
// stamps mailchimp_synced_at + the status Mailchimp returned; failure stamps
// mailchimp_sync_error and leaves synced_at NULL so the next run retries it.
// A tag-write failure counts as a failure for the same reason — synced_at
// stays NULL, and the retry's PUT is idempotent so re-pushing is safe.
//
// Requests run SEQUENTIALLY. Mailchimp allows 10 simultaneous connections per
// account; one at a time is far under it, and the volumes here (website leads
// per location) never justify a pool worth debugging.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'crypto'
import { supabaseService } from './supabase-service'
import { apiBase } from './mailchimp'
import { mapLeadToPerson } from './people-mapper'
// clientStatus.js is an untyped pure JS module — typed at the boundary, same
// as lib/hub-all-overview.ts does, so the arguments stay checked.
import { deriveClientStatus as deriveClientStatusUntyped } from '@/components/hive/shared/clientStatus'
const deriveClientStatus = deriveClientStatusUntyped as (
  person: any,
  openClientIds: Set<string> | null,
  nowMs?: number,
  wonClientIds?: Set<string> | null,
) => string

export const MD5_OF_LOWERCASED_EMAIL = (email: string): string =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex')

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

export type SyncReport = {
  ran: boolean
  // ran:false reasons — every one of them means ZERO requests were sent.
  reason?: 'sync_not_enabled' | 'not_connected' | 'no_audience' | 'location_not_found'
  pushed: number
  skipped: number
  failed: number
  // A sample of what went wrong, for the server log / response body.
  errors: Array<{ lead_id: string; error: string }>
}

const zeroReport = (reason: NonNullable<SyncReport['reason']>): SyncReport => ({
  ran: false, reason, pushed: 0, skipped: 0, failed: 0, errors: [],
})

// Read one Mailchimp response safely — the outcome may be in the body even
// when the HTTP status is fine, and the body may not be JSON at all.
async function readJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => '')
  try { return JSON.parse(text) } catch { return { detail: text.slice(0, 200) } }
}

export async function syncWebsiteLeadsToMailchimp(locationUuid: string): Promise<SyncReport> {
  // ── 1. The gate ─────────────────────────────────────────────
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, mailchimp_connected, mailchimp_access_token, mailchimp_server_prefix, mailchimp_list_id, mailchimp_sync_live')
    .eq('id', locationUuid)
    .maybeSingle()
  if (locErr || !loc) return zeroReport('location_not_found')

  if (!loc.mailchimp_connected || !loc.mailchimp_access_token || !loc.mailchimp_server_prefix) {
    return zeroReport('not_connected')
  }
  if (!loc.mailchimp_list_id) return zeroReport('no_audience')
  // The fail-closed switch. False means false — nothing is sent, and the
  // report says why instead of pretending an empty location.
  if (!loc.mailchimp_sync_live) return zeroReport('sync_not_enabled')

  const token = loc.mailchimp_access_token as string
  const base = apiBase(loc.mailchimp_server_prefix as string)
  const listId = loc.mailchimp_list_id as string

  // ── 2. Eligibility ──────────────────────────────────────────
  // leads.location_uuid (uuid, NOT NULL) rather than leads.location_id (the
  // text slug): the guard hands this function the locations.id uuid, and
  // location_uuid is its direct typed key — no slug round-trip, no text/uuid
  // comparison to get wrong (hub_users.location_id being TEXT is exactly that
  // bug class). The two columns agree on every row in prod, so this is a
  // choice of the cleaner join, not a behavioral fork.
  //
  // Paged because PostgREST caps a response at 1000 rows and a first-ever sync
  // on a busy location could clear that.
  const eligible: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseService
      .from('leads')
      .select('*')
      .eq('location_uuid', locationUuid)
      .eq('source', 'Website')
      .not('email', 'is', null)
      .neq('email', '')
      .not('marketing_opt_out', 'is', true)
      .is('marketing_unsubscribed_at', null)
      .is('mailchimp_synced_at', null)
      .not('is_junk', 'is', true)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(`eligibility read failed: ${error.message}`)
    eligible.push(...(data || []))
    if ((data || []).length < 1000) break
  }

  // Skipped = website-source leads for this location that the eligibility
  // clauses excluded (no email, opted out, unsubscribed, already synced,
  // junked). Counted with head:true — PostgREST aggregates are disabled on
  // this project, but head-counts work.
  const { count: totalWebsite } = await supabaseService
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('location_uuid', locationUuid)
    .eq('source', 'Website')
  const skipped = Math.max(0, (totalWebsite ?? eligible.length) - eligible.length)

  if (eligible.length === 0) {
    return { ran: true, pushed: 0, skipped, failed: 0, errors: [] }
  }

  // ── 3. Derivation inputs (the hub-all-overview recipe) ──────
  // The status tag must be the LIVE derivation, so fetch what it reads: each
  // lead's engagements (open → Active, won → Client, any → settles Nurturing)
  // and reach-out touchpoints (Attempting). Chunked .in() — an unfiltered
  // child read is the bug class the Hub already fixed once.
  //
  // lead_tags rides the same chunks: the REAL tags live in the junction
  // (leads.tags the column is a write-orphan — nothing in the app populates
  // it), resolved tag_lookup_id → lookups.label in ONE batched read below,
  // never per lead. Same resolution _hub-page.tsx does for the Hub.
  const ids = eligible.map((l: any) => l.id)
  const openIds = new Set<string>()
  const wonIds = new Set<string>()
  const engagementCounts: Record<string, number> = {}
  const touchByLead: Record<string, any[]> = {}
  const leadTagRows: Array<{ lead_id: string; tag_lookup_id: string }> = []
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const [engRes, touchRes, tagRes] = await Promise.all([
      supabaseService.from('engagements').select('client_id, stage').in('client_id', chunk),
      // ⚠️ `kind`, not `type` — the COLUMN is touchpoints.kind; the mapper
      // renames it on the timeline entry the derivation reads.
      supabaseService.from('touchpoints').select('lead_id, kind, occurred_at').in('lead_id', chunk),
      supabaseService.from('lead_tags').select('lead_id, tag_lookup_id').in('lead_id', chunk),
    ])
    if (engRes.error) throw new Error(`engagements read failed: ${engRes.error.message}`)
    if (touchRes.error) throw new Error(`touchpoints read failed: ${touchRes.error.message}`)
    if (tagRes.error) throw new Error(`lead_tags read failed: ${tagRes.error.message}`)
    for (const e of engRes.data || []) {
      engagementCounts[e.client_id] = (engagementCounts[e.client_id] || 0) + 1
      if (e.stage === 'Closed Won') wonIds.add(e.client_id)
      if (e.stage !== 'Closed Won' && e.stage !== 'Closed Lost') openIds.add(e.client_id)
    }
    for (const t of touchRes.data || []) (touchByLead[t.lead_id] ||= []).push(t)
    leadTagRows.push(...(tagRes.data || []))
  }

  // Resolve tag definitions ONCE for the whole run — the distinct
  // tag_lookup_ids are bounded by the admin vocabulary (a handful of rows),
  // so this is a single .in() read, not a per-lead query.
  const tagLabelById: Record<string, string> = {}
  const tagLookupIds = Array.from(new Set(leadTagRows.map((r) => r.tag_lookup_id)))
  if (tagLookupIds.length > 0) {
    const { data: lookupRows, error: lookupErr } = await supabaseService
      .from('lookups')
      .select('id, label')
      .in('id', tagLookupIds)
    if (lookupErr) throw new Error(`lookups read failed: ${lookupErr.message}`)
    for (const r of lookupRows || []) tagLabelById[r.id] = r.label
  }
  const tagLabelsByLead: Record<string, string[]> = {}
  for (const r of leadTagRows) {
    const label = tagLabelById[r.tag_lookup_id]
    if (label) (tagLabelsByLead[r.lead_id] ||= []).push(label)
  }

  // ── 4. Push, one lead at a time ─────────────────────────────
  const nowMs = Date.now()
  let pushed = 0
  const errors: Array<{ lead_id: string; error: string }> = []

  for (const row of eligible) {
    const email = String(row.email).trim()
    // The DB clauses cannot see whitespace-only emails; this can.
    if (!email) { errors.push({ lead_id: row.id, error: 'empty_email' }); continue }

    try {
      const person = mapLeadToPerson(row, {
        touchpoints: touchByLead[row.id] || [],
        engagement_count: engagementCounts[row.id] || 0,
      })
      const status = deriveClientStatus(person, openIds, nowMs, wonIds)
      const tags = buildMemberTags({
        projectType: row.project_type,
        source: row.source,
        clientStatus: status,
        leadTags: tagLabelsByLead[row.id] || [],
      })

      const hash = MD5_OF_LOWERCASED_EMAIL(email)

      // Upsert the member. status_if_new ONLY — see the header for why a
      // plain `status` here would resurrect Mailchimp-side unsubscribes.
      const memberRes = await fetch(`${base}lists/${listId}/members/${hash}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_address: email,
          status_if_new: 'subscribed',
          merge_fields: {
            FNAME: row.first_name || '',
            LNAME: row.last_name || '',
          },
        }),
        cache: 'no-store',
      })
      const member = await readJson(memberRes)
      if (!memberRes.ok) {
        throw new Error(String(member?.detail || member?.title || `member_http_${memberRes.status}`))
      }

      // Tags ride a separate endpoint. A failure here fails the LEAD (synced_at
      // stays NULL, the retry re-PUTs harmlessly) — a member without their tags
      // is a half-synced member, and half-synced reads as synced forever.
      if (tags.length > 0) {
        const tagRes = await fetch(`${base}lists/${listId}/members/${hash}/tags`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: tags.map((name) => ({ name, status: 'active' })) }),
          cache: 'no-store',
        })
        if (!tagRes.ok) {
          const tagBody = await readJson(tagRes)
          throw new Error(`tags_failed: ${String(tagBody?.detail || tagBody?.title || tagRes.status)}`)
        }
      }

      // Success write-back. The status recorded is what MAILCHIMP said — for
      // an existing member who unsubscribed over there, that is 'unsubscribed',
      // and recording it truthfully is the point.
      const { error: writeErr } = await supabaseService
        .from('leads')
        .update({
          mailchimp_synced_at: new Date().toISOString(),
          mailchimp_status: String(member?.status || 'subscribed'),
          mailchimp_sync_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
      if (writeErr) {
        // The push happened but the stamp failed — surface it as a failure so
        // somebody looks; the retry's PUT is idempotent.
        throw new Error(`writeback_failed: ${writeErr.message}`)
      }

      pushed++
    } catch (err: any) {
      const message = String(err?.message || err).slice(0, 500)
      errors.push({ lead_id: row.id, error: message })
      // Failure write-back: the error lands on the row, synced_at stays NULL
      // so the next run picks this lead up again. Best-effort — if even this
      // write fails, the error is still in the report.
      await supabaseService
        .from('leads')
        .update({ mailchimp_sync_error: message, updated_at: new Date().toISOString() })
        .eq('id', row.id)
    }
  }

  return { ran: true, pushed, skipped, failed: errors.length, errors }
}
