// @vitest-environment node
//
// Fix 2 / Phase 4 — 'All Locations' becomes a corporate overview.
//
// 'all' was the last slow path: 28.57 MB of records loaded so the BROWSER could
// reduce them to five headline numbers. Now the server reduces and ships the
// numbers, and the people graph is not loaded on that scope at all.
//
// What these tests defend, in order of how badly each fails:
//
//  1. NO FABRICATED NUMBERS. Every count is computed with the SAME pure
//     functions the scoped Home uses, so the two paths agree by construction.
//     A re-implementation that drifts would show a different number for the
//     same tenant depending on which scope you were on — and both would look
//     equally authoritative.
//  2. THE SEARCH FENCE. The search now reaches every location for an elevated
//     user. A franchise user must not be able to reach another location's
//     leads through it by any spelling of the query.
//  3. TRUNCATION IS VISIBLE. A short count presented as complete is the exact
//     silent failure this whole effort has been retiring.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))
vi.mock('@/components/BeeHub', () => ({ default: () => null }))

import { buildAllOverview } from '@/lib/hub-all-overview'
import {
  ESTIMATE_FOLLOWUP_DAYS,
  INVOICE_AGING_DAYS,
} from '@/components/hive/shared/attentionThresholds'

const DAY = 86400000
const NOW = Date.UTC(2026, 6, 23, 12, 0, 0)
const ago = (d: number) => new Date(NOW - d * DAY).toISOString()

