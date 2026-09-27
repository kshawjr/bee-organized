// lib/sendable-domains.ts
//
// WHICH DOMAINS CAN BEE ORGANIZED SEND FROM? Before this file the app did not
// know. It sent from whatever address a setting held and learned the answer
// from Resend's refusal — after the fact, one lead at a time (lib/sender-domain.ts
// has the incident). The Settings checks need the answer BEFORE a save.
//
// Where the answer comes from, in order:
//
//   1. SENDABLE_EMAIL_DOMAINS (env, comma-separated) — an explicit list, for
//      when the Resend key can't list domains (below) or to pin it by hand.
//   2. Resend itself: domains.list(), keeping status 'verified'. This is the
//      source of truth — it is exactly the list Resend will accept a From on.
//      It needs a FULL-ACCESS API key; a "sending access" key answers
//      restricted_api_key. Which kind production holds is not visible from
//      here (the key is marked Sensitive in Vercel).
//   3. Neither → null: UNKNOWN. Callers then check the address's shape only
//      and skip the domain rule. Never guessed, never hard-coded. The send path
//      still classifies Resend's refusal correctly (the lead is held, the owner
//      is told), so unknown costs a late message, not a lost lead.
//
// Cached for ten minutes per server instance: a newly verified domain shows up
// within ten minutes, and a Settings save costs no Resend call most of the time.

import { Resend } from 'resend'

const TTL_MS = 10 * 60 * 1000
let cache: { at: number; domains: string[] | null } | null = null

export function parseDomainList(raw: string | null | undefined): string[] | null {
  const list = String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return list.length ? list : null
}

export function _resetSendableDomainsCache() {
  cache = null
}

export async function getSendableDomains(): Promise<string[] | null> {
  const fromEnv = parseDomainList(process.env.SENDABLE_EMAIL_DOMAINS)
  if (fromEnv) return fromEnv

  if (cache && Date.now() - cache.at < TTL_MS) return cache.domains
  let domains: string[] | null = null
  try {
    if (process.env.RESEND_API_KEY) {
      const { data, error } = await new Resend(process.env.RESEND_API_KEY).domains.list()
      if (error) {
        console.warn('[sendable-domains] Resend would not list domains — domain checks off until SENDABLE_EMAIL_DOMAINS is set or the key allows it:', error.name ?? error.message)
      } else {
        const rows = ((data as any)?.data ?? []) as { name?: string; status?: string }[]
        const verified = rows.filter((d) => d.status === 'verified' && d.name).map((d) => d.name!.toLowerCase())
        domains = verified.length ? verified : null
      }
    }
  } catch (e: any) {
    console.warn('[sendable-domains] domain list unavailable:', e?.message || e)
  }
  cache = { at: Date.now(), domains }
  return domains
}
