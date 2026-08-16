// lib/sequence-senders.ts
// ─────────────────────────────────────────────────────────────
// WHAT ONE DRIP SEQUENCE SENDS AS (issue 303).
//
// THE DEFECT THIS EXISTS TO END. The Emails tab shows one sequence at a time
// behind an Organizing / Moving toggle, and under it a card headed "who these
// come from" that read the LOCATION's sending identity. The card was telling
// the truth about itself and lying about its context: it said "Lynette Ewy"
// whichever sequence was on screen, directly beneath four moving emails that go
// out as Carol Kern. Kevin, who built the screen, could not tell from it who
// the moving emails came from.
//
// A SEQUENCE IS A FAMILY, AND A FAMILY IS ONE-TO-MANY OVER JOB TYPES. This is
// the trap. The toggle picks a drip_category — 'general' or 'move' — and each
// one covers however many project types carry that category. Production today:
//
//   move     Moving/Relocation
//   general  Home or Office Organizing, Concierge Services, Other
//
// So Moving has one answer, and Organizing has one answer only because all
// three of its types happen to resolve to the same person at loc_kc. BOTH ARE
// COINCIDENCES OF TODAY'S DATA. Reactivating Move-In Organization (inactive,
// drip_category 'move') or giving one organizing type to a different handler
// makes the correct answer a LIST. Hence the shape here: `rows` is always the
// full per-type answer and is the thing to render; `uniform` is a
// convenience for the degenerate case where every row agrees, never the
// primary. Picking the first row, or averaging, or falling back to the location
// default to avoid a list, would each re-introduce the original lie.
//
// IT MIRRORS THE SEND PATH, IT DOES NOT RESTATE IT. Three rules decide what a
// client actually sees, and all three live elsewhere:
//   · which types are in the family    lookups.attrs.drip_category, carried on
//                                      SenderConfig.project_type_groups.
//   · is the handler still a person    lib/project-type-handlers.ts, carried on
//                                      each assignment as handler_active.
//   · typed identity vs the handler's  sender_is_custom, on the row.
// What is left — combining them per type and noticing when they disagree — is
// UI shaping, and that is all this module does. It is pure and takes the
// payload, so it is testable without a DB and cannot drift from what the tab
// actually received.
//
// PURE + client-safe: TYPE-ONLY import below, so nothing pulls
// lib/supabase-service into the browser bundle.
// ─────────────────────────────────────────────────────────────

import type { SenderConfig } from './project-type-senders'

export type SequenceFamily = 'move' | 'general'

// One resolved answer to "whose name and address go on this mail".
export type SequenceSender = {
  name: string
  email: string
  // The EFFECTIVE reply-to, never null. Person mode stores no reply-to of its
  // own and lib/resend.ts resolves `override.sender_reply_to ?? reply_to_email`
  // at send time; an owner reading a card wants the address replies land at,
  // not a null meaning "look somewhere else".
  replyTo: string
  // A hand-typed identity — usually a shared mailbox — rather than a person's
  // own (issue 296). Worth surfacing: "Carol Kern" on a row whose mail actually
  // says moving@beeorganized-kc.com is issue 303's defect in a new place.
  typed: boolean
  // Nothing per-type applies to this job type, so it sends as the location's
  // own sending identity.
  isDefault: boolean
}

export type SequenceSenderRow = { projectType: string; sender: SequenceSender }

export type SequenceSenderReport = {
  family: SequenceFamily
  // Every active job type in this family, in lookups order. THE answer.
  rows: SequenceSenderRow[]
  // Non-null only when every row sends identically — the case where naming one
  // sender is the whole truth. Null means render the list.
  uniform: SequenceSender | null
  // Does some job type IN THIS SEQUENCE fall through to the location default?
  // NOTE this is not the only way the default gets used — see the caller's copy
  // and the note on locationDefault below.
  usesDefault: boolean
  locationDefault: SequenceSender
}

