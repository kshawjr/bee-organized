// lib/network/types.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 1 — THE vocabulary. Pure: no I/O, no
// React, no database. Every other file in lib/network/ reads its types,
// levels and stages from here, so a ruling changes in one place.
//
// Ported from the Lovable design (kshawjr/brief-and-current, network-data.ts)
// and CHANGED to Kevin's rulings of 2026-11-15, which override the design:
//
//   TYPES — a contact can hold more than one. Exactly five:
//     Referral partner · Vendor / Service Provider · Nurture ·
//     Organization · Not sure yet
//   There is NO Client type (clients live in their own tab), so the design's
//   "client" type, activeJob flag and startJob() did not come across.
//
//   PARTNER LEVELS — Referral partners only. Exactly three, in order:
//     Potential · Referral Partner · Power Partner
//   (the design's Network / Premier and the live "Networking Contact" are gone)
//
//   PARTNER STAGES — Referral partners only; every other type has no stage:
//     New Contact · Reaching Out · Building the Relationship ·
//     Active Partner · Gone quiet
//
// The design's 14 sample tags and its sample people are deliberately NOT
// here: Bee Hub's own tag list (lib/tags.ts) stays the tag list.
// ─────────────────────────────────────────────────────────────

export type NetType = 'partner' | 'vendor' | 'nurture' | 'organization' | 'unsure'

/** The five types, in the order every picker and filter shows them. */
export const NET_TYPES: readonly NetType[] = ['partner', 'vendor', 'nurture', 'organization', 'unsure']

export const TYPE_META: Record<NetType, { label: string; short: string; blurb: string; examples: string }> = {
  partner: {
    label: 'Referral partner',
    short: 'Partner',
    blurb: 'Sends us work',
    examples: 'Realtors, movers, senior living, nearby organizers',
  },
  vendor: {
    label: 'Vendor / Service Provider',
    short: 'Vendor',
    blurb: 'We recommend or use them',
    examples: 'Electrician, handyman, painter, cleaner, storage',
  },
  nurture: {
    label: 'Nurture',
    short: 'Nurture',
    blurb: "Showed interest, hasn't booked",
    examples: 'Asked for a quote, had a consult, went quiet',
  },
  organization: {
    label: 'Organization',
    short: 'Organization',
    blurb: 'A business or group, not one person',
    examples: 'A moving company, a senior living community, a chamber',
  },
  unsure: {
    label: 'Not sure yet',
    short: 'Not sure yet',
    blurb: 'Save now, decide later',
    examples: "Met them somewhere and you'll figure it out",
  },
}

export const typeLabel = (t: NetType) => TYPE_META[t].label

// ── Partner levels (Referral partners only) ──────────────────
export type PartnerLevel = 'potential' | 'referral' | 'power'

/** In order, lowest first. */
export const PARTNER_LEVELS: readonly PartnerLevel[] = ['potential', 'referral', 'power']

export const LEVEL_META: Record<PartnerLevel, { label: string; short: string; blurb: string }> = {
  potential: { label: 'Potential', short: 'Potential', blurb: 'Exploring a referral relationship' },
  referral: { label: 'Referral Partner', short: 'Referral', blurb: 'Sends us work' },
  power: { label: 'Power Partner', short: 'Power', blurb: 'Top referrers, sends work all year' },
}

/** What a Referral partner is until someone says otherwise. */
export const DEFAULT_PARTNER_LEVEL: PartnerLevel = 'potential'

// ── Partner stages (Referral partners only) ──────────────────
export const PARTNER_STAGES = [
  'New Contact',
  'Reaching Out',
  'Building the Relationship',
  'Active Partner',
  'Gone quiet',
] as const
export type PartnerStage = (typeof PARTNER_STAGES)[number]

/** Where a new Referral partner starts. Same seed the live create doors use. */
export const DEFAULT_PARTNER_STAGE: PartnerStage = 'New Contact'

// ── The contact ──────────────────────────────────────────────
export type TouchKind = 'Call' | 'Coffee / meeting' | 'Email' | 'Text' | 'Card / gift'
export const TOUCH_KINDS: readonly TouchKind[] = ['Call', 'Coffee / meeting', 'Email', 'Text', 'Card / gift']
export type Touchpoint = { kind: TouchKind; when: string; note?: string | undefined }

export type ContactNote = { text: string; at: string; title?: string | undefined; author?: string | undefined }

export type HistoryKind =
  | 'touchpoint' | 'tags' | 'type' | 'partner' | 'email' | 'followup' | 'job' | 'referral' | 'created' | 'note'
export type HistoryEvent = { kind: HistoryKind; when: string; text: string }

export type Mailchimp = { on: boolean; how?: string | undefined; when?: string | undefined }

/**
 * One person or organization, as the new screens will hold it. This is the
 * shape the rules in this folder work on; it is not a database row (slice 2
 * decides the columns).
 */
