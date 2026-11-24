// lib/mailchimp-audience-look.ts
// ─────────────────────────────────────────────────────────────────────────────
// FL-75 slice 4 (2026-11-23) — LOOK AT BOTH SIDES, WRITE NOTHING.
//
// Reads one location's Mailchimp audience, page by page, and compares it with
// that location's Bee Hub records using the slice 1 rules (lib/mailchimp-
// rules.ts — emailKey, matchPhoneKey, buildMatchIndex, matchContact,
// mailchimpEligibility). No new matching rules live here.
//
// ── WHAT THIS FILE NEVER DOES ───────────────────────────────────────────────
//   • writes to Bee Hub — every database call is a select. No lead, no tag,
//     no mailchimp_synced_at, no sync error, no no-marketing-list row.
//   • writes to Mailchimp — every request is a GET. No PUT, POST, PATCH or
//     DELETE. (The only Mailchimp writer, the Sync now engine, is not imported.)
//   • puts a Mailchimp-side unsubscribe on the no-marketing list. It is NOTED
//     in the result (mailchimpSaidNo) for slice 7, and nothing else.
//   • joins two records on phone. A phone match is a SUGGESTION for the owner
//     to confirm; the member stays "Mailchimp only" until someone does.
//   • looks at names. The match types do not carry one.
//   • prints, logs or returns the token. Every error string that leaves this
//     file goes through scrub(); nothing here calls console.* with a request.
//
// ── WHO MAY BE READ ─────────────────────────────────────────────────────────
// A location is read when ALL of these are true (readRefusal below), and
// nothing else is asked (Kevin's ruling, corrected 2026-11-23):
//   connected (a token and server prefix stored), an audience chosen, and
//   lifecycle_status 'active'.
// A location that fails any of them is REFUSED before its token is even
// selected from the database, with the reason named.
//
//   NOT is_active — false for 36 locations whose lifecycle is 'active'
//     (lib/hub-scope.ts warns it is not a reliable "launched" flag).
//   NOT mailchimp_sync_live — that switch is the fail-closed gate on SENDING.
//     Requiring it here would mean arming sends just to look. Reading never
//     sends, and the switch still guards the sending code exactly as before.
// Both were in the rule until 2026-11-23 (2193793).
//
// ── A BIG AUDIENCE, RATE LIMITS, A HALF-READ ────────────────────────────────
// Pages of 1000 (Mailchimp's maximum), one request at a time — Mailchimp
// allows 10 at once per account, so one is far under it. A 429 (too many
// requests) or a 5xx is retried up to 3 times, waiting Retry-After when
// Mailchimp sends one, else 1s, 2s, 4s. A page that still fails ENDS the read.
//
// If the first page fails, the look fails (ok:false, with the reason). If a
// later page fails — or the audience's size changes while we read, which
// shifts offset paging — the result is complete:false. A partial read is
// never presented as the whole picture: "Bee Hub only" is null (unknown —
// those people may be on a page we did not read), and "both" and
// "Mailchimp only" are labelled as counted from the pages read.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { loadSaidNoSet } from './marketing-no-list'
import { apiBase } from './mailchimp'
import {
  buildMatchIndex, emailKey, mailchimpEligibility, matchContact,
  type MailchimpIneligibleReason, type MatchContact,
} from './mailchimp-rules'

export const PAGE_SIZE = 1000
export const MAX_RETRIES = 3

// ── Who may be read ──────────────────────────────────────────
export type LocationFlags = {
  id: string
  name?: string | null
  lifecycle_status?: string | null
  mailchimp_connected?: boolean | null
  mailchimp_list_id?: string | null
  mailchimp_list_name?: string | null
}

export type ReadRefusal =
  | 'not_connected'          // no Mailchimp account linked
  | 'no_audience'            // linked, but no audience chosen
  | 'location_inactive'      // lifecycle not 'active'

export const REFUSAL_WORDS: Record<ReadRefusal | 'location_not_found', string> = {
  location_not_found: 'That location was not found.',
  not_connected: 'This location has not connected Mailchimp.',
  no_audience: 'This location has connected Mailchimp but not chosen an audience, so there is nothing to look at.',
  location_inactive: 'This location is not active in Bee Hub, so its Mailchimp audience is not read.',
}

