// lib/response-forensics.ts
//
// DIAGNOSTIC ONLY — Kevin removes this. See the note in the commit.
//
// THE QUESTION. The sweeper's POST to /api/import/jobber-clients gets HTTP 200
// with {"job_id":"...","started":true} — a string that exists NOWHERE in the
// current codebase — while the import function never runs. Proven by 1b385c2:
// the route logs a [secret-match] row unconditionally for any cookie-less
// request, before any decision at all, and between 03:43 and 03:48 there were
// six sweeper rows and ZERO route rows. The same request from Kevin's Mac does
// reach the function and runs a real segment.
//
// So something between Vercel's function egress and the route is answering on
// its behalf. This dumps EVERYTHING about the response that could identify the
// responder, because the answer is most likely in a header nobody thought to
// look at: x-vercel-id names the region and deployment that served it,
// x-vercel-cache says whether an edge copy answered, x-matched-path says which
// route Vercel believes it matched, and `via`/`server`/`age` say whether an
// intermediary is involved at all.
//
// A URL that differs from the one we sent would be the answer outright, so it
// is flagged loudly rather than buried in a list.
//
// ─────────────────────────────────────────────────────────────────────────
// A HEADER DUMP IS EXACTLY WHERE A CREDENTIAL LEAKS BY ACCIDENT. Anything
// that could carry one is recorded as `name=<redacted>` — so we still learn
// the header EXISTS, which is itself evidence, without its value. Redaction is
// by NAME, and deliberately over-broad: a header wrongly redacted costs one
// round trip, a header wrongly printed costs a credential rotation.
// lib/beta-response-forensics.test.ts pins it.
// ─────────────────────────────────────────────────────────────────────────

// Substring match, case-insensitive, on the header NAME. Over-broad on
// purpose. None of the headers this diagnostic actually wants — x-vercel-id,
// x-vercel-cache, x-matched-path, server, age, via — contain any of these.
const REDACT_NAME = /(secret|token|auth|key|cookie|credential|password|passwd|session|bearer|signature|jwt)/i

// Names that carry credentials without saying so. x-vercel-sc-headers is the
// one that matters here: Vercel puts internal request headers in it, and on
// this route those include x-import-continue-secret.
const REDACT_EXACT = new Set([
  'x-vercel-sc-headers',
  'x-vercel-internal-ingress-bucket',
  'proxy-authorization',
  'www-authenticate',
  'proxy-authenticate',
])

// Headers that echo our own request back at us. The request carries the
// secret, so any echo of it is an echo of the credential.
const REDACT_PREFIX = ['x-vercel-sc-', 'x-forwarded-authorization', 'x-original-']

export function shouldRedactHeader(name: string): boolean {
  const n = String(name ?? '').toLowerCase().trim()
  if (!n) return false
  if (REDACT_EXACT.has(n)) return true
  if (REDACT_PREFIX.some((p) => n.startsWith(p))) return true
  return REDACT_NAME.test(n)
}

export const REDACTED = '<redacted>'

// Long values (a CSP, a big set-cookie) would swamp the row. The identifying
// headers are all short; anything long is truncated with its true length kept,
// because "this header is 4KB" is itself a clue.
export const HEADER_VALUE_MAX = 200

function renderValue(name: string, value: string): string {
  if (shouldRedactHeader(name)) return REDACTED
  const v = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (v.length <= HEADER_VALUE_MAX) return v
  return `${v.slice(0, HEADER_VALUE_MAX)}…(len=${v.length})`
}

/**
 * Every response header, name-sorted, redacted by name. Accepts anything with
 * a Headers-like shape (forEach, entries) or a plain object, because test
 * doubles and undici disagree and a diagnostic must not throw on either.
 */
export function dumpHeaders(headers: any): string {
  const pairs: Array<[string, string]> = []
  try {
    if (headers && typeof headers.forEach === 'function') {
      headers.forEach((v: any, k: any) => { pairs.push([String(k), String(v)]) })
    } else if (headers && typeof headers.entries === 'function') {
      for (const [k, v] of headers.entries()) pairs.push([String(k), String(v)])
    } else if (headers && typeof headers === 'object') {
      for (const k of Object.keys(headers)) pairs.push([k, String((headers as any)[k])])
    } else {
      return 'headers=<unreadable>'
    }
  } catch {
    return 'headers=<unreadable>'
  }
  if (!pairs.length) return 'headers=<none>'
  pairs.sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1))
  return pairs
    .map(([k, v]) => `${k.toLowerCase()}=${renderValue(k, v)}`)
    .join(' | ')
}

// Stable, greppable prefix — and the string to grep for when deleting these
// rows again.
export const RESPONDER_LOG_PREFIX = '[responder]'

export interface ResponderInput {
  requestUrl: string
  origin: string
  status?: number
  type?: string
  redirected?: boolean
  finalUrl?: string
  headers?: any
  bodySnippet?: string
  outcome?: string
}

/**
 * One line describing WHO answered.
 *
 * A final URL different from the one we sent is the single most conclusive
 * thing this can find, so it leads the line in shouting caps rather than
 * sitting in the middle of a header dump where it would be missed.
 */
export function formatResponder(input: ResponderInput): string {
  const finalUrl = String(input.finalUrl ?? '')
  const mismatch = !!finalUrl && finalUrl !== input.requestUrl

  const parts = [RESPONDER_LOG_PREFIX]
  if (mismatch) parts.push('*** URL-MISMATCH ***')
  parts.push(`sent=${input.requestUrl}`)
  parts.push(`final=${finalUrl || '<same-or-absent>'}`)
  parts.push(`origin=${input.origin}`)
  if (input.outcome) parts.push(`outcome=${input.outcome}`)
  parts.push(`status=${input.status ?? 'n/a'}`)
  parts.push(`type=${input.type ?? 'n/a'}`)
  parts.push(`redirected=${input.redirected === undefined ? 'n/a' : input.redirected}`)
  parts.push(`body="${input.bodySnippet ?? ''}"`)
  parts.push(`HEADERS: ${dumpHeaders(input.headers)}`)
  return parts.join(' ')
}