export type NetContact = {
  id: string
  name: string
  /** A person's first and last name (an organization has neither). Set with `name` by lib/network/names.ts. */
  firstName?: string | undefined
  lastName?: string | undefined
  /** What they like to be called. */
  nickname?: string | undefined
  /** One or more of the five. Read it through contactTypes(), never directly. */
  types: NetType[]
  /** Referral partners only. Read it through partnerLevel(). */
  level?: PartnerLevel | undefined
  /** Referral partners only. Read it through partnerStage(). */
  stage?: PartnerStage | undefined
  tags: string[]
  role?: string | undefined
  company?: string | undefined
  phone?: string | undefined
  email?: string | undefined
  howMet?: string | undefined
  /** Nurture: what they asked about. */
  interest?: string | undefined
  referred: number
  converted: number
  revenue: number
  /** Days since the last logged contact; null means nothing logged yet. */
  lastTalkedDays: number | null
  /** Organizations: how many people are linked. */
  people?: number | undefined
  /** Month and day, like "Mar 22". No year. */
  birthday?: string | undefined
  birthdayReminder?: boolean | undefined
  touchpoints?: Touchpoint[] | undefined
  /** ISO date, like "2026-11-20". */
  nextFollowUp?: string | undefined
  workflow?: string | undefined
  drip?: string | undefined
  mailchimp: Mailchimp
  notes?: ContactNote[] | undefined
  history?: HistoryEvent[] | undefined
}

// ── Membership ───────────────────────────────────────────────
/**
 * A clean list of types from whatever was stored or typed: known types only,
 * no repeats, in the standard order. "Not sure yet" means nothing has been
 * decided, so it drops out as soon as any other type is present, and it is
 * what an empty list means.
 */
export function normalizeTypes(raw: readonly unknown[] | null | undefined): NetType[] {
  const picked = NET_TYPES.filter((t) => (raw || []).includes(t))
  const decided = picked.filter((t) => t !== 'unsure')
  return decided.length ? decided : ['unsure']
}

export const contactTypes = (c: Pick<NetContact, 'types'>): NetType[] => normalizeTypes(c.types)

export const hasType = (c: Pick<NetContact, 'types'>, type: NetType) => contactTypes(c).includes(type)

export const isReferralPartner = (c: Pick<NetContact, 'types'>) => hasType(c, 'partner')

export const isOrganization = (c: Pick<NetContact, 'types'>) => hasType(c, 'organization')

/** Shows on the Network tab: everyone except a contact who is ONLY Nurture. */
export const isNetworkContact = (c: Pick<NetContact, 'types'>) => contactTypes(c).some((t) => t !== 'nurture')

/** Shows on the Nurturing tab. */
export const isNurtureContact = (c: Pick<NetContact, 'types'>) => hasType(c, 'nurture')

/** A Referral partner's level; null for everyone else, whatever is stored. */
export function partnerLevel(c: Pick<NetContact, 'types' | 'level'>): PartnerLevel | null {
  if (!isReferralPartner(c)) return null
  return c.level && PARTNER_LEVELS.includes(c.level) ? c.level : DEFAULT_PARTNER_LEVEL
}

/** A Referral partner's stage; null for everyone else, whatever is stored. */
export function partnerStage(c: Pick<NetContact, 'types' | 'stage'>): PartnerStage | null {
  if (!isReferralPartner(c)) return null
  return c.stage && PARTNER_STAGES.includes(c.stage) ? c.stage : DEFAULT_PARTNER_STAGE
}

/**
 * Change a contact's types and keep the two partner-only facts honest: a
 * contact who stops being a Referral partner loses level and stage, and one
 * who becomes a Referral partner starts at Potential / New Contact.
 */
export function withTypes<C extends NetContact>(c: C, types: readonly NetType[]): C {
  const next = normalizeTypes(types)
  if (!next.includes('partner')) return { ...c, types: next, level: undefined, stage: undefined }
  return {
    ...c,
    types: next,
    level: partnerLevel({ types: next, level: c.level }) ?? DEFAULT_PARTNER_LEVEL,
    stage: partnerStage({ types: next, stage: c.stage }) ?? DEFAULT_PARTNER_STAGE,
  }
}

// ── Small display helpers ────────────────────────────────────
export const money = (n: number) => '$' + n.toLocaleString('en-US')

export function talkedLabel(d: number | null) {
  if (d === null) return "Haven't talked yet"
  if (d === 0) return 'Talked today'
  if (d < 30) return `Talked ${d}d ago`
  return `${Math.round(d / 30)} mo since you talked`
}

/** Nothing logged, or nothing for 60 days. */
export const COLD_AFTER_DAYS = 60
export const isCold = (c: Pick<NetContact, 'lastTalkedDays'>) =>
  c.lastTalkedDays === null || c.lastTalkedDays >= COLD_AFTER_DAYS
