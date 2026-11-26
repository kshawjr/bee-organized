// lib/mailchimp-refusals.ts
//
// FL-75 slice 6 (2026-11-26): who Mailchimp refused, remembered by ADDRESS, so
// a refused person is never silently sent again on every sync.
// Table: migrations/mailchimp_refusals.sql (Kevin runs it).
//
// Kevin's rulings:
//   • A "no" — permanently deleted ("asked Mailchimp to forget them"),
//     unsubscribed, bounced (cleaned), a compliance block — is a person saying
//     no. It goes on the EXISTING no-marketing list (source 'mailchimp', through
//     marketing_unsubscribe_from_mailchimp), never here, and has no Try again.
//   • Only an invalid address, or a refusal that may be temporary, is kept
//     here, with Edit address, Try again and Leave out on the Mailchimp screen.
//
// THE RETRY RULE
//   invalid    held at once: not sent again until the address is edited (a new
//              address has no row) or the owner presses Try again, which sends
//              it once on the next sync.
//   temporary  sent again on the next sync; held after HOLD_AFTER refusals.
//   Added later → the row is removed.
//
// TOLERANT BEFORE THE MIGRATION: if the table can't be read, nothing is held
// and nothing is recorded here (the sync behaves as before) — never a guess
// that someone was refused.

import { supabaseService } from './supabase-service'

const likeExact = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

export type RefusalKind = 'already' | 'said_no' | 'invalid' | 'temporary'
export const HOLD_AFTER = 3

// Mailchimp's own words decide the kind. Anything not recognised is treated as
// possibly temporary: tried again, and held after HOLD_AFTER refusals.
export function classifyRefusal(code: unknown, said: unknown): RefusalKind {
  if (code === 'ERROR_CONTACT_EXISTS') return 'already'
  const t = String(said ?? '').toLowerCase()
  if (/permanently deleted|cannot be re-?imported|compliance state|compliance review|unsubscribed|was cleaned|been cleaned|cleaned contact|bounced|has bounced|forgotten/.test(t)) return 'said_no'
  if (/looks fake or invalid|invalid email|not a valid email|enter a (real|valid) email|email address is invalid|domain.*(does not exist|invalid)/.test(t)) return 'invalid'
  return 'temporary'
}

export type Refusal = {
  email_key: string
  kind: 'invalid' | 'temporary'
  mailchimp_code: string | null
  mailchimp_said: string
  refused_count: number
  first_refused_at: string
  last_refused_at: string
  held: boolean
  retry_requested_at: string | null
}

// Held = not sent on the next sync. Try again lifts it for one sync.
export const isHeld = (r: Pick<Refusal, 'held' | 'retry_requested_at'> | undefined | null): boolean => !!r && r.held === true && !r.retry_requested_at

export async function loadRefusals(locationUuid: string, deps: { db?: any } = {}): Promise<{ ok: true; byKey: Map<string, Refusal> } | { ok: false }> {
  const db = deps.db || supabaseService
  const r = await db.from('mailchimp_refusals')
    .select('email_key, kind, mailchimp_code, mailchimp_said, refused_count, first_refused_at, last_refused_at, held, retry_requested_at')
    .eq('location_id', locationUuid)
  if (r?.error) return { ok: false }
  const byKey = new Map<string, Refusal>()
  for (const row of r?.data || []) byKey.set(row.email_key, row as Refusal)
  return { ok: true, byKey }
}

// One more refusal for this address: a new row, or the existing one counted
// up. Try again is used up either way.
export async function recordRefusal(locationUuid: string, key: string, said: { kind: 'invalid' | 'temporary'; code: string | null; text: string }, at: string, existing: Refusal | undefined, deps: { db?: any } = {}): Promise<boolean> {
  const db = deps.db || supabaseService
  const text = (said.text || 'Mailchimp did not say why.').slice(0, 1000)
  if (existing) {
    const count = (existing.refused_count || 1) + 1
    const res = await db.from('mailchimp_refusals')
      .update({
        kind: said.kind, mailchimp_code: said.code, mailchimp_said: text,
        refused_count: count, last_refused_at: at,
        held: said.kind === 'invalid' || count >= HOLD_AFTER,
        retry_requested_at: null,
      })
      .eq('location_id', locationUuid).eq('email_key', key)
    return !res?.error
  }
  const res = await db.from('mailchimp_refusals').insert({
    location_id: locationUuid, email_key: key, kind: said.kind, mailchimp_code: said.code, mailchimp_said: text,
    refused_count: 1, first_refused_at: at, last_refused_at: at, held: said.kind === 'invalid', retry_requested_at: null,
  })
  return !res?.error
}

