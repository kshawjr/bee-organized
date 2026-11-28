// FL-75 slice 7: people who are only in a location's Mailchimp audience come
// into Bee Hub as Nurturing records, dated from when they joined Mailchimp.
//
// KEVIN'S RULES (2026-11-26)
//   • Match on email or phone. A phone-only match (same phone, different
//     email) is HELD for the owner to answer. Never a second record unless
//     the owner says they are different people.
//   • (2026-11-27) ONLY phone is a reason to stop and ask. A name match, a
//     match at another Bee Organized location, and two Mailchimp entries
//     sharing a name come in as ordinary new people. Kevin chose a handful of
//     duplicates over hundreds of judgment calls across 54 locations (at
//     Chattanooga, four people will arrive twice under different emails).
//   • Skipped, and counted with the reason: cleaned contacts; anyone whose
//     only match is in the Recycle Bin BY EMAIL OR PHONE (never by name —
//     Kevin, 2026-11-27: a name is too weak to ask about, so it is far too
//     weak to drop someone without a word); staff or test addresses
//     (@beeorganized.com, or any email on a Bee Hub user account).
//   • Unsubscribed in Mailchimp: the no-marketing list FIRST (through
//     marketing_unsubscribe_from_mailchimp), then the record, with
//     marketing_unsubscribed_at left EMPTY. That column set on insert makes
//     the database write a false "pressed Unsubscribe in a Bee Hub email" row.
//   • New records: stage Nurturing, import_source 'mailchimp_import',
//     created_at = the Mailchimp join date.
//   • No side effects. This file writes four things only: one leads row per
//     new person, (for an unsubscribed person) one no-marketing-list row, the
//     person's tag links, and at most one note on them.
//     It never calls anything that emails, enrols, posts or sends to Jobber;
//     lib/mailchimp-pull.test.ts reads this file and fails if it names one.
//   • Never into Other.
//   • TAGS (Kevin's ruling, 2026-11-27). A Mailchimp tag is attached only if
//     the location already has a switched-on tag with exactly that name
//     (corporate, or the location's own). No tag is ever created: each
//     location has only 15 of its own and Mailchimp would eat them. The names
//     with no match go into one note on the person, so nothing is lost.
//     "Profile Quiz", in any capitals, is NEVER attached as a tag, even if
//     Bee Hub has one: it is what signs a person up to the quiz journey, so
//     attaching it would sign up someone who never asked. (Kevin, 2026-11-27)
//     It IS written into the note, in plain words, because taking the quiz
//     is how that person joined the list: the note is the only record of it.
//     A note is text on the person's page and never reaches Mailchimp.
//     "CLOSEDJOB", in any capitals, is ignored completely (Kevin, option A):
//     no tag, no note, not counted anywhere.
//     Names are matched at the moment of import (the tag list is read fresh
//     each time).
//
// MY CALLS, flagged to Kevin
//   • Two Mailchimp people who would be created with the same phone are both
//     held (they may be one person with two addresses). Sharing a name alone
//     no longer holds anyone (Kevin, 2026-11-27).
//   • Only subscribed and unsubscribed people come in. Pending (never
//     confirmed), transactional and archived are skipped and counted.
//   • No first and last name in Mailchimp → the record is saved with the
//     name empty (nothing invented). Names are never used to match.
//
// Reading follows the slice 4 read gate (connected + audience + lifecycle
// 'active'); the send switch is not consulted. The whole audience must be read
// or nothing is planned.

import { supabaseService } from './supabase-service'
import { readAudience, readRefusal, scrub, type MailchimpMember as AudienceMember } from './mailchimp-audience-look'
import { emailKey, matchPhoneKey } from './mailchimp-rules'
import { recordSaidNo } from './mailchimp-refusals'
import { phoneForWrite } from './phone'
import { TAG_CATEGORIES } from './tags'

// The audience reader is pinned byte for byte, so names are taken from the
// same pages it reads (its merge_fields), through the fetch it is given.
export type MailchimpMember = AudienceMember & { firstName?: string | null; lastName?: string | null }

