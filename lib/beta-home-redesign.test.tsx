// @vitest-environment happy-dom
//
// Home page redesign (all 3 tiers). Under test — the guarantees from the
// approved-mockup build:
//   T1a  no Home link targets the OLD top-level nav vocabulary
//        (engagements/board/list/classic as a tab) — every tap-through goes
//        through nav('hive') or the onOpenHive deep-link intent.
//   T1b  "Open engagements" (record count) and "Active clients" (people count)
//        are SEPARATE, correctly-labeled metric tiles from the right sources.
//   T2b  Needs-attention hero renders the five alert types from REAL signals;
//        the transfer card is super_admin/corp ONLY; zero alerts → one calm
//        "all caught up" card, never an empty hero.
//   T2d  the info lists start COLLAPSED, remember per-section (a HOME-scoped
//        useStoredState key), and the hero is never collapsed.
//   T3a  Home reads the SHARED derivation (deriveClientStatus / deriveStatusChip)
//        + the CHIP_STYLES tone families, not a hand-rolled copy.
//   T3b  the day-thresholds live in ONE shared module, imported by Home.
//   Deep-link infra (general, reusable beyond Home): a { tab, view?, group?,
//        section? } intent threads BeeHub → HiveScreen → HiveShell, which lands
//        the right tab/view and FORCE-EXPANDS + scrolls the target group. Pinned
//        both as source wiring AND as a live render of the auto-expand.
import { describe, it, expect } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import EngagementGroupedList from '@/components/hive/EngagementGroupedList'
import { ENGAGEMENT_FILTER_DEFAULTS } from '@/components/hive/shared/engagementStatus'
import * as thresholds from '@/components/hive/shared/attentionThresholds'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
const hiveShell = readFileSync(join(process.cwd(), 'components/hive/HiveShell.jsx'), 'utf8')
const groupedList = readFileSync(join(process.cwd(), 'components/hive/EngagementGroupedList.jsx'), 'utf8')
const inbox = readFileSync(join(process.cwd(), 'components/hive/InboxScreen.jsx'), 'utf8')

// DashboardScreen (Home) body — sliced between its own signature and the next
// top-level function so assertions can't leak into neighbours.
const dash = (() => {
  const a = beehub.indexOf('function DashboardScreen(')
  const b = beehub.indexOf('function SubscriptionCalculator(', a + 1)
  return a >= 0 && b >= 0 ? beehub.slice(a, b) : ''
})()

describe('T1a — no stale top-level nav vocabulary in Home', () => {
  it('Home never targets engagements/board/list/classic as a top-level tab', () => {
    expect(dash).not.toContain("nav('engagements')")
    expect(dash).not.toContain("nav('board')")
    expect(dash).not.toContain("nav('list')")
    expect(dash).not.toContain("nav('classic')")
    expect(dash).not.toContain("onNavigate('engagements')")
    expect(dash).not.toContain('view=engagements')
  })
  it('tap-throughs go through nav(\'hive\') or the onOpenHive deep-link intent', () => {
    expect(dash).toContain('onOpenHive')
    // the deep-link targets are the NEW tab keys, not old vocabulary
    expect(dash).toContain("onOpenHive({ tab:'inbox'")
    expect(dash).toContain("onOpenHive({ tab:'engagements', view:'list', group:'Estimate' }")
  })
})

describe('T1b — two honestly-labeled counts, separate sources', () => {
  it('Open engagements = open engagement RECORD count', () => {
    expect(dash).toContain('const openEngagementsCount = openEngsH.length')
    expect(dash).toContain('label="Open engagements" value={openEngagementsCount}')
  })
  it('Active clients = distinct PEOPLE with an open engagement (not the record count)', () => {
    expect(dash).toContain('const activeClientsCount = scopedPeopleH.filter(p => openClientIdsH.has(p.id)).length')
    expect(dash).toContain('label="Active clients" value={activeClientsCount}')
  })
})