/** Why this location may not be read, or null when it may. Pure. */
export function readRefusal(loc: LocationFlags): ReadRefusal | null {
  if (!loc.mailchimp_connected) return 'not_connected'
  if (!loc.mailchimp_list_id) return 'no_audience'
  if (loc.lifecycle_status !== 'active') return 'location_inactive'
  return null
}

// ── Never let the token out ──────────────────────────────────
/** Replaces the token (and the Authorization header shape) in any text that leaves this file. */
export function scrub(text: unknown, token: string | null | undefined): string {
  let s = String(text ?? '')
  if (token && token.length >= 4) s = s.split(token).join('[token]')
  return s.replace(/(Bearer|OAuth)\s+[A-Za-z0-9._\-]+/g, '$1 [token]').slice(0, 300)
}

// ── Reading the audience ─────────────────────────────────────
export type MailchimpMember = {
  id: string
  email: string
  emailKey: string | null
  status: string            // subscribed | unsubscribed | cleaned | pending | transactional | archived
  joinedAt: string | null   // timestamp_opt, else timestamp_signup
  tags: string[]
  phone: string | null      // the PHONE merge field, if the audience has one
}

export type AudienceFailure = 'token_rejected' | 'audience_gone' | 'rate_limited' | 'request_failed' | 'mailchimp_error'

export type AudienceRead =
  | { ok: false; reason: AudienceFailure; detail: string; calls: string[] }
  | {
      ok: true
      complete: boolean
      // Present when complete is false: why the read stopped.
      stopped?: { reason: AudienceFailure | 'changed_while_reading'; detail: string; atOffset: number }
      members: MailchimpMember[]
      totalReported: number
      pagesRead: number
      calls: string[]       // "GET lists/{list}/members?offset=…" — never the token, never the host
    }

type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; cache: 'no-store' }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

const FIELDS = [
  'total_items',
  'members.id', 'members.email_address', 'members.status',
  'members.timestamp_signup', 'members.timestamp_opt',
  'members.tags', 'members.merge_fields',
].join(',')

function failureFor(status: number): AudienceFailure {
  if (status === 401 || status === 403) return 'token_rejected'
  if (status === 404) return 'audience_gone'
  if (status === 429) return 'rate_limited'
  return 'mailchimp_error'
}

function phoneOf(merge: any): string | null {
  if (!merge || typeof merge !== 'object') return null
  const v = merge.PHONE ?? merge.phone
  if (typeof v === 'string') return v.trim() || null
  return null
}

