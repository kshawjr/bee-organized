// components/hive/shared/stageConfig.js
// ─────────────────────────────────────────────────────────────
// THE single stage/status DISPLAY config for HIVE Phase 1 surfaces
// (docs/hive-phase1-engagements.md §2/§8.5/§8.6).
//
// Division of authority:
//   lib/engagements.ts   — server truth: ENGAGEMENT_STAGE_RANK, stage
//                          derivation, founding rules. Never duplicated.
//   this file            — display layer: labels, ordering, chip colors.
//
// Phase 0 had 5 drifting stage-constant copies + a stale CHECK; the rule
// here is ONE source per layer. Do not import anything from BeeHub.jsx,
// and do not add stage constants anywhere else in components/.
// ─────────────────────────────────────────────────────────────

import { ENGAGEMENT_STAGE_RANK } from '@/lib/engagements'

// Re-export, not redeclare — lib/engagements.ts is the authority.
export const STAGE_RANK = ENGAGEMENT_STAGE_RANK

// Ordered board/display config. Terminal stages render off the active
// board (filtered by isTerminal); they exist here for chips and lists.
export const ENGAGEMENT_STAGES = [
  { key: 'Request',          label: 'Request',          rank: STAGE_RANK['Request'],          terminal: false },
  { key: 'Estimate',         label: 'Estimate',         rank: STAGE_RANK['Estimate'],         terminal: false },
  { key: 'Job in Progress',  label: 'Job in Progress',  rank: STAGE_RANK['Job in Progress'],  terminal: false },
  { key: 'Final Processing', label: 'Final Processing', rank: STAGE_RANK['Final Processing'], terminal: false },
  { key: 'Closed Won',       label: 'Closed Won',       rank: STAGE_RANK['Closed Won'],       terminal: true },
  { key: 'Closed Lost',      label: 'Closed Lost',      rank: STAGE_RANK['Closed Lost'],      terminal: true },
]

export function isTerminal(stage) {
  return stage === 'Closed Won' || stage === 'Closed Lost'
}

// Client status machine (§2) — Bee Hub's own, fully decoupled from Jobber.
export const CLIENT_STATUSES = [
  { key: 'New',        label: 'New' },
  { key: 'Attempting', label: 'Attempting' },
  { key: 'Nurturing',  label: 'Nurturing' },
  { key: 'Active',     label: 'Active client' },
  { key: 'Past',       label: 'Past client' },
]

// ── chip color semantics (§8.6) ────────────────────────────────
// teal=new/go · blue=in-motion · amber=attention/nurture ·
// red=money-owed · purple=relationship/repeat · gray=past/closed.
// Dark text on light fills, always.

const TEAL   = { bg: 'rgba(13,148,136,0.12)', text: '#0f766e' }
const BLUE   = { bg: 'rgba(37,99,235,0.10)',  text: '#1d4ed8' }
const AMBER  = { bg: 'rgba(245,158,11,0.14)', text: '#b45309' }
const RED    = { bg: 'rgba(220,38,38,0.10)',  text: '#b91c1c' }
const PURPLE = { bg: 'rgba(139,92,246,0.12)', text: '#6d28d9' }
const GRAY   = { bg: 'rgba(138,158,154,0.14)', text: '#5c6f6b' }

export const CHIP_STYLES = {
  // base families — reach for these when no specific key fits
  teal: TEAL, blue: BLUE, amber: AMBER, red: RED, purple: PURPLE, gray: GRAY,

  // engagement stages
  'Request':          TEAL,   // new/go — actively engaging
  'Estimate':         BLUE,   // in-motion — quoting phase
  'Job in Progress':  BLUE,   // in-motion — work happening
  'Final Processing': RED,    // money-owed — loose end
  'Closed Won':       GRAY,   // closed
  'Closed Lost':      GRAY,   // closed

  // client statuses
  'New':        TEAL,
  'Attempting': BLUE,
  'Nurturing':  AMBER,
  'Active':     TEAL,
  'Past':       GRAY,

  // within-stage states (card chips)
  sent:              BLUE,    // quote out, no answer yet — neutral default
  approved:          TEAL,    // quote approved — go
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
