// lib/safe-next.ts
// ─────────────────────────────────────────────────────────────
// Open-redirect guard for the post-login `next` destination.
//
// A logged-out click on a deep-link (e.g. /clients/<leadId> from a lead
// notification email) is bounced to /auth/login?next=<path>; after auth the
// callback sends the user to `next`. That value is attacker-influenceable
// (it rides in a URL), so it must be constrained to a SAME-ORIGIN RELATIVE
// path — never an absolute or protocol-relative URL that could redirect the
// freshly-authenticated user off to a phishing host.
//
// Accept only: a string beginning with a single "/" followed by a normal
// path character. Reject "//evil.com" (protocol-relative), "/\evil.com"
// (backslash trick), anything containing a scheme ("://"), control chars, or
// whitespace. Anything not clearly safe collapses to "/".
// ─────────────────────────────────────────────────────────────

export function safeNextPath(next: string | null | undefined): string {
  if (!next || typeof next !== 'string') return '/'
  // Must be a rooted relative path.
  if (!next.startsWith('/')) return '/'
  // Protocol-relative ("//host") or backslash-smuggled ("/\host", "/%5C…").
  if (next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (/^\/%2f/i.test(next) || /^\/%5c/i.test(next)) return '/'
  // No scheme ("http://" smuggled mid-string).
  if (next.includes('://')) return '/'
  // No control chars (0x00–0x1F) or space (0x20) — defends against embedded
  // newlines/tabs splitting the URL.
  if (/[\x00-\x20]/.test(next)) return '/'
  return next
}