export async function readAudience(args: {
  token: string
  serverPrefix: string
  listId: string
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  pageSize?: number
}): Promise<AudienceRead> {
  const { token, serverPrefix, listId } = args
  const doFetch: FetchLike = args.fetchImpl || ((url, init) => fetch(url, init) as any)
  const sleep = args.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pageSize = args.pageSize || PAGE_SIZE
  const calls: string[] = []
  const members: MailchimpMember[] = []
  const seen = new Set<string>()
  let totalReported = -1
  let pagesRead = 0
  let offset = 0

  // One page, with retries. Answers the parsed body, or a failure.
  const getPage = async (at: number): Promise<{ body: any } | { fail: AudienceFailure; detail: string }> => {
    const query = new URLSearchParams({ count: String(pageSize), offset: String(at), fields: FIELDS })
    const path = `lists/${encodeURIComponent(listId)}/members?${query}`
    for (let attempt = 0; ; attempt++) {
      calls.push(`GET lists/${'{list}'}/members?count=${pageSize}&offset=${at}`)
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await doFetch(`${apiBase(serverPrefix)}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
      } catch (err: any) {
        if (attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt); continue }
        return { fail: 'request_failed', detail: scrub(err?.message || err, token) }
      }
      const text = await res.text().catch(() => '')
      let body: any = null
      try { body = JSON.parse(text) } catch { body = { detail: text } }
      if (res.status >= 200 && res.status < 300) return { body }
      const retryable = res.status === 429 || res.status >= 500
      if (retryable && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt)
        continue
      }
      return { fail: failureFor(res.status), detail: scrub(body?.detail || body?.title || `http ${res.status}`, token) }
    }
  }

  for (;;) {
    const page = await getPage(offset)
    if ('fail' in page) {
      if (pagesRead === 0) return { ok: false, reason: page.fail, detail: page.detail, calls }
      return { ok: true, complete: false, stopped: { reason: page.fail, detail: page.detail, atOffset: offset }, members, totalReported, pagesRead, calls }
    }
    pagesRead++
    const total = Number(page.body?.total_items)
    const rows: any[] = Array.isArray(page.body?.members) ? page.body.members : []
    if (pagesRead === 1) totalReported = Number.isFinite(total) ? total : rows.length
    else if (Number.isFinite(total) && total !== totalReported) {
      // People joined or left mid-read: offset paging may have skipped or
      // repeated someone. Say so rather than guess.
      return {
        ok: true, complete: false,
        stopped: { reason: 'changed_while_reading', detail: `audience size went from ${totalReported} to ${total} during the read`, atOffset: offset },
        members, totalReported, pagesRead, calls,
      }
    }
    for (const m of rows) {
      const id = String(m?.id || '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      const email = String(m?.email_address || '')
      members.push({
        id,
        email,
        emailKey: emailKey(email),
        status: String(m?.status || 'unknown'),
        joinedAt: (m?.timestamp_opt || m?.timestamp_signup || null) || null,
        tags: Array.isArray(m?.tags) ? m.tags.map((t: any) => String(t?.name || '')).filter(Boolean) : [],
        phone: phoneOf(m?.merge_fields),
      })
    }
    offset += rows.length
    if (rows.length === 0 || offset >= totalReported) break
  }
  const complete = members.length >= totalReported
  return complete
    ? { ok: true, complete: true, members, totalReported, pagesRead, calls }
    : { ok: true, complete: false, stopped: { reason: 'mailchimp_error', detail: `Mailchimp said ${totalReported} people but sent ${members.length}`, atOffset: offset }, members, totalReported, pagesRead, calls }
}

// ── The Bee Hub side ─────────────────────────────────────────
export type BeeHubLead = {
  id: string
  email?: string | null
  phone?: string | null
  is_junk?: boolean | null
  marketing_opt_out?: boolean | null
  marketing_unsubscribed_at?: string | null
  archived_at?: string | null
}

// ── The comparison ───────────────────────────────────────────
// Counts are of EMAIL ADDRESSES (people), not records: two Bee Hub records
// with one address are one person here, and their record count is given
// alongside so nothing is silently collapsed.
export type Comparison = {
  complete: boolean
  mailchimpOnly: number              // members whose address matches no Bee Hub record
  beeHubOnly: number | null          // addresses with no member — null when the read is partial
  both: number                       // addresses on both sides
  beeHubOnlyEligible: number | null  // of beeHubOnly, the ones slice 1 would offer
  beeHubOnlyNotOffered: Partial<Record<MailchimpIneligibleReason, number>> | null
  bothByMailchimpStatus: Record<string, number>
  bothNotOfferedInBeeHub: Partial<Record<MailchimpIneligibleReason, number>>
  // Phone proposals: a member with no address match whose phone matches a
  // Bee Hub record. NOT joined, NOT counted in "both".
  phoneSuggestions: { memberId: string; leadIds: string[] }[]
  // Unsubscribed or cleaned INSIDE Mailchimp. Noted for slice 7; nothing is
  // written anywhere because of it.
  mailchimpSaidNo: { memberId: string; emailKey: string | null; status: string }[]
  membersWithUnreadableEmail: number
  beeHubRecords: number
  beeHubRecordsWithEmail: number
  beeHubAddresses: number
  bothLeadRecords: number            // Bee Hub records behind the "both" addresses
  addressesWithSeveralRecords: number
}

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] || 0) + 1 }

export function compareSides(args: {
  members: readonly MailchimpMember[]
  leads: readonly BeeHubLead[]
  suppressed: ReadonlySet<string>
  complete: boolean
}): Comparison {
  const { members, leads, suppressed, complete } = args
  const contacts: MatchContact[] = leads.map((l) => ({ id: l.id, email: l.email, phone: l.phone }))
  const index = buildMatchIndex(contacts)
  const leadById = new Map(leads.map((l) => [l.id, l]))

  const matchedAddresses = new Set<string>()
  let mailchimpOnly = 0
  let unreadable = 0
  const phoneSuggestions: Comparison['phoneSuggestions'] = []
  const mailchimpSaidNo: Comparison['mailchimpSaidNo'] = []
  const bothByMailchimpStatus: Record<string, number> = {}
  const bothNotOffered: Record<string, number> = {}
  let bothLeadRecords = 0

  for (const m of members) {
    if (m.status === 'unsubscribed' || m.status === 'cleaned') mailchimpSaidNo.push({ memberId: m.id, emailKey: m.emailKey, status: m.status })
    if (!m.emailKey) unreadable++
    const verdict = matchContact({ id: m.id, email: m.email, phone: m.phone }, index)
    if (verdict.kind === 'email' && m.emailKey && !matchedAddresses.has(m.emailKey)) {
      matchedAddresses.add(m.emailKey)
      bump(bothByMailchimpStatus, m.status)
      bothLeadRecords += verdict.ids.length
      // The address's Bee Hub standing: offered if ANY record at it would be.
      const verdicts = verdict.ids.map((id) => mailchimpEligibility(leadById.get(id) || {}, { suppressed }))
      const offered = verdicts.find((v) => v.eligible)
      if (!offered) { const first = verdicts[0]; if (first && !first.eligible) bump(bothNotOffered, first.reason) }
      continue
    }
    if (verdict.kind === 'email') continue // a second member at an address already counted
    mailchimpOnly++
    if (verdict.kind === 'phone_confirm') phoneSuggestions.push({ memberId: m.id, leadIds: verdict.ids })
  }

  // Bee Hub addresses with no member.
  let beeHubOnly = 0
  let beeHubOnlyEligible = 0
  const notOffered: Record<string, number> = {}
  let withEmail = 0
  let several = 0
  for (const [addr, ids] of Array.from(index.byEmail.entries())) {
    withEmail += ids.length
    if (ids.length > 1) several++
    if (matchedAddresses.has(addr)) continue
    beeHubOnly++
    const verdicts = ids.map((id) => mailchimpEligibility(leadById.get(id) || {}, { suppressed }))
    if (verdicts.some((v) => v.eligible)) beeHubOnlyEligible++
    else { const first = verdicts[0]; if (first && !first.eligible) bump(notOffered, first.reason) }
  }

  return {
    complete,
    mailchimpOnly,
    beeHubOnly: complete ? beeHubOnly : null,
    both: matchedAddresses.size,
    beeHubOnlyEligible: complete ? beeHubOnlyEligible : null,
    beeHubOnlyNotOffered: complete ? notOffered : null,
    bothByMailchimpStatus,
    bothNotOfferedInBeeHub: bothNotOffered,
    phoneSuggestions,
    mailchimpSaidNo,
    membersWithUnreadableEmail: unreadable,
    beeHubRecords: leads.length,
    beeHubRecordsWithEmail: withEmail,
    beeHubAddresses: index.byEmail.size,
    bothLeadRecords,
    addressesWithSeveralRecords: several,
  }
}

export const PARTIAL_WORDS =
  'Only part of the Mailchimp audience could be read, so this is not the whole picture. "Bee Hub only" is not shown, because those people may be on the part we could not read.'

// ── One location, end to end ─────────────────────────────────
export type LocationLook =
  | { ok: false; reason: 'location_not_found' | ReadRefusal | 'beehub_read_failed' | AudienceFailure; words: string; detail?: string; calls: string[] }
  | {
      ok: true
      complete: boolean
      words: string | null            // PARTIAL_WORDS when complete is false
      location: { id: string; name: string | null; audienceName: string | null }
      mailchimp: { totalReported: number; membersRead: number; pagesRead: number; byStatus: Record<string, number>; stopped?: { reason: string; detail: string; atOffset: number } }
      comparison: Comparison
      calls: string[]
    }

type Db = typeof supabaseService

export async function lookAtLocation(locationId: string, deps: {
  db?: Db
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  loadSuppressed?: (emails: readonly unknown[]) => Promise<Set<string>>
  pageSize?: number
} = {}): Promise<LocationLook> {
  const db = deps.db || supabaseService
  const calls: string[] = []

  // 1. The flags — WITHOUT the token. A refused location's token is never read.
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, name, lifecycle_status, mailchimp_connected, mailchimp_list_id, mailchimp_list_name')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr || !loc) return { ok: false, reason: 'location_not_found', words: REFUSAL_WORDS.location_not_found, calls }
  const refusal = readRefusal(loc as LocationFlags)
  if (refusal) return { ok: false, reason: refusal, words: REFUSAL_WORDS[refusal], calls }

  // 2. Only now, the credentials. Held in this function; never returned.
  const { data: cred, error: credErr } = await db
    .from('locations')
    .select('mailchimp_access_token, mailchimp_server_prefix')
    .eq('id', locationId)
    .maybeSingle()
  const token = (cred as any)?.mailchimp_access_token as string | undefined
  const prefix = (cred as any)?.mailchimp_server_prefix as string | undefined
  if (credErr || !token || !prefix) return { ok: false, reason: 'not_connected', words: REFUSAL_WORDS.not_connected, calls }

  // 3. Mailchimp, GET only.
  const read = await readAudience({ token, serverPrefix: prefix, listId: (loc as any).mailchimp_list_id, fetchImpl: deps.fetchImpl, sleep: deps.sleep, pageSize: deps.pageSize })
  calls.push(...read.calls)
  if (!read.ok) return { ok: false, reason: read.reason, words: AUDIENCE_FAILURE_WORDS[read.reason], detail: read.detail, calls }

  // 4. Bee Hub, select only, paged (the API returns at most 1000 rows a call).
  const leads: BeeHubLead[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('leads')
      .select('id, email, phone, is_junk, marketing_opt_out, marketing_unsubscribed_at, archived_at')
      .eq('location_uuid', locationId)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) return { ok: false, reason: 'beehub_read_failed', words: 'Bee Hub’s own records could not be read, so nothing is compared.', detail: scrub(error.message, token), calls }
    leads.push(...((data || []) as BeeHubLead[]))
    if (!data || data.length < 1000) break
  }
  let suppressed: Set<string>
  try {
    suppressed = await (deps.loadSuppressed || loadSaidNoSet)(leads.map((l) => l.email))
  } catch (err: any) {
    return { ok: false, reason: 'beehub_read_failed', words: 'The no-marketing list could not be read, so nothing is compared.', detail: scrub(err?.message || err, token), calls }
  }

  const byStatus: Record<string, number> = {}
  for (const m of read.members) bump(byStatus, m.status)
  return {
    ok: true,
    complete: read.complete,
    words: read.complete ? null : PARTIAL_WORDS,
    location: { id: locationId, name: (loc as any).name ?? null, audienceName: (loc as any).mailchimp_list_name ?? null },
    mailchimp: { totalReported: read.totalReported, membersRead: read.members.length, pagesRead: read.pagesRead, byStatus, ...(read.stopped ? { stopped: read.stopped } : {}) },
    comparison: compareSides({ members: read.members, leads, suppressed, complete: read.complete }),
    calls,
  }
}

export const AUDIENCE_FAILURE_WORDS: Record<AudienceFailure, string> = {
  token_rejected: 'Mailchimp turned down this location’s connection. The owner needs to reconnect Mailchimp.',
  audience_gone: 'The chosen Mailchimp audience no longer exists. The owner needs to choose an audience again.',
  rate_limited: 'Mailchimp asked us to slow down and kept refusing, so the audience was not read. Try again in a few minutes.',
  request_failed: 'Mailchimp could not be reached, so the audience was not read.',
  mailchimp_error: 'Mailchimp sent an error, so the audience was not read.',
}
