// lib/gmail-sync.ts
//
// Gmail sync step 4 — ingest. The first step that writes rows.
//
// THE FILTER IS THE PRIVACY BOUNDARY. A thread is persisted ONLY if at
// least one of its messages has a participant matching a lead at the
// mailbox's location. Non-matching messages are read as METADATA ONLY
// and discarded — never written, never logged, and their bodies are
// never even fetched (format=full happens strictly after the match).
//
// The sync_enabled gate lives HERE in the engine, not the route, so no
// future caller can skip it — same precedent as the Mailchimp engine's
// mailchimp_sync_live gate. sync_enabled=false returns a zero report
// with a reason and makes ZERO Gmail requests (pinned by a fetch-count
// test). (The Mailchimp engine's filename is deliberately not written
// out here — its sweep test greps for the literal string to catch new
// importers.)
//
// Join conventions (all re-verified against prod 2026-08-20):
//   email_accounts.location_id — uuid, FK locations.id
//   leads.location_uuid        — uuid, FK-equivalent of locations.id;
//     agrees with the leads.location_id slug convention on 15647/15647
//     rows (0 nulls, 0 disagreements) — same choice the Mailchimp engine made
//   leads.location_id          — slug (used only to key the report)
// Lead matching runs IN POSTGRES via .ilikeAnyOf (wildcards escaped, so
// each pattern is case-insensitive equality) against leads_email_lower_idx's
// table — not step 3's in-memory comparison.
//
// Upsert keys (verified unique indexes — onConflict on anything else
// 42P10s, see subrecord-onconflict history):
//   email_threads   (account_id, gmail_thread_id)  email_threads_account_thread_uniq
//   email_messages  (account_id, gmail_message_id) email_messages_account_msg_uniq
//   email_attachments has NO composite unique index — idempotency there
//   is select-missing-then-insert, deliberately not onConflict.
//
// The history cursor advances ONLY after every write of a complete run
// succeeds. Partial runs (time budget, message cap) return capHit and
// leave last_history_id untouched.

import {
  listMessageIds as defaultListMessageIds,
  getMessageMetadata as defaultGetMessageMetadata,
  getMessageFull as defaultGetMessageFull,
  listHistory as defaultListHistory,
  getProfile as defaultGetProfile,
  parseAddresses,
  GmailApiError,
  GmailMessageMetadata,
  GmailMessageRef,
} from './gmail'
import { supabaseService } from './supabase-service'

export const SYNC_DAYS_DEFAULT = 30
export const SYNC_DAYS_MAX = 90
export const SYNC_MAX_MESSAGES = 500

const LIST_PAGE_SIZE = 100
const FETCH_CONCURRENCY = 8
const LEAD_QUERY_CHUNK = 100
const WRITE_CHUNK = 100

export interface GmailSyncReport {
  ran: boolean
  // ran:false reasons — each means ZERO Gmail requests and ZERO writes.
  reason?: 'account_not_found' | 'sync_not_enabled'
  mailbox: string | null
  locationSlug: string | null
  locationScoped: boolean
  mode: 'full' | 'incremental' | null
  historyFallback: boolean
  daysScanned: number | null
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
  threadsWritten: number
  messagesWritten: number
  attachmentsWritten: number
  cursorAdvancedTo: string | null
  elapsedMs: number
}

// Test seam only — production callers pass nothing here.
export interface GmailSyncDeps {
  supabase?: any
  listMessageIds?: typeof defaultListMessageIds
  getMessageMetadata?: typeof defaultGetMessageMetadata
  getMessageFull?: typeof defaultGetMessageFull
  listHistory?: typeof defaultListHistory
  getProfile?: typeof defaultGetProfile
}

export interface GmailSyncOptions {
  days?: number
  maxMessages?: number
  timeBudgetMs?: number
  deps?: GmailSyncDeps
}

