// The [secret-match] diagnostic must never leak the credential it describes.
//
// CRON_SECRET is a production credential and sync_log is readable. This file
// exists almost entirely for one assertion — that the secret's value is not a
// substring of anything the diagnostic emits — and that assertion is checked
// against a realistic secret (64 hex chars from `openssl rand -hex 32`), a
// short one, and one full of regex/JSON metacharacters.
//
// The rest is light, as asked: enough to know the fingerprint can actually
// answer the question it was added for.
import { describe, it, expect } from 'vitest'
import {
  fingerprintSecret,
  formatSecretMatch,
  FINGERPRINT_HEX_CHARS,
  SECRET_MATCH_PREFIX,
} from './secret-fingerprint'

// THROWAWAY FIXTURES — invented for this file, never any real credential.
// Shaped like a real CRON_SECRET (64 hex chars, as `openssl rand -hex 32`
// produces) so the length and entropy assertions mean something. Verified
// against the CRON_SECRET on this machine: different value, different digest.
const SECRET = 'a3f1c09e77b2d4485e6a1f0c9d38b27e4c5a6b7d8e9f0a1b2c3d4e5f60718293'
const OTHER  = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

describe('THE SECRET NEVER APPEARS IN WHAT IS LOGGED', () => {
  const cases: Array<[string, string]> = [
    ['a real 64-hex secret', SECRET],
    ['a short secret', 'hunter2'],
    ['one with metacharacters', 'p@ss|w0rd".*$^{}[]\\/'],
    ['one that is mostly digits', '00000000000000000000000000000001'],
  ]

  for (const [label, value] of cases) {
    it(`${label} is not a substring of the route row`, () => {
      const line = formatSecretMatch({
        side: 'route',
        headerValue: value,
        envValue: value,
        matched: true,
        host: 'beehive.beeorganized.com',
      })
      expect(line).not.toContain(value)
    })

    it(`${label} is not a substring of the sweeper row`, () => {
      const line = formatSecretMatch({
        side: 'sweeper',
        headerValue: value,
        envValue: value,
        origin: 'https://beehive.beeorganized.com',
        note: 'dispatch',
      })
      expect(line).not.toContain(value)
    })

    it(`no PREFIX or SUFFIX of ${label} longer than a few chars survives either`, () => {
      const line = formatSecretMatch({ side: 'route', headerValue: value, envValue: value, matched: true })
      // Nothing recognisable from either end of the value may appear. 6 is
      // well below the 8-char digest, so this cannot trip on a hash collision
      // with the secret's own text unless something is genuinely being echoed.
      for (let n = 6; n <= value.length; n++) {
        expect(line).not.toContain(value.slice(0, n))
        expect(line).not.toContain(value.slice(-n))
      }
    })
  }

  it('the fingerprint itself carries no fragment of the value', () => {
    const f = fingerprintSecret(SECRET)
    expect(f.hash).not.toBeNull()
    expect(SECRET).not.toContain(f.hash!)          // not lifted out of the value
    expect(f.hash).toHaveLength(FINGERPRINT_HEX_CHARS)
    expect(JSON.stringify(f)).not.toContain(SECRET)
  })

  it('length is reported but the value is not reconstructible from the row', () => {
    const line = formatSecretMatch({ side: 'route', headerValue: SECRET, envValue: SECRET, matched: true })
    expect(line).toContain('len=64')
    // 8 hex chars is 32 bits against a 64-hex-char secret — a fingerprint,
    // never an inversion.
    expect(line).toMatch(/sha8=[0-9a-f]{8}\b/)
    expect(line).not.toContain(SECRET)
  })
})

describe('it can actually answer the question it was added for', () => {
  it('two ends holding the SAME value report same=true', () => {
    const line = formatSecretMatch({ side: 'route', headerValue: SECRET, envValue: SECRET, matched: true })
    expect(line).toContain('same=true')
    expect(line).toContain('matched=true')
  })

  it('two ends holding DIFFERENT values report same=false — hypothesis (b)', () => {
    const line = formatSecretMatch({ side: 'route', headerValue: OTHER, envValue: SECRET, matched: false })
    expect(line).toContain('same=false')
    expect(line).toContain('matched=false')
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain(OTHER)
  })

  it('a header that never arrived reads as absent — hypothesis (a)', () => {
    const line = formatSecretMatch({ side: 'route', headerValue: null, envValue: SECRET, matched: false })
    expect(line).toContain('header=absent')
    expect(line).toContain('env=present')
    expect(line).not.toContain('same=')   // nothing to compare
  })

  it('an unset CRON_SECRET on the route is visible too', () => {
    const line = formatSecretMatch({ side: 'route', headerValue: SECRET, envValue: undefined, matched: false })
    expect(line).toContain('env=absent')
    expect(line).toContain('header=present')
  })

  it('same value, different lengths is impossible; different length shows up plainly', () => {
    const a = fingerprintSecret(SECRET)
    const b = fingerprintSecret(SECRET + ' ')   // a stray trailing space in an env var
    expect(a.length).toBe(64)
    expect(b.length).toBe(65)
    expect(a.hash).not.toBe(b.hash)
  })

  it('an empty string reads as absent, not as a zero-length present value', () => {
    expect(fingerprintSecret('')).toEqual({ present: false, length: 0, hash: null })
  })

  it('rows are greppable by one stable prefix', () => {
    expect(formatSecretMatch({ side: 'route' })).toContain(SECRET_MATCH_PREFIX)
    expect(formatSecretMatch({ side: 'sweeper' })).toContain(SECRET_MATCH_PREFIX)
  })

  it('both ends hash identically — otherwise every comparison is meaningless', () => {
    const route = formatSecretMatch({ side: 'route', headerValue: SECRET, envValue: null })
    const sweeper = formatSecretMatch({ side: 'sweeper', headerValue: SECRET, envValue: null })
    const grab = (l: string) => /header=present len=\d+ sha8=([0-9a-f]+)/.exec(l)?.[1]
    expect(grab(route)).toBe(grab(sweeper))
    expect(grab(route)).toBeTruthy()
  })
})