export function nameCatcher(inner?: any): { fetchImpl: any; names: Map<string, { first: string | null; last: string | null }> } {
  const names = new Map<string, { first: string | null; last: string | null }>()
  const base = inner || ((url: string, init: any) => fetch(url, init))
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const fetchImpl = async (url: string, init: any) => {
    const res = await base(url, init)
    const body = await res.text()
    try {
      const j = JSON.parse(body)
      for (const m of Array.isArray(j?.members) ? j.members : []) {
        if (m?.id) names.set(String(m.id), { first: text(m?.merge_fields?.FNAME), last: text(m?.merge_fields?.LNAME) })
      }
    } catch { /* not JSON: the reader reports it */ }
    return { status: res.status, headers: res.headers, text: async () => body }
  }
  return { fetchImpl, names }
}

export const PULL_IMPORT_SOURCE = 'mailchimp_import'
export const PULL_SOURCE_LABEL = 'Mailchimp'
export const STAFF_DOMAIN = 'beeorganized.com'
const OTHER_CODE = 'loc_other'

export type PullLead = {
  id: string
  name?: string | null
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  is_junk?: boolean | null
}

export type SkipReason = 'no_email' | 'cleaned' | 'other_status' | 'staff' | 'recycle_bin_only' | 'no_join_date'
export type HoldReason = 'phone_match' | 'duplicate_in_mailchimp'

export type PullDecision =
  | { kind: 'create'; member: MailchimpMember; unsubscribed: boolean }
  | { kind: 'already'; member: MailchimpMember; ids: string[] }
  | { kind: 'held'; reason: HoldReason; member: MailchimpMember; ids: string[] }
  | { kind: 'skipped'; reason: SkipReason; member: MailchimpMember; ids: string[] }

export type PullPlan = {
  decisions: PullDecision[]
  counts: {
    read: number
    create: number
    createUnsubscribed: number
    already: number
    held: Record<HoldReason, number>
    skipped: Record<SkipReason, number>
  }
}

// ── Name key ────────────────────────────────────────────────
// First + last, letters only, lower case. Both must be present, or there is
// no key and no name comparison is made.
const letters = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '')
export function nameKey(first: unknown, last: unknown): string | null {
  const f = letters(first), l = letters(last)
  return f && l ? `${f}|${l}` : null
}
export function leadNameKey(lead: PullLead): string | null {
  const direct = nameKey(lead.first_name, lead.last_name)
  if (direct) return direct
  const parts = String(lead.name ?? '').trim().split(/\s+/).filter(Boolean)
  return parts.length >= 2 ? nameKey(parts[0], parts[parts.length - 1]) : null
}

// The same mailbox: "kshawjr+x@gmail.com" is "kshawjr@gmail.com" (Kevin,
// 2026-11-26). Only the plus part is dropped.
export function mailboxKey(key: string | null): string | null {
  if (!key) return null
  const at = key.lastIndexOf('@')
  if (at < 1) return key
  const local = key.slice(0, at).replace(/\+.*$/, '')
  return (local || key.slice(0, at)) + key.slice(at)
}

export function isStaffAddress(key: string | null, staffKeys: ReadonlySet<string>): boolean {
  if (!key) return false
  if (staffKeys.has(mailboxKey(key) as string)) return true
  const domain = key.slice(key.lastIndexOf('@') + 1)
  return domain === STAFF_DOMAIN || domain.endsWith('.' + STAFF_DOMAIN)
}

// Email and phone only, live or in the Recycle Bin. Never a name.
type Index = { email: Map<string, string[]>; phone: Map<string, string[]> }
function indexOf(leads: readonly PullLead[]): Index {
  const ix: Index = { email: new Map(), phone: new Map() }
  const add = (m: Map<string, string[]>, k: string | null, id: string) => {
    if (!k) return
    const list = m.get(k); if (!list) m.set(k, [id]); else if (!list.includes(id)) list.push(id)
  }
  for (const l of leads) {
    add(ix.email, emailKey(l.email), l.id)
    add(ix.phone, matchPhoneKey(l.phone), l.id)
  }
  return ix
}
const hit = (m: Map<string, string[]>, k: string | null) => (k ? m.get(k) || [] : [])

