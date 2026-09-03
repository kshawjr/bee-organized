#!/usr/bin/env node
// scripts/waggle-add.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Add ONE line to this week's What's new draft, from the command line — for a
// Claude Code session to run after a push lands, when an owner would notice
// what shipped. The rule for WHEN is in CLAUDE.md ("What's new — telling the
// owners"). This file only carries the line.
//
//   node scripts/waggle-add.mjs <new|changed|fixed> "Headline" "One sentence."
//   node scripts/waggle-add.mjs fixed "Finished jobs will actually close now" \
//     "Jobs you archived or finished at no charge sat in Final Processing with no way out. Two clicks now."
//
// Flags:
//   --dry-run   print what would be sent and stop (no key needed, no network)
//
// Key:  WAGGLE_WRITE_KEY in the environment, else the file ~/.config/bee-hub/waggle-key.
//       The same value is set in Vercel (Production) for the route. Generate with
//       `openssl rand -hex 32`. Never in the repo, never in .env.local.
// URL:  WAGGLE_URL in the environment, default https://beehive.beeorganized.com.
//
// The words are checked HERE first (lib/waggle-line-rules.mjs — the same
// checks the route runs), so a hash, an issue number, a file name or
// engineering vocabulary fails before anything leaves this machine.
// Exit codes: 0 added (or dry run) · 1 refused (bad words, server said no) ·
// 2 not set up (no key) · 3 could not reach the server.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lintOwnerLine } from '../lib/waggle-line-rules.mjs'

export const KEY_ENV = 'WAGGLE_WRITE_KEY'
export const KEY_FILE = path.join(os.homedir(), '.config', 'bee-hub', 'waggle-key')
export const DEFAULT_URL = 'https://beehive.beeorganized.com'
export const ROUTE = '/api/help/releases/lines'

export function readKey(env = process.env) {
  if (env[KEY_ENV]?.trim()) return env[KEY_ENV].trim()
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim() || null } catch { return null }
}

export function parseArgs(argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--')))
  const positional = argv.filter(a => !a.startsWith('--'))
  const [group, title, body] = positional
  return { group: (group || '').toLowerCase(), title: title || '', body: body || '', dryRun: flags.has('--dry-run') }
}

const USAGE = `usage: node scripts/waggle-add.mjs <new|changed|fixed> "Headline" "One sentence." [--dry-run]`

export async function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const { group, title, body, dryRun } = parseArgs(argv)
  if (!group || !title || !body) { out.error(USAGE); return 1 }

  const line = { group, title, body }
  const problem = lintOwnerLine(line)
  if (problem) { out.error(`Not added — ${problem}`); return 1 }

  const base = (env.WAGGLE_URL || DEFAULT_URL).replace(/\/+$/, '')
  const url = `${base}${ROUTE}`
  if (dryRun) {
    out.log(`DRY RUN — would POST to ${url}`)
    out.log(JSON.stringify(line, null, 2))
    return 0
  }

  const key = readKey(env)
  if (!key) {
    out.error(`Not set up — no ${KEY_ENV} in the environment and no ${KEY_FILE}. Ask Kevin for the key, then: mkdir -p ~/.config/bee-hub && printf '%s' '<key>' > ${KEY_FILE} && chmod 600 ${KEY_FILE}`)
    return 2
  }

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(line),
    })
  } catch (err) {
    out.error(`Could not reach ${url}: ${err?.message || err}`)
    return 3
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    out.error(`Not added — the server said ${res.status}: ${data.error || 'no detail'}`)
    return 1
  }
  const label = { new: 'New', changed: 'Changed', fixed: 'Fixed' }[data.line?.group] || group
  out.log(`Added to the What's new draft for the week ending ${data.release?.week_label || data.release?.publish_on || '?'}:`)
  out.log(`  ${label} · ${data.line?.title || title}`)
  out.log(`  ${data.line?.body || body}`)
  out.log(`Kevin can edit or remove it under Help › What's new.`)
  return 0
}

// Run only when invoked directly, so the test can import main() without side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().then(code => process.exit(code))
}