// ── fake PostgREST: enough grammar for the overview's reads ────────────────
function makeDb(tables: Record<string, any[]>) {
  const seen: string[] = []
  const from = (table: string) => {
    seen.push(table)
    let rows = [...(tables[table] || [])]
    let head = false
    const b: any = {
      select(_c: string, opts: any = {}) { head = !!opts.head; return b },
      not(col: string, op: string, val: any) {
        if (op === 'is' && val === true) rows = rows.filter(r => r[col] !== true)
        else if (op === 'in') {
          const set = new Set(String(val).replace(/[()"]/g, '').split(','))
          rows = rows.filter(r => !set.has(r[col]))
        }
        return b
      },
      eq(col: string, val: any) { rows = rows.filter(r => r[col] === val); return b },
      gt(col: string, val: any) { rows = rows.filter(r => Number(r[col]) > Number(val)); return b },
      gte(col: string, val: any) { rows = rows.filter(r => String(r[col]) >= String(val)); return b },
      lt(col: string, val: any) { rows = rows.filter(r => String(r[col]) < String(val)); return b },
      in(col: string, vals: any[]) { const s = new Set(vals); rows = rows.filter(r => s.has(r[col])); return b },
      order() { return b },
      range(a: number, z: number) { rows = rows.slice(a, z + 1); return b },
      then(res: any, rej: any) {
        return Promise.resolve(head
          ? { data: null, count: rows.length, error: null }
          : { data: rows, count: rows.length, error: null }
        ).then(res, rej)
      },
    }
    return b
  }
  return { db: { from }, seen }
}

const lead = (o: any = {}) => ({
  id: o.id || `l-${Math.random().toString(36).slice(2, 8)}`,
  name: 'A Lead', email: 'a@b.com', phone: '5615550199',
  created_at: ago(3), is_junk: false, location_id: 'loc_kc',
  location_uuid: 'kc', paid_amount: 0, ...o,
})

describe('Phase 4 — the overview computes REAL numbers', () => {
  it('counts new-uncontacted through the SAME derivation the scoped Home uses', async () => {
    const { db } = makeDb({
      leads: [
        lead({ id: 'n1', created_at: ago(2) }),                       // New
        lead({ id: 'n2', created_at: ago(29) }),                      // New (inside 30d)
        lead({ id: 'active', created_at: ago(1) }),                   // has an open engagement → Active
        lead({ id: 'won', created_at: ago(1) }),                      // has a won engagement → Client
        lead({ id: 'paid', created_at: ago(1), paid_amount: 500 }),   // paid → Past
        lead({ id: 'nocontact', created_at: ago(1), email: null, phone: null }), // no_contact
        lead({ id: 'other', created_at: ago(1), location_id: 'loc_other' }),     // transfer card, not this
        lead({ id: 'junk', created_at: ago(1), is_junk: true }),      // excluded by the query
      ],
      touchpoints: [],
      engagements: [{ client_id: 'won', stage: 'Closed Won' }],
      invoices: [],
    })
    const ov = await buildAllOverview(db, [{ id: 'e1', client_id: 'active', stage: 'Request' }], NOW)
    // n1 + n2 only. Every other row is excluded by a REAL rule, not a filter
    // written twice.
    expect(ov.newUncontacted.count).toBe(2)
    expect(ov.newUncontacted.oldestDays).toBe(29)
  })

  it('an Attempting lead (recent reach-out) is NOT counted as New', async () => {
    const { db } = makeDb({
      leads: [lead({ id: 'a1', created_at: ago(5) })],
      // `kind` is the real column name — the mapper renames it to `type` on
      // the timeline entry. A fixture using `type` here would pass against a
      // query that is broken in production.
      touchpoints: [{ lead_id: 'a1', kind: 'reach_out', occurred_at: ago(2) }],
      engagements: [], invoices: [],
    })
    const ov = await buildAllOverview(db, [], NOW)
    expect(ov.newUncontacted.count).toBe(0)
  })

  it('estimates awaiting follow-up honor the SHARED threshold', async () => {
    const engs = [
      { id: 'e1', client_id: 'c1', stage: 'Estimate', quotes: [{ sent_at: ago(ESTIMATE_FOLLOWUP_DAYS + 5) }] },
      { id: 'e2', client_id: 'c2', stage: 'Estimate', quotes: [{ sent_at: ago(1) }] },      // too recent
      { id: 'e3', client_id: 'c3', stage: 'Estimate', quotes: [] },                          // never sent
      { id: 'e4', client_id: 'c4', stage: 'Request', quotes: [{ sent_at: ago(99) }] },       // wrong stage
    ]
    const { db } = makeDb({ leads: [], touchpoints: [], engagements: [], invoices: [] })
    const ov = await buildAllOverview(db, engs, NOW)
    expect(ov.estimateFollowUps.count).toBe(1)
    expect(ov.estimateFollowUps.oldestDays).toBe(ESTIMATE_FOLLOWUP_DAYS + 5)
  })

  it('sums aging invoices in JS — PostgREST aggregates are disabled project-wide', async () => {
    const { db } = makeDb({
      leads: [], touchpoints: [], engagements: [],
      invoices: [
        { id: 'i1', balance_owing: 100.5, issued_at: ago(INVOICE_AGING_DAYS + 10) },
        { id: 'i2', balance_owing: 250, issued_at: ago(INVOICE_AGING_DAYS + 1) },
        { id: 'i3', balance_owing: 999, issued_at: ago(1) },   // not aging yet
        { id: 'i4', balance_owing: 0, issued_at: ago(99) },    // paid
      ],
    })
    const ov = await buildAllOverview(db, [], NOW)
    expect(ov.agingInvoices.count).toBe(2)
    expect(ov.agingInvoices.total).toBeCloseTo(350.5, 2)
    expect(ov.agingInvoices.oldestDays).toBe(INVOICE_AGING_DAYS + 10)
    // Outstanding is EVERY unpaid balance, deliberately a different number.
    expect(ov.outstandingTotal).toBeCloseTo(1349.5, 2)
  })

  it('active clients = DISTINCT clients with an open engagement, not engagement count', async () => {
    // A repeat client with two open deals is ONE active client but TWO open
    // engagements — the scoped Home draws that distinction and so must this.
    const engs = [
      { id: 'e1', client_id: 'c1', stage: 'Request' },
      { id: 'e2', client_id: 'c1', stage: 'Estimate' },
      { id: 'e3', client_id: 'c2', stage: 'Request' },
    ]
    const { db } = makeDb({ leads: [], touchpoints: [], engagements: [], invoices: [] })
    const ov = await buildAllOverview(db, engs, NOW)
    expect(ov.openEngagementsCount).toBe(3)
    expect(ov.activeClientsCount).toBe(2)
  })

  it('assessments are windowed to today..+horizon and carry the client name', async () => {
    const soon = new Date(NOW + 3 * 3600000).toISOString()
    const engs = [
      { id: 'e1', client_id: 'c1', client_name: 'Sarah M', stage: 'Request', assessments: [{ id: 'a1', scheduled_at: soon }] },
      { id: 'e2', client_id: 'c2', client_name: 'Old One', stage: 'Request', assessments: [{ id: 'a2', scheduled_at: ago(9) }] },
    ]
    const { db } = makeDb({ leads: [], touchpoints: [], engagements: [], invoices: [] })
    const ov = await buildAllOverview(db, engs, NOW)
    expect(ov.upcomingAssessments).toHaveLength(1)
    expect(ov.upcomingAssessments[0].client).toBe('Sarah M')
  })

  it('reads touchpoints.kind — the column that actually exists', () => {
    // Selecting `type` errors ("column touchpoints.type does not exist"), the
    // accumulator stays empty, and every Attempting lead counts as New. A
    // WRONG headline number, not a missing one.
    const src = readFileSync('lib/hub-all-overview.ts', 'utf8')
    expect(src).toContain(`.select('lead_id, kind, occurred_at')`)
    expect(src).not.toContain(`.select('lead_id, type, occurred_at')`)
  })

  it('a failed derivation input marks the overview truncated rather than inflating', () => {
    const src = readFileSync('lib/hub-all-overview.ts', 'utf8')
    expect(src).toContain('derivationInputsComplete = false')
    expect(src).toContain('|| !derivationInputsComplete,')
  })

  it('never reads the whole leads table — candidates are recency-bounded', async () => {
    // The regression that would undo the phase: dropping the created_at bound
    // and paging every lead again.
    const src = readFileSync('lib/hub-all-overview.ts', 'utf8')
    expect(src).toContain(`.gte('created_at', since30)`)
    expect(src).toContain(`.not('is_junk', 'is', true)`)
  })
})

describe('_hub-page wiring — Phase 4', () => {
  const src = readFileSync('app/_hub-page.tsx', 'utf8')

  it('"all" for an elevated user takes the overview branch', () => {
    expect(src).toContain('const overviewOnly = isElevated && !scopeLocationUuid')
    expect(src).toContain('if (!overviewOnly) {')
  })

  it('a franchise user with no location still takes the OLD path, not the overview', () => {
    // `isElevated &&` is what keeps them there. Without it a franchise user
    // with a null location_id would silently lose their people graph.
    expect(src).toContain('isElevated && !scopeLocationUuid')
  })

  it('the bin is skipped on "all" — it enumerates people', () => {
    expect(src).toContain('if (!overviewOnly) {\n    let binQ')
  })

  it('engagements are COUNTED on "all" but never shipped (Phase 4b)', () => {
    // Phase 4 kept the board live on 'all'. Phase 4b removed it — a board
    // blending several locations' deals into shared stage columns is a blend,
    // not a view. The rows are still read server-side to reduce the overview,
    // but only the three columns it needs, and initialEngagements stays empty
    // (which is what drives the Engagements picker prompt).
    expect(src).toContain('buildAllOverview(supabaseService, overviewEngagements)')
    expect(src).toContain(`.select('id, client_id, stage')`)
    // Only the two child tables the overview reduces — no jobs / invoices /
    // service_requests, and no repeat-count or client-name sweep for a board
    // that no longer renders.
    expect(src).toContain(`chunked('quotes', 'engagement_id, sent_at'`)
    expect(src).toContain(`chunked('assessments', 'id, engagement_id, scheduled_at'`)
    const block = src.slice(src.indexOf("The 'all' path: COUNTS ONLY"), src.indexOf('// Recycle Bin: load is_junk=true'))
    expect(block).not.toContain(`chunked('jobs'`)
    expect(block).not.toContain(`chunked('invoices'`)
    expect(block).not.toContain(`chunked('service_requests'`)
  })

  it('MAX_LEADS is lowered to 5,000 and truncation is made VISIBLE', () => {
    expect(src).toContain('const MAX_LEADS = 5000')
    expect(src).toContain('leadsTruncated = true')
    expect(src).toContain('initialLeadsTruncated={leadsTruncated}')
  })

  it('the overview reaches the client', () => {
    expect(src).toContain('initialAllOverview={initialAllOverview}')
  })
})

describe('search endpoint — the fence and the sanitizer', () => {
  const src = readFileSync('app/api/search/route.ts', 'utf8')

  it('non-elevated callers are pinned to their own location', () => {
    expect(src).toContain('const scopeUuid = elevated ? null : (hubUser.location_id || null)')
    expect(src).toContain(`if (scopeUuid) q = q.eq('location_uuid', scopeUuid)`)
    // A franchise user with no location gets nothing, not everything.
    expect(src).toContain('if (!elevated && !scopeUuid)')
  })

  it('the term is sanitized before it can reach the or() grammar', () => {
    // `,` `(` `)` are STRUCTURAL in PostgREST's or= filter, and `%`/`_` are
    // LIKE wildcards — a raw term could restructure the query or force a full
    // table scan.
    expect(src).toContain('function sanitizeTerm')
    expect(src).toMatch(/replace\(\/\[,\(\)\*%_\\\\\.\]\/g/)
    expect(src).toContain('.or(ors.join(\',\'))')
  })

  it('results carry the location — the point of a cross-location search', () => {
    expect(src).toContain('locationName:')
    expect(src).toContain('truncated:')
  })

  it('junked leads never surface', () => {
    expect(src).toContain(`.not('is_junk', 'is', true)`)
  })
})

describe('location summary endpoint', () => {
  const src = readFileSync('app/api/admin/locations/[id]/summary/route.ts', 'utf8')

  it('is elevated-only — it reads ANY location by id', () => {
    expect(src).toContain('if (!isAdmin(hubUser.role))')
    expect(src).toContain('forbidden_admin_only')
  })

  it('ships counts, never rows', () => {
    expect(src).toContain(`{ count: 'exact', head: true }`)
    expect(src).not.toContain(`.select('*')`)
  })

  it('derives open stages from the stage machine rather than re-typing them', () => {
    // A hand-written list would silently omit a stage the board later gains,
    // and the pipeline bars would just not show it.
    expect(src).toContain('ENGAGEMENT_STAGES.filter(s => !s.terminal).map(s => s.key)')
    // CLOSED_STAGE_FILTERS is an OBJECT — `.closed` holds the terminal pair.
    expect(src).toContain('CLOSED_STAGE_FILTERS.closed.join')
  })
})

describe('BeeHub wiring — Phase 4', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')

  it('Home reads the server overview on "all" instead of the people graph', () => {
    expect(src).toContain('if (allOverview) {')
    expect(src).toContain('}, [people, engagements, transferPeople, allOverview, effectiveLocId, isElevated, canSeeFinancials])')
  })

  it('the hero cards read explicit COUNTS, so both paths share one shape', () => {
    // The 'all' branch has numbers without rows and must not fabricate array
    // elements just to satisfy `.length`.
    expect(src).toContain('newCount > 0 &&')
    expect(src).toContain('estimateCount > 0 &&')
    expect(src).toContain('canSeeFinancials && agingCount > 0')
    expect(src).toContain('const attentionCount = newCount + estimateCount + upcomingAssessments.length')
  })

  it('truncation is rendered, not just logged', () => {
    expect(src).toContain('{(leadsTruncated || overviewTruncated) && (')
    expect(src).toContain("Some records weren&apos;t loaded")
  })

  it('the hardcoded loc_kc literal is gone', () => {
    expect(src).not.toContain(`locFilter==='all'?'loc_kc':locFilter`)
    expect(src).toContain(`locFilter==='all' ? null : locFilter`)
  })

  it('⌘K queries the server and navigates for real', () => {
    expect(src).toContain('/api/search?q=')
    // router.push, not pushState: only a real navigation re-runs the server
    // component, which is what opens a hit at ANOTHER location (Phase 2).
    expect(src).toContain('router.push(clientPath(p.id))')
  })

  it('LocationDrilldown reads the summary endpoint, not the people graph', () => {
    expect(src).toContain('/api/admin/locations/${loc.id}/summary')
    expect(src).not.toContain('const locPeople   = people.filter(p=>p.locationId===loc.id&&!p.isJunk)')
  })

  it('every record lens is gated on "all", and the picker is one click away', () => {
    // Renamed from peopleUnavailable in 4b: it gates ENGAGEMENTS now too, and a
    // name that says "people" would invite someone to re-enable the board.
    expect(src).toContain('locationRequired={!!initialAllOverview}')
    expect(src).not.toContain('peopleUnavailable={')
    // The prompt opens the switcher itself rather than sending the user hunting.
    expect(src).toContain('onOpenLocationPicker={()=>setShowLocPicker(true)}')
  })
})

describe('HiveShell — the record lenses on "all" (Phase 4b)', () => {
  const src = readFileSync('components/hive/HiveShell.jsx', 'utf8')

  it('Client List AND Engagements swap for the shared prompt', () => {
    // PickALocation moved to shared/ when Network (mounted outside the shell)
    // joined the same rule — the shell now imports the one shared prompt.
    expect(src).toContain("import PickALocation from './shared/PickALocation'")
    expect(src).toContain("locationRequired && (lens === 'clients' || lens === 'engagements')")
  })

  it('ONE prompt component covers every lens — no second empty state', () => {
    const shared = readFileSync('components/hive/shared/PickALocation.jsx', 'utf8')
    expect(shared).toContain('const PICK_COPY = {')
    for (const k of ['inbox:', 'clients:', 'engagements:', 'network:']) expect(shared).toContain(k)
    // Copy is about HOW THE PRODUCT WORKS, never about missing data.
    expect(shared).toContain('works one location at a time')
    expect(src).not.toContain('No engagements found')
    // The shell defines no local copy of the prompt — one component, period.
    expect(src).not.toContain('function PickALocation')
  })

  it('the prompt opens the switcher rather than describing where it is', () => {
    const shared = readFileSync('components/hive/shared/PickALocation.jsx', 'utf8')
    expect(shared).toContain('Choose a location')
    expect(shared).toContain('onClick={onPick}')
  })

  it('the Inbox is NOT swapped — it owns the cross-location transfer queue', () => {
    // Phase 4's version replaced the whole Inbox, which took the loc_other
    // "Needs transfer" section down on 'all'. It renders the queue and shows
    // the prompt in place of New/Attempting instead.
    expect(src).toContain('locationRequired={locationRequired}')
    expect(src).not.toContain("locationRequired && (lens === 'inbox'")
  })

  it('badges are suppressed, not shown as zero', () => {
    // A 0 would read as "you have no work" rather than "not counted here".
    expect(src).toContain('const tabBadges = locationRequired')
    expect(src).toContain("{ inbox: null, engagements: null, clients: null }")
  })

  it('the Board/List toggle is hidden when there is no board', () => {
    expect(src).toContain("const engToggleEl = (lens !== 'engagements' || locationRequired) ? null : (")
  })
})

describe('InboxScreen on "all" — the transfer queue survives', () => {
  const src = readFileSync('components/hive/InboxScreen.jsx', 'utf8')
  it('renders the queue and prompts only in place of New/Attempting', () => {
    expect(src).toContain('locationRequired = false')
    expect(src).toContain('{locationRequired ? (')
    // The transfer section is rendered BEFORE the branch, so it is unaffected.
    const transferAt = src.indexOf('bee-inbox-sec-transfer')
    const branchAt = src.indexOf('{locationRequired ? (')
    expect(transferAt).toBeGreaterThan(0)
    expect(transferAt).toBeLessThan(branchAt)
  })
})
