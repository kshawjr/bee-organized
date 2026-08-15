// lib/beta-screen-map-248.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE GUARD for docs/screen-map.json (issue 248 step 1).
//
// A map that silently rots is worse than no map: a wrong entry sends every
// future scout to the wrong file, permanently, and does it with confidence.
// This test is what makes rot loud.
//
// It fails on STALENESS, not merely on malformed JSON:
//   · a file an entry points at has been deleted or moved
//   · a symbol an entry names is no longer declared at the top level
//   · a symbol that was exported is now internal (or the reverse)
//   · a sub-region anchor string is gone, or has become ambiguous
//   · an API route an entry claims to call no longer exists
//   · that route no longer exports the method the entry claims
//   · a table no longer appears in any route or lib query
//   · a line range no longer matches what the anchors derive
//
// The line-range check is the one that fires most often, because most changes
// move code inside BeeHub.jsx. Fixing it is one command:
//     node scripts/screen-map-sync.mjs
// which re-derives every range from the anchors. Line numbers are never
// hand-written, so they can never be hand-wrong.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain-JS engine shared with scripts/screen-map-sync.mjs
import { loadMap, verifyMap, NAV_SURFACES } from '../scripts/screen-map.mjs'

const map = loadMap()
const entries: any[] = map.entries

describe('screen map (docs/screen-map.json)', () => {
  it('has a usable number of entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(40)
  })

  it('covers every nav surface a user can reach', () => {
    const covered = new Set(entries.map(e => e.nav))
    for (const nav of NAV_SURFACES) expect(covered.has(nav), `no entry for nav "${nav}"`).toBe(true)
  })

  // The whole point. One assertion, every kind of rot, and the message names
  // the entry and what stopped being true.
  it('still describes the code that is actually there', () => {
    const problems: string[] = verifyMap(map)
    expect(problems, `\n${problems.length} stale or invalid entr${problems.length === 1 ? 'y' : 'ies'}:\n  · ${problems.join('\n  · ')}\n`).toEqual([])
  })
})

// ── Proof the guard is not vacuous ───────────────────────────────────────────
// Each case takes the REAL map, breaks one entry the way a real refactor would,
// and asserts the guard notices. Without these, a guard that silently passed on
// everything would look exactly like a guard that works.
describe('the guard fails on a stale entry', () => {
  const clone = () => JSON.parse(JSON.stringify(map))
  const failuresFor = (mutate: (m: any) => void) => {
    const m = clone()
    mutate(m)
    return verifyMap(m) as string[]
  }

  it('catches a file that has been deleted or moved', () => {
    const problems = failuresFor(m => { m.entries[0].file = 'components/hive/GoneForever.jsx' })
    expect(problems.some(p => p.includes('file does not exist'))).toBe(true)
  })

  it('catches a symbol that has been renamed away', () => {
    const problems = failuresFor(m => {
      const e = m.entries.find((x: any) => x.id === 'clients.record.notes')
      e.symbol = 'NotesStreamRenamed'
    })
    expect(problems.some(p => p.includes('no longer declares'))).toBe(true)
  })

  it('catches an export that stopped being an export', () => {
    const problems = failuresFor(m => {
      const e = m.entries.find((x: any) => x.id === 'clients.record.notes')
      e.exported = 'internal'
    })
    expect(problems.some(p => p.includes('map says internal'))).toBe(true)
  })

  it('catches a sub-region anchor that no longer exists', () => {
    const problems = failuresFor(m => {
      const e = m.entries.find((x: any) => x.anchor)
      e.anchor = "{activeSection==='thisSectionWasDeleted'&&("
    })
    expect(problems.some(p => p.includes('anchor not found'))).toBe(true)
  })

  it('catches an API route that has been removed', () => {
    const problems = failuresFor(m => {
      const e = m.entries.find((x: any) => x.id === 'clients.send-to-jobber')
      e.routes = ['POST /api/leads/[id]/send-to-jobber-v2']
    })
    expect(problems.some(p => p.includes('route file does not exist'))).toBe(true)
  })

  it('catches a route that no longer serves that method', () => {
    const problems = failuresFor(m => {
      const e = m.entries.find((x: any) => x.id === 'shell.global-search')
      e.routes = ['DELETE /api/search']
    })
    expect(problems.some(p => p.includes('no longer exports DELETE'))).toBe(true)
  })

  it('catches a table that is no longer queried anywhere', () => {
    const problems = failuresFor(m => {
      const e = m.entries.find((x: any) => x.id === 'clients.inbox')
      e.tables = ['leads_old']
    })
    expect(problems.some(p => p.includes('is not read or written'))).toBe(true)
  })

  it('catches a line range that has drifted out of date', () => {
    const problems = failuresFor(m => {
      const e = m.entries.find((x: any) => x.id === 'clients.record')
      e.lines = [1, 2]
    })
    expect(problems.some(p => p.includes('line range is stale'))).toBe(true)
  })
})