// ── The plan (pure) ─────────────────────────────────────────
// leadsHere: EVERY record at this location, Recycle Bin included (is_junk
// tells them apart; archived counts as live). staffKeys: mailboxKey() of
// every Bee Hub user account. Other locations are not looked at (2026-11-27).
export function planPull(args: {
  members: readonly MailchimpMember[]
  leadsHere: readonly PullLead[]
  staffKeys: ReadonlySet<string>
}): PullPlan {
  const live = indexOf(args.leadsHere.filter((l) => l.is_junk !== true))
  const bin = indexOf(args.leadsHere.filter((l) => l.is_junk === true))
  const decisions: PullDecision[] = []

  for (const m of args.members) {
    const e = m.emailKey || emailKey(m.email)
    const p = matchPhoneKey(m.phone)
    const skip = (reason: SkipReason, ids: string[] = []) => decisions.push({ kind: 'skipped', reason, member: m, ids })
    const hold = (reason: HoldReason, ids: string[]) => decisions.push({ kind: 'held', reason, member: m, ids })

    if (!e) { skip('no_email'); continue }
    if (m.status === 'cleaned') { skip('cleaned'); continue }
    if (m.status !== 'subscribed' && m.status !== 'unsubscribed') { skip('other_status'); continue }
    if (isStaffAddress(e, args.staffKeys)) { skip('staff'); continue }

    const byEmail = hit(live.email, e)
    if (byEmail.length) { decisions.push({ kind: 'already', member: m, ids: byEmail }); continue }
    const byPhone = hit(live.phone, p)

    if (!byPhone.length) {
      const inBin = [...hit(bin.email, e), ...hit(bin.phone, p)]
      if (inBin.length) { skip('recycle_bin_only', Array.from(new Set(inBin))); continue }
    }

    // Checked before the hold: a held person the owner answers "Different
    // people" comes in as a create, so they must pass every create rule.
    if (!m.joinedAt || !Number.isFinite(Date.parse(m.joinedAt))) { skip('no_join_date'); continue }
    if (byPhone.length) { hold('phone_match', byPhone); continue }
    decisions.push({ kind: 'create', member: m, unsubscribed: m.status === 'unsubscribed' })
  }

  // Two would-be records sharing a phone: hold every one of them.
  const creates = decisions.filter((d): d is Extract<PullDecision, { kind: 'create' }> => d.kind === 'create')
  const groups = new Map<string, number[]>()
  creates.forEach((d) => {
    const i = decisions.indexOf(d)
    for (const k of [matchPhoneKey(d.member.phone) && 'p:' + matchPhoneKey(d.member.phone)]) {
      if (!k) continue
      const g = groups.get(k); if (g) g.push(i); else groups.set(k, [i])
    }
  })
  const dupIdx = new Set<number>()
  groups.forEach((g) => { if (g.length > 1) g.forEach((i) => dupIdx.add(i)) })
  dupIdx.forEach((i) => {
    const d = decisions[i]
    const pk = matchPhoneKey(d.member.phone)
    const others = Array.from(dupIdx).filter((j) => j !== i && matchPhoneKey(decisions[j].member.phone) === pk).map((j) => decisions[j].member.id)
    decisions[i] = { kind: 'held', reason: 'duplicate_in_mailchimp', member: d.member, ids: others }
  })

  const counts: PullPlan['counts'] = {
    read: args.members.length, create: 0, createUnsubscribed: 0, already: 0,
    held: { phone_match: 0, duplicate_in_mailchimp: 0 },
    skipped: { no_email: 0, cleaned: 0, other_status: 0, staff: 0, recycle_bin_only: 0, no_join_date: 0 },
  }
  for (const d of decisions) {
    if (d.kind === 'create') { counts.create++; if (d.unsubscribed) counts.createUnsubscribed++ }
    else if (d.kind === 'already') counts.already++
    else if (d.kind === 'held') counts.held[d.reason]++
    else counts.skipped[d.reason]++
  }
  return { decisions, counts }
}

