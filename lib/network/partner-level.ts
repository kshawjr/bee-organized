// lib/network/partner-level.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 1 — changing a Referral partner's level.
// Pure. Ported from the design's partner-choice.ts + partner-type.ts.
//
// What changed from the design: it kept "potential" as a flag beside a
// three-value tier and needed an adapter to stop both being set at once.
// Kevin's three levels (Potential · Referral Partner · Power Partner) are
// ONE field, so that clash cannot happen and the adapter is gone.
//
// The rule that did come across unchanged: a level never changes until the
// owner confirms it. An unconfirmed call hands back the SAME object, so a
// closed dialog can never save a change or its draft note.
// ─────────────────────────────────────────────────────────────

import { changeEvents } from './history'
import {
  LEVEL_META, PARTNER_LEVELS, isReferralPartner, partnerLevel,
  type NetContact, type PartnerLevel,
} from './types'

/** The picker's options, lowest level first. */
export const LEVEL_CHOICES: { value: PartnerLevel; label: string; short: string; description: string }[] =
  PARTNER_LEVELS.map((value) => ({
    value,
    label: LEVEL_META[value].label,
    short: LEVEL_META[value].short,
    description: LEVEL_META[value].blurb,
  }))

export const levelLabel = (level: PartnerLevel) => LEVEL_META[level].label
export const levelShort = (level: PartnerLevel) => LEVEL_META[level].short

/**
 * Set a Referral partner's level. Returns the SAME contact (nothing saved)
 * when it is not confirmed, the contact is not a Referral partner, or the
 * level is already that. On a real change: the level, a History line, and
 * the optional note, all stamped with `at`.
 */
export function confirmPartnerLevel<C extends NetContact>(
  c: C, level: PartnerLevel, note: string, confirmed: boolean, at = new Date().toISOString(),
): C {
  if (!confirmed || !isReferralPartner(c) || partnerLevel(c) === level) return c
  const next = { ...c, level }
  const text = note.trim()
  return {
    ...next,
    history: [...changeEvents(c, next, at), ...(c.history ?? [])],
    notes: text ? [{ text, title: `Changed to ${levelLabel(level)}`, author: 'You', at }, ...(c.notes ?? [])] : c.notes,
  }
}
