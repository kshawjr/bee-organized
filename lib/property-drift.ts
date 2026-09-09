// lib/property-drift.ts
//
// THE DRIFT DECISION, as pure functions. No Supabase, no Jobber, no clock.
//
// WHY THIS FILE EXISTS. Jobber tells us about a property; we have to decide
// whether it is an address we already know. That decision was about to exist
// in two places — the inbound webhook, and any backfill sweep that goes
// looking for the ~105 clients whose Jobber properties Bee Hub never
// recorded. Two copies of "already known" is two answers to the same
// question, and the one that drifts is the one that writes a duplicate onto
// an owner's card. So the opinion lives here, once, and both callers ask it.
//
// WHAT IT DOES NOT DO. It never decides to touch the primary address columns
// and never decides to move leads.jobber_property_id. That is the rule the
// fourth routing branch in handlePropertyCore was built to protect (d8aa5ef):
// before it, any property event on a multi-property client overwrote the
// lead's CURRENT address and re-pointed its link at whichever property fired
// last. Adding one of the client's OTHER addresses violates neither half of
// that rule — the branch gains an action, it does not lose its guard.
//
// The 'other' + 'Found in Jobber' labelling matches
// scripts/import-six-properties.mjs exactly, so a row written by the webhook
// and a row written by Kevin's held backfill are indistinguishable on the
// card. 'other' REQUIRES a note (lib/address-labels, validateAddressLabel) —
// a bare 'other' degrades to the word "Other", which is the label saying
// nothing, the exact defect a fixed label set exists to prevent.

import {
  composeLeadAddress,
  formatLeadAddress,
  normalizeAddressKey,
  buildAddedAddress,
  isRetiredAddress,
  type FormerAddress,
  type LeadAddressParts,
} from '@/lib/lead-address'

// The label every drift-discovered address carries. Both writers use these.
export const DRIFT_LABEL = 'other' as const
export const DRIFT_LABEL_NOTE = 'Found in Jobber'

// Jobber's SINGLE_PROPERTY_QUERY address shape. `province` is Jobber's name
// for what we store as `state`; nothing else needs translating.
export interface JobberPropertyAddress {
  street?: string | null
  city?: string | null
  province?: string | null
  postalCode?: string | null
}

export type DriftSkipReason = 'no_address' | 'matches_primary' | 'matches_existing'

export type DriftPlan =
  | { action: 'create'; entry: FormerAddress }
  | { action: 'skip'; reason: 'no_address' }
  | { action: 'skip'; reason: 'matches_primary' }
  | { action: 'skip'; reason: 'matches_existing'; index: number; retired: boolean }

export interface PlanDriftInput {
  lead: LeadAddressParts
  formerAddresses: FormerAddress[]
  address: JobberPropertyAddress | null | undefined
  jobberPropertyId: string | null | undefined
  nowIso: string
}

