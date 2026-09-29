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
// BRANDED LAYOUT (#114, then the Closed-Job follow-ups 2026-09-28): the #90
// Bee Organized layout (lib/drip-email-layout.ts) wraps the drip steps
// (lib/drip-send.ts) and ALL SIX opportunity-stage emails (lib/stage-emails.ts
// renderStageEmailContent) — the four transactional estimate follow-ups with no
// footer, and opp_closed_job_3mo / opp_closed_job_12mo WITH the #115 CAN-SPAM
// footer placed inside the white card, above the teal band. The Closed-Job pair
// was held on the plain bodyToHtml path only until #115 shipped the footer
// (branded chrome on a footer-less commercial email would have looked
// official while non-compliant); #115 has shipped, so that reason is gone.
// welcome joined them on 2026-09-28 for the same reason, its footer also in
// the card (lib/welcome-email.ts renderWelcomeEmailContent). NOTE: this
// tripwire hashes the seed BODIES, so an HTML layout change does NOT trip it —
// placement is guarded by lib/beta-stage-email-wrapper.test.ts, not here.
//
// FOOTER STATUS (#115, this change): the three COMMERCIAL emails now carry a
// CAN-SPAM footer (unsubscribe link + postal address). The rail split is
// recorded and guarded in the "rail split" block below:
//   welcome            → lib/welcome-email.ts places the footer in the card (audience inquiry)
//   opp_closed_job_3mo → lib/stage-emails.ts places the footer in the card (audience client)
//   opp_closed_job_12mo→ lib/stage-emails.ts places the footer in the card (audience client)
// The drip rail (lib/drip-send.ts) stays footer-less — its 24 steps are
// transactional. The seed BODIES are unchanged (the footer is appended at send
// time, not stored), so the hash pins below still hold and still guard copy edits.
//
// Scope caveat: this sweeps migrations/seed_master_drip_paths.sql, the
// repo source of master content (masters are corp-gated byte-pristine in
// prod) — EXCEPT the welcome, which is read from
// migrations/restore_welcome_master_template.sql (see LIVE_WELCOME below).
// Location-owned clones/templates live only in the DB and are out of a repo
// test's reach — re-audit those by hand when they change. A master edited in
// the app rather than by migration is out of reach too.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  COMMERCIAL_PRIMARY,
  EXPECTED_STEP_PROFILES,
  EXPECTED_TEMPLATE_PROFILES,
  TRANSACTIONAL_ANCHOR,
  promoProfile,
} from '@/lib/canspam-classifier'

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

// The welcome production sends is NOT the seed's. It was retired (issue 314),
// then restored on 2026-09-27 with Kevin's rewritten copy, inserted by
// migrations/restore_welcome_master_template.sql — confirmed byte-identical to
// the live master row on 2026-09-28 (sha256 3856f4917e51…). Until then this
// tripwire classified the seed's older welcome, so the copy actually being
// sent had never been through it. The live copy replaces the seed's welcome
// in every check below. (The other six standard templates were checked the
// same day: the seed matches production for all six.)
const RESTORE_WELCOME_SQL = 'migrations/restore_welcome_master_template.sql'
function parseLiveWelcome(): ParsedBody {
  const sql = readFileSync(join(ROOT, RESTORE_WELCOME_SQL), 'utf8')
  const m = sql.match(
    /\('welcome', '[^']+', 'email', '[^']*',\s*\n\s*'((?:[^']|'')*)',\s*\n\s*\$tpl\$([\s\S]*?)\$tpl\$\)/,
  )
  if (!m) throw new Error(`could not parse the welcome row out of ${RESTORE_WELCOME_SQL}`)
  return { key: 'welcome', subject: m[1], body: m[2] }
}

const steps = parseSteps()
const templates = parseTemplates()
const LIVE_WELCOME = parseLiveWelcome()
const byKey = new Map(
  [...steps, ...templates.filter((t) => t.key !== 'welcome'), LIVE_WELCOME].map((p) => [p.key, p]),
)

// ── Classification machinery ──────────────────────────────────────────
// The lexicon, the transactional anchor and the per-body pins live in
// lib/canspam-classifier.ts, shared with the live check
// (scripts/scan-canspam-live.mjs), so the repo check and the live check can
// never disagree about what counts as promotional. Growing the lexicon is
// encouraged; shrinking it or re-profiling a body means the CAN-SPAM
// assessment was redone.

// COMMERCIAL_PRIMARY (welcome + the two Closed-Job follow-ups) carries the
// #115 CAN-SPAM footer at send time — see the rail-split block. Membership
// changes only with a redone assessment.

