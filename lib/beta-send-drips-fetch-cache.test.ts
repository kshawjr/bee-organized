// The unsubscribe-token fault (2026-10-17). The send-drips cron had
// dynamic='force-dynamic' but no fetchCache, and Next 14.2.3's Data Cache kept
// the supabase-js GETs anyway. ensureUnsubscribeToken's per-lead read was
// answered with the "no token" it had seen before the token was minted, every
// hour after, so 37 welcome emails and 7 closed-job follow-ups were refused as
// canspam_no_token — the oldest for 18 days — while the token sat in the row.
//
// Proven from Supabase edge logs, not inferred: ~30 token PATCHes an hour
// reached the database, and 0–3 of the reads that must precede each of them.
//
// What this file pins:
//   1. the cron route carries fetchCache='force-no-store' (and force-dynamic);
//   2. EVERY app route that calls the welcome send, the closed-job send or the
//      token mint carries it too, so a new caller cannot reintroduce the freeze.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const NO_STORE = "export const fetchCache = 'force-no-store'"

describe('send-drips cron reads are never served from the Data Cache', () => {
  it('declares fetchCache force-no-store alongside force-dynamic', () => {
    const src = readFileSync('app/api/cron/send-drips/route.ts', 'utf8')
    expect(src).toContain("export const dynamic = 'force-dynamic'")
    expect(src).toContain(NO_STORE)
  })

  it('every route that sends a token-footered email declares it too', () => {
    // The two senders that need the unsubscribe token, and the mint itself.
    // Routes that only SCHEDULE or CANCEL (lead create, intake, edit, resume,
    // close) are not covered by this pin — they never read the token.
    const calls = ['sendWelcomeEmail(', 'sendStageEmail(', 'ensureUnsubscribeToken(', 'buildCanSpamFooter(']
    const args = calls.map((c) => `-e '${c}'`).join(' ')
    const hits = execSync(`grep -rlF ${args} app --include=route.ts || true`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    // The cron itself must be among them — if this ever fails, the grep broke,
    // not the rule.
    expect(hits).toContain('app/api/cron/send-drips/route.ts')
    const missing = hits.filter((f) => !readFileSync(f, 'utf8').includes(NO_STORE))
    expect(missing, 'routes that send a footered email without fetchCache=force-no-store').toEqual([])
  })
})