// Is this Jobber property an address the client's card already carries — and
// if not, what entry should be appended?
//
// MATCH ORDER matters, and each step earns its place:
//   1. no street / nothing composable → skip. A blank address row is worse
//      than the drift it would fix; the four id-only rows in the held
//      backfill script are skipped for the same reason.
//   2. it IS the primary address → skip. The primary lives in the columns,
//      not in the list; recording it twice makes the card lie about how many
//      addresses the client has.
//   3. same jobber_property_id → skip. The id is IDENTITY: it survives an
//      address edit on either side, so a corrected street still resolves to
//      the entry we already hold rather than creating a second one.
//   4. same normalized display → skip. Catches entries recorded before the
//      id was known (the held backfill writes two of those with a null id).
//   5. otherwise → create.
//
// A RETIRED match still skips, and STAYS retired. An inbound Jobber event is
// not the owner changing their mind about a retirement they made — Jobber has
// no archive, so the property being alive over there says nothing about
// whether Bee Hub should be offering it at send time. The caller is told
// `retired: true` so its note can say which entry matched and in what state.
//
// Comparison is normalizeAddressKey, the same key the address card uses to
// decide an edit is a no-op — so casing and punctuation cannot manufacture a
// duplicate ("10 Old Rd" vs "10 old rd." are the same address).
export function planDriftAddress(input: PlanDriftInput): DriftPlan {
  const { lead, formerAddresses, address, jobberPropertyId, nowIso } = input

  const street = String(address?.street ?? '').trim()
  const city   = String(address?.city ?? '').trim()
  const state  = String(address?.province ?? '').trim()
  const zip    = String(address?.postalCode ?? '').trim()

  // 1. Nothing usable.
  const display = street ? composeLeadAddress({ street, city, state, zip }) : ''
  if (!street || !display) return { action: 'skip', reason: 'no_address' }

  const key = normalizeAddressKey(display)

  // 2. It is the primary address already.
  const primary = formatLeadAddress(lead)
  if (primary && normalizeAddressKey(primary) === key) {
    return { action: 'skip', reason: 'matches_primary' }
  }

  const list = Array.isArray(formerAddresses) ? formerAddresses : []
  const propId = jobberPropertyId ? String(jobberPropertyId) : ''

  // 3. Same property id — identity wins over text.
  if (propId) {
    const i = list.findIndex(e => String(e?.jobber_property_id ?? '') === propId)
    if (i >= 0) {
      return { action: 'skip', reason: 'matches_existing', index: i, retired: isRetiredAddress(list[i]) }
    }
  }

  // 4. Same address text — an entry recorded before we knew the id.
  const j = list.findIndex(e => !!e?.display && normalizeAddressKey(e.display) === key)
  if (j >= 0) {
    return { action: 'skip', reason: 'matches_existing', index: j, retired: isRetiredAddress(list[j]) }
  }

  // 5. Genuinely new to us.
  const entry = buildAddedAddress(
    { street, city, state, zip },
    propId || null,
    DRIFT_LABEL,
    DRIFT_LABEL_NOTE,
    nowIso,
  )
  // buildAddedAddress only returns null without a street or display, both
  // already proven above — but it is typed nullable, so honour that rather
  // than assert past it.
  if (!entry) return { action: 'skip', reason: 'no_address' }
  return { action: 'create', entry }
}

export type DestroyPlan =
  | { action: 'retire'; index: number; next: FormerAddress[] }
  | { action: 'skip'; reason: 'no_property_id' | 'not_held' | 'already_retired' }

