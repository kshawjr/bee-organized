// lib/network/new-contact-type.ts
// ─────────────────────────────────────────────────────────────
// What a Network contact made RIGHT NOW is, in the new model: its types,
// and for a Referral partner its level and stage.
//
// WHY. Two doors in Clients make Network contacts and stay open to owners
// while the Network screen is greyed (2026-11-19 investigation): a client's
// "Referred by" › Create partner (POST /api/partners) and a client card's or
// the Inbox's Add / Move to Network (POST /api/leads/:id/network). Until now
// both wrote a row with no network_types, so 26 contacts in three days had
// to be fixed by hand (migrations/network_types_fix_26.sql). Now every
// partners insert those routes make goes through modelForNewContact, and
// the row is never written without it.
//
// THE RULES ARE SLICE 2's, NOT NEW ONES. This calls mapLivePartner
// (lib/network/live-mapping.ts, Kevin's slice 1 rulings), the same function
// the backfill's report was built from, with the facts a new contact has:
//   · tier and stage, as the door sent them
//   · the labels of the tags that will really attach (same check
//     attachPartnerTags makes: right list, this location or corporate)
//   · "has sent a lead" is TRUE for a contact made from "Referred by": the
//     contact is made to be named as a client's referrer, which is exactly
//     what rule 1 reads. The four made this way in production on 16-18 Nov
//     came out Referral Partner / New Contact under the backfill's rule.
//   · a contact made from a client record has no tier and has sent no lead,
//     so rule 4 says Not sure yet (unless a picked tag says otherwise).
// ─────────────────────────────────────────────────────────────

import { mapLivePartner } from './live-mapping'
import type { NetType, PartnerLevel, PartnerStage } from './types'
import { cleanTagIds, tagApplyError } from '@/lib/tags'

/** The three model columns, as they go on the row. */
export type NewContactModel = {
  network_types: NetType[]
  partner_level: PartnerLevel | null
  partner_stage: PartnerStage | null
}

export type NewContactFacts = {
  tier?: string | null
  stage?: string | null
  tagLabels?: readonly (string | null | undefined)[] | null
  /** Made from a client's "Referred by": counts as having sent a lead (rule 1). */
  asReferrer?: boolean
}

export function modelForNewContact(f: NewContactFacts = {}): NewContactModel {
  const m = mapLivePartner({
    tier: f.tier ?? null,
    stage: f.stage ?? null,
    tagLabels: f.tagLabels ?? [],
    hasSentLead: f.asReferrer === true,
  })
  return { network_types: m.types, partner_level: m.level, partner_stage: m.stage }
}

/**
 * The labels of the picked tags that will really attach to a contact at
 * this location. A tag that attachPartnerTags would refuse does not get to
 * decide the type.
 */
export async function attachableTagLabels(db: any, rawTagIds: unknown, locationId: string): Promise<string[]> {
  const ids = cleanTagIds(rawTagIds)
  if (!ids.length) return []
  const { data, error } = await db.from('lookups').select('id, category, location_id, label').in('id', ids)
  if (error) throw new Error(`tag lookup read failed: ${error.message}`)
  return (data || [])
    .filter((d: any) => tagApplyError(d, locationId) === null)
    .map((d: any) => String(d.label ?? ''))
}
