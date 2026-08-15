#!/usr/bin/env node
// scripts/screen-map-sync.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Recompute the DERIVED "lines" on every docs/screen-map.json entry from its
// anchors, and write them back. Nothing else in the file is touched.
//
// Run it after a change moves code around inside BeeHub.jsx (which is most
// changes). The guard fails on drift on purpose; this is the one command that
// fixes the drift without letting anyone hand-edit a line number.
//
//   node scripts/screen-map-sync.mjs           # write
//   node scripts/screen-map-sync.mjs --check   # report only, exit 1 on drift
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import { MAP_PATH, loadMap, deriveLines, findDecl, fileExists } from './screen-map.mjs'

const checkOnly = process.argv.includes('--check')
const map = loadMap()
const entries = map.entries
const changed = []
const broken = []

for (const e of entries) {
  if (!fileExists(e.file)) { broken.push(`${e.id}: missing file ${e.file}`); continue }
  if (!findDecl(e.file, e.symbol)) { broken.push(`${e.id}: ${e.file} has no top-level "${e.symbol}"`); continue }
  const derived = deriveLines(e, entries)
  if (derived === null) { broken.push(`${e.id}: anchor missing or ambiguous in ${e.file}`); continue }
  const before = JSON.stringify(e.lines)
  if (before !== JSON.stringify(derived)) {
    changed.push(`${e.id}: ${before ?? 'none'} → ${JSON.stringify(derived)}`)
    e.lines = derived
  }
}

if (broken.length) {
  console.error('Cannot sync — these entries no longer resolve at all:')
  for (const b of broken) console.error('  ✗ ' + b)
  console.error('\nFix or remove the entry; a line number cannot be derived for code that is gone.')
  process.exit(1)
}

if (!changed.length) {
  console.log(`docs/screen-map.json: ${entries.length} entries, all line ranges current.`)
  process.exit(0)
}

if (checkOnly) {
  console.error(`docs/screen-map.json: ${changed.length} stale line range(s):`)
  for (const c of changed) console.error('  · ' + c)
  process.exit(1)
}

fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n')
console.log(`docs/screen-map.json: updated ${changed.length} line range(s).`)
for (const c of changed) console.log('  · ' + c)