// A property deleted in Jobber that the client holds as one of their OTHER
// addresses. Today nothing happens to it: the send-time picker keeps offering
// it, and the send then FAILS, because a second address resolves to a
// property that must already exist and the push refuses to create one.
//
// RETIRE, never delete. Same semantics as the owner's own "Stop using"
// control: the address, its label and its history stay on the card, Bee Hub
// just stops offering it. An address deleted in Jobber must not silently
// vanish from Bee Hub — the owner's record of where their client lived is
// theirs, not Jobber's, and a row disappearing is a row nobody can ask about.
//
// Already-retired is a skip, not a rewrite: re-stamping an entry the owner
// retired weeks ago would move it in any history that reads the entry, for
// no change in meaning.
export function planDestroyedProperty(
  formerAddresses: FormerAddress[],
  jobberPropertyId: string | null | undefined,
): DestroyPlan {
  const propId = jobberPropertyId ? String(jobberPropertyId) : ''
  if (!propId) return { action: 'skip', reason: 'no_property_id' }

  const list = Array.isArray(formerAddresses) ? formerAddresses : []
  const index = list.findIndex(e => String(e?.jobber_property_id ?? '') === propId)
  if (index < 0) return { action: 'skip', reason: 'not_held' }
  if (isRetiredAddress(list[index])) return { action: 'skip', reason: 'already_retired' }

  const next = list.map((e, i) => (i === index ? { ...e, status: 'retired' as const } : e))
  return { action: 'retire', index, next }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE LOOSE KEY — reporting only, deliberately not wired in yet.
//
// WHY IT EXISTS. The first dry run of the backfill sweep came back with 1,336
// would-creates against an expected ~137. Reading the output, a large share are
// the SAME address written differently rather than a second property: a zip
// present on one side and missing on the other, zip+4 against a bare zip, a
// state spelled out against its abbreviation, "Ave" against "Avenue", and
// primaries whose stored address repeats its own city/state/zip tail — one
// repeats it three times.
//
// normalizeAddressKey, which planDriftAddress uses, is a STRICT key: it strips
// case and punctuation and nothing else, so every one of those reads as a
// different address. That strictness is right for the webhook — writing a
// duplicate onto an owner's card is worse than missing one — and it is not
// being changed here.
//
// ─────────────────────────────────────────────────────────────────────────
// NOTHING BELOW IS CALLED BY planDriftAddress. This commit adds a way to
// COUNT the near-duplicates, not a way to act on them. The create/skip
// decision, the webhook, and what --commit writes are all exactly as they
// were. It lives in this file rather than in the sweep so that promoting it
// to the real matcher later is a wiring change here, not a move.
// ─────────────────────────────────────────────────────────────────────────
//
// TWO KINDS OF "the same street address", and they must not be conflated.
// Apartment 3 and apartment 5 in one building are two genuinely different
// properties that an owner will want on the card. So the unit is held apart
// from the key: it never makes two addresses fail to match, and a difference
// in it is reported as its own outcome rather than folded into either answer.

// Spelling variants of the SAME street type, collapsed onto one token. Every
// entry here maps forms of one type together — no two DIFFERENT types share a
// canonical form — so this can merge "Ave" with "Avenue" and can never merge
// "Ct" with "Cir".
const STREET_TYPES = new Map<string, string>(Object.entries({
  avenue: 'ave', ave: 'ave', av: 'ave',
  street: 'st', st: 'st', str: 'st',
  road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr', drv: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct', crt: 'ct',
  boulevard: 'blvd', blvd: 'blvd', boul: 'blvd',
  terrace: 'ter', ter: 'ter', terr: 'ter',
  place: 'pl', pl: 'pl',
  circle: 'cir', cir: 'cir', circ: 'cir',
  parkway: 'pkwy', pkwy: 'pkwy', pky: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  // Beyond Kevin's list, and safe for the same reason: each line is spellings
  // of one type, so the worst it can do is match an address to itself.
  trail: 'trl', trl: 'trl',
  square: 'sq', sq: 'sq',
  crossing: 'xing', xing: 'xing',
  point: 'pt', pt: 'pt',
  heights: 'hts', hts: 'hts',
  way: 'way', loop: 'loop', run: 'run', path: 'path', park: 'park',
}))

const DIRECTIONALS = new Map<string, string>(Object.entries({
  north: 'n', n: 'n',
  south: 's', s: 's',
  east: 'e', e: 'e',
  west: 'w', w: 'w',
  northeast: 'ne', ne: 'ne',
  northwest: 'nw', nw: 'nw',
  southeast: 'se', se: 'se',
  southwest: 'sw', sw: 'sw',
}))

// A designator only counts when something follows it to name the unit, so a
// street that merely ends in one of these words is left alone. That matters
// most for "fl": it is Florida in a tail segment and a floor in a street, and
// requiring a following token keeps a bare trailing "Fl" from being eaten.
const UNIT_WORDS = new Set([
  'apt', 'apartment', 'unit', 'ste', 'suite', 'bldg', 'building',
  'fl', 'floor', 'rm', 'room', 'lot', 'spc', 'space', 'trlr', 'trailer',
])

const STATES = new Map<string, string>(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'puerto rico': 'PR',
}))
const STATE_CODES = new Set(Array.from(STATES.values()))

const ZIP_RE = /^(\d{5})(?:-\d{4})?$/

