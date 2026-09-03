// components/hive/shared/returningVariant.js
// ─────────────────────────────────────────────────────────────
// PURE module — which returning-client path a location gets.
//
// The ordinary drips handle "do you put your rate in the email?" and "do
// people book online?" with VARIANT TEMPLATES, not conditional blocks: the
// two answers pick a letter (issue 194, pathStyleFromAnswers in BeeHub.jsx),
// and the four master paths differ only in whether their bodies contain the
// {{rate_per_hour}} / {{book_assessment_link}} tags at all.
//
//   a  reply       + rate in email    → rate paragraph, no booking sentence
//   b  book online + rate in email    → both
//   c  reply       + rate on the call → neither  (needs nothing set up)
//   d  book online + rate on the call → booking sentence, no rate
//
// The returning-client sequence follows the SAME letter as the location's
// organizing default (locations.default_drip_path, e.g. 'organizing-c' →
// 'returning-c'), so an owner who answered "no" to either question gets
// returning emails that never mention it — and is never held for a
// preference they declined. Held stays what it was: a template that quotes
// a tag whose value is blank.
//
// No default set (an owner who chose "custom" or never finished the two
// questions) → 'returning-c', the variant with nothing that can be held.
//
// Shared by lib/drip-lifecycle.ts (enrolment) and BeeHub.jsx (the Settings
// › Emails group), so the two can never disagree about which emails send.
// ─────────────────────────────────────────────────────────────

export const RETURNING_PATH_PREFIX = 'returning-'
export const RETURNING_PATH_KEYS = ['returning-a', 'returning-b', 'returning-c', 'returning-d']
export const RETURNING_FALLBACK_KEY = 'returning-c'

export function returningPathKeyFor(defaultPathKey) {
  const letter = String(defaultPathKey || '').trim().slice(-1)
  return ['a', 'b', 'c', 'd'].includes(letter) ? `${RETURNING_PATH_PREFIX}${letter}` : RETURNING_FALLBACK_KEY
}

export function isReturningPathKey(pathKey) {
  return RETURNING_PATH_KEYS.includes(pathKey)
}
