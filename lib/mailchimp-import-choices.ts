// lib/mailchimp-import-choices.ts
//
// MAILCHIMP SLICE 7 (FL-75, 2026-11-26): the owner's ticks on "Who comes in
// from Mailchimp" survive leaving the screen — slice 6's pattern
// (lib/mailchimp-review-choices.ts), in its own table,
// mailchimp_import_choices (see migrations/mailchimp_import_choices.sql for
// why it is not slice 6's table).
//
// Only a difference from the default is stored. Everyone new starts ticked.
//   group  'new' + 'in' | 'out' | null   — the "New to Bee Hub" group
//   person <email> + 'in' | 'out' | null — one person, overriding the group
// null forgets the choice (back to the default), so the row is deleted.
//
// A SAVED TICK IS NEVER TRUSTED ON ITS OWN: lib/mailchimp-pull-review.ts
// plans again from scratch at import time, and a tick can only pick from the
// people that plan says "will be created". A row here can keep someone out;
// it can never let anyone past a rule.
//
// The only table this file writes is mailchimp_import_choices. It sends
// nothing and writes no lead record.

import { supabaseService } from './supabase-service'
import { emailKey } from './mailchimp-rules'
import { pullAllowed } from './mailchimp-pull-pilot'

export const IMPORT_GROUP = 'new'
export type Tick = 'in' | 'out'
export type ImportChoices = { ready: boolean; group: Tick | null; person: Map<string, Tick> }

export const IMPORT_SAVE_WORDS = {
  not_available: 'Bringing people in from Mailchimp isn’t switched on for your location yet.',
  bad_request: 'That choice could not be read, so nothing was saved.',
  already_here: 'This person is already in Bee Hub, so there’s nothing to bring in.',
  not_ready: 'Saving choices isn’t switched on yet. Nothing was saved.',
  failed: 'Your choice could not be saved. Please try again.',
}

export type ImportSaveResult = { ok: true } | { ok: false; status: number; error: keyof typeof IMPORT_SAVE_WORDS; words: string }
const fail = (status: number, error: keyof typeof IMPORT_SAVE_WORDS): ImportSaveResult => ({ ok: false, status, error, words: IMPORT_SAVE_WORDS[error] })

const missingTable = (e: any) => e?.code === '42P01' || /does not exist|schema cache/i.test(String(e?.message || ''))
// LIKE treats % and _ as wildcards; an address can hold _ (jane_doe@...).
const likeExact = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

export function validateImportChoice(input: { scope: unknown; key: unknown; choice: unknown }):
  | { ok: true; scope: 'group' | 'person'; key: string; choice: Tick | null }
  | { ok: false } {
  const { scope, key, choice } = input
  if (choice !== 'in' && choice !== 'out' && choice !== null) return { ok: false }
  if (scope === 'group' && key === IMPORT_GROUP) return { ok: true, scope, key, choice }
  if (scope === 'person' && typeof key === 'string' && key.length <= 400 && emailKey(key) === key) return { ok: true, scope, key, choice }
  return { ok: false }
}

// Person first, then the group, then the default (ticked).
export function isTicked(email: unknown, choices: Pick<ImportChoices, 'group' | 'person'>): boolean {
  const k = emailKey(email)
  const c = k ? choices.person.get(k) : undefined
  if (c) return c === 'in'
  return choices.group !== 'out'
}

// Read only. Before the migration is run: ready=false and nothing saved.
export async function loadImportChoices(locationId: string, db: any = supabaseService): Promise<ImportChoices> {
  const { data, error } = await db.from('mailchimp_import_choices').select('scope, key, choice').eq('location_id', locationId)
  if (error) {
    if (missingTable(error)) return { ready: false, group: null, person: new Map() }
    throw new Error(`mailchimp_import_choices: ${error.message}`)
  }
  const out: ImportChoices = { ready: true, group: null, person: new Map() }
  for (const r of data || []) {
    if (r.choice !== 'in' && r.choice !== 'out') continue
    if (r.scope === 'group' && r.key === IMPORT_GROUP) out.group = r.choice
    else if (r.scope === 'person' && emailKey(r.key) === r.key) out.person.set(r.key, r.choice)
  }
  return out
}

export async function saveImportChoice(locationId: string, userId: string | null, input: { scope: unknown; key: unknown; choice: unknown }, deps: { db?: any } = {}): Promise<ImportSaveResult> {
  if (!pullAllowed(locationId)) return fail(403, 'not_available')
  const db = deps.db || supabaseService
  const v = validateImportChoice(input)
  if (!v.ok) return fail(400, 'bad_request')

  // Already in Bee Hub here → their choice is spent; they can't be ticked in.
  if (v.scope === 'person' && v.choice === 'in') {
    const { data, error } = await db.from('leads').select('id, email, is_junk').eq('location_uuid', locationId).ilike('email', likeExact(v.key))
    if (error) return fail(500, 'failed')
    if ((data || []).some((l: any) => emailKey(l.email) === v.key && l.is_junk !== true)) return fail(409, 'already_here')
  }

  const res = v.choice === null
    ? await db.from('mailchimp_import_choices').delete().eq('location_id', locationId).eq('scope', v.scope).eq('key', v.key)
    : await db.from('mailchimp_import_choices').upsert(
        { location_id: locationId, scope: v.scope, key: v.key, choice: v.choice, chosen_by: userId, chosen_at: new Date().toISOString() },
        { onConflict: 'location_id,scope,key' })
  if (res.error) {
    if (/mailchimp_import_already_here/.test(String(res.error.message || ''))) return fail(409, 'already_here')
    if (missingTable(res.error)) return fail(503, 'not_ready')
    return fail(500, 'failed')
  }
  return { ok: true }
}

// After an import: the people brought in (or found already there) have spent
// their choice. Their rows go, so nothing is left to offer them again.
export async function spendImportChoices(locationId: string, emails: readonly string[], db: any = supabaseService): Promise<{ ok: boolean }> {
  const keys = Array.from(new Set(emails.map((e) => emailKey(e)).filter((k): k is string => !!k)))
  if (!keys.length) return { ok: true }
  const { error } = await db.from('mailchimp_import_choices').delete().eq('location_id', locationId).eq('scope', 'person').in('key', keys)
  return { ok: !error || missingTable(error) }
}