function zeroReport(reason: NonNullable<GmailSyncReport['reason']>, elapsedMs: number): GmailSyncReport {
  return {
    ran: false,
    reason,
    mailbox: null,
    locationSlug: null,
    locationScoped: false,
    mode: null,
    historyFallback: false,
    daysScanned: null,
    capHit: false,
    messagesScanned: 0,
    messagesWithExternalParticipants: 0,
    messagesMatchedExactlyOneLead: 0,
    messagesMatchedMultipleLeadsSameLocation: 0,
    messagesMatchedLeadsInMultipleLocations: 0,
    messagesUnmatched: 0,
    distinctAddressesSeen: 0,
    distinctAddressesMatched: 0,
    distinctThreadsSeen: 0,
    matchesByLocationSlug: {},
    threadsWritten: 0,
    messagesWritten: 0,
    attachmentsWritten: 0,
    cursorAdvancedTo: null,
    elapsedMs,
  }
}

// Escape LIKE metacharacters so each ilike pattern is exact-match,
// case-insensitive equality — never a wildcard.
function escapeLike(address: string): string {
  return address.replace(/[\\%_]/g, (m) => `\\${m}`)
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function collapseHeaders(rawHeaders: any[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const h of rawHeaders ?? []) {
    const key = String(h?.name ?? '').toLowerCase()
    if (!key) continue
    const value = String(h?.value ?? '')
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value
  }
  return headers
}

function decodeBody(data?: string): string | null {
  if (!data) return null
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

interface AttachmentMeta {
  gmail_attachment_id: string
  filename: string | null
  mime_type: string | null
  size_bytes: number | null
}

// Walk a format=full payload tree for bodies + attachment METADATA (no bytes).
function extractParts(payload: any): {
  bodyText: string | null
  bodyHtml: string | null
  attachments: AttachmentMeta[]
} {
  let bodyText: string | null = null
  let bodyHtml: string | null = null
  const attachments: AttachmentMeta[] = []
  const walk = (part: any) => {
    if (!part) return
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        gmail_attachment_id: String(part.body.attachmentId),
        filename: String(part.filename) || null,
        mime_type: part.mimeType ? String(part.mimeType) : null,
        size_bytes: part.body.size != null ? Number(part.body.size) : null,
      })
    } else if (part.mimeType === 'text/plain' && part.body?.data && bodyText === null) {
      bodyText = decodeBody(part.body.data)
    } else if (part.mimeType === 'text/html' && part.body?.data && bodyHtml === null) {
      bodyHtml = decodeBody(part.body.data)
    }
    for (const p of part.parts ?? []) walk(p)
  }
  walk(payload)
  return { bodyText, bodyHtml, attachments }
}

function parseFromHeader(value?: string): { email: string | null; name: string | null } {
  if (!value) return { email: null, name: null }
  const email = parseAddresses(value)[0] ?? null
  let name: string | null = value.split('<')[0].trim()
  name = name.replace(/^"(.*)"$/, '$1').trim() || null
  if (name && email && name.toLowerCase() === email) name = null
  return { email, name }
}

function throwDb(op: string, error: { message?: string } | null): never {
  throw new Error(`gmail-sync ${op} failed: ${error?.message ?? 'unknown error'}`)
}

