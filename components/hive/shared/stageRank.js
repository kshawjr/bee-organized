// components/hive/shared/stageRank.js
// ─────────────────────────────────────────────────────────────
// THE single engagement stage-rank source. PURE module — zero imports,
// safe in any bundle (client components, server libs, API routes).
//
// lib/engagements.ts (server) and stageConfig.js (display) both import
// from HERE — never the other way around. A client-side import of
// lib/engagements.ts drags the Supabase service client into the browser
// bundle and crashes at module load ("supabaseKey is required") — that
// was incident 2026-07-03; this module is the fix. Keep it pure.
// ─────────────────────────────────────────────────────────────

export const ENGAGEMENT_STAGE_RANK = {
  'Request':          0,
  'Estimate':         1,
  'Job in Progress':  2,
  'Final Processing': 3,
  'Closed Won':       4,
  'Closed Lost':      4,
}

export function isTerminal(stage) {
  return stage === 'Closed Won' || stage === 'Closed Lost'
}