describe('T2b — Needs-attention hero: five real signals, role-scoped, empty state', () => {
  it('new-leads-not-contacted reuses the Inbox "New" derivation (deriveClientStatus)', () => {
    expect(dash).toContain("deriveClientStatus(p, openClientIdsH, nowHome, wonClientIdsH) === 'New'")
    expect(dash).toContain("key:'new-uncontacted'")
  })
  it('estimate follow-ups read engagement quotes sent-age against the shared threshold', () => {
    expect(dash).toContain("e.stage !== 'Estimate'")
    expect(dash).toContain('sharedDaysSince(sent, nowHome) > ESTIMATE_FOLLOWUP_DAYS')
  })
  it('assessments today/tomorrow read engagement assessments scheduled_at (raw ISO)', () => {
    expect(dash).toContain('for (const a of (e.assessments||[]))')
    expect(dash).toContain('a.scheduled_at')
    expect(dash).toContain("key:'assessments-soon'")
  })
  it('invoices are UNPAID+AGING (balance + issued-age), never "overdue"', () => {
    expect(dash).toContain('const bal = Number(inv.balance)')
    expect(dash).toContain('sharedDaysSince(inv.date, nowHome)')
    expect(dash).toContain('INVOICE_AGING_DAYS')
    // must not claim a due-date / overdue we don't have
    expect(dash).not.toContain('overdue')
    expect(dash).not.toContain('dueDate')
  })
  it('the transfer card renders ONLY for elevated (super_admin/corp)', () => {
    // Source moved to the dedicated queue in Fix 2 Phase 2 (see
    // lib/beta-hub-scope-phase2.test.ts); the isElevated gate this test exists
    // for is unchanged, and now matters MORE — the server ships the queue
    // whenever the SESSION is elevated, so under view-as this ternary is the
    // only thing keeping corporate's routing queue off an impersonated
    // franchise owner's Home. The gate itself is now the shared
    // visibleTransferQueue, mounted both ways in
    // lib/beta-transfer-queue-all-scope.test.tsx.
    expect(dash).toContain('const transferLeads = visibleTransferQueue(transferPeople, { isElevated }).filter(isLivePersonH)')
    expect(dash).toContain("key:'needs-transfer'")
  })
  it('zero alerts → one calm "all caught up" card, never an empty hero', () => {
    expect(dash).toContain('alertCards.length===0')
    expect(dash).toContain('<HomeAllClearCard />')
  })
})

describe('T2d — collapsible info lists; hero never collapses', () => {
  it('uses the shared useStoredState with a HOME-scoped key (absent = collapsed)', () => {
    expect(beehub).toContain("import { useStoredState } from \"@/components/hive/shared/useStoredControls\"")
    expect(dash).toContain("useStoredState('bee_hive_home_collapsed', {})")
    expect(dash).toContain("const homeExpanded = (k) => homeCollapsed[k] === true")
  })
  it('only the info lists collapse — the Needs-attention hero has no collapse wrapper', () => {
    // the hero label is rendered directly, not behind homeExpanded(...)
    const heroIdx = dash.indexOf('Needs attention</p>')
    expect(heroIdx).toBeGreaterThan(-1)
    const heroBlock = dash.slice(heroIdx - 400, heroIdx + 400)
    expect(heroBlock).not.toContain('homeExpanded(')
    // the info lists DO gate their rows on homeExpanded
    expect(dash).toContain("homeExpanded('upcoming')")
    expect(dash).toContain("homeExpanded('recent')")
  })
})

