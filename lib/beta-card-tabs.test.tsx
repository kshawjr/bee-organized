// @vitest-environment happy-dom
// Tabbed lead-detail cards (PersonCard / ClientProfile / EngagementPanel):
//   — shared skeleton: header → VITALS STRIP → tabs → content; Overview
//     default; Timeline tab embeds the 848cb60 Timeline component; Files
//     on ClientProfile + EngagementPanel only (nothing to file
//     pre-founding)
//   — vitals strip: four cells between the header identity row and the
//     tab bar on every card (so it stays visible on every tab) —
//     EngagementPanel Stage/Value/Last touch/Next, ClientProfile
//     Status/Lifetime/Last touch/Open, PersonCard Status/Inquired/
//     Last touch/Next; absent values render '—'; the strip REPLACED the
//     panel's standalone stage bar and both cards' money-tile rows
//     (invoiced/paid detail moved to the invoice record row; nonzero
//     owing keeps a red Key-facts line on the profile)
//   — pinned buzz on every Overview; the SAME client-level buzz rows
//     show on ClientProfile AND that client's EngagementPanel (one
//     standing note, inherited — not two per-surface notes), and both
//     append through the same lead_notes kind='buzz' write
//   — per-surface content: PersonCard lean (no money/engagements list);
//     ClientProfile engagements + client-WIDE activity incl.
//     client-level job notes (the old inventory gap) with '· re:' tags;
//     EngagementPanel description + records checklist
//   — TWO activity surfaces: Overview quick slice + composer AND the
//     Timeline tab's full stream
//   — write paths preserved: Source None-clear, EditableDesc,
//     stage Advance (which server-side writes the stage_change
//     touchpoint — route source guard)
//   — EngagementPanel header carries the client line (name + View
//     client →) — moved up from Key facts, renders exactly ONCE
//   — action rows are cardKit ActionRow: equal-width repeat(N,1fr)
//     grid, soft-tinted no-border buttons (Call blue / neutral gray /
//     Advance+Send green), behaviors unchanged
//   — §8.5: no BeeHub/PartnersContext/useContext in the card pieces
//   — tab switching works post-streaming without content vanishing
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import PersonCard from '@/components/hive/PersonCard'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
  source: 'Webform', locationId: 'loc-uuid-1', created: daysAgo(40),
  isJunk: false, outreachTimeline: [], ...over,
})

const LOOKUPS = { sources: ['Webform', 'Website', 'Referral'], projectTypes: ['Client', 'Move'] }

// The client's ONE standing buzz — same rows via both endpoints.
const BUZZ_ROWS = [{ id: 'b1', text: 'Gate code 4321 — call before arriving', user_label: 'Kevin', created_at: daysAgo(2) }]

const profilePayload = (over: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: '12 Hive Ln', city: 'Denver', state: 'CO', zip: '80014',
    created_at: daysAgo(40), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: 'Garage overhaul', project_type: 'Client', location_name: 'Denver',
  },
  referred_us: [],
  contacts: [],
  engagements: [
    { id: 'eng-77', title: 'Pantry refresh', stage: 'Estimate', founded_by: 'request', created_at: daysAgo(10), total_invoiced: 0, total_paid: 0, balance_owing: 0, quotes: [{ id: 'q1', status: 'sent', total: 900 }], jobs: [], invoices: [], assessments: [] },
  ],
  touchpoints: [
    { id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(1), engagement_id: 'eng-77', user_label: 'Kevin' },
  ],
  buzz_notes: BUZZ_ROWS,
  job_notes: [
    // client-level note (posted on PersonCard) — the old inventory gap
    { id: 'jn1', text: 'Measured the garage', user_label: 'Kevin', created_at: daysAgo(3), engagement_id: null },
    // engagement-scoped note — must carry the '· re:' tag on the profile
    { id: 'jn2', text: 'Confirmed pantry scope', user_label: 'Kevin', created_at: daysAgo(2), engagement_id: 'eng-77' },
  ],
  aggregates: { lifetime_paid: 4200, open_pipeline: 900, owing: 0, open_count: 1, total_count: 2 },
  ...over,
})

