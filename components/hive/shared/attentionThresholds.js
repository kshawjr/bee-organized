// components/hive/shared/attentionThresholds.js
// ─────────────────────────────────────────────────────────────
// ONE home for the day-count thresholds behind the Home "Needs attention"
// signals. Tier 3b of the Home redesign: Home used to hard-code these inline
// (>3 days, >7/30 days). There is NO pre-existing threshold constant in the
// shared machinery to derive from — stageConfig.js is a pure display layer
// (labels/colors, no day math), and the only day-thresholds that existed were
// inline literals in engagementStatus.js (the 21-day Request cue, the 90-day
// nurture clock) which are their OWN rules, not these.
//
// So this module is the single source these signals read. Any Clients view
// that later grows the same "estimate needs follow-up / invoice aging" rule
// MUST import from here rather than copy a second literal — that's the whole
// point of centralizing: Home and a view can never drift on the number.
// ─────────────────────────────────────────────────────────────

// An estimate-stage engagement whose quote was SENT more than this many days
// ago and is still open reads as "awaiting follow-up" on Home. (Jobber does
// not track a customer reply, so sent-age is the honest proxy for "no reply
// yet" — a longer sit is the neglect signal.)
export const ESTIMATE_FOLLOWUP_DAYS = 3

// An unpaid invoice ISSUED more than this many days ago reads as "aging" on
// Home. This is a minimum-age FLOOR, not a due-date: Jobber imports no invoice
// due-date, so a true "overdue past its window" is not computable. The floor
// exists so a legitimately-recent unpaid invoice (issued yesterday) does not
// trip the card — only balances that have sat unpaid past the floor surface.
export const INVOICE_AGING_DAYS = 7

// The "today / tomorrow" horizon for the upcoming-assessments signal: an
// assessment scheduled between now and the end of (today + N days) counts.
// N = 1 → today and tomorrow.
export const ASSESSMENT_HORIZON_DAYS = 1