// ── Tags (pure) ─────────────────────────────────────────────
// A tag Bee Hub has, as read from lookups: switched on, and corporate
// (location_id null) or this location's own.
export type TagDef = { id: string; label: string; location_id: string | null }

// Compared in any capitals, however it is spaced.
const tagKey = (name: unknown) => String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
// Never attached as a Bee Hub tag, by any route. (The quiz is written into
// the note instead, in plain words: see QUIZ_NOTE.)
export const NEVER_COPY_TAGS = ['profile quiz'] as const
export function isNeverCopied(name: unknown): boolean {
  return (NEVER_COPY_TAGS as readonly string[]).includes(tagKey(name))
}
export const isQuizTag = isNeverCopied
// Ignored completely: no tag, no note, no count (Kevin, option A).
export const IGNORED_TAGS = ['closedjob'] as const
export function isIgnoredTag(name: unknown): boolean {
  return (IGNORED_TAGS as readonly string[]).includes(tagKey(name))
}

// What happens to one person's Mailchimp tags. attach: the Bee Hub tags with
// exactly the same name (a corporate tag wins over the location's own of the
// same name). noted: the names Bee Hub has no tag for, in Mailchimp's order.
// quiz: they carry "Profile Quiz" (never attached; said in the note).
// Nothing here ever makes a tag.
export function tagsFor(mailchimpTags: readonly unknown[] | null | undefined, defs: readonly TagDef[]): { attach: TagDef[]; noted: string[]; quiz: boolean } {
  const byName = new Map<string, TagDef>()
  for (const d of defs) {
    const k = String(d.label ?? '').trim()
    if (!k) continue
    const had = byName.get(k)
    if (!had || (had.location_id && !d.location_id)) byName.set(k, d)
  }
  const attach: TagDef[] = [], noted: string[] = []
  let quiz = false
  for (const raw of mailchimpTags || []) {
    const name = String(raw ?? '').trim()
    if (!name || isIgnoredTag(name)) continue
    if (isQuizTag(name)) { quiz = true; continue }
    const def = byName.get(name)
    if (def) { if (!attach.some((a) => a.id === def.id)) attach.push(def) }
    else if (!noted.includes(name)) noted.push(name)
  }
  return { attach, noted, quiz }
}

export const TAG_NOTE_LABEL = 'Mailchimp'
export const QUIZ_NOTE = 'Joined your mailing list by taking the quiz on your website.'
export function tagNoteText(noted: readonly string[], quiz = false): string | null {
  const lines: string[] = []
  if (quiz) lines.push(QUIZ_NOTE)
  if (noted.length) lines.push(leftoverWords(noted))
  return lines.length ? lines.join(' ') : null
}
function leftoverWords(noted: readonly string[]): string {
  return `Tags from Mailchimp: ${noted.join(', ')}. Bee Hub has no tag with ${noted.length === 1 ? 'this name' : 'these names'}, so ${noted.length === 1 ? 'it is' : 'they are'} kept here.`
}

// ── The new record ──────────────────────────────────────────
export type PullLocation = { id: string; name: string; location_id: string; audienceId: string }

export function isOther(loc: { name?: string | null; location_id?: string | null }): boolean {
  return loc.location_id === OTHER_CODE || String(loc.name ?? '').trim().toLowerCase() === 'other'
}