const engagementPayload = (over: any = {}) => ({
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: daysAgo(5), stage_entered_at: daysAgo(5), location_uuid: 'loc-uuid-1',
    project_type: 'Client', description: 'Full kitchen reorganization',
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
    ...(over.engagement || {}),
  },
  children: {
    service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [],
    notes: [{ id: 'en1', text: 'Client prefers mornings', user_label: 'Kevin', created_at: daysAgo(1) }],
    touchpoints: [],
    ...(over.children || {}),
  },
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
    request_details: null, source: 'Webform',
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: BUZZ_ROWS, // the SAME client-level rows the profile shows
    lifetime_paid: 4200, prior_engagements: 1, other_open: 0,
  },
})

const timelinePayload = () => ({
  lead: { id: 'lead-9', snoozed_until: null, snoozed_note: null, welcome_email_scheduled_at: null, welcome_email_sent_at: null },
  touchpoints: [{ id: 'tt1', kind: 'system', method: 'system', label: 'Client created', occurred_at: daysAgo(40), engagement_id: null }],
  notes: [], engagements: [], service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [], scheduled_stage_emails: [],
})
const dripsPayload = () => ({ items: [], drip_progress_id: null, drip_path_name: null, paused: false, stopped: false, completed: false, completed_at: null, stopped_at: null })

// ── fetch mock ─────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let leadPatches: Array<{ url: string, body: any }> = []
let engPatches: any[] = []
let notePosts: any[] = []
let profileOver: any = {}
let engOver: any = {}
const installFetch = () => {
  leadPatches = []; engPatches = []; notePosts = []
  profileOver = {}; engOver = {}
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (u.includes('/outreach-timeline')) return jsonRes(dripsPayload())
    if (u.includes('/api/leads/') && u.includes('/timeline')) return jsonRes(timelinePayload())
    if (u.includes('/api/lead-notes') && method === 'POST') {
      const body = JSON.parse(opts.body)
      notePosts.push(body)
      return jsonRes({ note: { id: `n-${notePosts.length}`, text: body.text, kind: body.kind, engagement_id: body.engagement_id ?? null, user_label: 'You', created_at: new Date().toISOString() } }, 201)
    }
    if (u.includes('/api/touchpoints') && method === 'POST') {
      return jsonRes({ touchpoint: { id: 'tp-new', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: new Date().toISOString() } }, 201)
    }
    if (u.includes('/api/leads/') && method === 'PATCH') {
      leadPatches.push({ url: u, body: JSON.parse(opts.body) })
      return jsonRes({ ok: true })
    }
    if (u.includes('/api/engagements/') && method === 'PATCH') {
      const body = JSON.parse(opts.body)
      engPatches.push(body)
      return jsonRes({ id: 'eng-1', stage: body.stage ?? 'Request', prev_stage: 'Request', title: 'Kitchen + Pantry', description: body.description ?? null, project_type: 'Client', changed: true })
    }
    if (u.includes('/api/engagements/')) return jsonRes(engagementPayload(engOver))
    if (u.includes('/api/partners')) return jsonRes([])
    if (u.includes('/profile')) return jsonRes(profilePayload(profileOver))
    return jsonRes({})
  })
  ;(globalThis as any).fetch = mock
  return mock
}

// ── DOM helpers ────────────────────────────────────────────
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const type = (input: Element, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const keydown = (el: Element, key: string) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
})
const tabButton = (host: Element, label: string) =>
  [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === `${label} tab`)
const buttonContaining = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))

const mountPerson = () => mount(<PersonCard person={person()} onClose={() => {}} lookupOptions={LOOKUPS} onSendToJobber={() => {}} />)
const mountProfile = () => mount(<ClientProfile clientId="lead-9" onClose={() => {}} onSendToJobber={() => {}} />)
const mountPanel = (props: any = {}) => mount(<EngagementPanel engagementId="eng-1" onClose={() => {}} lookupOptions={LOOKUPS} {...props} />)

beforeEach(() => installFetch())

