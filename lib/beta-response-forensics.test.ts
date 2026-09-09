// The [responder] header dump must never leak a credential.
//
// A header dump is exactly where one leaks by accident: the sweeper's request
// carries x-import-continue-secret, Vercel echoes internal request headers back
// in x-vercel-sc-headers, and nobody enumerating "useful" headers thinks about
// either. So redaction is by NAME and deliberately over-broad, and this file
// pins it the same way lib/beta-secret-fingerprint.test.ts pins the other one.
//
// The rest is light: enough to know the dump can actually identify a responder.
import { describe, it, expect } from 'vitest'
import {
  formatResponder,
  dumpHeaders,
  shouldRedactHeader,
  REDACTED,
  HEADER_VALUE_MAX,
  RESPONDER_LOG_PREFIX,
} from './response-forensics'

// THROWAWAY fixture — invented here, never any real credential.
const CRED = 'a3f1c09e77b2d4485e6a1f0c9d38b27e4c5a6b7d8e9f0a1b2c3d4e5f60718293'
const SENT = 'https://beehive.beeorganized.com/api/import/jobber-clients?location_id=loc_phillysuburbs&_continue=1'

// A Headers-like double, as undici would hand it over.
const H = (obj: Record<string, string>) => ({
  forEach: (cb: (v: string, k: string) => void) => { for (const k of Object.keys(obj)) cb(obj[k], k) },
  get: (k: string) => obj[k.toLowerCase()] ?? null,
})

describe('NO CREDENTIAL SURVIVES THE HEADER DUMP', () => {
  const carriers = [
    'x-import-continue-secret',
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'x-vercel-sc-headers',
    'x-api-key',
    'x-auth-token',
    'x-session-id',
    'proxy-authorization',
    'x-vercel-oidc-token',
    'x-forwarded-authorization',
    'x-signature',
    'x-jwt-assertion',
  ]

  for (const name of carriers) {
    it(`${name} is recorded as existing, but its value never appears`, () => {
      const line = formatResponder({
        requestUrl: SENT,
        origin: 'https://beehive.beeorganized.com',
        status: 200,
        headers: H({ [name]: CRED, 'x-vercel-id': 'iad1::abc123' }),
      })
      expect(line).not.toContain(CRED)
      // ...and we still learn the header EXISTS, which is itself evidence.
      expect(line.toLowerCase()).toContain(`${name.toLowerCase()}=${REDACTED}`)
      // the innocent header beside it is untouched
      expect(line).toContain('x-vercel-id=iad1::abc123')
    })
  }

  it('no PREFIX or SUFFIX of a credential survives, down to six characters', () => {
    const line = formatResponder({
      requestUrl: SENT,
      origin: 'https://x',
      headers: H({ authorization: `Bearer ${CRED}`, 'x-import-continue-secret': CRED }),
    })
    for (let n = 6; n <= CRED.length; n++) {
      expect(line).not.toContain(CRED.slice(0, n))
      expect(line).not.toContain(CRED.slice(-n))
    }
  })

  it('redaction is case-insensitive on the header name', () => {
    expect(shouldRedactHeader('X-IMPORT-CONTINUE-SECRET')).toBe(true)
    expect(shouldRedactHeader('Set-Cookie')).toBe(true)
    expect(shouldRedactHeader('AUTHORIZATION')).toBe(true)
  })

  it('the headers this diagnostic actually needs are NOT redacted', () => {
    // Over-broad redaction is the right default, but it must not blind the
    // dump to the six headers most likely to name the responder.
    for (const n of ['x-vercel-id', 'x-vercel-cache', 'x-matched-path', 'server', 'age', 'via', 'content-type']) {
      expect(shouldRedactHeader(n)).toBe(false)
    }
  })

  it('a credential in an UNREDACTED header is still not silently fine — the dump is name-based', () => {
    // Documents the known limit honestly: redaction cannot see values. If a
    // credential ever appears in, say, x-vercel-id, this dump would print it.
    // That is why the name list is over-broad rather than minimal.
    const line = dumpHeaders(H({ 'x-vercel-id': CRED }))
    expect(line).toContain(CRED)   // <- the limit, asserted so nobody assumes otherwise
  })
})

describe('it can identify who answered', () => {
  it('A DIFFERING FINAL URL IS FLAGGED SO IT CANNOT BE MISSED', () => {
    const line = formatResponder({
      requestUrl: SENT,
      origin: 'https://beehive.beeorganized.com',
      status: 200,
      finalUrl: 'https://some-other-host.vercel.app/api/import/jobber-clients',
      headers: H({}),
    })
    expect(line).toContain('*** URL-MISMATCH ***')
    expect(line).toContain('final=https://some-other-host.vercel.app/api/import/jobber-clients')
  })

  it('the same URL back is not flagged', () => {
    const line = formatResponder({ requestUrl: SENT, origin: 'https://x', finalUrl: SENT, headers: H({}) })
    expect(line).not.toContain('URL-MISMATCH')
  })

  it('dumps EVERY header, not a chosen few, name-sorted', () => {
    const line = dumpHeaders(H({ server: 'Vercel', age: '42', 'x-matched-path': '/api/import/jobber-clients', via: '1.1 vegur' }))
    expect(line).toContain('server=Vercel')
    expect(line).toContain('age=42')
    expect(line).toContain('x-matched-path=/api/import/jobber-clients')
    expect(line).toContain('via=1.1 vegur')
    expect(line.indexOf('age=')).toBeLessThan(line.indexOf('server='))   // sorted
  })

  it('an enormous header is truncated but its true length is kept', () => {
    const line = dumpHeaders(H({ 'content-security-policy': 'x'.repeat(5000) }))
    expect(line).toContain('len=5000')
    expect(line).not.toContain('x'.repeat(HEADER_VALUE_MAX + 1))
  })

  it('survives a headers object it does not recognise, rather than throwing', () => {
    expect(dumpHeaders(null)).toBe('headers=<unreadable>')
    expect(dumpHeaders(undefined)).toBe('headers=<unreadable>')
    expect(dumpHeaders(H({}))).toBe('headers=<none>')
    expect(dumpHeaders({ 'x-vercel-id': 'iad1::abc' })).toContain('x-vercel-id=iad1::abc')
  })

  it('records status, type and redirected, and stays greppable', () => {
    const line = formatResponder({
      requestUrl: SENT, origin: 'https://x',
      status: 200, type: 'basic', redirected: false,
      bodySnippet: '{"job_id":"f385d31d","started":true}',
      outcome: 'landed',
      headers: H({ 'x-vercel-cache': 'MISS' }),
    })
    expect(line.startsWith(RESPONDER_LOG_PREFIX)).toBe(true)
    expect(line).toContain('status=200')
    expect(line).toContain('type=basic')
    expect(line).toContain('redirected=false')
    expect(line).toContain('outcome=landed')
    expect(line).toContain('started":true')      // the body we are trying to source
    expect(line).toContain('x-vercel-cache=MISS')
  })
})
