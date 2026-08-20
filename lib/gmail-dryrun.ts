// lib/gmail-dryrun.ts
//
// Gmail sync step 3 — dry-run lead matching. COUNTS ONLY, ZERO WRITES.
//
// Scans recent mailbox metadata (never bodies) and reports how messages
// would match against leads, so the matching rule can be judged from
// numbers before any row is ever stored. Nothing here may INSERT,
// UPDATE, UPSERT, or DELETE, and nothing here may log or return a
// subject, address, name, or lead id — aggregate counts only.
//
// Location scoping crosses two different join conventions behind
// identically-named columns (both verified against prod 2026-08-19):
//   hub_users.location_id — locations.id AS TEXT (30/30 rows join on
//     l.id::text = hu.location_id; 0 join via slug)
//   leads.location_id     — locations.SLUG (15646/15646 rows join on
//     l.slug = ld.location_id; 0 join via id::text; 0 orphans)
//
// Lead-email matching is case-insensitive BY NECESSITY: 941 of 15646
// prod leads have mixed-case emails, so an .in('email', lowercased)
// batch would silently miss ~6% of matches. We therefore fetch the
// candidate lead set (location-scoped, paginated — max location today
// is ~3.4k leads) and compare lowercased in memory. Batched per page,
// never per message, never per address.

import {
  listMessageIds as defaultListMessageIds,
  getMessageMetadata as defaultGetMessageMetadata,
  parseAddresses,
  GmailMessageMetadata,
  GmailMessageRef,
} from './gmail'
import { supabaseService } from './supabase-service'

export const DRYRUN_DAYS_DEFAULT = 7
export const DRYRUN_DAYS_MAX = 90
export const DRYRUN_MAX_MESSAGES_DEFAULT = 200
export const DRYRUN_MAX_MESSAGES_CEILING = 500

const LIST_PAGE_SIZE = 100
const METADATA_CONCURRENCY = 8
const LEADS_PAGE_SIZE = 1000

export interface DryRunResult {
  mailbox: string
  locationSlug: string | null
  locationScoped: boolean
  daysScanned: number
  capHit: boolean
  messagesScanned: number
  messagesWithExternalParticipants: number
  messagesMatchedExactlyOneLead: number
  messagesMatchedMultipleLeadsSameLocation: number
  messagesMatchedLeadsInMultipleLocations: number
  messagesUnmatched: number
  distinctAddressesSeen: number
  distinctAddressesMatched: number
  distinctThreadsSeen: number
  matchesByLocationSlug: Record<string, number>
  elapsedMs: number
}

// Test seam only — production callers pass nothing here.
export interface DryRunDeps {
  supabase?: any
  listMessageIds?: typeof defaultListMessageIds
  getMessageMetadata?: typeof defaultGetMessageMetadata
}

