// lib/secret-fingerprint.ts
//
// DIAGNOSTIC ONLY — Kevin removes this once the question below is answered.
//
// THE QUESTION. The sweeper's POSTs to /api/import/jobber-clients are not
// being recognised as internal. The same header, sent by hand from Kevin's Mac
// with the value out of .env.production.local, IS recognised: that request
// takes the awaited branch and comes back with entered / mutex:'won' /
// records_written:400. Every [continuation] row the sweeper writes replies
// {"job_id":"...","started":true} — a string that exists nowhere in the
// current route file, so those requests took neither branch of the split.
//
// Two hypotheses, and they need different fixes:
//   (a) the header never arrives — stripped or renamed in transit
//   (b) it arrives, but the value differs from what the route compares against
//       (the cron's runtime resolving a different CRON_SECRET)
//
// One fingerprint, computed the SAME way at both ends, separates them. If the
// hashes match, the values match and the problem is elsewhere. If one end has
// no header at all, it is (a). If both are present and the hashes differ, it
// is (b). This has to be one shared helper — two implementations that hashed
// differently would make every comparison meaningless.
//
// ─────────────────────────────────────────────────────────────────────────
// THE SECRET IS NEVER RECORDED. Not the value, not a prefix, not a suffix,
// not a substring. sync_log is readable, and CRON_SECRET is a production
// credential. What goes out is presence, length, and a TRUNCATED sha256 —
// 8 hex characters, 32 bits. That is enough to tell two values apart and far
// too little to recover either: the secret is 64 hex chars from
// `openssl rand -hex 32`, so a 32-bit digest maps astronomically many inputs
// onto each output. lib/beta-secret-fingerprint.test.ts asserts the value
// never appears in the output.
// ─────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'

export interface SecretFingerprint {
  present: boolean
  length: number
  /** First 8 hex chars of sha256(value). null when there is no value. */
  hash: string | null
}

// How much of the digest to keep. Enough to distinguish, not enough to invert.
export const FINGERPRINT_HEX_CHARS = 8

export function fingerprintSecret(value: string | null | undefined): SecretFingerprint {
  if (value === null || value === undefined || value === '') {
    return { present: false, length: 0, hash: null }
  }
  const s = String(value)
  return {
    present: true,
    length: s.length,
    hash: createHash('sha256').update(s, 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_CHARS),
  }
}

const render = (label: string, f: SecretFingerprint): string =>
  f.present
    ? `${label}=present len=${f.length} sha8=${f.hash}`
    : `${label}=absent`

// Stable, greppable prefix — Kevin can pull the whole picture out of sync_log
// with one message filter, and delete these rows by the same filter after.
export const SECRET_MATCH_PREFIX = '[secret-match]'

/**
 * The ROUTE's side: what arrived versus what it compares against.
 *
 * `matched` is the boolean the route already computed — passed in rather than
 * recomputed, so this can never disagree with the decision actually taken.
 */
export function formatSecretMatch(input: {
  side: 'route' | 'sweeper'
  headerValue?: string | null
  envValue?: string | null
  matched?: boolean
  host?: string | null
  origin?: string | null
  note?: string | null
}): string {
  const header = fingerprintSecret(input.headerValue)
  const env = fingerprintSecret(input.envValue)
  const parts = [
    SECRET_MATCH_PREFIX,
    `side=${input.side}`,
    render('header', header),
    render('env', env),
  ]
  if (input.matched !== undefined) parts.push(`matched=${input.matched}`)
  // Same value at both ends is the single most useful line in the row: it says
  // "the sweeper is sending what the route expects" without either being shown.
  if (header.present && env.present) {
    parts.push(`same=${header.hash === env.hash}`)
  }
  if (input.host) parts.push(`host=${input.host}`)
  if (input.origin) parts.push(`origin=${input.origin}`)
  if (input.note) parts.push(`note=${input.note}`)
  return parts.join(' ')
}
