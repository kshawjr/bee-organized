// CAN-SPAM tripwire — pins the 7/24 audit classification of every
// currently-sending automated email (drip steps, welcome, opp-stage) so
// content or rail changes force the assessment to be redone instead of
// silently shifting a footer-less email across the commercial line.
//
// The audit (7/24, scout on 8f1446e's follow-up question):
//
//   TRANSACTIONAL (no footer needed) — all 24 master drip steps and the
//   four opp_*_estimate follow-ups: each responds to the recipient's own
//   inquiry (scheduling, rates, estimate follow-up). Some carry known
//   INCIDENTAL promo lines (Google Reviews sign-off, Profiles Quiz P.S.)
//   that do not flip primary purpose — but exactly which body carries
//   which line is pinned below, so a new promo line anywhere trips.
//
//   COMMERCIAL primary purpose (needs a CAN-SPAM footer before content
//   changes or a marketing rail touches them) —
//     welcome              zero transactional content; pure brand promo
//     opp_closed_job_3mo   "1 Free Hour" offer + Maintenance Program upsell
//     opp_closed_job_12mo  year-later re-solicitation (no lexical marker,
//                          so it is hash-pinned: ANY copy edit trips)
//
// Deliberately NOT built yet (Kevin 7/24: tripwire only, no footers):
// the three send rails append no footer and mint no unsubscribe token.
// That exposure is pinned too — the day footer machinery lands, this
// file trips and the pins here get consciously updated.
//
// Scope caveat: this sweeps migrations/seed_master_drip_paths.sql, the
// repo source of master content (masters are corp-gated byte-pristine in
// prod). Location-owned clones/templates live only in the DB and are
// out of a repo test's reach — re-audit those by hand when they change.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const seedSql = readFileSync(join(ROOT, 'migrations/seed_master_drip_paths.sql'), 'utf8')

// ── Parse the seed (same shapes validated against prod in the audit) ──

type ParsedBody = { key: string; subject: string; body: string }

function parseSteps(): ParsedBody[] {
  const re =
    /SELECT dp\.id, (\d+), (\d+), 'email',\s*\n\s*'((?:[^']|'')*)',\s*\n\s*\$tpl\$([\s\S]*?)\$tpl\$,\s*\n\s*true\s*\nFROM drip_paths dp WHERE dp\.is_master = true AND dp\.path_key = '([^']+)'/g
  const out: ParsedBody[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(seedSql))) {
    out.push({ key: `${m[5]}#${m[1]}`, subject: m[3], body: m[4] })
  }
  return out
}

function parseTemplates(): ParsedBody[] {
  const re =
    /\('([a-z0-9_]+)', '(?:[^']|'')*', 'email', '[^']*',\s*\n\s*'((?:[^']|'')*)',\s*\n\s*\$tpl\$([\s\S]*?)\$tpl\$\)/g
  const out: ParsedBody[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(seedSql))) {
    out.push({ key: m[1], subject: m[2], body: m[3] })
  }
  return out
}

const steps = parseSteps()
const templates = parseTemplates()
const byKey = new Map([...steps, ...templates].map((p) => [p.key, p]))

// ── Classification machinery ──────────────────────────────────────────

// Promo-marker lexicon. A body's profile is the sorted list of marker
// names it matches. Growing this lexicon is encouraged; shrinking it or
// re-profiling a body below means the CAN-SPAM assessment was redone.
const PROMO_MARKERS: Record<string, RegExp> = {
  reviews: /google reviews|\{\{reviews_link\}\}/i,
  quiz: /profiles? quiz/i,
  brand_story: /how we came to bee|national franchise/i,
  offer: /free hour|% off|\boff your next\b|maintenance program|discount|special offer/i,
}

// A transactional email must actually be about the recipient's inquiry.
const TRANSACTIONAL_ANCHOR =
  /assessment|discovery|estimate|schedul|availability|interested|your (project|move)/i

function promoProfile(body: string): string[] {
  return Object.keys(PROMO_MARKERS)
    .filter((k) => PROMO_MARKERS[k].test(body))
    .sort()
}

// ── The pins ──────────────────────────────────────────────────────────

// Every step-1 signs off with the Google Reviews line; five step-2s
// carry the Profiles Quiz paragraph; every step-3 (and moving-a/b/c
// step 2) is promo-free. Incidental under primary-purpose — allowed,
// but pinned per body.
const PATHS = [
  'organizing-a', 'organizing-b', 'organizing-c', 'organizing-d',
  'moving-a', 'moving-b', 'moving-c', 'moving-d',
]
const QUIZ_STEP2_PATHS = ['organizing-a', 'organizing-b', 'organizing-c', 'organizing-d', 'moving-d']

const EXPECTED_STEP_PROFILES: Record<string, string[]> = {}
for (const p of PATHS) {
  EXPECTED_STEP_PROFILES[`${p}#1`] = ['reviews']
  EXPECTED_STEP_PROFILES[`${p}#2`] = QUIZ_STEP2_PATHS.includes(p) ? ['quiz'] : []
  EXPECTED_STEP_PROFILES[`${p}#3`] = []
}

