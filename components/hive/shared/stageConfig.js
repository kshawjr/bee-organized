// components/hive/shared/stageConfig.js
// ─────────────────────────────────────────────────────────────
// THE single stage/status DISPLAY config for HIVE Phase 1 surfaces
// (docs/hive-phase1-engagements.md §2/§8.5/§8.6).
//
// Division of authority:
//   shared/stageRank.js  — the rank + terminality source. PURE, importable
//                          from both bundles. NEVER import lib/engagements
//                          from client code — it drags the Supabase service
//                          client into the browser bundle (2026-07-03
//                          incident: "supabaseKey is required" at load).
//   lib/engagements.ts   — server truth: stage derivation, founding rules.
//   this file            — display layer: labels, ordering, chip colors.
//
// Phase 0 had 5 drifting stage-constant copies + a stale CHECK; the rule
// here is ONE source per layer. Do not import anything from BeeHub.jsx,
// and do not add stage constants anywhere else in components/.
// ─────────────────────────────────────────────────────────────

import { ENGAGEMENT_STAGE_RANK, isTerminal } from './stageRank'
import { T } from './tokens'

// Re-export, not redeclare — stageRank.js is the authority.
export const STAGE_RANK = ENGAGEMENT_STAGE_RANK
export { isTerminal }

// Ordered board/display config. Terminal stages render off the active
// board (filtered by isTerminal); they exist here for chips and lists.
// `key` is the CANONICAL stage string (DB rows + CHECK constraint —
// never change it); `displayLabel` is the sentence-case mockup label.
// UI consumes displayLabel / stageDisplayLabel(), never the raw key.
export const ENGAGEMENT_STAGES = [
  { key: 'Request',          label: 'Request',          displayLabel: 'Request',          rank: STAGE_RANK['Request'],          terminal: false },
  { key: 'Estimate',         label: 'Estimate',         displayLabel: 'Estimate',         rank: STAGE_RANK['Estimate'],         terminal: false },
  { key: 'Job in Progress',  label: 'Job in Progress',  displayLabel: 'Job in progress',  rank: STAGE_RANK['Job in Progress'],  terminal: false },
  { key: 'Final Processing', label: 'Final Processing', displayLabel: 'Final processing', rank: STAGE_RANK['Final Processing'], terminal: false },
  { key: 'Closed Won',       label: 'Closed Won',       displayLabel: 'Closed won',       rank: STAGE_RANK['Closed Won'],       terminal: true },
  { key: 'Closed Lost',      label: 'Closed Lost',      displayLabel: 'Closed lost',      rank: STAGE_RANK['Closed Lost'],      terminal: true },
]

const DISPLAY_LABELS = Object.fromEntries(ENGAGEMENT_STAGES.map(s => [s.key, s.displayLabel]))
export function stageDisplayLabel(stageKey) {
  return DISPLAY_LABELS[stageKey] || stageKey
}

// ── milestone records arc (design-system pass 7/11) ─────────────
// Each working (non-terminal) stage owns ONE record family — the same
// mapping the panel's currentType ternary used to inline. Single-homed
// here so the milestone checklist's expected path derives from the
// stage machine's canonical order (ENGAGEMENT_STAGES ranks), never a
// hardcoded drifting list.
export const STAGE_RECORD_FAMILY = {
  'Request':          'request',
  'Estimate':         'quote',
  'Job in Progress':  'job',
  'Final Processing': 'invoice',
}

// The expected milestone path: working stages in rank order, mapped to
// their record family — Request → [Assessment →] Quote → Job → Invoice.
// The Assessment step is NOT stage-owned (assessments ride the Request
// stage) and creation_type is never persisted on engagements, so the
// only honest signal that this engagement's arc includes one is the
// presence of assessment child records — pass hasAssessment from those.
export function milestoneFamilies({ hasAssessment = false } = {}) {
  const arc = ENGAGEMENT_STAGES
    .filter(s => !s.terminal)
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map(s => STAGE_RECORD_FAMILY[s.key])
  if (hasAssessment) arc.splice(arc.indexOf('request') + 1, 0, 'assessment')
  return arc
}

