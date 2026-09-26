// lib/feedback-triage-link.ts
// ─────────────────────────────────────────────────────────────
// Where a message meant for KEVIN sends him to look at feedback: the admin
// Feedback tab. There is no per-report link — the tab reads no item
// parameter — so every Kevin-facing message links to the list.
//
// NOT /?feedback=1. That is the OWNER's reply-email link: it redirects to the
// owner's own Help › My requests page (hubUrl legacyFeedbackRedirect), which
// shows Kevin nothing useful. The owner-report alert and the 5am queue digest
// both shipped with it once; they now share this one constant so they cannot
// drift apart again.
// ─────────────────────────────────────────────────────────────

export const FEEDBACK_TRIAGE_PATH = '/admin?adminTab=feedback'