export interface DryRunOptions {
  days?: number
  maxMessages?: number
  timeBudgetMs?: number
  deps?: DryRunDeps
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

export async function dryRunMailbox(
  userEmail: string,
  opts: DryRunOptions = {}
): Promise<DryRunResult> {
  const start = Date.now()
  const supabase = opts.deps?.supabase ?? supabaseService
  const listIds = opts.deps?.listMessageIds ?? defaultListMessageIds
  const getMeta = opts.deps?.getMessageMetadata ?? defaultGetMessageMetadata

  const mailbox = userEmail.trim().toLowerCase()
  const days = clamp(Math.floor(opts.days ?? DRYRUN_DAYS_DEFAULT), 1, DRYRUN_DAYS_MAX)
  const maxMessages = clamp(
    Math.floor(opts.maxMessages ?? DRYRUN_MAX_MESSAGES_DEFAULT),
    1,
    DRYRUN_MAX_MESSAGES_CEILING
  )
  const timeBudgetMs = opts.timeBudgetMs ?? 50_000
  const outOfTime = () => Date.now() - start > timeBudgetMs

  // ---- Resolve mailbox -> location (hub_users.location_id = locations.id::text)
  let locationSlug: string | null = null
  {
    const { data: hubRows, error: huErr } = await supabase
      .from('hub_users')
      .select('location_id')
      .eq('email', mailbox)
      .limit(1)
    if (huErr) throw new Error(`hub_users lookup failed: ${huErr.message}`)
    const locationId = hubRows?.[0]?.location_id ?? null
    if (locationId) {
      const { data: locRows, error: locErr } = await supabase
        .from('locations')
        .select('slug')
        .eq('id', locationId)
        .limit(1)
      if (locErr) throw new Error(`locations lookup failed: ${locErr.message}`)
      if (!locRows || locRows.length === 0) {
        // Loud failure, not a clean-looking zero: the uuid-as-text join broke.
        throw new Error(
          'mailbox has a hub_users.location_id but the locations.id join returned zero rows — refusing to report counts that would masquerade as a clean result'
        )
      }
      if (!locRows[0].slug) {
        throw new Error(
          'mailbox resolved to a locations row with no slug — cannot scope the lead query; refusing to report counts'
        )
      }
      locationSlug = locRows[0].slug
    }
  }
  const locationScoped = locationSlug !== null

  // ---- List message ids (capped)
  let capHit = false
  const refs: GmailMessageRef[] = []
  let pageToken: string | undefined
  const query = `newer_than:${days}d -in:chats`
  for (;;) {
    const page = await listIds(mailbox, {
      query,
      maxResults: Math.min(LIST_PAGE_SIZE, maxMessages - refs.length),
      pageToken,
    })
    refs.push(...page.messages)
    pageToken = page.nextPageToken
    if (refs.length >= maxMessages) {
      if (pageToken || refs.length > maxMessages) capHit = true
      refs.length = maxMessages
      break
    }
    if (!pageToken) break
    if (outOfTime()) {
      capHit = true
      break
    }
  }

  // ---- Fetch metadata (bounded concurrency, time-budget aware)
  const metas: GmailMessageMetadata[] = []
  for (let i = 0; i < refs.length; i += METADATA_CONCURRENCY) {
    if (outOfTime()) {
      capHit = true
      break
    }
    const chunk = refs.slice(i, i + METADATA_CONCURRENCY)
    const settled = await Promise.allSettled(chunk.map((r) => getMeta(mailbox, r.id)))
    for (const s of settled) {
      // A message deleted between list and get shouldn't kill the run;
      // it simply doesn't count as scanned.
      if (s.status === 'fulfilled') metas.push(s.value)
    }
  }

  // ---- Per-message external participants (From/To/Cc minus the mailbox itself)
  const perMessage: { threadId: string; addresses: string[] }[] = []
  const allAddresses = new Set<string>()
  const threadIds = new Set<string>()
  for (const m of metas) {
    if (m.threadId) threadIds.add(m.threadId)
    const addrs = new Set<string>()
    for (const key of ['from', 'to', 'cc']) {
      for (const a of parseAddresses(m.headers[key])) addrs.add(a)
    }
    addrs.delete(mailbox)
    perMessage.push({ threadId: m.threadId, addresses: Array.from(addrs) })
    addrs.forEach((a) => allAddresses.add(a))
  }

  // ---- Candidate leads, batched per page (never per message / per address).
  // Case-insensitive compare in memory — see header comment for why .in()
  // equality is not safe against prod data.
  const emailToLeads = new Map<string, { id: string; slug: string }[]>()
  if (allAddresses.size > 0) {
    let from = 0
    for (;;) {
      let q = supabase
        .from('leads')
        .select('id, email, location_id')
        .not('is_junk', 'is', true)
        .not('email', 'is', null)
        .order('id')
        .range(from, from + LEADS_PAGE_SIZE - 1)
      if (locationScoped) q = q.eq('location_id', locationSlug)
      const { data: leadRows, error: leadErr } = await q
      if (leadErr) throw new Error(`leads query failed: ${leadErr.message}`)
      for (const row of leadRows ?? []) {
        const em = String(row.email).trim().toLowerCase()
        if (!allAddresses.has(em)) continue
        const entry = { id: String(row.id), slug: String(row.location_id) }
        const list = emailToLeads.get(em)
        if (list) list.push(entry)
        else emailToLeads.set(em, [entry])
      }
      if (!leadRows || leadRows.length < LEADS_PAGE_SIZE) break
      from += LEADS_PAGE_SIZE
    }
  }

  // ---- Classify messages
  let messagesWithExternalParticipants = 0
  let messagesMatchedExactlyOneLead = 0
  let messagesMatchedMultipleLeadsSameLocation = 0
  let messagesMatchedLeadsInMultipleLocations = 0
  let messagesUnmatched = 0
  const matchesByLocationSlug: Record<string, number> = {}
  const matchedAddresses = new Set<string>()

  for (const pm of perMessage) {
    if (pm.addresses.length === 0) continue
    messagesWithExternalParticipants++
    const leadIds = new Set<string>()
    const slugs = new Set<string>()
    for (const a of pm.addresses) {
      const hits = emailToLeads.get(a)
      if (!hits) continue
      matchedAddresses.add(a)
      for (const h of hits) {
        leadIds.add(h.id)
        slugs.add(h.slug)
      }
    }
    if (leadIds.size === 0) {
      messagesUnmatched++
      continue
    }
    slugs.forEach((s) => {
      matchesByLocationSlug[s] = (matchesByLocationSlug[s] ?? 0) + 1
    })
    if (leadIds.size === 1) messagesMatchedExactlyOneLead++
    else if (slugs.size === 1) messagesMatchedMultipleLeadsSameLocation++
    else messagesMatchedLeadsInMultipleLocations++
  }

  return {
    mailbox,
    locationSlug,
    locationScoped,
    daysScanned: days,
    capHit,
    messagesScanned: metas.length,
    messagesWithExternalParticipants,
    messagesMatchedExactlyOneLead,
    messagesMatchedMultipleLeadsSameLocation,
    messagesMatchedLeadsInMultipleLocations,
    messagesUnmatched,
    distinctAddressesSeen: allAddresses.size,
    distinctAddressesMatched: matchedAddresses.size,
    distinctThreadsSeen: threadIds.size,
    matchesByLocationSlug,
    elapsedMs: Date.now() - start,
  }
}
