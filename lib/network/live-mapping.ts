// lib/network/live-mapping.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 1 — how a contact in the LIVE partners
// table lands in the new model. Pure: it decides, it reads and writes
// nothing. Slice 2's migration and its dry-run report both call this, so
// the report Kevin reads and the change that runs cannot disagree.
//
// KEVIN'S RULES (2026-11-15), in his words and in this order:
//
//   1. Tier Referral Partner, or tagged Partner / Referral, or has sent a
//      lead (a client whose "referred by" points at them):
//        type Referral partner. Level Referral Partner, or Power Partner
//        where the tier says so.
//   2. Tier Service Provider, or tagged Vendor:
//        type Vendor / Service Provider. No level, no stage.
//   3. Tier Networking Contact: Not sure yet. No level, no stage.
//   4. Everything else (a trade tag only, came from a client record, typed
//      in bare): Not sure yet. A trade tag is NEVER used to guess a type.
//   5. The live stage carries across only for Referral partners; live
//      Dormant becomes Gone quiet. Every other type drops its stage.
//
// The live `type` column (partner / contact) is deliberately not an input:
// it is 'partner' on 262 of 263 rows, a default nobody chose.
//
// THREE THINGS THE RULES LEAVE OPEN. Each is decided here in the plainest
// way, said out loud in `flags` on the result, and listed for Kevin:
//   a. A contact who meets rule 1 AND rule 2 gets BOTH types — a contact can
//      hold more than one. (6 such rows in production on 2026-11-15.)
//   b. A Referral partner with no live stage, or a stage that is not one of
//      the five, starts at New Contact, the seed every live create door
//      uses. (2 rows with no stage.)
//   c. Rule 1 never produces Potential: a partner found by tag or by a lead
//      they sent, with no tier, is level Referral Partner, as the rule says.
// ─────────────────────────────────────────────────────────────

import {
  DEFAULT_PARTNER_STAGE, PARTNER_STAGES,
  type NetType, type PartnerLevel, type PartnerStage,
} from './types'

/** The live tier keys (lookups category partner_tiers, attrs.key). */
export const LIVE_TIER = {
  referral: 'referral-partner',
  power: 'power-partner',
  service: 'service-provider',
  networking: 'networking-contact',
} as const

/** Tag names that mean Referral partner, and the one that means Vendor. Matched on the tag's label, any case. */
export const REFERRAL_TAG_LABELS = ['partner', 'referral'] as const
export const VENDOR_TAG_LABELS = ['vendor'] as const

/** What the mapping needs to know about one live contact. */
export type LivePartnerFacts = {
  /** partners.tier — the key ('referral-partner') or the label ('Referral Partner'). */
  tier?: string | null
  /** partners.stage, as stored. */
  stage?: string | null
  /** The labels of the tags on this contact (partner_tags → lookups.label). */
  tagLabels?: readonly (string | null | undefined)[] | null
  /** True when at least one client's "referred by" points at this contact. */
  hasSentLead?: boolean | null
}

export type MappedContact = {
  types: NetType[]
  /** Only ever set for a Referral partner. */
  level: PartnerLevel | null
  /** Only ever set for a Referral partner. */
  stage: PartnerStage | null
  /** Which rule put them here, in plain words. */
  why: string[]
  /** Anything the rules did not settle, or anything dropped. Empty for a clean row. */
  flags: string[]
}

const clean = (v: unknown) => String(v ?? '').trim().toLowerCase()

/** 'Referral Partner', 'referral_partner' and 'referral-partner' are the same tier. */
export const tierKey = (tier: unknown) => clean(tier).replace(/[\s_]+/g, '-')

// The live stage names → ours. The live screen's rail calls the third stage
// 'Building' while the lookup list calls it 'Building the Relationship';
// both read. 'Dormant' is the one rename.
const LIVE_STAGE: Record<string, PartnerStage> = {
  ...Object.fromEntries(PARTNER_STAGES.map((s) => [s.toLowerCase(), s])),
  building: 'Building the Relationship',
  dormant: 'Gone quiet',
}

/** A live stage in the new words, or null when it is blank or not one of the five. */
export function mapLiveStage(stage: unknown): PartnerStage | null {
  return LIVE_STAGE[clean(stage).replace(/\s+/g, ' ')] ?? null
}

