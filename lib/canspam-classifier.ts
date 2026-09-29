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
// PURE — erasable TypeScript only, and no imports beyond Node's own crypto —
// so Node can load it straight from a .mjs script (node strips the types) as
// well as from vitest.

import { createHash } from 'node:crypto'
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

// ── Reviewed and accepted: no-footer emails that don't name the enquiry ──
//
// WHY THESE ARE ACCEPTED (Kevin, 2026-09-28): each is a short NUDGE in a
// "Returning client" sequence — the 2nd or 3rd email, sent only after a past
// client has got back in touch and email 1 has acknowledged their enquiry
// ("Thanks for getting back in touch. We've got your enquiry…"). They follow
// up on that same request — "Just making sure this didn't get buried… Reply
// whenever suits", "If you'd still like a hand, just reply and we'll sort out
// a time" — and contain NO offer, no discount, no brand story, nothing to
// sell. Their primary purpose is the client's own open request, so they go
// without an unsubscribe footer like the rest of the drip. The rules flag them
// only because they don't use a word like "enquiry" or "schedule" that a text
// check can see.
//
// HOW THE ACCEPTANCE WORKS: each entry is tied to one place, one email in one
// sequence, and the SHA-256 fingerprint of its exact text (the text that
// sends — the step's own body, else its linked template's). Change one word
// and the fingerprint no longer matches, so the email is flagged again and
// someone reads it again. The same text turning up somewhere new is flagged
// too — it gets its own look. Only the "doesn't mention the enquiry" finding
// is waived; the offer/brand-story check still runs on every email.
//
// To accept another: read it, confirm it is a nudge on the client's own
// request with nothing to sell, add an entry with its current fingerprint,
// and say why here if the reason differs.
export type AcceptedEmail = {
  place: string // 'standard', or the location's id (stable across renames)
  key: string // '<path_key>#<step_order>'
  fingerprint: string // sha256 hex of the exact text
  label: string // for people: where it is and how it opens
}

export const STANDARD = 'standard'

const NUDGE_BURIED = 'dc8b923d00788170e4d34c701478575e4331eeb42cae584c95fc33ec2b981858' // "Just making sure this didn't get buried… Reply whenever suits and we'll pick it up."
const NUDGE_LAST = '2d711276f37f013f152f0233b8f3e72edad1e6d5d052d60e410d070dd7763d65' // "This is the last you'll hear from us on this one. If you'd still like a hand, just reply…"
const NORTH_HOUSTON = 'ffed5dfb-0b2e-4812-be19-9dbb34c92290'
const WEST_ST_LOUIS = 'da63ea96-5b64-474b-a961-fa2c038dad89'
const SAN_DIEGO = 'a626445b-6d9f-44ef-bd7d-f52b50b3c1be'

export const ACCEPTED_WITHOUT_ENQUIRY_WORDS: AcceptedEmail[] = [
  { place: STANDARD, key: 'returning-a#2', fingerprint: NUDGE_BURIED, label: 'Standard — Returning client Path A, email 2 ("didn\'t get buried")' },
  { place: STANDARD, key: 'returning-a#3', fingerprint: NUDGE_LAST, label: 'Standard — Returning client Path A, email 3 ("the last you\'ll hear from us")' },
  { place: STANDARD, key: 'returning-c#2', fingerprint: NUDGE_BURIED, label: 'Standard — Returning client Path C, email 2 ("didn\'t get buried")' },
  { place: STANDARD, key: 'returning-c#3', fingerprint: NUDGE_LAST, label: 'Standard — Returning client Path C, email 3 ("the last you\'ll hear from us")' },
  { place: WEST_ST_LOUIS, key: 'returning-c#2', fingerprint: NUDGE_BURIED, label: 'West St Louis — Returning client Path C, email 2 (unchanged standard text)' },
  { place: WEST_ST_LOUIS, key: 'returning-c#3', fingerprint: NUDGE_LAST, label: 'West St Louis — Returning client Path C, email 3 (unchanged standard text)' },
  {
    place: NORTH_HOUSTON,
    key: 'returning-c#2',
    fingerprint: '23a61124391cc3ec87efd0293fe0e3ee5bf4ed85c6b076a7dfda2480d49eb1b6',
    label: 'North Houston — Returning client Path C, email 2 ("didn\'t get buried… reach out when you\'re ready!")',
  },
  {
    place: SAN_DIEGO,
    key: 'returning-a#2',
    fingerprint: '330b9858422067db286b4c6fff81e9c127d6412b4b1edb4acc4db1e881c9ff82',
    label: 'San Diego — Returning client Path A, email 2 ("our messages didn\'t get buried… your next organizing project")',
  },
]

export function fingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

function isAccepted(e: LiveEmail): boolean {
  if (!e.place) return false
  const fp = fingerprint(e.body)
  return ACCEPTED_WITHOUT_ENQUIRY_WORDS.some((a) => a.place === e.place && a.key === e.key && a.fingerprint === fp)
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
  // 'standard' or the location id — only needed to match an accepted email
  place?: string
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
    if (!TRANSACTIONAL_ANCHOR.test(e.body) && !isAccepted(e)) {
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