export type LocationDefaultInput = {
  name?: string | null
  email?: string | null
  replyTo?: string | null
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

// The location's own identity, as the send path assembles it: reply-to falls
// back to the send-from address when unset, matching lib/resend.ts.
export function locationDefaultSender(loc: LocationDefaultInput): SequenceSender {
  const email = clean(loc?.email)
  return {
    name: clean(loc?.name),
    email,
    replyTo: clean(loc?.replyTo) || email,
    typed: false,
    isDefault: true,
  }
}

function sameSender(a: SequenceSender, b: SequenceSender): boolean {
  return (
    a.email.toLowerCase() === b.email.toLowerCase() &&
    a.name === b.name &&
    a.replyTo.toLowerCase() === b.replyTo.toLowerCase() &&
    a.typed === b.typed &&
    a.isDefault === b.isDefault
  )
}

// What ONE job type sends as, given its handler row (or the absence of one).
//
// The three ways a type lands on the location default are deliberately NOT
// distinguished in the output — no row, an offboarded person-mode handler, or a
// row carrying no address all mean the same thing to a client, which is the
// only reader whose experience this card is describing.
function senderForType(
  assignment: SenderConfig['assignments'][number] | undefined,
  fallback: SequenceSender,
): SequenceSender {
  if (!assignment) return fallback

  const email = clean(assignment.sender_email)
  // Mirrors lib/resend.ts, which only overrides when there is an address to
  // override WITH: `if (override?.sender_email)`.
  if (!email) return fallback

  if (assignment.sender_is_custom) {
    // A typed identity outlives its handler on purpose (issue 296) — a mailbox
    // does not stop existing when someone leaves — so handler_active is not
    // consulted here.
    return {
      name: clean(assignment.sender_name) || email,
      email,
      replyTo: clean(assignment.sender_reply_to) || fallback.replyTo,
      typed: true,
      isDefault: false,
    }
  }

  // Person mode. An offboarded handler is dropped by getLocationHandlers, so
  // the type really does send as the location default — saying "Carol Kern"
  // here because the row still says so is the whole bug, one layer down.
  if (!assignment.handler_active) return fallback

  return {
    name: clean(assignment.sender_name) || email,
    email,
    // Person mode stores no reply-to of its own; replies follow the location.
    replyTo: clean(assignment.sender_reply_to) || fallback.replyTo,
    typed: false,
    isDefault: false,
  }
}

// The full answer for one sequence. `config` is the /project-type-senders GET
// payload; `family` is the tab's toggle.
export function resolveSequenceSenders(
  config: Partial<SenderConfig> | null | undefined,
  family: SequenceFamily,
  locationDefault: LocationDefaultInput | SequenceSender,
): SequenceSenderReport {
  const fallback: SequenceSender =
    'isDefault' in (locationDefault as SequenceSender)
      ? (locationDefault as SequenceSender)
      : locationDefaultSender(locationDefault as LocationDefaultInput)

  const groups = config?.project_type_groups || []
  const assignments = config?.assignments || []

  // Case-insensitive, matching the DB's ..._loc_type_ci_idx: the server
  // canonicalizes labels on write and the index guarantees at most one row per
  // type, so this lookup cannot be ambiguous.
  const byType = new Map<string, SenderConfig['assignments'][number]>()
  for (const a of assignments) {
    const key = clean(a?.project_type).toLowerCase()
    if (key) byType.set(key, a)
  }

  const rows: SequenceSenderRow[] = groups
    .filter(g => g && g.drip_category === family && clean(g.label))
    .map(g => ({
      projectType: clean(g.label),
      sender: senderForType(byType.get(clean(g.label).toLowerCase()), fallback),
    }))

  const uniform =
    rows.length > 0 && rows.every(r => sameSender(r.sender, rows[0].sender))
      ? rows[0].sender
      : null

  return {
    family,
    rows,
    uniform,
    usesDefault: rows.some(r => r.sender.isDefault),
    locationDefault: fallback,
  }
}