// Added after all: forget the refusal.
export async function clearRefusal(locationUuid: string, key: string, deps: { db?: any } = {}): Promise<boolean> {
  const db = deps.db || supabaseService
  const res = await db.from('mailchimp_refusals').delete().eq('location_id', locationUuid).eq('email_key', key)
  return !res?.error
}

// A "no" in Mailchimp → the no-marketing list, through its own function.
// false = it could not be written (e.g. the migration has not run).
export async function recordSaidNo(locationUuid: string, audienceId: string, email: string, said: string, deps: { db?: any } = {}): Promise<boolean> {
  const db = deps.db || supabaseService
  const res = await db.rpc('marketing_unsubscribe_from_mailchimp', {
    p_email: email, p_location: locationUuid, p_audience: audienceId, p_note: `Mailchimp said: ${said}`.slice(0, 1000),
  })
  return !res?.error
}

// Try again: the next sync sends this address once more.
export async function requestRetry(locationUuid: string, key: string, at: string, deps: { db?: any } = {}): Promise<boolean> {
  const db = deps.db || supabaseService
  const res = await db.from('mailchimp_refusals').update({ retry_requested_at: at })
    .eq('location_id', locationUuid).eq('email_key', key).select('email_key')
  return !res?.error && (res?.data || []).length === 1
}

export type RefusedPerson = Refusal & { email: string; records: Array<{ id: string; name: string }> }

// Who the owner sees: refused addresses still on a LIVE record here (never the
// Recycle Bin), and not left out of Mailchimp by the owner.
export async function listRefused(locationUuid: string, deps: { db?: any } = {}): Promise<{ ok: true; ready: boolean; people: RefusedPerson[] } | { ok: false }> {
  const db = deps.db || supabaseService
  const refusals = await loadRefusals(locationUuid, { db })
  if (!refusals.ok) return { ok: true, ready: false, people: [] }
  if (!refusals.byKey.size) return { ok: true, ready: true, people: [] }
  const leftOut = new Set<string>()
  const ch = await db.from('mailchimp_review_choices').select('key, choice').eq('location_id', locationUuid).eq('scope', 'person')
  if (!ch?.error) for (const c of ch?.data || []) if (c.choice === 'out') leftOut.add(c.key)
  const records = new Map<string, Array<{ id: string; name: string; email: string }>>()
  const keys = Array.from(refusals.byKey.keys()).filter((k) => !leftOut.has(k))
  // One exact, case-insensitive match per refused address (refusals are few).
  for (const k of keys) {
    const r = await db.from('leads').select('id, email, name, first_name, last_name')
      .eq('location_uuid', locationUuid).not('is_junk', 'is', true).ilike('email', likeExact(k))
    if (r?.error) return { ok: false }
    for (const l of r?.data || []) {
      const k = String(l.email || '').trim().toLowerCase()
      const name = [l.first_name, l.last_name].map((s: any) => String(s || '').trim()).filter(Boolean).join(' ') || String(l.name || '').trim()
      ;(records.get(k) || records.set(k, []).get(k)!).push({ id: l.id, name, email: String(l.email || '').trim() })
    }
  }
  const people: RefusedPerson[] = []
  for (const k of keys) {
    const recs = records.get(k)
    if (!recs || !recs.length) continue
    people.push({ ...refusals.byKey.get(k)!, email: recs[0].email, records: recs.map(({ id, name }) => ({ id, name })) })
  }
  people.sort((a, b) => (a.records[0].name || a.email).localeCompare(b.records[0].name || b.email))
  return { ok: true, ready: true, people }
}
