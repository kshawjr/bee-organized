// lib/network/partner-stage.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 1 — moving a Referral partner between
// stages. Pure. Ported from the design's partner-stage.ts, on Kevin's five
// stages (lib/network/types.ts). Only a Referral partner has a stage.
//
// Same confirmation rule as the level: nothing moves, and no note is saved,
// until the owner confirms. An unconfirmed call hands back the SAME object.
// ─────────────────────────────────────────────────────────────

import { changeEvents } from './history'
import { isReferralPartner, partnerStage, type NetContact, type PartnerStage } from './types'

export function confirmPartnerStage<C extends NetContact>(
  c: C, stage: PartnerStage, note: string, confirmed: boolean, at = new Date().toISOString(),
): C {
  if (!confirmed || !isReferralPartner(c) || partnerStage(c) === stage) return c
  const next = { ...c, stage }
  const text = note.trim()
  return {
    ...next,
    history: [...changeEvents(c, next, at), ...(c.history ?? [])],
    notes: text ? [{ text, title: `Moved to ${stage}`, author: 'You', at }, ...(c.notes ?? [])] : c.notes,
  }
}