export function mapLivePartner(facts: LivePartnerFacts): MappedContact {
  const tier = tierKey(facts.tier)
  const tags = new Set((facts.tagLabels || []).map(clean).filter(Boolean))
  const hasTag = (labels: readonly string[]) => labels.some((l) => tags.has(l))
  const why: string[] = []
  const flags: string[] = []

  // Rule 1 — Referral partner.
  const refReasons: string[] = []
  if (tier === LIVE_TIER.referral) refReasons.push('tier is Referral Partner')
  if (tier === LIVE_TIER.power) refReasons.push('tier is Power Partner')
  if (hasTag(REFERRAL_TAG_LABELS)) refReasons.push('tagged Partner or Referral')
  if (facts.hasSentLead === true) refReasons.push('has sent a lead')
  const isReferral = refReasons.length > 0

  // Rule 2 — Vendor / Service Provider.
  const vendorReasons: string[] = []
  if (tier === LIVE_TIER.service) vendorReasons.push('tier is Service Provider')
  if (hasTag(VENDOR_TAG_LABELS)) vendorReasons.push('tagged Vendor')
  const isVendor = vendorReasons.length > 0

  const types: NetType[] = []
  if (isReferral) { types.push('partner'); why.push(`Referral partner: ${refReasons.join(', ')}`) }
  if (isVendor) { types.push('vendor'); why.push(`Vendor / Service Provider: ${vendorReasons.join(', ')}`) }
  if (isReferral && isVendor) flags.push('Meets both the Referral partner and the Vendor rule, so holds both types')

  // Rules 3 and 4 — Not sure yet. Trade tags are never read.
  if (!types.length) {
    types.push('unsure')
    why.push(tier === LIVE_TIER.networking
      ? 'Not sure yet: tier is Networking Contact'
      : 'Not sure yet: no tier, tag or sent lead says what they are')
  } else if (tier === LIVE_TIER.networking) {
    flags.push('Tier Networking Contact dropped: another rule decided the type')
  }
  if (tier && !(Object.values(LIVE_TIER) as string[]).includes(tier)) {
    flags.push(`Tier “${String(facts.tier).trim()}” is not one of the four live tiers and was not used`)
  }

  // Level — Referral partners only; never Potential from this mapping.
  const level: PartnerLevel | null = isReferral ? (tier === LIVE_TIER.power ? 'power' : 'referral') : null

  // Rule 5 — the stage carries across for Referral partners only.
  let stage: PartnerStage | null = null
  const liveStage = String(facts.stage ?? '').trim()
  if (isReferral) {
    stage = mapLiveStage(liveStage)
    if (!stage) {
      stage = DEFAULT_PARTNER_STAGE
      flags.push(liveStage
        ? `Live stage “${liveStage}” is not one of the five, so they start at ${DEFAULT_PARTNER_STAGE}`
        : `No live stage, so they start at ${DEFAULT_PARTNER_STAGE}`)
    }
  } else if (liveStage && clean(liveStage) !== clean(DEFAULT_PARTNER_STAGE)) {
    // Losing the default "New Contact" loses nothing anyone chose. Losing
    // anything else is a choice an owner made, so it is said.
    flags.push(`Live stage “${liveStage}” dropped: only a Referral partner has a stage`)
  }

  return { types, level, stage, why, flags }
}

export type MappingSummary = {
  total: number
  referralPartner: number
  /** Of referralPartner: how many are also Vendor. */
  referralAndVendor: number
  vendorOnly: number
  notSure: number
  powerPartner: number
  flagged: number
}

/** Counts for a batch of live contacts — the top of slice 2's dry-run report. */
export function summarizeMapping(rows: readonly LivePartnerFacts[]): MappingSummary {
  const s: MappingSummary = { total: 0, referralPartner: 0, referralAndVendor: 0, vendorOnly: 0, notSure: 0, powerPartner: 0, flagged: 0 }
  for (const row of rows) {
    const m = mapLivePartner(row)
    s.total += 1
    const ref = m.types.includes('partner')
    const ven = m.types.includes('vendor')
    if (ref) s.referralPartner += 1
    if (ref && ven) s.referralAndVendor += 1
    if (ven && !ref) s.vendorOnly += 1
    if (m.types.includes('unsure')) s.notSure += 1
    if (m.level === 'power') s.powerPartner += 1
    if (m.flags.length) s.flagged += 1
  }
  return s
}