const EXPECTED_TEMPLATE_PROFILES: Record<string, string[]> = {
  welcome: ['brand_story', 'quiz'],
  opp_closed_job_3mo: ['offer'],
  opp_closed_job_12mo: [],
  opp_organizing_estimate_3d: [],
  opp_organizing_estimate_30d: [],
  opp_moving_estimate_3d: [],
  opp_moving_estimate_30d: [],
}

// Commercial-primary set per the audit. These send footer-less TODAY —
// membership changes only with a redone assessment (and, for additions,
// a footer plan).
const COMMERCIAL_PRIMARY = ['welcome', 'opp_closed_job_3mo', 'opp_closed_job_12mo']

// The commercial trio is hash-pinned: any copy edit to a footer-less
// commercial email must re-ask the CAN-SPAM question (12mo especially —
// its classification rests on judgment, not lexical markers).
const COMMERCIAL_BODY_HASHES: Record<string, string> = {
  welcome: '70fcc5951201',
  opp_closed_job_3mo: '5b28a1f22e7a',
  opp_closed_job_12mo: '3e5643fdf958',
}

const hash12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

// ── Tests ─────────────────────────────────────────────────────────────

describe('CAN-SPAM tripwire — seed parse', () => {
  it('finds all 24 master step bodies and 7 standalone templates', () => {
    // A parse miss would silently exempt content from the sweep.
    expect(steps.map((s) => s.key).sort()).toEqual(Object.keys(EXPECTED_STEP_PROFILES).sort())
    expect(templates.map((t) => t.key).sort()).toEqual(Object.keys(EXPECTED_TEMPLATE_PROFILES).sort())
  })
})

describe('CAN-SPAM tripwire — content classification', () => {
  it('every body carries exactly its pinned promo-marker profile', () => {
    const expected = { ...EXPECTED_STEP_PROFILES, ...EXPECTED_TEMPLATE_PROFILES }
    const mismatches: string[] = []
    for (const [key, want] of Object.entries(expected)) {
      const got = promoProfile(byKey.get(key)!.body)
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        mismatches.push(`${key}: expected [${want}] got [${got}]`)
      }
    }
    expect(
      mismatches,
      'Promo content shifted in a currently-sending email. Redo the CAN-SPAM ' +
        'primary-purpose assessment (see 7/24 audit) before updating these pins — ' +
        'a new offer/promo line in a footer-less email may require the footer first.',
    ).toEqual([])
  })

  it('transactional emails stay anchored to the recipient inquiry; welcome stays unanchored', () => {
    const commercial = new Set(COMMERCIAL_PRIMARY)
    for (const [key, p] of byKey) {
      if (commercial.has(key)) continue
      expect(
        TRANSACTIONAL_ANCHOR.test(p.body),
        `${key} no longer references the recipient's own inquiry — its transactional-exemption basis is gone.`,
      ).toBe(true)
    }
    // The audit's welcome finding: nothing transactional to claim primary
    // purpose with. If an anchor appears, welcome was reworked — reassess.
    expect(
      TRANSACTIONAL_ANCHOR.test(byKey.get('welcome')!.body),
      'welcome now contains transactional content — its commercial classification may have changed; redo the assessment.',
    ).toBe(false)
  })

  it('commercial-primary bodies are byte-pinned until they get a footer', () => {
    for (const key of COMMERCIAL_PRIMARY) {
      expect(
        hash12(byKey.get(key)!.body),
        `${key} copy changed. It is classified commercial-primary and sends WITHOUT a ` +
          'CAN-SPAM footer — re-run the assessment on the new copy (and update this hash) ' +
          'or ship the footer with the change.',
      ).toBe(COMMERCIAL_BODY_HASHES[key])
    }
  })
})

describe('CAN-SPAM tripwire — rails stay footer-less knowingly', () => {
  // The documented exposure: no rail appends buildMarketingFooter or
  // mints an unsubscribe token. When footer machinery lands (the fix for
  // the commercial trio), this trips so the pins above get revisited —
  // update COMMERCIAL_* expectations and retire this block deliberately.
  const RAILS = ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts']

  it('no drip rail imports footer/unsubscribe machinery yet', () => {
    for (const rail of RAILS) {
      const src = readFileSync(join(ROOT, rail), 'utf8')
      expect(
        /buildMarketingFooter|ensureUnsubscribeToken|marketing-consent|marketing-unsubscribe/.test(src),
        `${rail} now touches footer/unsubscribe machinery — the footer work has started. ` +
          'Update the COMMERCIAL_PRIMARY pins in this tripwire (welcome, opp_closed_job_3mo, ' +
          'opp_closed_job_12mo were the emails needing the footer) and retire this assertion.',
      ).toBe(false)
    }
  })
})
