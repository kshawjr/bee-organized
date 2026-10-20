// @vitest-environment node
//
// Every cron writes one log line on EVERY run, even when there was nothing to
// do (Kevin, 20 Oct 2026) — so a healthy quiet cron and a dead one never look
// the same from a log search. other-cards was taken for never having run.
//   • the words (lib/cron-log-lines), zeros included
//   • each silent cron now calls its line on the success path
//   • a guard: any cron registered in vercel.json with no log line fails here
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { otherCardsLine, sendDripsLine, gmailSyncLine, zohoTopupLine, importSweeperQuietLine } from '@/lib/cron-log-lines'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const zero = { sent: 0, skipped: 0, failed: 0, considered: 0 }

describe('the lines, quiet runs included', () => {
  it('other-cards', () => {
    expect(otherCardsLine({ checked: 0, retired: 0, reposted: 0, failed: 0 })).toBe('[cron other-cards] checked 0, retired 0, reposted 0')
    expect(otherCardsLine({ checked: 4, retired: 1, reposted: 2, failed: 1 })).toBe('[cron other-cards] checked 4, retired 1, reposted 2, failed 1')
  })
  it('send-drips', () => {
    expect(sendDripsLine({ drips: zero, welcome: zero, stage: zero, held: 0 }))
      .toBe('[cron send-drips] drips 0 sent / 0 skipped / 0 failed of 0; welcome 0 sent / 0 skipped / 0 failed of 0; stage 0 sent / 0 skipped / 0 failed of 0; held 0')
    expect(sendDripsLine({ drips: { sent: 3, skipped: 1, failed: 0, considered: 4 }, welcome: zero, stage: zero, held: 2 }))
      .toContain('drips 3 sent / 1 skipped / 0 failed of 4')
  })
  it('gmail-sync', () => {
    expect(gmailSyncLine({ accountsEnabled: 0, accountsSynced: 0, accountsFailed: [], circuitOpen: [], skippedForTime: [], elapsedMs: 12 }))
      .toBe('[cron gmail-sync] accounts 0, synced 0, failed 0, circuit open 0, out of time 0, 12ms')
  })
  it('zoho-recipient-topup', () => {
    expect(zohoTopupLine({ locations: 41, planned: 0, inserted: 0, errors: 0 })).toBe('[cron zoho-recipient-topup] locations 41, planned 0, inserted 0, errors 0')
  })
  it('import-sweeper, nothing stalled', () => {
    expect(importSweeperQuietLine()).toBe('[import-sweeper] checked 0, resumed 0 — no stalled imports')
  })
})

describe('each formerly-silent cron logs on its success path', () => {
  // The line must sit in the straight-line path to the success return, not
  // inside an "only when something happened" branch.
  it.each([
    ['app/api/cron/other-cards/route.ts', 'console.log(otherCardsLine(result))', 'return NextResponse.json({ ok: true, ...result })'],
    ['app/api/cron/send-drips/route.ts', 'console.log(sendDripsLine({', 'return NextResponse.json({\n    held_missing_rate: heldMissingRate,'],
    ['app/api/cron/gmail-sync/route.ts', 'console.log(gmailSyncLine(report))', 'return NextResponse.json(report)'],
    ['app/api/cron/zoho-recipient-topup/route.ts', 'console.log(zohoTopupLine({', 'return NextResponse.json({\n    locations_in_scope: plan.locations.length,'],
    ['app/api/cron/import-sweeper/route.ts', 'console.log(importSweeperQuietLine())', 'return NextResponse.json({ resumed: 0, checked: 0 })'],
  ])('%s', (file, logCall, successReturn) => {
    const s = read(file)
    const at = s.indexOf(logCall)
    const ret = s.indexOf(successReturn)
    expect(at).toBeGreaterThan(-1)
    expect(ret).toBeGreaterThan(at)
    // nothing between the line and the return can skip it
    const between = s.slice(at, ret)
    expect(between).not.toMatch(/\breturn\b/)
    // and the line is not tucked inside a "did anything happen" if — neither
    // a one-line `if (x) console.log(…)` nor an `if (x) {` block around it
    const lineStart = s.lastIndexOf('\n', at) + 1
    expect(s.slice(lineStart, at).trim()).toBe('')
    const before = s.slice(Math.max(0, at - 160), lineStart)
    expect(before).not.toMatch(/if \([^)]*\) \{\s*$/)
  })

  it('zoho no longer logs only when it inserted something', () => {
    expect(read('app/api/cron/zoho-recipient-topup/route.ts')).toContain('console.log(zohoTopupLine({')
  })
})

describe('guard: no registered cron may be silent', () => {
  const crons: { path: string }[] = JSON.parse(read('vercel.json')).crons
  it.each(crons.map((c) => [c.path]))('%s writes a log line', (path) => {
    const s = read(`app${path}/route.ts`)
    expect(s).toMatch(/console\.log\(/)
  })
})