// ═══ shared skeleton ═══════════════════════════════════════
describe('tabbed skeleton', () => {
  it('all three cards: Overview default; Files on profile + panel, NOT on PersonCard', async () => {
    const pc = await mountPerson()
    expect(tabButton(pc.host, 'Overview')?.getAttribute('aria-selected')).toBe('true')
    expect(tabButton(pc.host, 'Timeline')).toBeTruthy()
    expect(tabButton(pc.host, 'Files')).toBeFalsy() // nothing to file pre-founding
    await pc.unmount()

    const cp = await mountProfile()
    expect(tabButton(cp.host, 'Overview')?.getAttribute('aria-selected')).toBe('true')
    expect(tabButton(cp.host, 'Timeline')).toBeTruthy()
    expect(tabButton(cp.host, 'Files')).toBeTruthy()
    await cp.unmount()

    const ep = await mountPanel()
    expect(tabButton(ep.host, 'Overview')?.getAttribute('aria-selected')).toBe('true')
    expect(tabButton(ep.host, 'Timeline')).toBeTruthy()
    expect(tabButton(ep.host, 'Files')).toBeTruthy()
    await ep.unmount()
  })

  it('the Timeline tab embeds the shared Timeline component (its stream renders)', async () => {
    const { host, unmount } = await mountPerson()
    expect(host.textContent).not.toContain('Client created') // timeline not mounted yet
    await click(tabButton(host, 'Timeline')!)
    expect(host.textContent).toContain('Client created') // Timeline's merged stream
    await unmount()
  })

  it('tab switching post-streaming: Overview ↔ Timeline ↔ Files without content vanishing; the strip stays', async () => {
    const { host, unmount } = await mountProfile()
    expect(host.textContent).toContain('Engagements · 2 · 1 open') // Overview
    await click(tabButton(host, 'Timeline')!)
    expect(host.textContent).toContain('Client created')
    expect(host.textContent).not.toContain('Engagements ·') // stepper, not display:none
    expect(host.querySelector('[aria-label="Vitals"]')).toBeTruthy() // header strip persists across tabs
    await click(tabButton(host, 'Files')!)
    expect(host.textContent).toContain('No files yet')
    await click(tabButton(host, 'Overview')!)
    expect(host.textContent).toContain('Engagements · 2 · 1 open') // back, intact
    await unmount()
  })

  it('§8.5: card pieces import no BeeHub/PartnersContext/useContext', () => {
    for (const f of [
      'components/hive/PersonCard.jsx', 'components/hive/ClientProfile.jsx', 'components/hive/EngagementPanel.jsx',
      'components/hive/shared/CardTabs.jsx', 'components/hive/shared/PinnedBuzz.jsx', 'components/hive/shared/cardKit.jsx',
      'components/hive/shared/VitalsStrip.jsx',
    ]) {
      const src = readFileSync(f, 'utf8')
      const importLines = src.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n')
      expect(importLines, f).not.toContain('PartnersContext')
      expect(importLines, f).not.toContain('BeeHub')
      expect(src, f).not.toContain('useContext')
    }
  })
})

// ═══ pinned buzz ═══════════════════════════════════════════
describe('pinned buzz', () => {
  it('shows on every Overview, latest note first', async () => {
    for (const m of [mountPerson, mountProfile, mountPanel]) {
      const { host, unmount } = await m()
      expect(host.textContent).toContain('Gate code 4321')
      await unmount()
    }
  })

  it('is the SAME client-level note on ClientProfile and the EngagementPanel — one standing note, one write path', async () => {
    // Same underlying lead_notes rows arrive via both endpoints.
    const cp = await mountProfile()
    expect(cp.host.textContent).toContain('Gate code 4321')
    await cp.unmount()

    const ep = await mountPanel()
    expect(ep.host.textContent).toContain('Gate code 4321')
    // Appending from the panel writes the CLIENT's buzz (lead_id, no
    // engagement scoping) — the same path the profile's band uses.
    await click(ep.host.querySelector('[aria-label="Expand buzz"]')!)
    const input = ep.host.querySelector('input[aria-label="Add buzz note"]')!
    await type(input, 'Prefers afternoon calls')
    await keydown(input, 'Enter')
    await ep.unmount()

    const cp2 = await mountProfile()
    await click(cp2.host.querySelector('[aria-label="Expand buzz"]')!)
    const input2 = cp2.host.querySelector('input[aria-label="Add buzz note"]')!
    await type(input2, 'Second note')
    await keydown(input2, 'Enter')
    await cp2.unmount()

    expect(notePosts).toHaveLength(2)
    for (const p of notePosts) {
      expect(p.lead_id).toBe('lead-9')
      expect(p.kind).toBe('buzz')
      expect(p.engagement_id ?? null).toBeNull()
    }
  })

  it('no buzz yet → quiet add affordance, not an empty band', async () => {
    profileOver = { buzz_notes: [] }
    const { host, unmount } = await mountProfile()
    expect(host.querySelector('[aria-label="Add buzz"]')).toBeTruthy()
    expect(host.textContent).toContain('Add a note about this client')
    await unmount()
  })
})

