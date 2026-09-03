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

// Serialize a Next.js `searchParams` object back into a query string ("?a=1"),
// or "" when there is nothing to carry. Issue 235 defect A: the root route's
// query string is part of where a logged-out visitor was actually headed — the
// feedback reply email links to /?feedback=1 — and it was being thrown away
// before the login bounce, so the reply the email promised never opened.
// Repeated keys are preserved; undefined values are skipped.
export function queryStringFrom(
  params: Record<string, string | string[] | undefined> | undefined | null,
): string {
  if (!params) return ''
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const v of value) usp.append(key, v)
    else usp.append(key, value)
  }
  const qs = usp.toString()
  return qs ? `?${qs}` : ''
}

// Where a logged-OUT Hub visitor was actually headed, as a relative path, or
// null when "nowhere in particular" (a bare visit to the domain). Extracted
// from app/_hub-page so the issue 235 defect A case is testable: the feedback
// reply email links to /?feedback=1, and the home branch used to return null
// unconditionally, dropping the one param that made the link mean anything.
export function hubReturnTo(args: {
  initialRoute?: string
  initialSelectedLeadId?: string
  initialSelectedEngagementId?: string
  searchParams?: Record<string, string | string[] | undefined> | null
}): string | null {
  const { initialRoute, initialSelectedLeadId, initialSelectedEngagementId, searchParams } = args
  if (initialSelectedLeadId) {
    return `/clients/${initialSelectedLeadId}${initialSelectedEngagementId ? `?e=${initialSelectedEngagementId}` : ''}`
  }
  // A route WITH a query keeps it: /help?tab=requests is the reply-email
  // landing now, and dropping the tab at the login door would land the owner
  // on the how-tos with no sign of the reply the email promised.
  if (initialRoute && initialRoute !== 'home') return `/${initialRoute}${queryStringFrom(searchParams)}`
  // Home WITH a query string is a real destination; home without one is not.
  const search = queryStringFrom(searchParams)
  return search ? `/${search}` : null
}

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