export function newLeadRow(member: MailchimpMember, loc: PullLocation, runId: string, unsubscribed: boolean): Record<string, unknown> {
  const first = member.firstName || null, last = member.lastName || null
  const phone = phoneForWrite(member.phone)
  const row: Record<string, unknown> = {
    location_id: loc.location_id,
    location_uuid: loc.id,
    name: [first, last].filter(Boolean).join(' ') || null,
    first_name: first,
    last_name: last,
    email: member.email.trim(),
    phone: phone.value,
    stage: 'Nurturing',
    import_source: PULL_IMPORT_SOURCE,
    source: PULL_SOURCE_LABEL,
    created_at: member.joinedAt,
    metadata: { mailchimp_import: { run_id: runId, member_id: member.id, audience_id: loc.audienceId, joined_at: member.joinedAt, status: member.status } },
  }
  if (phone.note) row.notes = `Phone as written in Mailchimp: ${phone.note}`
  // Never set marketing_unsubscribed_at here (see the rules above). The
  // no-marketing list is already written, so the database's own guard keeps
  // this true and records nothing new.
  if (unsubscribed) row.marketing_opt_out = true
  return row
}

// ── Reading everything (read only) ──────────────────────────
type LoadOk = { ok: true; location: PullLocation; plan: PullPlan; audienceTotal: number; tags: TagDef[] }
type LoadFail = { ok: false; reason: string; detail?: string }

async function readAll(db: any, build: (q: any) => any, cols: string): Promise<{ rows: any[] } | { error: string }> {
  const rows: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(db.from('leads').select(cols)).order('id').range(from, from + 999)
    if (error) return { error: error.message || String(error) }
    rows.push(...(data || [])); if (!data || data.length < 1000) break
  }
  return { rows }
}

export async function loadPull(locationUuid: string, deps: { db?: any; fetchImpl?: any } = {}): Promise<LoadOk | LoadFail> {
  const db = deps.db || supabaseService
  const { data: loc, error: locErr } = await db.from('locations')
    .select('id, name, location_id, lifecycle_status, mailchimp_connected, mailchimp_list_id, mailchimp_access_token, mailchimp_server_prefix')
    .eq('id', locationUuid).maybeSingle()
  if (locErr || !loc) return { ok: false, reason: 'location_unreadable', detail: locErr?.message }
  if (isOther(loc)) return { ok: false, reason: 'other_location_refused' }
  const refused = readRefusal(loc)
  if (refused) return { ok: false, reason: refused }
  if (!loc.mailchimp_access_token || !loc.mailchimp_server_prefix) return { ok: false, reason: 'not_connected' }

  // Staff addresses: fail closed if the user accounts can't be read.
  const { data: users, error: uErr } = await db.from('hub_users').select('email')
  if (uErr || !Array.isArray(users)) return { ok: false, reason: 'staff_list_unreadable', detail: uErr?.message }
  const staffKeys = new Set<string>()
  for (const u of users) { const k = mailboxKey(emailKey(u?.email)); if (k) staffKeys.add(k) }

  const cols = 'id, name, first_name, last_name, email, phone, is_junk'
  const here = await readAll(db, (q) => q.eq('location_uuid', loc.id), cols)
  if ('error' in here) return { ok: false, reason: 'records_unreadable', detail: here.error }

  // The tags this location has, read fresh: matching is at the moment of
  // import. Fail closed — a tag list that can't be read imports nobody.
  const { data: tagRows, error: tagErr } = await db.from('lookups').select('id, label, location_id, is_active')
    .in('category', TAG_CATEGORIES).eq('is_active', true).or(`location_id.is.null,location_id.eq.${loc.id}`)
  if (tagErr || !Array.isArray(tagRows)) return { ok: false, reason: 'tags_unreadable', detail: tagErr?.message }
  const tags: TagDef[] = tagRows
    .filter((t: any) => t && t.is_active === true && (t.location_id == null || t.location_id === loc.id))
    .map((t: any) => ({ id: t.id, label: String(t.label || ''), location_id: t.location_id ?? null }))

  const catcher = nameCatcher(deps.fetchImpl)
  const read = await readAudience({ token: loc.mailchimp_access_token, serverPrefix: loc.mailchimp_server_prefix, listId: loc.mailchimp_list_id, fetchImpl: catcher.fetchImpl })
  if (!read.ok) return { ok: false, reason: 'audience_unreadable', detail: `${read.reason}: ${scrub(read.detail, loc.mailchimp_access_token)}` }
  if (!read.complete) return { ok: false, reason: 'audience_incomplete', detail: scrub(read.stopped?.detail, loc.mailchimp_access_token) }

  const members: MailchimpMember[] = read.members.map((m) => {
    const n = catcher.names.get(m.id)
    return { ...m, firstName: n?.first ?? null, lastName: n?.last ?? null }
  })
  const plan = planPull({ members, leadsHere: here.rows, staffKeys })
  return { ok: true, location: { id: loc.id, name: loc.name, location_id: loc.location_id, audienceId: loc.mailchimp_list_id }, plan, audienceTotal: read.totalReported, tags }
}

