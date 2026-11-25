// lib/connection-screens-hub-footprint.ts
// ─────────────────────────────────────────────────────────────
// The Slack and Jobber connection screens (2026-11-25, the Lovable look)
// changed components/BeeHub.jsx on purpose: SlackCard, JobberCard, the import
// step JobberCard draws inside itself, their two mounts in SettingsScreen and
// three import lines. Several older tests pin BeeHub.jsx by fingerprint
// ("this slice changed nothing else"). They take THIS change back out first.
//
// The pieces are in lib/__fixtures__/connection-screens-hub.json as
// [what is there now, what main c35bb70 had] — too long to read here, and
// made by comparing the two files, not by hand. Each "now" piece must be in
// the file exactly once, and the file with all of them put back is byte for
// byte origin/main c35bb70 (its fingerprint is in the fixture and is checked
// here). So ANY other change to BeeHub.jsx still fails those tests.
// ─────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto'
import fixture from './__fixtures__/connection-screens-hub.json'

export const CONNECTION_SCREENS_HUB = fixture as { from: string; sha256: string; pieces: [string, string][] }

/** BeeHub.jsx with the Slack and Jobber screens taken back out. Throws if a piece is missing or doubled. */
export function withoutConnectionScreens(src: string): string {
  let s = src
  for (const [now, was] of CONNECTION_SCREENS_HUB.pieces) {
    const n = s.split(now).length - 1
    if (n !== 1) throw new Error(`BeeHub.jsx: a connection-screens piece ${JSON.stringify(now.slice(0, 60))} appears ${n} times, expected 1`)
    s = s.split(now).join(was)
  }
  return s
}

/** True when the file, with the pieces put back, is exactly what main had. */
export const isMainOnceTakenOut = (src: string) =>
  createHash('sha256').update(withoutConnectionScreens(src)).digest('hex') === CONNECTION_SCREENS_HUB.sha256