// ═══ per-surface content ═══════════════════════════════════
describe('per-surface Overview content', () => {
  it('PersonCard is lean: no money tiles, no engagements list, no stage bar', async () => {
    const { host, unmount } = await mountPerson()
    expect(host.textContent).not.toContain('Lifetime paid')
    expect(host.textContent).not.toContain('Engagements ·')
    expect(host.textContent).not.toContain('Estimate') // no stage bar segments
    expect(host.textContent).toContain('What they want')
    expect(host.textContent).toContain('Garage overhaul') // request_details
    await unmount()
  })

  it('ClientProfile: engagements list + client-WIDE activity with re: tags AND client-level job notes (the gap fix); money tiles GONE', async () => {
    const { host, unmount } = await mountProfile()
    expect(host.textContent).not.toContain('Lifetime paid') // tiles removed — the strip's Lifetime cell carries it
    expect(host.textContent).not.toContain('Open pipeline')
    expect(host.textContent).toContain('Engagements · 2 · 1 open')
    expect(host.textContent).toContain('Pantry refresh')
    // THE GAP FIX: the client-level note posted on PersonCard is visible
    expect(host.textContent).toContain('Measured the garage')
    // engagement-scoped items carry the '· re:' tag
    expect(host.textContent).toContain('re: Pantry refresh')
    await unmount()
  })

  it('PersonCard recent activity shows ONLY client-level notes (engagement-scoped stay with their engagement)', async () => {
    const { host, unmount } = await mountPerson()
    expect(host.textContent).toContain('Measured the garage')
    expect(host.textContent).not.toContain('Confirmed pantry scope')
    await unmount()
  })

  it('EngagementPanel: description + records; stage bar AND money tiles GONE (the strip carries Stage/Value)', async () => {
    const { host, unmount } = await mountPanel()
    expect(host.textContent).toContain('Full kitchen reorganization') // description
    expect(host.textContent).toContain('Records')
    // The 5-segment stage bar rendered ALL its labels ('Final', 'Won')
    // regardless of stage — neither appears on a Request-stage overview
    // now (no records, close confirm shut).
    expect(host.textContent).not.toContain('Final')
    expect(host.textContent).not.toContain('Won')
    // Money tiles removed with it.
    expect(host.textContent).not.toContain('Engagement value')
    expect(host.textContent).not.toContain('Invoiced')
    await unmount()
  })

  it("EngagementPanel: invoiced/paid detail moved onto the invoice record row — '$X of $Y paid', owing red state kept", async () => {
    engOver = {
      engagement: { stage: 'Final Processing', total_invoiced: 4400, balance_owing: 4400 },
      children: { invoices: [{ id: 'i1', total: 4400, status: 'sent', balance_owing: 4400, paid_amount: 0, issued_at: daysAgo(2) }] },
    }
    const { host, unmount } = await mountPanel()
    expect(host.textContent).toContain('$0 of $4,400 paid') // the detail the tiles used to carry
    expect(host.textContent).toContain('owing $4,400')      // red trailing state, unchanged
    await unmount()
  })

  it('ClientProfile: nonzero owing keeps a red Key-facts line (not silently dropped with the tiles)', async () => {
    profileOver = { aggregates: { lifetime_paid: 4200, open_pipeline: 900, owing: 350, open_count: 1, total_count: 2 } }
    const { host, unmount } = await mountProfile()
    expect(host.textContent).toContain('Owing $350')
    await unmount()
  })
})

// ═══ vitals strip ══════════════════════════════════════════
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (t: number) => { const d = new Date(t); return `${MON[d.getMonth()]} ${d.getDate()}` }
const inDays = (n: number) => new Date(now + n * 86400000).toISOString()
const stripOf = (host: Element) => host.querySelector('[aria-label="Vitals"]')!
const stripLabels = (host: Element) =>
  [...stripOf(host).children].map(cell => cell.querySelectorAll('p')[0].textContent)
const stripValues = (host: Element) =>
  [...stripOf(host).children].map(cell => cell.querySelectorAll('p')[1])

