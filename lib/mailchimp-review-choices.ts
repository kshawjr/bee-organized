// lib/mailchimp-review-choices.ts
//
// MAILCHIMP SLICE 5 (FL-75, 2026-11-24): saves ONE choice an owner makes on
// the "Who goes to Mailchimp" screen, so it survives leaving the screen.
//
// The only table this file writes is mailchimp_review_choices. It writes no
// lead record, nothing on the no-marketing list, nothing in Mailchimp, and it
// sends nothing.
//
// A choice is:
//   group  + 'in' | 'out'          — tick or untick a whole group
//   person + 'in' | 'out'          — tick or untick one person (their address)
//   phone  + 'same' | 'different'  — the owner's answer to "Is this the same
//                                     person?" Kept only. Nothing is joined.
//   any    + null                  — forget the choice (back to the default)
//
// A PERSON WHO CANNOT BE MARKETED TO CAN NEVER BE TICKED IN. Checked here
// first, so the owner gets plain words, and again by the database guard in
// migrations/mailchimp_review_choices.sql, so no other route gets round it.

import { supabaseService } from './supabase-service'
import { emailKey, mailchimpEligibility } from './mailchimp-rules'
import { loadSaidNoSet } from './marketing-no-list'

export type ChoiceInput = { scope: unknown; key: unknown; choice: unknown }

export type SaveResult =
  | { ok: true }
  | { ok: false; status: number; error: string; words: string }

const GROUP_KEY = /^(archived|worked|never_other|added:\d{4}-\d{2}-\d{2})$/

export const SAVE_WORDS = {
  bad_request: 'That choice could not be read, so nothing was saved.',
  said_no: 'This person has said no to marketing emails, so they can’t be added to Mailchimp.',
  not_offered: 'This person can’t be added to Mailchimp (no usable record here, in the Recycle Bin, or marked “No marketing emails”).',
  not_ready: 'Saving choices isn’t switched on yet. Nothing was saved.',
  failed: 'Your choice could not be saved. Please try again.',
}

export function validateChoice(input: ChoiceInput):
  | { ok: true; scope: 'group' | 'person' | 'phone'; key: string; choice: 'in' | 'out' | 'same' | 'different' | null }
  | { ok: false } {
  const { scope, key, choice } = input
  if (typeof key !== 'string' || !key || key.length > 400) return { ok: false }
  if (scope === 'group') {
    if (!GROUP_KEY.test(key)) return { ok: false }
    if (choice !== 'in' && choice !== 'out' && choice !== null) return { ok: false }
    return { ok: true, scope, key, choice }
  }
  if (scope === 'person') {
    if (emailKey(key) !== key) return { ok: false }
    if (choice !== 'in' && choice !== 'out' && choice !== null) return { ok: false }
    return { ok: true, scope, key, choice }
  }
  if (scope === 'phone') {
    const bar = key.indexOf('|')
    if (bar < 1 || emailKey(key.slice(bar + 1)) !== key.slice(bar + 1)) return { ok: false }
    if (choice !== 'same' && choice !== 'different' && choice !== null) return { ok: false }
    return { ok: true, scope, key, choice }
  }
  return { ok: false }
}

// LIKE treats % and _ as wildcards; an address can hold _ (jane_doe@...).
const likeExact = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

export async function saveChoice(locationId: string, userId: string | null, input: ChoiceInput, deps: {
  db?: any
  loadSuppressed?: (emails: readonly unknown[]) => Promise<Set<string>>
} = {}): Promise<SaveResult> {
  const db = deps.db || supabaseService
  const v = validateChoice(input)
  if (!v.ok) return { ok: false, status: 400, error: 'bad_request', words: SAVE_WORDS.bad_request }

  if (v.scope === 'person' && v.choice === 'in') {
    const suppressed = await (deps.loadSuppressed || loadSaidNoSet)([v.key])
    if (suppressed.has(v.key)) return { ok: false, status: 409, error: 'said_no', words: SAVE_WORDS.said_no }
    const { data, error } = await db
      .from('leads')
      .select('id, email, is_junk, marketing_opt_out, marketing_unsubscribed_at, archived_at')
      .eq('location_uuid', locationId)
      .ilike('email', likeExact(v.key))
    if (error) return { ok: false, status: 500, error: 'failed', words: SAVE_WORDS.failed }
    const offered = (data || []).filter((l: any) => emailKey(l.email) === v.key && mailchimpEligibility(l, { suppressed }).eligible)
    if (!offered.length) return { ok: false, status: 409, error: 'not_offered', words: SAVE_WORDS.not_offered }
  }

  const res = v.choice === null
    ? await db.from('mailchimp_review_choices').delete().eq('location_id', locationId).eq('scope', v.scope).eq('key', v.key)
    : await db.from('mailchimp_review_choices').upsert(
        { location_id: locationId, scope: v.scope, key: v.key, choice: v.choice, chosen_by: userId, chosen_at: new Date().toISOString() },
        { onConflict: 'location_id,scope,key' })
  if (res.error) {
    const msg = String(res.error.message || '')
    if (/mailchimp_review_said_no/.test(msg)) return { ok: false, status: 409, error: 'said_no', words: SAVE_WORDS.said_no }
    if (/mailchimp_review_not_offered/.test(msg)) return { ok: false, status: 409, error: 'not_offered', words: SAVE_WORDS.not_offered }
    if (res.error.code === '42P01' || /does not exist|schema cache/i.test(msg)) return { ok: false, status: 503, error: 'not_ready', words: SAVE_WORDS.not_ready }
    return { ok: false, status: 500, error: 'failed', words: SAVE_WORDS.failed }
  }
  return { ok: true }
}