describe('T3a/T3b — shared machinery + one threshold source', () => {
  it('Home imports the shared derivations + tone families (no private copy)', () => {
    expect(beehub).toContain('import { deriveClientStatus } from "@/components/hive/shared/clientStatus"')
    expect(beehub).toContain('from "@/components/hive/shared/engagementStatus"')
    expect(beehub).toContain('CHIP_STYLES as HIVE_CHIP_STYLES')
  })
  it('the thresholds are ONE shared module, imported by Home', () => {
    expect(typeof thresholds.ESTIMATE_FOLLOWUP_DAYS).toBe('number')
    expect(typeof thresholds.INVOICE_AGING_DAYS).toBe('number')
    expect(typeof thresholds.ASSESSMENT_HORIZON_DAYS).toBe('number')
    expect(beehub).toContain('from "@/components/hive/shared/attentionThresholds"')
  })
})

describe('Deep-link infra — general, threaded, force-expands the target', () => {
  it('the intent threads BeeHub root → HiveScreen → HiveShell', () => {
    expect(beehub).toContain('const [hiveIntent, setHiveIntent] = useState(null)')
    expect(beehub).toContain('initialHiveIntent={hiveIntent}')
    expect(beehub).toContain('onHiveIntentConsumed={()=>setHiveIntent(null)}')
    expect(beehub).toContain('initialHiveIntent=null, onHiveIntentConsumed')
    expect(beehub).toContain('initialIntent={initialHiveIntent}')
  })
  it('HiveShell consumes { tab, view?, group?, section? } and a stage group implies List', () => {
    expect(hiveShell).toContain('initialIntent = null')
    expect(hiveShell).toContain("if (group) { pickEngView('list'); setListInitialView(group) }")
    expect(hiveShell).toContain('initialSection={inboxInitialSection}')
    expect(hiveShell).toContain('onIntentConsumed()')
  })
  it('EngagementGroupedList force-expands ANY stage group (not just Closed) + gives bands ids', () => {
    expect(groupedList).toContain("const gid = initialView === 'closed' ? CLOSED_GID : initialView")
    expect(groupedList).toContain('bee-eng-band-${gid}')
  })
  it('InboxScreen scrolls to the target section on a deep-link', () => {
    expect(inbox).toContain('initialSection')
    expect(inbox).toContain('bee-inbox-sec-transfer')
    expect(inbox).toContain('bee-inbox-sec-new')
  })
})

// ── Live behavior: a deep-linked group lands EXPANDED (Kevin's item 3) ──
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const estimateEngagement = {
  id: 'e1', stage: 'Estimate', client_name: 'Estimate Client', title: 'Kitchen reno',
  created_at: new Date().toISOString(), repeat_count: 1,
  quotes: [{ id: 'q1', status: 'sent', sent_at: new Date().toISOString(), total: 500, approved_at: null }],
  jobs: [], invoices: [], assessments: [], service_requests: [],
  total_invoiced: 0, total_paid: 0, balance_owing: 0, location_uuid: 'loc-1',
}

describe('render — deep-link auto-expand', () => {
  it('lands with the target stage group EXPANDED (rows visible)', async () => {
    try { (globalThis as any).localStorage?.clear?.() } catch {}
    const { host, unmount } = await mount(
      <EngagementGroupedList
        engagements={[estimateEngagement]}
        workFilters={ENGAGEMENT_FILTER_DEFAULTS}
        initialView="Estimate"
        onInitialViewConsumed={() => {}}
        onOpenEngagement={() => {}}
      />,
    )
    // the Estimate band is expanded → its row's client name is in the DOM
    expect(host.textContent || '').toContain('Estimate Client')
    await unmount()
  })

  it('without a deep-link, groups start COLLAPSED (rows not rendered)', async () => {
    try { (globalThis as any).localStorage?.clear?.() } catch {}
    const { host, unmount } = await mount(
      <EngagementGroupedList
        engagements={[estimateEngagement]}
        workFilters={ENGAGEMENT_FILTER_DEFAULTS}
        initialView={null}
        onInitialViewConsumed={() => {}}
        onOpenEngagement={() => {}}
      />,
    )
    // header renders, but the collapsed band hides its rows
    expect(host.textContent || '').not.toContain('Estimate Client')
    await unmount()
  })
})
