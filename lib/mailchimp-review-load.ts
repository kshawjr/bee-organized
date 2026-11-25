// lib/mailchimp-review-load.ts
//
// MAILCHIMP SLICE 5 (FL-75, 2026-11-24): gathers what the "Who goes to
// Mailchimp" screen needs, for ONE location, and hands it to buildReview
// (lib/mailchimp-review.ts).
//
// READ ONLY. Bee Hub is read with select; Mailchimp is read with the slice 4
// reader (readAudience — GET only). Nothing is written anywhere and nothing is
// sent. The owner's saved choices are WRITTEN by a different file
// (lib/mailchimp-review-choices.ts), so this one can be pinned as read-only.
//
// THE SAME READ RULE AS SLICE 4 (Kevin, 2026-11-23): connected, an audience
// chosen, lifecycle 'active'. Nothing else — the sending switch is not read.
//
// IF MAILCHIMP CANNOT BE READ IN FULL, the screen still works, but says so:
// with members = null, nobody is counted as "already in your Mailchimp", the
// big number reads "ticked to go to", and a line says why. A half-read is
// never shown as the whole picture.
//
// The access token is held only inside this function and scrubbed from every
// message (scrub from slice 4). It is never returned.

import { supabaseService } from './supabase-service'
import { readRefusal, REFUSAL_WORDS, readAudience, scrub, AUDIENCE_FAILURE_WORDS, PARTIAL_WORDS, type LocationFlags, type ReadRefusal, type MailchimpMember } from './mailchimp-audience-look'
import { loadSaidNoSet } from './marketing-no-list'
import { resolveTimezone } from './drip-time'
import { buildReview, type ReviewLead, type ReviewModel, type StoredChoice } from './mailchimp-review'
import { emailKey } from './mailchimp-rules'

type FetchLike = (url: string, init: any) => Promise<any>

export type ReviewLoad =
  | { ok: false; reason: ReadRefusal | 'location_not_found' | 'beehub_read_failed'; words: string }
  | {
      ok: true
      location: { id: string; name: string | null; audienceName: string | null; timeZone: string }
      mailchimpWords: string | null    // why Mailchimp could not be read in full; null when it was
      choicesReady: boolean            // false until migrations/mailchimp_review_choices.sql is run
      model: ReviewModel
      // Only with deps.withLeadIds (slice 6, the sending code): every Bee Hub
      // record id at this location, by email address. Never sent to a browser.
      leadIdsByKey?: Record<string, string[]>
    }

const PAGE = 1000

async function pagedSelect(db: any, table: string, cols: string, col: string, value: string, extra?: (q: any) => any): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select(cols).eq(col, value)
    if (extra) q = extra(q)
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

export async function loadReview(locationId: string, deps: {
  db?: any
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  loadSuppressed?: (emails: readonly unknown[]) => Promise<Set<string>>
  withLeadIds?: boolean
} = {}): Promise<ReviewLoad> {
  const db = deps.db || supabaseService

  // 1. The flags — without the token.
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, name, location_id, timezone, lifecycle_status, mailchimp_connected, mailchimp_list_id, mailchimp_list_name')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr || !loc) return { ok: false, reason: 'location_not_found', words: REFUSAL_WORDS.location_not_found }
  const refusal = readRefusal(loc as LocationFlags)
  if (refusal) return { ok: false, reason: refusal, words: REFUSAL_WORDS[refusal] }
  const timeZone = resolveTimezone((loc as any).timezone)

  // 2. Mailchimp, GET only. A failure or a half-read leaves members = null.
  let members: MailchimpMember[] | null = null
  let mailchimpWords: string | null = null
  const { data: cred } = await db
    .from('locations')
    .select('mailchimp_access_token, mailchimp_server_prefix')
    .eq('id', locationId)
    .maybeSingle()
  const token = (cred as any)?.mailchimp_access_token as string | undefined
  const prefix = (cred as any)?.mailchimp_server_prefix as string | undefined
  if (!token || !prefix) {
    mailchimpWords = REFUSAL_WORDS.not_connected
  } else {
    const read = await readAudience({ token, serverPrefix: prefix, listId: (loc as any).mailchimp_list_id, fetchImpl: deps.fetchImpl, sleep: deps.sleep })
    if (!read.ok) mailchimpWords = AUDIENCE_FAILURE_WORDS[read.reason]
    else if (!read.complete) mailchimpWords = PARTIAL_WORDS
    else members = read.members
  }

  // 3. Bee Hub, select only.
  let leads: ReviewLead[]
  const contacted = new Set<string>()
  let suppressed: Set<string>
  let choices: StoredChoice[] = []
  let choicesReady = true
  try {
    leads = await pagedSelect(db, 'leads',
      'id, email, phone, first_name, last_name, name, created_at, is_junk, marketing_opt_out, marketing_unsubscribed_at, archived_at',
      'location_uuid', locationId)
    const code = (loc as any).location_id as string | null
    // "Contact" = a job, quote, request or card, or a touchpoint a person made.
    if (code) {
      for (const t of ['jobs', 'quotes', 'service_requests']) {
        for (const r of await pagedSelect(db, t, 'id, lead_id', 'location_id', code)) if (r.lead_id) contacted.add(r.lead_id)
      }
    }
    for (const r of await pagedSelect(db, 'engagements', 'id, client_id', 'location_uuid', locationId)) if (r.client_id) contacted.add(r.client_id)
    for (const r of await pagedSelect(db, 'touchpoints', 'id, lead_id, kind', 'location_uuid', locationId)) if (r.lead_id && r.kind !== 'system') contacted.add(r.lead_id)
    suppressed = await (deps.loadSuppressed || loadSaidNoSet)(leads.map((l) => l.email))
    const ch = await db.from('mailchimp_review_choices').select('scope, key, choice').eq('location_id', locationId)
    if (ch.error) {
      // 42P01 = the table does not exist yet: the migration has not been run.
      if (ch.error.code === '42P01' || /does not exist|schema cache/i.test(ch.error.message || '')) choicesReady = false
      else throw new Error(`mailchimp_review_choices: ${ch.error.message}`)
    } else choices = (ch.data || []) as StoredChoice[]
  } catch (err: any) {
    return { ok: false, reason: 'beehub_read_failed', words: 'Bee Hub’s own records could not be read, so nothing is shown. ' + scrub(err?.message || err, token || '') }
  }

  let leadIdsByKey: Record<string, string[]> | undefined
  if (deps.withLeadIds) {
    leadIdsByKey = {}
    for (const l of leads) { const k = emailKey(l.email); if (k) (leadIdsByKey[k] ||= []).push(l.id) }
  }

  return {
    ok: true,
    location: { id: locationId, name: (loc as any).name ?? null, audienceName: (loc as any).mailchimp_list_name ?? null, timeZone },
    mailchimpWords: mailchimpWords ? scrub(mailchimpWords, token || '') : null,
    choicesReady,
    model: buildReview({ leads, contacted, suppressed, members, choices, timeZone }),
    ...(leadIdsByKey ? { leadIdsByKey } : {}),
  }
}
