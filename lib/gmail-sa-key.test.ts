// @vitest-environment node
//
// GOOGLE_SA_KEY parsing — pins that parseServiceAccountKey handles the
// private key's newlines arriving either way from a Vercel env box:
// real newlines, or the two-character sequence backslash-n. Also pins the
// named error on missing/unparseable input. Credentials here are mocks —
// never put a real key in a test file.
import { describe, it, expect } from 'vitest'
import { parseServiceAccountKey, GoogleServiceAccountKeyError } from './gmail'

const MOCK_KEY_REAL_NEWLINES =
  '-----BEGIN PRIVATE KEY-----\nMOCKLINE1\nMOCKLINE2\n-----END PRIVATE KEY-----\n'

function mockKeyJson(privateKey: string): string {
  return JSON.stringify({
    type: 'service_account',
    client_email: 'bee-hub-gmail@mock-project.iam.gserviceaccount.com',
    private_key: privateKey,
  })
}

describe('parseServiceAccountKey', () => {
  it('passes through a private_key with real newlines unchanged', () => {
    const creds = parseServiceAccountKey(mockKeyJson(MOCK_KEY_REAL_NEWLINES))
    expect(creds.client_email).toBe('bee-hub-gmail@mock-project.iam.gserviceaccount.com')
    expect(creds.private_key).toBe(MOCK_KEY_REAL_NEWLINES)
  })

  it('converts escaped backslash-n sequences in private_key to real newlines', () => {
    // JSON.stringify of a string containing the two chars \ n produces the
    // doubly-escaped form Vercel stores when the key is pasted pre-escaped.
    const escaped = MOCK_KEY_REAL_NEWLINES.replace(/\n/g, '\\n')
    expect(escaped).toContain('\\n')
    const creds = parseServiceAccountKey(mockKeyJson(escaped))
    expect(creds.private_key).toBe(MOCK_KEY_REAL_NEWLINES)
    expect(creds.private_key).not.toContain('\\n')
  })

  it('throws the named error on invalid JSON', () => {
    expect(() => parseServiceAccountKey('not json at all')).toThrowError(
      GoogleServiceAccountKeyError
    )
    expect(() => parseServiceAccountKey('not json at all')).toThrowError(/not valid JSON/)
  })

  it('throws the named error when client_email or private_key is missing', () => {
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com' }))
    ).toThrowError(GoogleServiceAccountKeyError)
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ private_key: MOCK_KEY_REAL_NEWLINES }))
    ).toThrowError(GoogleServiceAccountKeyError)
  })
})