// ── Writing (the real run) ──────────────────────────────────
export type ApplyResult = {
  memberId: string
  email: string
  outcome: 'created' | 'created_unsubscribed' | 'already_there' | 'no_list_write_failed' | 'insert_failed'
  leadId?: string
  detail?: string
  // Tags, for a person created here: the Bee Hub tags attached, the names
  // kept in the note, and whether either write failed (the person is still in).
  tagsAttached?: string[]
  tagsNoted?: string[]
  joinedByQuiz?: boolean
  tagsFailed?: boolean
}

// deps.tags: the location's tags, read by loadPull for THIS import. deps.by:
// the Bee Hub user who confirmed (recorded on each tag link).
export async function applyPull(plan: PullPlan, location: PullLocation, deps: { db?: any; runId: string; tags?: readonly TagDef[]; by?: string | null }): Promise<ApplyResult[]> {
  const db = deps.db || supabaseService
  if (isOther(location)) throw new Error('Refused: never import into Other.')
  const out: ApplyResult[] = []
  for (const d of plan.decisions) {
    if (d.kind !== 'create') continue
    const m = d.member
    const base = { memberId: m.id, email: m.email }
    // Someone may have been added since the plan was read: look once more.
    const { data: exists, error: exErr } = await db.from('leads').select('id')
      .eq('location_uuid', location.id).ilike('email', m.email.trim().replace(/[\\%_]/g, (c: string) => '\\' + c)).limit(1)
    if (exErr) { out.push({ ...base, outcome: 'insert_failed', detail: `re-check failed: ${exErr.message}` }); continue }
    if (exists && exists.length) { out.push({ ...base, outcome: 'already_there', leadId: exists[0].id }); continue }

    if (d.unsubscribed) {
      const listed = await recordSaidNo(location.id, location.audienceId, m.email, 'unsubscribed in Mailchimp (found by the slice 7 import)', { db })
      // Not on the list → no record. A record without it would be mailable.
      if (!listed) { out.push({ ...base, outcome: 'no_list_write_failed' }); continue }
    }
    const { data: ins, error: insErr } = await db.from('leads').insert(newLeadRow(m, location, deps.runId, d.unsubscribed)).select('id').single()
    if (insErr || !ins) { out.push({ ...base, outcome: 'insert_failed', detail: insErr?.message }); continue }
    const t = tagsFor(m.tags, deps.tags || [])
    let tagsFailed = false
    if (t.attach.length) {
      const { error } = await db.from('lead_tags').upsert(
        t.attach.map((def) => ({ lead_id: ins.id, tag_lookup_id: def.id, added_by: deps.by || null })),
        { onConflict: 'lead_id,tag_lookup_id', ignoreDuplicates: true })
      if (error) tagsFailed = true
    }
    const note = tagNoteText(t.noted, t.quiz)
    if (note) {
      const { error } = await db.from('lead_notes').insert({ lead_id: ins.id, location_uuid: location.id, kind: 'buzz', text: note, user_id: null, user_label: TAG_NOTE_LABEL })
      if (error) tagsFailed = true
    }
    out.push({
      ...base, outcome: d.unsubscribed ? 'created_unsubscribed' : 'created', leadId: ins.id,
      tagsAttached: t.attach.map((a) => a.label), tagsNoted: t.noted, ...(t.quiz ? { joinedByQuiz: true } : {}), ...(tagsFailed ? { tagsFailed: true } : {}),
    })
  }
  return out
}
