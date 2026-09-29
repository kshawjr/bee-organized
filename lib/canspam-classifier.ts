// lib/canspam-classifier.ts
//
// The CAN-SPAM content rules, in ONE place, for two readers:
//
//   • lib/beta-drip-canspam-tripwire.test.ts — the repo check. Runs these
//     rules over the master copy in migrations/ on every test run.
//   • scripts/scan-canspam-live.mjs — the live check. Runs the SAME rules over
//     what production actually holds: every master, every location's own drip
//     sequences, and every owner-edited copy of a standalone template. Those
//     live only in the database, out of a repo test's reach.
//
// Sharing the rules means the two checks cannot quietly disagree about what
// counts as promotional.
//
// PURE — no imports, erasable TypeScript only — so Node can load it straight
// from a .mjs script (node strips the types) as well as from vitest.
//
// The audit this encodes (7/24, reassessed 2026-09-27/28):
//   COMMERCIAL, sent WITH the #115 unsubscribe footer:
//     welcome, opp_closed_job_3mo, opp_closed_job_12mo
//   TRANSACTIONAL, sent with NO footer:
//     every drip step, and the four opp_*_estimate follow-ups
//   A footer-less email may carry INCIDENTAL promo (the Google Reviews line,
//   the Profiles Quiz) without its primary purpose flipping — but an offer or
//   the brand story, or losing any reference to the recipient's own enquiry,
//   is a reason to look again.

// Promo-marker lexicon. A body's profile is the sorted list of marker names it
// matches. Growing this lexicon is encouraged; shrinking it means the CAN-SPAM
// assessment was redone.
export const PROMO_MARKERS: Record<string, RegExp> = {
  reviews: /google reviews|\{\{reviews_link\}\}/i,
  quiz: /profiles? quiz/i,
  brand_story: /how we came to bee|national franchise/i,
  offer: /free hour|% off|\boff your next\b|maintenance program|discount|special offer/i,
}

// A transactional email must actually be about the recipient's inquiry.
// 'enquir|inquir' added 2026-09-28: the returning-client sequences (written
// after the original audit) say "We've got your enquiry" — the most direct
// reference there is — and the list, built from the new-lead copy, missed it.
export const TRANSACTIONAL_ANCHOR =
  /assessment|discovery|estimate|schedul|availability|interested|your (project|move)|enquir|inquir/i

// Promo that does not flip a footer-less email's primary purpose.
export const INCIDENTAL_PROMO = ['reviews', 'quiz']

export function promoProfile(body: string): string[] {
  return Object.keys(PROMO_MARKERS)
    .filter((k) => PROMO_MARKERS[k].test(body))
    .sort()
}

// The standalone templates that carry the #115 footer (keyed on legacy_id; an
// owner-edited copy inherits its master's key — the footer decision in
// lib/welcome-email.ts / lib/stage-emails.ts is keyed on the template, never
// on the body, so an edit cannot remove it).
export const COMMERCIAL_PRIMARY = ['welcome', 'opp_closed_job_3mo', 'opp_closed_job_12mo']

// ── The per-body pins for the standard (master) copy ─────────────────────
// Every step-1 signs off with the Google Reviews line; five step-2s carry the
// Profiles Quiz paragraph; every step-3 (and moving-a/b/c step 2) is
// promo-free. Incidental under primary-purpose — allowed, but pinned per body.
export const PINNED_PATHS = [
  'organizing-a', 'organizing-b', 'organizing-c', 'organizing-d',
  'moving-a', 'moving-b', 'moving-c', 'moving-d',
]
const QUIZ_STEP2_PATHS = ['organizing-a', 'organizing-b', 'organizing-c', 'organizing-d', 'moving-d']

export const EXPECTED_STEP_PROFILES: Record<string, string[]> = {}
for (const p of PINNED_PATHS) {
  EXPECTED_STEP_PROFILES[`${p}#1`] = ['reviews']
  EXPECTED_STEP_PROFILES[`${p}#2`] = QUIZ_STEP2_PATHS.includes(p) ? ['quiz'] : []
  EXPECTED_STEP_PROFILES[`${p}#3`] = []
}

export const EXPECTED_TEMPLATE_PROFILES: Record<string, string[]> = {
  welcome: ['brand_story', 'quiz'],
  opp_closed_job_3mo: ['offer'],
  opp_closed_job_12mo: [],
  opp_organizing_estimate_3d: [],
  opp_organizing_estimate_30d: [],
  opp_moving_estimate_3d: [],
  opp_moving_estimate_30d: [],
}

// ── The live verdict ─────────────────────────────────────────────────────
export type LiveEmail = {
  // 'organizing-a#1' for a step, 'welcome' / 'opp_closed_job_3mo' for a template
  key: string
  // true for the corp master; false for a location's own copy
  isMaster: boolean
  // does this email go out with the #115 unsubscribe footer?
  footered: boolean
  // the text that actually sends (a step's own body, else its linked template's)
  body: string
}

export type LiveFinding = {
  // 'problem' — a footer-less email that now reads as promotional;
  // 'changed' — a master no longer matches what was assessed.
  level: 'problem' | 'changed'
  reason: string
}

export function auditLiveEmail(e: LiveEmail): LiveFinding[] {
  const found: LiveFinding[] = []
  const profile = promoProfile(e.body)

  if (!e.footered) {
    const promo = profile.filter((m) => !INCIDENTAL_PROMO.includes(m))
    if (promo.length) {
      found.push({
        level: 'problem',
        reason: `promotional content (${promo.join(', ')}) in an email that has no unsubscribe footer`,
      })
    }
    if (!TRANSACTIONAL_ANCHOR.test(e.body)) {
      found.push({
        level: 'problem',
        reason: "doesn't mention the recipient's own enquiry, which is what lets it go without an unsubscribe footer",
      })
    }
  }

  if (e.isMaster) {
    const expected = EXPECTED_STEP_PROFILES[e.key] ?? EXPECTED_TEMPLATE_PROFILES[e.key]
    if (expected && JSON.stringify(profile) !== JSON.stringify(expected)) {
      found.push({
        level: 'changed',
        reason: `standard copy changed since it was assessed: promo was [${expected.join(', ')}], now [${profile.join(', ')}]`,
      })
    }
  }

  return found
}
