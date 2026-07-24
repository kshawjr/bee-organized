// lib/rate-guard.ts
//
// Rate-tag send guard. {{rate_per_hour}} substitutes as empty string when
// the location has no rate (like every unresolved tag), which turns the
// pricing sentence into "Our rate starts at  per hour per Bee." — a hole
// only the client sees. Senders (drip, welcome, stage) call this BEFORE
// rendering: template references the tag + rate blank → HOLD the send
// (row untouched, cron retries) instead of shipping broken copy. Checked
// against the template SOURCE, not path letters, so cloned/customized
// templates are guarded too. Never invent a placeholder rate.
//
// Deliberately its own module (not lib/resend.ts): sender tests mock
// resend wholesale, and the guard must stay REAL under those mocks.

export function blockedOnMissingRate(
  template: { subject: string | null; body: string | null },
  rate: string | null | undefined,
): boolean {
  if (rate != null && String(rate).trim() !== '') return false
  return `${template.subject ?? ''}\n${template.body ?? ''}`.includes('{{rate_per_hour}}')
}
