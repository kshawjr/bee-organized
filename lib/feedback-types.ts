// lib/feedback-types.ts
//
// ONE vocabulary for feedback_items.type. Issue 247 step 2.
//
// The column now carries four values. Two are things anyone can report, two are
// things only we file:
//
//   bug       something is broken            — owner-fileable
//   feature   something would help           — owner-fileable
//   decision  a call waiting on a person     — INTERNAL ONLY
//   hazard    a known risk, not yet an event — INTERNAL ONLY
//
// The two new ones exist because the internal backlog holds work that is
// neither a bug nor a feature. "Decide what happens to 9 locations marked
// active with no Stripe record" is a decision; "past-due pending touchpoints
// will burst-email on the first nurture run" is a hazard. Filing either as a
// bug makes the open-bug count wrong, which is the one number a single tracker
// exists to get right.
//
// ─── WHAT THIS MODULE IS *NOT* ────────────────────────────────────────
// It is NOT the write validator, and it must not become one.
//
// There are two constants named VALID_TYPES in this codebase and they mean
// different things:
//
//   app/api/feedback/route.ts        ('bug','feature')  — what an OWNER may FILE.
//                                     That narrowness IS the enforcement that an
//                                     owner can never file a decision or hazard.
//   app/api/admin/feedback/route.ts  (all four)         — what may be FILTERED on,
//                                     corp-only, read-side.
//
// They are only accidentally equal in shape today and will diverge further.
// Both stay hand-written in their own files. Nothing here is imported by
// either — importing would create exactly the coupling that lets a later
// "tidy-up" widen the owner path by accident.
//
// This module is the UI vocabulary: labels, chip families, tab names, and the
// internal-only predicate. Server-safe (no 'use client', no React) so routes
// and the reply-email builder can import it too — the same posture as
// lib/feedback-queues.

// Every value the database will accept. Mirrors feedback_items_type_check.
export const FEEDBACK_TYPES = ['bug', 'feature', 'decision', 'hazard'] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

// Enforced in the database by feedback_items_internal_type_check:
//   type IN ('bug','feature') OR is_internal
// so a row carrying one of these is guaranteed is_internal, and therefore
// guaranteed excluded from every owner-facing read (issue 247 step 1).
export const INTERNAL_ONLY_TYPES = ['decision', 'hazard'] as const

export function isKnownFeedbackType(type: unknown): boolean {
  return (FEEDBACK_TYPES as readonly string[]).includes(String(type ?? ''))
}

export function isInternalOnlyType(type: unknown): boolean {
  return (INTERNAL_ONLY_TYPES as readonly string[]).includes(String(type ?? ''))
}

// Plural, for the triage type filter chips. 'feature' reads as "Ideas" there —
// the established word on that screen since issue 126.
export const FEEDBACK_TYPE_TAB_LABEL: Record<string, string> = {
  bug: 'Bugs',
  feature: 'Ideas',
  decision: 'Decisions',
  hazard: 'Hazards',
}

// The chip family per type. These are CHIP_STYLES / T.family KEY NAMES, never
// colors — call sites resolve them through the token system, which is what
// keeps the screens free of color literals.
//
//   bug      red     — something is broken
//   feature  blue    — in-motion, the existing "idea" tone
//   decision purple  — its own category, not an urgency
//   hazard   amber   — the attention family; a risk wants the warning tone
export const FEEDBACK_TYPE_CHIP_STYLE: Record<string, string> = {
  bug: 'red',
  feature: 'blue',
  decision: 'purple',
  hazard: 'amber',
}

// An unseen value gets the neutral family — NOT the tone of a type it isn't.
export function feedbackTypeChipStyle(type: unknown): string {
  return FEEDBACK_TYPE_CHIP_STYLE[String(type ?? '')] || 'gray'
}

// What a chip SAYS for a given type.
//
// THIS IS THE FIX FOR THE THREE SILENT READ SITES. The old expression was
//   item.type === 'bug' ? 'bug' : 'feature'
// which does not merely fail to render an unknown value — it PRINTS THE WORD
// "feature" on a hazard. A falsehood is worse than an unknown, and worse than
// an error, because nobody goes looking for it.
//
// A known value renders its own name. An unknown one renders ITSELF (trimmed
// and capped), so a fifth type added to the database shows up as its own word
// on day one rather than wearing a fourth type's. An empty/missing value is the
// only case that falls back, and it falls back to a word that claims nothing.
export function feedbackTypeChipLabel(type: unknown): string {
  const raw = String(type ?? '').trim()
  if (!raw) return 'unspecified'
  return raw.slice(0, 24)
}

// Tab label for a value that may not be one of the four. Used by the triage
// filter's honesty valve — see the "Other" chip in AdminFeedbackScreen.
export function feedbackTypeTabLabel(type: unknown): string {
  return FEEDBACK_TYPE_TAB_LABEL[String(type ?? '')] || 'Other'
}
