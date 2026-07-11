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
//   — write paths preserved: Source None-clear, EditableDesc, the ···
//     menu Close (stage Advance was REMOVED 2026-07-10 per Kevin —
//     stages move only via Jobber derivation; the route still writes
//     the stage_change touchpoint on closes — source guard)
//   — EngagementPanel header (Option B): the CLIENT NAME is the 19px/600
//     headline (renders exactly ONCE; the auto-generated engagement
//     title is NOT rendered); quiet subtitle = 'View profile' accent
//     link (fires onOpenClient — the old View client → button is gone)
//     + full-format opened date + founded-by. Full prose dates ride the
//     roomy header/subtitle spots ONLY — the vitals strip and Timeline
//     rows keep their compact formats (deliberate, not drift)
//   — action rows are cardKit ActionRow: equal-width repeat(N,1fr)
//     grid, soft-tinted no-border buttons (Call blue / neutral gray /
//     Send-to-Jobber green), behaviors unchanged
//   — §8.5: no BeeHub/PartnersContext/useContext in the card pieces
//   — tab switching works post-streaming without content vanishing
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import PersonCard from '@/components/hive/PersonCard'
import { formatFullDate } from '@/components/hive/shared/engagementStatus'
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
    expect(host.querySelector('[aria-label="Metrics"]')).toBeTruthy() // header metric band persists across tabs
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
  it('shows on the PERSON-scoped Overviews (PersonCard + ClientProfile) — the panel dropped it in build 2 (person-vs-deal)', async () => {
    for (const m of [mountPerson, mountProfile]) {
      const { host, unmount } = await m()
      expect(host.textContent).toContain('Gate code 4321')
      await unmount()
    }
  })

  it('the note is CLIENT-level (lead_id, no engagement scoping) from the profile band; the panel shows NO buzz since build 2', async () => {
    const ep = await mountPanel()
    expect(ep.host.textContent).not.toContain('Gate code 4321') // person-scoped — lives on the profile now
    expect(ep.host.querySelector('[aria-label="Expand buzz"]')).toBeNull()
    await ep.unmount()

    const cp = await mountProfile()
    expect(cp.host.textContent).toContain('Gate code 4321')
    await click(cp.host.querySelector('[aria-label="Expand buzz"]')!)
    const input2 = cp.host.querySelector('input[aria-label="Add buzz note"]')!
    await type(input2, 'Second note')
    await keydown(input2, 'Enter')
    await cp.unmount()

    expect(notePosts).toHaveLength(1)
    expect(notePosts[0].lead_id).toBe('lead-9')
    expect(notePosts[0].kind).toBe('buzz')
    expect(notePosts[0].engagement_id ?? null).toBeNull()
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

  it("ClientProfile: nonzero owing rides the metric band's Owing cell in THE accent (design-system pass — Owing is money to collect, an action cue; route aggregate spans ALL engagements incl. closed)", async () => {
    profileOver = { aggregates: { lifetime_paid: 4200, invoiced: 5000, open_pipeline: 900, owing: 350, open_count: 1, total_count: 2 } }
    const { host, unmount } = await mountProfile()
    const band = host.querySelector('[aria-label="Metrics"]')!
    const owingCell = [...band.children].find(c => (c.textContent || '').includes('Owing'))! as HTMLElement
    expect(owingCell.textContent).toContain('$350')
    const value = owingCell.querySelectorAll('p')[1] as HTMLElement
    expect(['#0F6E56', 'rgb(15, 110, 86)']).toContain(value.style.color)
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

// Build 2 split: PersonCard keeps the tinted VitalsStrip; ClientProfile
// runs the full-bleed METRIC BAND; the panel's masthead carries
// stage/value itself (no strip at all).
const bandOf = (host: Element) => host.querySelector('[aria-label="Metrics"]')!
const bandLabels = (host: Element) =>
  [...bandOf(host).children].map(cell => cell.querySelectorAll('p')[0].textContent)
const bandValues = (host: Element) =>
  [...bandOf(host).children].map(cell => cell.querySelectorAll('p')[1])
const chipSpan = (host: Element, label: string) =>
  [...host.querySelectorAll('span')].find(sp => (sp as HTMLElement).style.borderRadius === '8px' && sp.textContent === label)

describe('vitals strip / metric band', () => {
  it('PersonCard renders the 4-cell strip between the header identity row and the tab bar', async () => {
    const { host, unmount } = await mountPerson()
    const strip = stripOf(host)
    expect(strip).toBeTruthy()
    expect(stripLabels(host)).toHaveLength(4)
    const name = [...host.querySelectorAll('h2, p')].find(el => (el.textContent || '').includes('Dana Client'))!
    const tabBar = tabButton(host, 'Overview')!
    expect(name.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(strip.compareDocumentPosition(tabBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await unmount()
  })

  it('ClientProfile renders the METRIC BAND (Collected/Invoiced/Owing/Last touch) between header and tabs — full-bleed hairline, tabular numerals', async () => {
    const { host, unmount } = await mountProfile()
    const band = bandOf(host)
    expect(band).toBeTruthy()
    expect(bandLabels(host)).toEqual(['Collected', 'Invoiced', 'Owing', 'Last touch'])
    // default payload: lifetime 4200 collected; nothing invoiced/owing → '—'; touchpoint 1d ago
    expect(bandValues(host).map(pEl => pEl.textContent)).toEqual(['$4,200', '—', '—', '1d'])
    expect((bandValues(host)[0] as HTMLElement).style.fontVariantNumeric).toBe('tabular-nums')
    // full-bleed: negative margins cancel the body padding; hairline rules
    expect((band as HTMLElement).style.margin).toContain('-')
    expect((band as HTMLElement).style.borderTop).toContain('0.5px')
    // DOM order: header → band → tab bar
    const tabBar = tabButton(host, 'Overview')!
    expect(band.compareDocumentPosition(tabBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the strip idiom is GONE from this card
    expect(host.querySelector('[aria-label="Vitals"]')).toBeNull()
    await unmount()
  })

  it('EngagementPanel: NO strip — the masthead itself carries stage chip + right-aligned value', async () => {
    engOver = { engagement: { total_invoiced: 1200 }, children: { quotes: [{ id: 'q1', status: 'approved', total: 900 }] } }
    const { host, unmount } = await mountPanel()
    expect(host.querySelector('[aria-label="Vitals"]')).toBeNull()
    expect(host.querySelector('[aria-label="Metrics"]')).toBeNull()
    expect(host.textContent).toContain('$1,200') // total_invoiced wins over the quote
    await unmount()
  })

  it('EngagementPanel masthead value: best quote pre-invoicing; HIDDEN (not $0) when neither exists', async () => {
    engOver = { children: { quotes: [{ id: 'q1', status: 'sent', total: 900, sent_at: daysAgo(3) }] } }
    const quoted = await mountPanel()
    expect(quoted.host.textContent).toContain('$900')
    await quoted.unmount()

    engOver = {}
    const bare = await mountPanel()
    expect(bare.host.textContent).not.toContain('$0')
    await bare.unmount()
  })

  it('ClientProfile: $0 engagement sum does not mask the leads.paid_amount denorm — chips Past client', async () => {
    // Aggregate is always numeric once loaded, so a ?? fallback never fires;
    // paid history on the lead row must still win the Past existence test.
    const base = profilePayload()
    profileOver = {
      client: { ...base.client, paid_amount: 500 },
      engagements: [], touchpoints: [],
      aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
    }
    const { host, unmount } = await mountProfile()
    expect(chipSpan(host, 'Past client')).toBeTruthy() // header status chip — the strip's Status cell retired with it
    await unmount()
  })

  it('ClientProfile: a $0 Closed Won engagement still chips Client — won rank ignores dollars', async () => {
    profileOver = {
      engagements: [
        { id: 'eng-z', title: 'Comped job', stage: 'Closed Won', founded_by: 'request', created_at: daysAgo(60), closed_at: daysAgo(30), total_invoiced: 0, total_paid: 0, balance_owing: 0, quotes: [], jobs: [], invoices: [], assessments: [] },
      ],
      touchpoints: [],
      aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 1 },
    }
    const { host, unmount } = await mountProfile()
    expect(chipSpan(host, 'Client')).toBeTruthy() // header status chip (exact-label span — 'Dana Client' prose can't match)
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

// ═══ header — Option B: the client name IS the headline ════
const FULL_MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const fullDate = (t: number) => { const d = new Date(t); return `${FULL_MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` }

describe('header client identity (Option B)', () => {
  it('client name is the primary headline — 19px/600 h2, larger than the subtitle; renders exactly ONCE', async () => {
    const { host, unmount } = await mountPanel()
    const h2 = host.querySelector('h2')! as HTMLElement
    expect(h2.textContent).toBe('Dana Client')
    expect(h2.style.fontSize).toBe('19px')
    expect(String(h2.style.fontWeight)).toBe('600')
    // headline outranks the 12px subtitle
    const sub = buttonContaining(host, 'View profile')!.parentElement as HTMLElement
    expect(sub.style.fontSize).toBe('12px')
    // once across the whole card — the header IS the name's one home
    expect(host.textContent!.split('Dana Client').length - 1).toBe(1)
    await unmount()
  })

  it('the engagement title RENDERS in the masthead deal line (v2 restored it — displayTitle, once, below the client name)', async () => {
    const { host, unmount } = await mountPanel() // default payload title 'Kitchen + Pantry'
    expect(host.textContent!.split('Kitchen + Pantry').length - 1).toBe(1)
    // deal line sits between the name headline and the tab bar
    const title = [...host.querySelectorAll('span')].find(sp => sp.textContent === 'Kitchen + Pantry')!
    const h2 = host.querySelector('h2')!
    expect(h2.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(title.compareDocumentPosition(tabButton(host, 'Overview')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await unmount()
  })

  it("subtitle: 'View profile' accent link + full opened date + founded-by; click fires onOpenClient; old View client → gone", async () => {
    const opened: string[] = []
    const { host, unmount } = await mountPanel({ onOpenClient: (id: string) => opened.push(id) })
    const view = buttonContaining(host, 'View profile')! as HTMLElement
    expect(view).toBeTruthy()
    expect(['#0F6E56', 'rgb(15, 110, 86)']).toContain(view.style.color) // THE accent (one-accent rule)
    // header region: above the tab bar in DOM order
    expect(view.compareDocumentPosition(tabButton(host, 'Overview')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // founding facts ride the same line, FULL-format date (created_at = 5d ago)
    const sub = view.parentElement as HTMLElement
    expect(sub.textContent).toContain(`opened ${fullDate(now - 5 * 86400000)}`)
    expect(sub.textContent).toContain('founded by manual')
    // the old separate blue button is gone
    expect(buttonContaining(host, 'View client')).toBeUndefined()
    await click(view)
    expect(opened).toEqual(['lead-9']) // identical swap-to-profile behavior
    await unmount()
  })

  it('bottom action bar: Call / Log touchpoint / Send to Jobber, equal-width grid — NO Advance (7/10), NO Close… (moved to ···, Part 1)', async () => {
    const { host, unmount } = await mountPanel({ onSendToJobber: () => {} })
    const row = buttonContaining(host, 'Log touchpoint')!.parentElement as HTMLElement
    expect([...row.children].map(el => (el.textContent || '').trim())).toEqual(['Call', 'Log touchpoint', 'Send to Jobber'])
    expect(row.style.display).toBe('grid')
    expect(row.getAttribute('style')).toMatch(/repeat\(3,\s*1fr\)/)
    // The close-out actions live in the masthead ··· menu now.
    expect(buttonContaining(host, 'Close…')).toBeUndefined()
    expect(host.querySelector('[data-bee-record-menu-trigger]')).toBeTruthy()
    await unmount()
  })
})

// ═══ full prose dates — headers full, strip/timeline compact ═
describe('full-date treatment (formatFullDate)', () => {
  it("produces 'July 7, 2026' — full month name, day, year; null/garbage → null", () => {
    expect(formatFullDate('2026-07-07T12:00:00')).toBe('July 7, 2026')
    expect(formatFullDate('2025-01-02T12:00:00')).toBe('January 2, 2025')
    expect(formatFullDate(null)).toBeNull()
    expect(formatFullDate('not-a-date')).toBeNull()
  })

  it("ClientProfile subtitle (v4): '{location} · client since Mon YYYY' — compact month-year, location leads", async () => {
    const { host, unmount } = await mountProfile()
    const d = new Date(now - 40 * 86400000)
    const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    expect(host.textContent).toContain(`Denver · client since ${MON3[d.getUTCMonth()]} ${d.getUTCFullYear()}`)
    expect(host.textContent).not.toContain(`client since ${fullDate(now - 40 * 86400000)}`)
    await unmount()
  })

  it("PersonCard subtitle: 'inquired' rides the full date (name was already the headline)", async () => {
    const { host, unmount } = await mountPerson()
    expect(host.textContent).toContain(`inquired ${fullDate(now - 40 * 86400000)}`)
    await unmount()
  })

  it('the metric band stays COMPACT — full dates never leak into the tight cells', async () => {
    const { host, unmount } = await mountProfile()
    const last = bandValues(host)[3].textContent!
    expect(last).toBe('1d') // relative, not 'July …, 2026'
    expect(last).not.toContain(String(new Date(now).getFullYear()))
    await unmount()
  })
})

// ═══ action row — equal-width soft-tinted grid ═════════════
describe('action row', () => {
  const rowOf = (host: Element) => buttonContaining(host, 'Log touchpoint')!.parentElement as HTMLElement

  it('every card: repeat(N,1fr) grid sized to the rendered button count — not a flex row', async () => {
    for (const m of [mountPerson, mountProfile, () => mountPanel({ onSendToJobber: () => {} })]) {
      const { host, unmount } = await m()
      const row = rowOf(host)
      const n = row.children.length
      expect(n).toBeGreaterThanOrEqual(3)
      expect(row.style.display).toBe('grid')
      expect(row.getAttribute('style')).toMatch(new RegExp(`repeat\\(${n},\\s*1fr\\)`))
      await unmount()
    }
  })

  it('soft tints, matching text color, no hairline: Call + Send ride THE accent (one-accent rule), neutrals gray, 38px', async () => {
    const ep = await mountPanel({ onSendToJobber: () => {} })
    const call = [...ep.host.querySelectorAll('a')].find(a => (a.textContent || '').includes('Call'))!
    expect(call.getAttribute('style')).toMatch(/rgba\(15,\s*110,\s*86/) // ~10% accent tint
    expect(call.getAttribute('style')).not.toContain('solid')           // no hairline border
    expect(['#085041', 'rgb(8, 80, 65)']).toContain((call as HTMLElement).style.color)
    const panelSend = buttonContaining(ep.host, 'Send to Jobber')!
    expect(panelSend.getAttribute('style')).toMatch(/rgba\(15,\s*110,\s*86/) // same accent tint — the forest/blue split is dead
    const log = buttonContaining(ep.host, 'Log touchpoint')!
    expect(log.getAttribute('style')).toMatch(/rgba\(0,\s*0,\s*0/) // neutral gray tint
    expect((log as HTMLElement).style.height).toBe('38px')
    await ep.unmount()

    const pc = await mountPerson()
    const send = buttonContaining(pc.host, 'Send to Jobber')!
    expect(send.getAttribute('style')).toMatch(/rgba\(15,\s*110,\s*86/) // founding door rides the accent
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

  it('stage Advance is GONE (7/10 — stages move via Jobber); the route still writes the stage_change touchpoint on closes (source guard)', async () => {
    // Default payload = LOCAL engagement (zero work records) — the old
    // button rendered exactly here; now no surface offers a manual move.
    const { host, unmount } = await mountPanel()
    expect(buttonContaining(host, 'Advance')).toBeUndefined()
    expect(engPatches).toEqual([])
    await unmount()
    const src = readFileSync('app/api/engagements/[id]/route.ts', 'utf8')
    expect(src).toContain("kind: 'stage_change'")
    expect(src).toContain('manual_stage_move_rejected') // terminal-only stage writes
  })

  it('Close-out lives in the masthead ··· menu (Part 1) → the Lost wizard commits through the one write path', async () => {
    const { host, unmount } = await mountPanel()
    // Open the ··· menu (trigger in the card; items portal to <body>).
    await click(host.querySelector('[data-bee-record-menu-trigger]')!)
    const lostItem = [...document.querySelectorAll('[data-bee-record-menu] button')]
      .find(b => (b.textContent || '').includes('Mark as Closed Lost'))!
    await click(lostItem)
    // Wizard: reason step → follow-up step → commit (default reason, skip follow-up).
    await click(buttonContaining(host, 'Next')!)
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