// Terminal stage vocabulary — audited against prod 2026-07-04: the two
// terminal values in engagements.stage are EXACTLY 'Closed Won' (680)
// and 'Closed Lost' (695). closed_reason is NOT won/lost-symmetric
// ('won' vs 'stale_on_import') — never bind won/lost logic to it; the
// stage string is the one truth. Consumed by the closed API route, the
// list won/lost filters, and the board's closed rail.
export const CLOSED_WON = 'Closed Won'
export const CLOSED_LOST = 'Closed Lost'
export const CLOSED_STAGE_FILTERS = {
  closed: [CLOSED_WON, CLOSED_LOST],
  won: [CLOSED_WON],
  lost: [CLOSED_LOST],
}

// Client status machine (§2) — Bee Hub's own, fully decoupled from Jobber.
export const CLIENT_STATUSES = [
  { key: 'New',        label: 'New' },
  { key: 'Attempting', label: 'Attempting' },
  { key: 'Nurturing',  label: 'Nurturing' },
  { key: 'Active',     label: 'Active client' },
  { key: 'Client',     label: 'Client' }, // won — ≥1 Closed Won engagement
  { key: 'Past',       label: 'Past client' },
]

// ── chip color semantics (§8.6, LOCKED mockup values) ──────────
// teal=new/go · blue=in-motion · green=approved · amber=attention/
// nurture · red=money-owed · purple=relationship/repeat ·
// gray=past/closed. Dark text on light fills, always. These exact
// pairs are the design language — do not tweak per-surface.

// The pairs live in shared/tokens (T.family — the ONE hex home); this
// file only assigns them to stage/status vocabulary. Teal's text stop
// is the dark stop of the brand-green 3-stop scale; the unread badge
// and StatusChip resolve to THIS pair.
const TEAL   = T.family.teal
const BLUE   = T.family.blue
const GREEN  = T.family.green
const AMBER  = T.family.amber
const RED    = T.family.red
const PURPLE = T.family.purple
const GRAY   = T.family.gray

// Extra-quiet ghost for de-emphasized states (No-contact-info etc.).
const QUIET_GRAY = T.family.quiet

export const CHIP_STYLES = {
  // base families — reach for these when no specific key fits
  teal: TEAL, blue: BLUE, green: GREEN, amber: AMBER, red: RED, purple: PURPLE, gray: GRAY,
  quiet: QUIET_GRAY,

  // engagement stages — BOTH vocabularies resolve (canonical DB keys AND
  // sentence-case displayLabels), same no-silent-miss rule as statuses.
  'Request':          TEAL,   // new/go — actively engaging
  'Estimate':         BLUE,   // in-motion — quoting phase
  'Job in Progress':  BLUE,   // in-motion — work happening
  'Final Processing': AMBER,  // attention — loose end to chase
  'Closed Won':       GRAY,   // closed
  'Closed Lost':      GRAY,   // closed
  'Job in progress':  BLUE,
  'Final processing': AMBER,
  'Closed won':       GRAY,
  'Closed lost':      GRAY,

  // client statuses — BOTH vocabularies resolve (status keys AND display
  // labels), so no call site can silently miss into the gray fallback.
  'New':             TEAL,
  'Attempting':      BLUE,
  'Nurturing':       AMBER,
  'Active':          PURPLE,  // relationship family (locked directory mockup)
  'Client':          GREEN,   // won — approved family, the customer badge
  'Past':            GRAY,
  'Active client':   PURPLE,
  'Past client':     GRAY,
  'no_contact':      QUIET_GRAY,
  'No contact info': QUIET_GRAY,

  // within-stage states (card chips)
  sent:              BLUE,    // quote out, no answer yet — neutral default
  approved:          GREEN,   // quote approved
  changes_requested: AMBER,   // quote needs attention
  nurturing:         AMBER,   // quiet-clock chip ("nurturing · dNN")
  upcoming:          BLUE,    // job scheduled ahead
  scheduled:         BLUE,    // assessment / job on the calendar
  in_progress:       BLUE,    // job underway
  owing:             RED,     // invoice balance outstanding
  paid:              TEAL,    // settled
  never_invoiced:    AMBER,   // complete but no invoice — loose end
  repeat:            PURPLE,  // relationship/repeat badge
}