// The commercial trio is hash-pinned: any copy edit to a commercial email must
// re-ask the CAN-SPAM question (12mo especially — its classification rests on
// judgment, not lexical markers).
const COMMERCIAL_BODY_HASHES: Record<string, string> = {
  // 2026-09-27 — was '70fcc5951201'. REASSESSED, not waved through: the only
  // change is the removal of Markdown asterisks (*Simplify Your Hive!*,
  // **Bee Organized**, and the two **headings**), which reached the inbox
  // literally because client emails have no Markdown step. Every word, link
  // and line is otherwise identical: no offer added or removed, no
  // transactional content (the TRANSACTIONAL_ANCHOR check above still finds
  // none), so the primary purpose is unchanged — still commercial, still
  // pure brand promo, still sent WITH the #115 footer by lib/welcome-email.ts.
  //
  // 2026-09-28 — was '5f4c801030dc' (the SEED's welcome, which production does
  // not send). Now pins the LIVE welcome, Kevin's 2026-09-27 rewrite read from
  // migrations/restore_welcome_master_template.sql. ASSESSED on first read,
  // not waved through: it adds a {{first_name}} greeting and a {{signature}},
  // keeps the Organizing Profile Quiz and How We Came To Bee / national-
  // franchise paragraphs, and adds no offer and no transactional content (the
  // TRANSACTIONAL_ANCHOR check finds none) — same promo profile
  // [brand_story, quiz], still commercial, still sent WITH the #115 footer by
  // lib/welcome-email.ts (inside the branded card since b5e114c).
  welcome: '3856f4917e51',
  opp_closed_job_3mo: '5b28a1f22e7a',
  opp_closed_job_12mo: '3e5643fdf958',
}

const hash12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

// ── Tests ─────────────────────────────────────────────────────────────

describe('CAN-SPAM tripwire — the welcome checked is the one production sends', () => {
  it('the welcome under test comes from the restore migration, not the seed', () => {
    expect(byKey.get('welcome')).toBe(LIVE_WELCOME)
    const seedWelcome = templates.find((t) => t.key === 'welcome')!
    // If these ever match again, the seed was updated — fine, but say so here.
    expect(LIVE_WELCOME.body).not.toBe(seedWelcome.body)
    expect(LIVE_WELCOME.subject).toBe('Welcome to the Bee Organized Hive!')
    expect(LIVE_WELCOME.body.startsWith('{{first_name}},')).toBe(true)
    expect(LIVE_WELCOME.body.endsWith('{{signature}}')).toBe(true)
  })
})

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

  it('commercial-primary bodies are byte-pinned (copy edits must re-ask the question)', () => {
    for (const key of COMMERCIAL_PRIMARY) {
      expect(
        hash12(byKey.get(key)!.body),
        `${key} copy changed. It is classified commercial-primary and sends WITH the #115 ` +
          'CAN-SPAM footer — re-run the primary-purpose assessment on the new copy and ' +
          'update this hash (a new offer or a shift in purpose may change what the footer must say).',
      ).toBe(COMMERCIAL_BODY_HASHES[key])
    }
  })
})

describe('CAN-SPAM tripwire — the commercial/transactional rail split (#115)', () => {
  // #115 wired the footer onto the three COMMERCIAL emails. The split is now
  // enforced structurally: the commercial rails carry the footer machinery, the
  // drip rail does not. If this block trips, a rail crossed the line — either a
  // commercial rail lost its footer, or the transactional drip rail grew one.
  const FOOTER_MACHINERY = /appendCanSpamFooter|buildMarketingFooter|ensureUnsubscribeToken|marketing-unsubscribe|marketing-consent/

  it('the commercial rails (welcome, stage-emails) carry the CAN-SPAM footer machinery', () => {
    for (const rail of ['lib/welcome-email.ts', 'lib/stage-emails.ts']) {
      const src = readFileSync(join(ROOT, rail), 'utf8')
      expect(
        FOOTER_MACHINERY.test(src),
        `${rail} no longer imports the CAN-SPAM footer machinery — a commercial email ` +
          '(welcome / opp_closed_job_3mo / opp_closed_job_12mo) may now send footer-less. ' +
          'Restore appendCanSpamFooter on the commercial path.',
      ).toBe(true)
    }
  })

  it('the drip rail stays footer-less — its 24 steps are transactional', () => {
    const src = readFileSync(join(ROOT, 'lib/drip-send.ts'), 'utf8')
    expect(
      FOOTER_MACHINERY.test(src),
      'lib/drip-send.ts now touches footer/unsubscribe machinery. Drip steps are ' +
        'transactional and must stay footer-less — if a step became commercial, redo the ' +
        'assessment and update this tripwire deliberately.',
    ).toBe(false)
  })

  it('no rail gates a commercial send on marketingSendBlockReason (CAN-SPAM ≠ prior consent)', () => {
    // That gate demands marketing_consented_at, the OPT-IN mailing-list contract
    // (0/9431 leads in prod). CAN-SPAM turns on opt-out + address + accurate
    // headers, not consent — using it here would refuse every commercial send.
    for (const rail of ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts']) {
      const src = readFileSync(join(ROOT, rail), 'utf8')
      expect(
        /marketingSendBlockReason/.test(src),
        `${rail} calls marketingSendBlockReason — that consent gate is for the opt-in ` +
          'mailing list, not CAN-SPAM. Commercial rails keep their marketing_opt_out check ' +
          'and add only the token + footer.',
      ).toBe(false)
    }
  })
})