export async function syncMailbox(
  accountId: string,
  opts: GmailSyncOptions = {}
): Promise<GmailSyncReport> {
  const start = Date.now()
  const supabase = opts.deps?.supabase ?? supabaseService
  const listIds = opts.deps?.listMessageIds ?? defaultListMessageIds
  const getMeta = opts.deps?.getMessageMetadata ?? defaultGetMessageMetadata
  const getFull = opts.deps?.getMessageFull ?? defaultGetMessageFull
  const history = opts.deps?.listHistory ?? defaultListHistory
  const profile = opts.deps?.getProfile ?? defaultGetProfile

  const days = Math.max(1, Math.min(SYNC_DAYS_MAX, Math.floor(opts.days ?? SYNC_DAYS_DEFAULT)))
  const maxMessages = Math.max(1, Math.min(SYNC_MAX_MESSAGES, Math.floor(opts.maxMessages ?? SYNC_MAX_MESSAGES)))
  const timeBudgetMs = opts.timeBudgetMs ?? 45_000
  const outOfTime = () => Date.now() - start > timeBudgetMs

  // ── 1. The gate — before ANY Gmail request ─────────────────────────
  const { data: acctRows, error: acctErr } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('id', accountId)
    .limit(1)
  if (acctErr) throwDb('email_accounts lookup', acctErr)
  const account = acctRows?.[0]
  if (!account) return zeroReport('account_not_found', Date.now() - start)
  // The fail-closed switch. False means false — no Gmail traffic, no
  // writes, and the report says why instead of pretending an empty run.
  if (!account.sync_enabled) return zeroReport('sync_not_enabled', Date.now() - start)

  const mailbox = String(account.email_address).trim().toLowerCase()

  // ── 2. Resolve location (email_accounts.location_id = locations.id, uuid)
  let locationSlug: string | null = null
  if (account.location_id) {
    const { data: locRows, error: locErr } = await supabase
      .from('locations')
      .select('slug')
      .eq('id', account.location_id)
      .limit(1)
    if (locErr) throwDb('locations lookup', locErr)
    if (!locRows || locRows.length === 0 || !locRows[0].slug) {
      throw new Error(
        'email_accounts.location_id joins zero locations rows (or a slugless one) — refusing to sync without a resolvable scope'
      )
    }
    locationSlug = locRows[0].slug
  }
  const locationScoped = locationSlug !== null

  // ── 3. Candidate message refs: incremental via history, else full window
  let mode: 'full' | 'incremental' = account.last_history_id ? 'incremental' : 'full'
  let historyFallback = false
  let capHit = false
  let cursorTarget: string | null = null
  const refById = new Map<string, GmailMessageRef>()

  const runFullListing = async () => {
    // Capture the cursor target BEFORE listing so the next incremental
    // run replays anything that arrives mid-sync rather than skipping it.
    cursorTarget = String((await profile(mailbox)).historyId ?? '') || null
    let pageToken: string | undefined
    const query = `newer_than:${days}d -in:chats`
    for (;;) {
      const page = await listIds(mailbox, {
        query,
        maxResults: Math.min(LIST_PAGE_SIZE, maxMessages - refById.size),
        pageToken,
      })
      for (const r of page.messages) {
        if (refById.size >= maxMessages) break
        refById.set(r.id, r)
      }
      pageToken = page.nextPageToken
      if (refById.size >= maxMessages) {
        if (pageToken) capHit = true
        break
      }
      if (!pageToken) break
      if (outOfTime()) {
        capHit = true
        break
      }
    }
  }

  if (mode === 'incremental') {
    try {
      let pageToken: string | undefined
      for (;;) {
        const page = await history(mailbox, {
          startHistoryId: String(account.last_history_id),
          pageToken,
        })
        if (page.historyId) cursorTarget = String(page.historyId)
        for (const r of page.messagesAdded) {
          if (refById.size >= maxMessages) break
          refById.set(r.id, r)
        }
        pageToken = page.nextPageToken
        if (refById.size >= maxMessages && pageToken) {
          capHit = true
          break
        }
        if (!pageToken) break
        if (outOfTime()) {
          capHit = true
          break
        }
      }
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) {
        // Cursor too old to replay — fall back to a full window and say so.
        mode = 'full'
        historyFallback = true
        refById.clear()
        cursorTarget = null
        await runFullListing()
      } else {
        throw err
      }
    }
  } else {
    await runFullListing()
  }
  const refs = Array.from(refById.values())

  // ── 4. Metadata for every candidate (bodies come later, matched only)
  const metas: GmailMessageMetadata[] = []
  for (let i = 0; i < refs.length; i += FETCH_CONCURRENCY) {
    if (outOfTime()) {
      capHit = true
      break
    }
    const settled = await Promise.allSettled(
      refs.slice(i, i + FETCH_CONCURRENCY).map((r) => getMeta(mailbox, r.id))
    )
    for (const s of settled) {
      if (s.status === 'fulfilled') metas.push(s.value)
    }
  }

  // ── 5. External participants per message
  const perMessage: { meta: GmailMessageMetadata; addresses: string[] }[] = []
  const allAddresses = new Set<string>()
  const threadIds = new Set<string>()
  for (const m of metas) {
    if (m.threadId) threadIds.add(m.threadId)
    const addrs = new Set<string>()
    for (const key of ['from', 'to', 'cc']) {
      for (const a of parseAddresses(m.headers[key])) addrs.add(a)
    }
    addrs.delete(mailbox)
    perMessage.push({ meta: m, addresses: Array.from(addrs) })
    addrs.forEach((a) => allAddresses.add(a))
  }

  // ── 6. Lead matching IN POSTGRES — chunked ilikeAnyOf (escaped, so
  // exact case-insensitive equality), scoped by leads.location_uuid.
  const emailToLeads = new Map<string, { id: string; slug: string }[]>()
  const addressList = Array.from(allAddresses)
  for (const chunk of chunked(addressList, LEAD_QUERY_CHUNK)) {
    let q = supabase
      .from('leads')
      .select('id, email, location_id')
      .not('is_junk', 'is', true)
      .not('email', 'is', null)
      .neq('email', '')
      .ilikeAnyOf('email', chunk.map(escapeLike))
    if (locationScoped) q = q.eq('location_uuid', account.location_id)
    const { data: leadRows, error: leadErr } = await q
    if (leadErr) throwDb('leads match query', leadErr)
    for (const row of leadRows ?? []) {
      const em = String(row.email).trim().toLowerCase()
      if (!allAddresses.has(em)) continue
      const entry = { id: String(row.id), slug: String(row.location_id) }
      const list = emailToLeads.get(em)
      if (list) list.push(entry)
      else emailToLeads.set(em, [entry])
    }
  }

  // ── 7. Classify messages + group into threads
  let messagesWithExternalParticipants = 0
  let messagesMatchedExactlyOneLead = 0
  let messagesMatchedMultipleLeadsSameLocation = 0
  let messagesMatchedLeadsInMultipleLocations = 0
  let messagesUnmatched = 0
  const matchesByLocationSlug: Record<string, number> = {}
  const matchedAddresses = new Set<string>()
  // gmail_thread_id -> matched lead ids across the whole thread
  const threadLeadIds = new Map<string, Set<string>>()

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
    const acc = threadLeadIds.get(pm.meta.threadId) ?? new Set<string>()
    leadIds.forEach((id) => acc.add(id))
    threadLeadIds.set(pm.meta.threadId, acc)
  }

  // ── 8. The privacy boundary: only threads with >=1 matched message
  // proceed. Everything else is dropped here — no body fetch, no write.
  const qualifyingThreadIds = new Set(Array.from(threadLeadIds.keys()))
  const toIngest = perMessage.filter((pm) => qualifyingThreadIds.has(pm.meta.threadId))

  // ── 9. format=full for matched messages ONLY
  const fullById = new Map<string, any>()
  for (let i = 0; i < toIngest.length; i += FETCH_CONCURRENCY) {
    if (outOfTime()) {
      capHit = true
      break
    }
    const chunk = toIngest.slice(i, i + FETCH_CONCURRENCY)
    const settled = await Promise.allSettled(chunk.map((pm) => getFull(mailbox, pm.meta.id)))
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') fullById.set(chunk[j].meta.id, s.value)
    })
  }

  // ── 10. Build rows per qualifying thread from the full payloads we got
  interface PendingMessage {
    gmailId: string
    threadGmailId: string
    row: Record<string, any>
    attachments: AttachmentMeta[]
  }
  const pendingByThread = new Map<string, PendingMessage[]>()
  const threadSubject = new Map<string, string | null>()
  const threadLastMessageAt = new Map<string, string>()

  for (const pm of toIngest) {
    const full = fullById.get(pm.meta.id)
    if (!full) continue
    const headers = collapseHeaders(full.payload?.headers)
    const { email: fromEmail, name: fromName } = parseFromHeader(headers['from'])
    const { bodyText, bodyHtml, attachments } = extractParts(full.payload)
    const sentAtMs = Number(full.internalDate)
    const sentAt = Number.isFinite(sentAtMs) && sentAtMs > 0
      ? new Date(sentAtMs).toISOString()
      : new Date().toISOString()
    const gmailThreadId = pm.meta.threadId
    const row = {
      account_id: account.id,
      gmail_message_id: String(full.id ?? pm.meta.id),
      rfc822_message_id: headers['message-id'] || null,
      direction: fromEmail === mailbox ? 'out' : 'in',
      from_email: fromEmail,
      from_name: fromName,
      to_emails: parseAddresses(headers['to']),
      cc_emails: parseAddresses(headers['cc']),
      subject: headers['subject'] || null,
      snippet: full.snippet ? String(full.snippet) : null,
      body_text: bodyText,
      body_html: bodyHtml,
      sent_at: sentAt,
      has_attachments: attachments.length > 0,
    }
    const list = pendingByThread.get(gmailThreadId) ?? []
    list.push({ gmailId: row.gmail_message_id, threadGmailId: gmailThreadId, row, attachments })
    pendingByThread.set(gmailThreadId, list)
    if (!threadSubject.has(gmailThreadId) && row.subject) threadSubject.set(gmailThreadId, row.subject)
    const prev = threadLastMessageAt.get(gmailThreadId)
    if (!prev || sentAt > prev) threadLastMessageAt.set(gmailThreadId, sentAt)
  }

  const ingestThreadIds = Array.from(pendingByThread.keys())
  let threadsWritten = 0
  let messagesWritten = 0
  let attachmentsWritten = 0
  const nowIso = new Date().toISOString()

  if (ingestThreadIds.length > 0) {
    // ── 11. Threads: select existing, insert new. Existing lead_id is
    // PRESERVED (match_method 'manual' exists — a hand assignment must
    // survive a re-sync); we only fill lead fields that are still null.
    const existingByGmailId = new Map<string, { id: string; lead_id: string | null; last_message_at: string | null }>()
    for (const chunk of chunked(ingestThreadIds, WRITE_CHUNK)) {
      const { data: rows, error } = await supabase
        .from('email_threads')
        .select('id, gmail_thread_id, lead_id, last_message_at')
        .eq('account_id', account.id)
        .in('gmail_thread_id', chunk)
      if (error) throwDb('email_threads select', error)
      for (const r of rows ?? []) {
        existingByGmailId.set(String(r.gmail_thread_id), {
          id: String(r.id),
          lead_id: r.lead_id ?? null,
          last_message_at: r.last_message_at ?? null,
        })
      }
    }

    const computedLead = (gmailThreadId: string): string | null => {
      const ids = threadLeadIds.get(gmailThreadId)
      // AMBIGUITY IS NOT A GUESS: >1 lead => NULL => the unmatched tray.
      return ids && ids.size === 1 ? Array.from(ids)[0] : null
    }

    const newThreadRows = ingestThreadIds
      .filter((t) => !existingByGmailId.has(t))
      .map((t) => {
        const lead = computedLead(t)
        return {
          account_id: account.id,
          gmail_thread_id: t,
          lead_id: lead,
          match_method: lead ? 'email' : null,
          matched_at: lead ? nowIso : null,
          subject: threadSubject.get(t) ?? null,
          last_message_at: threadLastMessageAt.get(t) ?? null,
        }
      })
    const threadUuidByGmailId = new Map<string, string>()
    existingByGmailId.forEach((v, k) => threadUuidByGmailId.set(k, v.id))
    for (const chunk of chunked(newThreadRows, WRITE_CHUNK)) {
      if (chunk.length === 0) continue
      const { data: inserted, error } = await supabase
        .from('email_threads')
        .insert(chunk)
        .select('id, gmail_thread_id')
      if (error) throwDb('email_threads insert', error)
      for (const r of inserted ?? []) threadUuidByGmailId.set(String(r.gmail_thread_id), String(r.id))
    }

    // ── 12. Messages: upsert on the verified (account_id, gmail_message_id)
    const allPending: PendingMessage[] = []
    pendingByThread.forEach((list) => allPending.push(...list))
    const messageUuidByGmailId = new Map<string, string>()
    for (const chunk of chunked(allPending, WRITE_CHUNK)) {
      const rows = chunk.map((p) => ({
        ...p.row,
        thread_id: threadUuidByGmailId.get(p.threadGmailId),
      }))
      const { data: upserted, error } = await supabase
        .from('email_messages')
        .upsert(rows, { onConflict: 'account_id,gmail_message_id' })
        .select('id, gmail_message_id')
      if (error) throwDb('email_messages upsert', error)
      for (const r of upserted ?? []) messageUuidByGmailId.set(String(r.gmail_message_id), String(r.id))
      messagesWritten += chunk.length
    }

    // ── 13. Attachment metadata (no bytes). No composite unique index on
    // email_attachments, so idempotency = select what exists, insert the rest.
    const withAttachments = allPending.filter((p) => p.attachments.length > 0)
    if (withAttachments.length > 0) {
      const msgUuids = withAttachments
        .map((p) => messageUuidByGmailId.get(p.gmailId))
        .filter(Boolean) as string[]
      const existingAtt = new Set<string>()
      for (const chunk of chunked(msgUuids, WRITE_CHUNK)) {
        const { data: rows, error } = await supabase
          .from('email_attachments')
          .select('message_id, gmail_attachment_id')
          .in('message_id', chunk)
        if (error) throwDb('email_attachments select', error)
        for (const r of rows ?? []) existingAtt.add(`${r.message_id}:${r.gmail_attachment_id}`)
      }
      const attRows: Record<string, any>[] = []
      for (const p of withAttachments) {
        const msgUuid = messageUuidByGmailId.get(p.gmailId)
        if (!msgUuid) continue
        for (const a of p.attachments) {
          if (existingAtt.has(`${msgUuid}:${a.gmail_attachment_id}`)) continue
          attRows.push({
            message_id: msgUuid,
            gmail_attachment_id: a.gmail_attachment_id,
            filename: a.filename,
            mime_type: a.mime_type,
            size_bytes: a.size_bytes,
          })
        }
      }
      for (const chunk of chunked(attRows, WRITE_CHUNK)) {
        if (chunk.length === 0) continue
        const { error } = await supabase.from('email_attachments').insert(chunk)
        if (error) throwDb('email_attachments insert', error)
        attachmentsWritten += chunk.length
      }
    }

    // ── 14. Thread rollups (message_count via head:true — PostgREST
    // aggregates are disabled in this project; head-count is the one
    // allowed form), plus null-only lead fill for existing threads.
    for (const gmailThreadId of ingestThreadIds) {
      const uuid = threadUuidByGmailId.get(gmailThreadId)
      if (!uuid) continue
      const { count, error: cntErr } = await supabase
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .eq('thread_id', uuid)
      if (cntErr) throwDb('email_messages count', cntErr)
      const patch: Record<string, any> = {
        message_count: count ?? 0,
        updated_at: nowIso,
      }
      const existing = existingByGmailId.get(gmailThreadId)
      if (existing) {
        const newLast = threadLastMessageAt.get(gmailThreadId)
        if (newLast && (!existing.last_message_at || newLast > existing.last_message_at)) {
          patch.last_message_at = newLast
        }
        const lead = computedLead(gmailThreadId)
        if (!existing.lead_id && lead) {
          patch.lead_id = lead
          patch.match_method = 'email'
          patch.matched_at = nowIso
        }
      }
      const { error: updErr } = await supabase.from('email_threads').update(patch).eq('id', uuid)
      if (updErr) throwDb('email_threads update', updErr)
      threadsWritten++
    }
  }

  // ── 15. Cursor: only a COMPLETE run may advance it.
  let cursorAdvancedTo: string | null = null
  if (!capHit && cursorTarget) {
    const { error } = await supabase
      .from('email_accounts')
      .update({ last_history_id: cursorTarget, last_synced_at: nowIso, updated_at: nowIso })
      .eq('id', account.id)
    if (error) throwDb('email_accounts cursor update', error)
    cursorAdvancedTo = cursorTarget
  }

  return {
    ran: true,
    mailbox,
    locationSlug,
    locationScoped,
    mode,
    historyFallback,
    daysScanned: mode === 'full' ? days : null,
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
    threadsWritten,
    messagesWritten,
    attachmentsWritten,
    cursorAdvancedTo,
    elapsedMs: Date.now() - start,
  }
}