const words = (s: string): string[] =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/[^a-z0-9# ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Is this whole segment a state, in either form? */
function asState(segment: string): string | null {
  const t = String(segment ?? '').trim().toLowerCase().replace(/\./g, '')
  if (!t) return null
  if (t.length === 2 && STATE_CODES.has(t.toUpperCase())) return t.toUpperCase()
  return STATES.get(t) ?? null
}

/**
 * Drop a repeated trailing run of segments.
 *
 * "…, Denver, CO, 80210, Denver, CO, 80210" is one address whose stored form
 * carries its own tail twice; a Palm Beach primary carries it three times.
 * Longest repeat first, and looping, so a triple collapses the same way a
 * double does.
 */
function collapseRepeatedTail(segments: string[]): { segments: string[]; collapsed: boolean } {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
  let out = segments.slice()
  let collapsed = false
  for (;;) {
    let cut = false
    for (let k = Math.floor(out.length / 2); k >= 1; k--) {
      const tail = out.slice(out.length - k).map(norm).join('|')
      const before = out.slice(out.length - 2 * k, out.length - k).map(norm).join('|')
      if (tail && tail === before) {
        out = out.slice(0, out.length - k)
        collapsed = true
        cut = true
        break
      }
    }
    if (!cut) break
  }
  return { segments: out, collapsed }
}

/** Pull a unit off a street's tokens. Returns the street without it. */
function splitUnit(tokens: string[]): { street: string[]; unit: string } {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('#')) {
      const id = [t.slice(1), ...tokens.slice(i + 1)].filter(Boolean).join(' ')
      if (id) return { street: tokens.slice(0, i), unit: id }
    }
    if (UNIT_WORDS.has(t) && i < tokens.length - 1) {
      return { street: tokens.slice(0, i), unit: tokens.slice(i + 1).join(' ') }
    }
  }
  return { street: tokens, unit: '' }
}

/** Does this whole segment read as a unit — "Apt 4", "#3", "Suite 200"? */
function segmentIsUnit(segment: string): string | null {
  const t = words(segment)
  if (!t.length) return null
  if (t[0].startsWith('#')) return [t[0].slice(1), ...t.slice(1)].filter(Boolean).join(' ') || null
  if (UNIT_WORDS.has(t[0]) && t.length > 1) return t.slice(1).join(' ')
  return null
}

function normalizeStreet(tokens: string[]): string {
  // Directionals anywhere; the type only at the end. Doing the type pass on
  // the LAST non-directional token — rather than on any token that looks like
  // one — is what keeps "South Saint Paul Street" from becoming
  // "s street paul st": "Saint" is not at the end, so it is never read as a
  // street type. It also lets "Main Street N" and "Main St N" agree.
  const t = tokens.map((x) => DIRECTIONALS.get(x) ?? x)
  let i = t.length - 1
  while (i > 0 && DIRECTIONALS.has(t[i])) i--
  if (i > 0 && STREET_TYPES.has(t[i])) t[i] = STREET_TYPES.get(t[i])!
  return t.join(' ')
}

export interface LooseAddress {
  /** street | city | state | zip5, all normalized. The promotable key. */
  key: string
  street: string
  city: string
  /** Two-letter, or '' when nothing in the tail read as a state. */
  state: string
  /** First five digits only, or '' when there is no zip. */
  zip5: string
  /** Held apart from the key on purpose — see the header. */
  unit: string
  raw: {
    street: string
    city: string
    state: string
    zip: string
    /** True when a repeated city/state/zip tail had to be dropped. */
    repeatedTail: boolean
  }
}

