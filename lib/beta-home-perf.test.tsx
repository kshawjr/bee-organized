// @vitest-environment happy-dom
//
// Home performance pass (4 quick wins). Guardrails that the perf refactor
// changed HOW OFTEN Home computes, never WHAT it computes. Every rendered
// number must be identical — this file pins the derivation logic and the
// re-render structure so a memo/dep/hoist mistake is caught.
//
// These assertions read the DashboardScreen / HomeGreeting SOURCE slice rather
// than rendering: DashboardScreen is not exported and is too entangled to mount
// in isolation — the SAME reason beta-home-redesign.test.tsx asserts on source.
// The byte-for-byte derivation-string pins below are strong: the numbers are
// produced by identical code, just relocated into a useMemo.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

const slice = (src: string, startNeedle: string, endNeedle: string) => {
  const a = src.indexOf(startNeedle)
  const b = src.indexOf(endNeedle, a + 1)
  return a >= 0 && b >= 0 ? src.slice(a, b) : ''
}

// DashboardScreen body — between its own signature and the next top-level fn.
const dash = slice(beehub, 'function DashboardScreen(', 'function SubscriptionCalculator(')
// HomeGreeting sits immediately before DashboardScreen.
const greeting = slice(beehub, 'function HomeGreeting(', 'function DashboardScreen(')

describe('Fix 1 — Home derivations are memoized (recompute on DATA, not per render)', () => {
  it('the needs-attention + metrics block is wrapped in a useMemo', () => {
    expect(dash).toContain('const homeDerived = useMemo(() => {')
  })

  it('the memo is keyed on the real data inputs — and NOT on any clock/time value', () => {
    // transferPeople joined the dep list in Fix 2 Phase 2 — the Home transfer
    // card reads it now, so a queue that changed without recomputing here
    // would render a stale count. Still no clock/time value: that omission is
    // the whole point of the memo and is asserted below.
    expect(dash).toContain('}, [people, engagements, transferPeople, effectiveLocId, isElevated, canSeeFinancials])')
    // The whole point: no time value in the deps (that would bust the memo on
    // every render/tick and defeat the fix). nowHome is captured INSIDE.
    expect(dash).not.toMatch(/\}, \[[^\]]*\bnow\b[^\]]*\]\)/)
    expect(dash).not.toMatch(/\}, \[[^\]]*nowHome[^\]]*\]\)/)
    expect(dash).not.toMatch(/\}, \[[^\]]*Date\.now[^\]]*\]\)/)
  })

  it('the derivation LOGIC is unchanged — the exact pre-perf expressions, now inside the memo', () => {
    // Pinned byte-for-byte so a "hoist into useMemo" that silently edits a
    // derivation (changing a rendered number) fails here.
    expect(dash).toContain('const nowHome = Date.now()')
    expect(dash).toContain('const openEngagementsCount = openEngsH.length')
    expect(dash).toContain('const activeClientsCount = scopedPeopleH.filter(p => openClientIdsH.has(p.id)).length')
    expect(dash).toContain("deriveClientStatus(p, openClientIdsH, nowHome, wonClientIdsH) === 'New'")
    expect(dash).toContain('sharedDaysSince(sent, nowHome) > ESTIMATE_FOLLOWUP_DAYS')
    expect(dash).toContain('for (const a of (e.assessments||[]))')
    expect(dash).toContain('sharedDaysSince(inv.date, nowHome)')
    // Fix 2 Phase 2 moved the SOURCE of this card (scopedPeopleH → the
    // dedicated, scope-independent transferPeople array) because filtering the
    // location-scoped people array silently emptied the queue under any
    // location scope. The elevated gate and the live-person filter are
    // unchanged, which is what this line still pins.
    expect(dash).toContain('const transferLeads = isElevated ? (transferPeople || []).filter(isLivePersonH) : []')
  })

  it('the memo returns the values the render consumes, destructured back out', () => {
    expect(dash).toContain('} = homeDerived')
    // the four metric tiles still read the memoized outputs (unchanged labels)
    expect(dash).toContain('label="Open engagements" value={openEngagementsCount}')
    expect(dash).toContain('label="Active clients" value={activeClientsCount}')
    expect(dash).toContain('label="New this week" value={newThisWeekCount}')
    expect(dash).toContain('value={fmt(outstandingTotal)}')
  })

  it('recentActivityItems is memoized too, on its own data-scoped deps', () => {
    expect(dash).toContain('const recentActivityItems = useMemo(() => {')
    expect(dash).toContain('}, [people, effectiveLocId])')
  })
})

describe('Fix 2 — the 60s header clock is isolated in HomeGreeting', () => {
  it('DashboardScreen no longer owns a clock (no interval / now state / date strings)', () => {
    // A clock tick must not re-render the derivation block. Proven structurally:
    // the interval + now-state that drove it are GONE from DashboardScreen.
    expect(dash).not.toContain('setInterval(() => setNow')
    expect(dash).not.toContain('const [now, setNow] = useState(null)')
    expect(dash).not.toContain('const dateStr = now ?')
    expect(dash).not.toContain('const timeStr = now ?')
  })

  it('a dedicated HomeGreeting component owns the clock and renders identical header text', () => {
    expect(greeting).not.toBe('')
    expect(greeting).toContain('const [now, setNow] = useState(null)')
    expect(greeting).toContain('setInterval(() => setNow(new Date()), 60_000)')
    // byte-identical greeting + date/time output as before the extraction
    expect(greeting).toContain("now.getHours()<12?'Good morning':now.getHours()<17?'Good afternoon':'Good evening'")
    expect(greeting).toContain('getFirstName(ownerName, ownerEmail)')
    expect(greeting).toContain('{dateStr}{timeStr && ` · ${timeStr}`}')
  })

  it('DashboardScreen renders the isolated greeting in the header', () => {
    expect(dash).toContain('<HomeGreeting ownerName={ownerName} ownerEmail={ownerEmail} />')
  })
})

describe('Fix 3 — dead derivations removed (each verified unused before deletion)', () => {
  // Every one of these fed only other members of the same block; none reached
  // the redesigned render (hero + 4 tiles + upcoming/recent lists).
  const deadVars = [
    'visibleLeads', 'visibleUpcoming', 'totalRevenue', 'collected', 'outstanding',
    'royalties', 'newClients', 'inProgressClients', 'activeLeads', 'oneWeekAgo',
    'newThisWeek', 'inProgress', 'assessmentsToday', 'visiblePeople', 'activePeople',
    'unpaidInvoices', 'stuckLeads', 'noReachOut', 'nearExpiryNurture', 'today',
    'snoozedToday', 'quickCaptures', 'stageCounts', 'maxCount',
  ]

  it('none of the dead stat variables are declared in DashboardScreen anymore', () => {
    for (const v of deadVars) {
      // matches `const X =` / `const X   =` but NOT `const XCount =` (live) or a
      // mention of the name inside a comment.
      const re = new RegExp(`\\bconst\\s+${v}\\s*=`)
      expect(dash, `dead var still declared: ${v}`).not.toMatch(re)
    }
  })

  it('the one live list still derived here (recentActivityItems) is kept and rendered', () => {
    expect(dash).toContain('const recentActivityItems = useMemo')
    expect(dash).toContain('recentActivityItems.length')
  })
})
