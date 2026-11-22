// lib/partner-sequences.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 2 (2026-11-22) — which email sequences are PARTNER
// sequences. Pure: no database, no email.
//
// Partners use the same sequence tables as client emails (drip_paths +
// drip_path_steps, masters + a location's own copy), so a partner sequence is
// told apart by its key: every one starts "partner-". A location's copy keeps
// its master's key (app/api/locations/[id]/drip-paths/clone), so a copy is a
// partner sequence too. The database says the same thing in
// public.is_partner_path_key (migrations/partner_emails.sql), and refuses a
// partner sequence as a location's client sequence.
//
// The two masters (migrations/partner_emails.sql, section 8):
//   partner-introduction        Email 500 on start, Email 501 three months later
//   partner-power-introduction  Email 502 only
// Any partner may be started on either, whatever their level.
// ─────────────────────────────────────────────────────────────

export const PARTNER_PATH_PREFIX = 'partner-'

export const PARTNER_SEQUENCES = [
  { pathKey: 'partner-introduction', name: 'Partner introduction', emails: ['500', '501'] },
  { pathKey: 'partner-power-introduction', name: 'Power Partner introduction', emails: ['502'] },
] as const

export const PARTNER_PATH_KEYS: readonly string[] = PARTNER_SEQUENCES.map((s) => s.pathKey)

/** True for a partner sequence's key (master or a location's copy). */
export function isPartnerPathKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(PARTNER_PATH_PREFIX)
}

/**
 * Which sequences a list or screen asked for. Every screen that existed before
 * partner emails asks for nothing and gets client sequences only, exactly as
 * before; slice 3's Emails screen asks for `?audience=partner`.
 */
export type SequenceAudience = 'client' | 'partner'
export function sequenceAudienceOf(raw: string | null | undefined): SequenceAudience {
  return raw === 'partner' ? 'partner' : 'client'
}
export function pathKeyFitsAudience(key: unknown, audience: SequenceAudience): boolean {
  return audience === 'partner' ? isPartnerPathKey(key) : !isPartnerPathKey(key)
}
