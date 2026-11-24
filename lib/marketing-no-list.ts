// lib/marketing-no-list.ts
// ─────────────────────────────────────────────────────────────────────────────
// FL-75 slice 2 — "an unsubscribe counts everywhere" (Kevin, 2026-11-23).
//
// The shared no-marketing list (migrations/marketing_unsubscribes.sql) holds
// every email address that said no to marketing, at ANY location, kept apart
// from the lead records so deleting a record does not forget it. Every client
// marketing send asks this file before it sends:
//
//   lib/drip-send.ts       each drip step
//   lib/stage-emails.ts    the Closed Won follow-ups
//   lib/welcome-email.ts   the welcome email
//   today's Sync now engine — filters its batch before anything is pushed
//
// This is the CLIENT list only. A referral partner's "stop the partner intros"
// lives in partner_unsubscribes (lib/network/partner-unsubscribe.ts), a
// different promise to a different person; neither file reads the other.
//
// FAILS CLOSED: if the list cannot be read, the send does not go (it holds and
// is tried again; it is not cancelled). The one exception is the list not
// existing yet — the migration not run — where the answer is "clear", because
// there is nothing on it, and every record's own No marketing emails mark
// still stops its own sends, exactly as before this slice.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

export type NoListAnswer = 'said_no' | 'clear' | 'unreadable'

// The send rails' stop/cancel reason when the address said no elsewhere.
export const SAID_NO_ELSEWHERE = 'unsubscribed_elsewhere'
// The send rails' answer when the list could not be read: HOLD, not cancel.
export const NO_LIST_UNREADABLE = 'no_list_unreadable'

const notRunYet = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code
  // function or table missing: PostgREST and Postgres spellings
  return code === 'PGRST202' || code === '42883' || code === 'PGRST205' || code === '42P01'
}

// The list's key: lower case, trimmed — exactly what the database stores
// (lower(btrim(email))). Deliberately NOT stricter than that: an oddly typed
// address that said no must still match itself. For a well-formed address it
// equals mailchimp-rules emailKey().
export function noListKey(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const k = email.trim().toLowerCase()
  return k || null
}

// One address. A blank address is 'clear' here: there is nothing to send to,
// and each rail's own no-email check already stops it.
export async function addressSaidNo(email: unknown): Promise<NoListAnswer> {
  const key = noListKey(email)
  if (!key) return 'clear'
  try {
    const { data, error } = await supabaseService.rpc('marketing_address_said_no', { p_email: key })
    if (error) {
      if (notRunYet(error)) return 'clear'
      console.error('[marketing-no-list] lookup failed', error.message)
      return 'unreadable'
    }
    if (data === true) return 'said_no'
    if (data === false) return 'clear'
    return 'unreadable'
  } catch (err) {
    console.error('[marketing-no-list] lookup threw', err)
    return 'unreadable'
  }
}

// Many addresses at once (a Mailchimp batch). Returns the noListKey() values
// that said no — the same shape mailchimpEligibility's `suppressed` takes.
// THROWS if the list cannot be read: a batch must not go out on a guess.
export async function loadSaidNoSet(emails: readonly unknown[]): Promise<Set<string>> {
  const keys = Array.from(new Set(emails.map(noListKey).filter((k): k is string => !!k)))
  const out = new Set<string>()
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200)
    const { data, error } = await supabaseService
      .from('marketing_unsubscribes')
      .select('email_normalized')
      .in('email_normalized', chunk)
      .is('reversed_at', null)
    if (error) {
      if (notRunYet(error)) return out
      throw new Error(`no-marketing list read failed: ${error.message}`)
    }
    for (const r of (data || []) as { email_normalized: string }[]) out.add(r.email_normalized)
  }
  return out
}