describe('vitals strip', () => {
  it('every card renders the 4-cell strip between the header identity row and the tab bar', async () => {
    for (const m of [mountPerson, mountProfile, mountPanel]) {
      const { host, unmount } = await m()
      const strip = stripOf(host)
      expect(strip).toBeTruthy()
      expect(stripLabels(host)).toHaveLength(4)
      // DOM order: name (header) → strip → tab bar
      const name = [...host.querySelectorAll('h2, p')].find(el => (el.textContent || '').includes('Dana Client') || (el.textContent || '').includes('Kitchen + Pantry'))!
      const tabBar = tabButton(host, 'Overview')!
      expect(name.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(strip.compareDocumentPosition(tabBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      await unmount()
    }
  })

  it("EngagementPanel: Stage/Value/Last touch/Next — missing values render '—', never zero", async () => {
    // Default payload: no quotes/invoicing, no touchpoints, nothing scheduled.
    const { host, unmount } = await mountPanel()
    expect(stripLabels(host)).toEqual(['Stage', 'Value', 'Last touch', 'Next'])
    expect(stripValues(host).map(p => p.textContent)).toEqual(['Request', '—', '—', '—'])
    await unmount()
  })

  it('EngagementPanel: Value = best quote pre-invoicing; Last touch abbreviated; Next = soonest future child, accent-colored', async () => {
    engOver = {
      children: {
        quotes: [{ id: 'q1', status: 'sent', total: 900, sent_at: daysAgo(3) }],
        touchpoints: [{ id: 'tp1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(2), user_label: 'Kevin' }],
        assessments: [{ id: 'a1', scheduled_at: inDays(5), completed_at: null, status: 'scheduled' }],
      },
    }
    const { host, unmount } = await mountPanel()
    const values = stripValues(host)
    expect(values.map(p => p.textContent)).toEqual(['Request', '$900', '2d', shortDate(now + 5 * 86400000)])
    // Next in the accent — happy-dom may serialize hex as rgb()
    expect(['#378ADD', 'rgb(55, 138, 221)']).toContain((values[3] as HTMLElement).style.color)
    await unmount()
  })

  it('EngagementPanel: Value flips to total_invoiced once real money exists', async () => {
    engOver = {
      engagement: { total_invoiced: 1200 },
      children: { quotes: [{ id: 'q1', status: 'approved', total: 900 }] },
    }
    const { host, unmount } = await mountPanel()
    expect(stripValues(host)[1].textContent).toBe('$1,200')
    await unmount()
  })

  it('ClientProfile: Status/Lifetime/Last touch/Open from the already-fetched profile aggregates', async () => {
    const { host, unmount } = await mountProfile()
    expect(stripLabels(host)).toEqual(['Status', 'Lifetime', 'Last touch', 'Open'])
    // open engagement → Active; lifetime 4200; touchpoint 1d ago; open pipeline 900
    expect(stripValues(host).map(p => p.textContent)).toEqual(['Active', '$4,200', '1d', '$900'])
    await unmount()
  })

  it("PersonCard: Status/Inquired/Last touch/Next — Next is '—' pre-engagement, snooze fills it", async () => {
    const pc = await mountPerson()
    expect(stripLabels(pc.host)).toEqual(['Status', 'Inquired', 'Last touch', 'Next'])
    // 40d-old lead, no reach-outs on the prop timeline → Nurturing;
    // Inquired past the 30d tier → bare date; profile touchpoint 1d ago.
    expect(stripValues(pc.host).map(p => p.textContent)).toEqual(['Nurturing', shortDate(now - 40 * 86400000), '1d', '—'])
    await pc.unmount()

    const snoozed = await mount(<PersonCard person={person({ snoozeUntil: inDays(3) })} onClose={() => {}} lookupOptions={LOOKUPS} onSendToJobber={() => {}} />)
    expect(stripValues(snoozed.host).map(p => p.textContent)[3]).toBe(shortDate(now + 3 * 86400000))
    await snoozed.unmount()
  })
})

// ═══ header client line (EngagementPanel) ══════════════════
describe('header client identity', () => {
  it('client name + View client → render up top (before the tabs), exactly ONCE, same swap behavior', async () => {
    const opened: string[] = []
    const { host, unmount } = await mountPanel({ onOpenClient: (id: string) => opened.push(id) })
    const view = buttonContaining(host, 'View client')!
    expect(view).toBeTruthy()
    // header region: above the tab bar in DOM order
    expect(view.compareDocumentPosition(tabButton(host, 'Overview')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // moved, not duplicated — Key facts lost its copy
    expect(host.textContent!.split('Dana Client').length - 1).toBe(1)
    await click(view)
    expect(opened).toEqual(['lead-9']) // identical swap-to-profile behavior
    await unmount()
  })
})

// ═══ action row — equal-width soft-tinted grid ═════════════
describe('action row', () => {
  const rowOf = (host: Element) => buttonContaining(host, 'Log touchpoint')!.parentElement as HTMLElement

  it('every card: repeat(N,1fr) grid sized to the rendered button count — not a flex row', async () => {
    for (const m of [mountPerson, mountProfile, mountPanel]) {
      const { host, unmount } = await m()
      const row = rowOf(host)
      const n = row.children.length
      expect(n).toBeGreaterThanOrEqual(3)
      expect(row.style.display).toBe('grid')
      expect(row.getAttribute('style')).toMatch(new RegExp(`repeat\\(${n},\\s*1fr\\)`))
      await unmount()
    }
  })

  it('soft tints, matching text color, no hairline: Call blue, Advance/Send green, neutrals gray, 38px', async () => {
    const ep = await mountPanel()
    const call = [...ep.host.querySelectorAll('a')].find(a => (a.textContent || '').includes('Call'))!
    expect(call.getAttribute('style')).toMatch(/rgba\(55,\s*138,\s*221/) // ~10% accent tint
    expect(call.getAttribute('style')).not.toContain('solid')           // no hairline border
    expect(['#2b6aad', 'rgb(43, 106, 173)']).toContain((call as HTMLElement).style.color)
    const advance = buttonContaining(ep.host, 'Advance to Estimate')!
    expect(advance.getAttribute('style')).toMatch(/rgba\(29,\s*158,\s*117/) // ~12% success tint
    const log = buttonContaining(ep.host, 'Log touchpoint')!
    expect(log.getAttribute('style')).toMatch(/rgba\(0,\s*0,\s*0/) // neutral gray tint
    expect((log as HTMLElement).style.height).toBe('38px')
    await ep.unmount()

    const pc = await mountPerson()
    const send = buttonContaining(pc.host, 'Send to Jobber')!
    expect(send.getAttribute('style')).toMatch(/rgba\(29,\s*158,\s*117/) // founding door rides green
    await pc.unmount()
  })
})

// ═══ two activity surfaces ═════════════════════════════════
describe('two activity surfaces', () => {
  it('Overview keeps the quick slice + composer; the Timeline tab holds the full stream', async () => {
    const { host, unmount } = await mountPerson()
    // Overview: recent slice + composer input
    expect(host.textContent).toContain('Recent activity')
    const composer = [...host.querySelectorAll('input')].find(i => i.getAttribute('placeholder') === 'Add a note…')
    expect(composer).toBeTruthy()
    // Timeline tab: the full merged stream (composer-less, exhaustive)
    await click(tabButton(host, 'Timeline')!)
    expect(host.textContent).toContain('Client created')
    await unmount()
  })
})

// ═══ write paths preserved ═════════════════════════════════
describe('write paths', () => {
  it('Source None-clear still PATCHes null from the new key-facts block', async () => {
    const { host, unmount } = await mountPerson()
    await click(buttonContaining(host, 'Source: Webform')!)
    await click([...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'None')!)
    expect(leadPatches).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), body: { source: null } }])
    await unmount()
  })

  it('stage Advance is a quiet action and PATCHes forward-only; the route writes the stage_change touchpoint (source guard)', async () => {
    const { host, unmount } = await mountPanel()
    const advance = buttonContaining(host, 'Advance to Estimate')!
    expect(advance).toBeTruthy()
    await click(advance)
    expect(engPatches).toEqual([{ stage: 'Estimate' }])
    await unmount()
    const src = readFileSync('app/api/engagements/[id]/route.ts', 'utf8')
    expect(src).toContain("kind: 'stage_change'")
  })

  it('Close moved to the ··· menu, same inline Won/Lost confirm + write', async () => {
    const { host, unmount } = await mountPanel()
    await click(host.querySelector('button[aria-label="More"]')!)
    await click(buttonContaining(host, 'Close engagement…')!)
    expect(host.textContent).toContain('Close as')
    await click(buttonContaining(host, 'Close as lost')!)
    expect(engPatches).toEqual([{ stage: 'Closed Lost', closed_reason: 'lost_no_response' }])
    await unmount()
  })

  it("EngagementPanel still offers 'Send to Jobber' (quiet, restrained) when zero work records", async () => {
    const sends: any[] = []
    engOver = { children: { notes: [], touchpoints: [] } }
    const { host, unmount } = await mountPanel({ onSendToJobber: (id: string, opts: any) => sends.push([id, opts]) })
    await click(buttonContaining(host, 'Send to Jobber')!)
    expect(sends).toEqual([['lead-9', { engagementId: 'eng-1' }]])
    await unmount()
  })
})