export interface LooseAddressInput {
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

/**
 * Parse a display string — or address parts — into the loose form.
 *
 * Works from the rendered string because that is where the defects are: the
 * repeated tail lives inside the stored address column, and a state spelled
 * out or a zip+4 arrives as text. Parts are composed into the same shape first
 * so there is one code path and not two that can disagree.
 */
export function parseLooseAddress(input: string | LooseAddressInput | null | undefined): LooseAddress {
  const text =
    typeof input === 'string'
      ? input
      : [input?.street, input?.city, input?.state, input?.zip]
          .map((p) => String(p ?? '').trim())
          .filter(Boolean)
          .join(', ')

  const blank: LooseAddress = {
    key: '', street: '', city: '', state: '', zip5: '', unit: '',
    raw: { street: '', city: '', state: '', zip: '', repeatedTail: false },
  }
  if (!String(text ?? '').trim()) return blank

  const split = String(text).split(',').map((s) => s.trim()).filter(Boolean)
  const { segments, collapsed } = collapseRepeatedTail(split)
  if (!segments.length) return blank

  // Units first, so an "Apt 4" segment is never mistaken for the city.
  let unit = ''
  const rest: string[] = []
  for (let i = 1; i < segments.length; i++) {
    const u = segmentIsUnit(segments[i])
    if (u && !unit) unit = u
    else rest.push(segments[i])
  }

  const streetTokens = words(segments[0])
  const { street: streetOnly, unit: inlineUnit } = splitUnit(streetTokens)
  if (!unit) unit = inlineUnit

  // Zip, then state, scanned from the end — formatLeadAddress renders them as
  // one "ST 12345" segment while composeLeadAddress renders them as two, and
  // both shapes are in the data.
  let rawZip = ''
  let zip5 = ''
  let rawState = ''
  let state = ''

  for (let i = rest.length - 1; i >= 0 && !zip5; i--) {
    const toks = rest[i].split(/\s+/).filter(Boolean)
    const last = toks[toks.length - 1] ?? ''
    const m = last.match(ZIP_RE)
    if (m) {
      rawZip = last
      zip5 = m[1]
      rest[i] = toks.slice(0, -1).join(' ')
    }
  }
  for (let i = rest.length - 1; i >= 0 && !state; i--) {
    if (!rest[i]) continue
    const s = asState(rest[i])
    if (s) {
      rawState = rest[i]
      state = s
      rest[i] = ''
    }
  }

  const cityParts = rest.filter(Boolean)
  const rawCity = cityParts.length ? cityParts[cityParts.length - 1] : ''
  const city = words(rawCity).join(' ')
  const street = normalizeStreet(streetOnly)

  return {
    key: [street, city, state, zip5].join('|'),
    street,
    city,
    state,
    zip5,
    unit: words(unit).join(''),
    raw: { street: segments[0], city: rawCity, state: rawState, zip: rawZip, repeatedTail: collapsed },
  }
}

/** The single-string form, for when this is promoted to a real matcher. */
export function looseAddressKey(input: string | LooseAddressInput | null | undefined): string {
  return parseLooseAddress(input).key
}

export type LooseMatch = 'match' | 'unit_differs' | 'no_match'

/**
 * Compare two addresses loosely.
 *
 * The street must agree — nothing else can rescue a mismatch there. City,
 * state and zip5 are compared ONLY where both sides carry one, because a zip
 * missing from the primary is the single commonest defect in the run and it
 * says nothing about whether the two are the same place.
 *
 * A unit difference is its own answer, never a mismatch and never a match: two
 * units in one building are two properties. A unit on one side and none on the
 * other counts as a difference too — that is the cautious direction, since
 * 'unit_differs' keeps a row in front of Kevin and 'match' is what dismisses
 * it.
 */
export function compareLoose(a: LooseAddress, b: LooseAddress): LooseMatch {
  if (!a.street || !b.street) return 'no_match'
  if (a.street !== b.street) return 'no_match'
  if (a.city && b.city && a.city !== b.city) return 'no_match'
  if (a.state && b.state && a.state !== b.state) return 'no_match'
  if (a.zip5 && b.zip5 && a.zip5 !== b.zip5) return 'no_match'
  if (a.unit !== b.unit) return 'unit_differs'
  return 'match'
}

/**
 * What actually differs between two addresses the loose key calls the same —
 * in Kevin's words, not the parser's. Ordered so the commonest defect in the
 * run reads first.
 */
export function describeLooseDifference(a: LooseAddress, b: LooseAddress): string {
  const why: string[] = []
  if (!!a.zip5 !== !!b.zip5) why.push('a zip on one and not the other')
  else if (a.zip5 && a.raw.zip !== b.raw.zip) why.push('zip+4 against a plain zip')
  if (a.raw.repeatedTail || b.raw.repeatedTail) why.push('a repeated city/state/zip tail')
  if (a.state && b.state && a.raw.state.toLowerCase() !== b.raw.state.toLowerCase()) {
    why.push('the state spelled out against its abbreviation')
  }
  if (a.raw.street.toLowerCase() !== b.raw.street.toLowerCase() && a.street === b.street) {
    why.push('the street type or direction written differently')
  }
  if (a.city && b.city && a.raw.city.toLowerCase() !== b.raw.city.toLowerCase()) {
    why.push('the city written differently')
  }
  if (!why.length) return 'only punctuation or spacing'
  if (why.length === 1) return `only ${why[0]}`
  return `${why.slice(0, -1).join(', ')} and ${why[why.length - 1]}`
}
