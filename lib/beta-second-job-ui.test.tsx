// @vitest-environment happy-dom
//
// A client's second job (Kevin, 2026-09-26): "Kitchen this month. Client
// calls and wants the bedroom next month." The screens that make it real work:
//
//   · ClientProfile — "Start a new job" on the Engagements header, for a
//     Jobber-linked client (2026-09-28; it replaced 2026-09-26's "New job in
//     Jobber"). It opens NewJobWizard, whose Send-now ending opens Send to
//     Jobber for the EXISTING Jobber client — see beta-new-job-wizard.test.tsx.
//     It is NOT in the action bar where the removed "+ New engagement" sat.
//   · Send to Jobber — tells the owner the truth for a linked client:
//     existing client reused, no new client.
//   · The after-send poll — surfaces the NEW engagement even though the
//     client already has an open one (the kitchen), and never mistakes the
//     kitchen for the bedroom.
//   · "Keep local for now" is gone from every screen; the phone New sheet can
//     send.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import SendToJobberModal from '@/components/hive/SendToJobberModal'
import HiveShell from '@/components/hive/HiveShell'
import { reconcileSentPolls } from '@/components/hive/shared/jobberSendPoll'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

const kitchen = {
  id: 'eng-kitchen', client_id: 'lead-9', client_name: 'Martha Wassel', location_uuid: 'loc-uuid-1',
  title: 'Kitchen', stage: 'Job in Progress', founded_by: 'request',
  created_at: daysAgo(20), stage_entered_at: daysAgo(10),
  quotes: [], jobs: [], invoices: [], assessments: [],
}
const bedroom = {
  ...kitchen, id: 'eng-bedroom', title: 'Bedroom', stage: 'Request',
  created_at: new Date(now).toISOString(), stage_entered_at: new Date(now).toISOString(),
}

const profilePayload = (client: any = {}, engagements: any[] = []) => ({
  client: {
    id: 'lead-9', name: 'Martha Wassel', first_name: 'Martha', last_name: 'Wassel',
    email: '', phone: '(423) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(400), source: 'Webform', paused: false, marketing_opt_out: false,
    snoozed_until: null, snoozed_note: null, assigned_to: null, assigned_to_name: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Chattanooga',
    ...client,
  },
  referred_us: [], contacts: [], engagements, touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: engagements.length, total_count: engagements.length },
})

let profileBody: any
let openRows: any[] = []
let openCalls = 0
let postedEngagements = 0
const installFetch = () => {
  openCalls = 0
  postedEngagements = 0
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/engagements') && opts.method === 'POST') { postedEngagements++; return jsonRes({}, 201) }
    if (u.includes('/api/engagements') && u.includes('open=1')) { openCalls++; return jsonRes({ rows: openRows, total: openRows.length }) }
    if (u.includes('/api/lookups')) return jsonRes({ lookups: [] })
    if (u.includes('/profile')) return jsonRes(profileBody)
    return jsonRes({})
  })
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return { host, root, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const newJobBtn = (host: Element) => host.querySelector('button[aria-label="Start a new job"]')

beforeEach(() => {
  document.body.innerHTML = ''
  openRows = []
  installFetch()
})

// ═══ the client-card action ════════════════════════════════════
describe('ClientProfile — "Start a new job"', () => {
  const mountProfile = (props: any = {}) => mount(
    <ClientProfile clientId="lead-9" people={[]} onClose={() => {}} setToast={() => {}}
      lookupOptions={{ sources: [], projectTypes: [], clientTags: [] } as any}
      locationUsers={[] as any} {...props} />
  )

  it('a Jobber-linked client with open work gets it; pressing it opens the wizard, not a card', async () => {
    profileBody = profilePayload({ jobber_client_id: '136289662' }, [kitchen])
    const onSend = vi.fn()
    const { host, unmount } = await mountProfile({ onSendToJobber: onSend })
    const b = newJobBtn(host)
    expect(b, 'the linked client gets the new-job action').toBeTruthy()
    expect(b!.textContent).toContain('Start a new job')
    await click(b!)
    expect(document.querySelector('[role="dialog"][aria-label="Start a new job"]')).toBeTruthy()
    // Opening the wizard writes nothing and sends nothing — the old button
    // founded on the click; this founds only after the work is described.
    expect(onSend).not.toHaveBeenCalled()
    expect(postedEngagements).toBe(0)
    await unmount()
  })

  it('sits on the Engagements header, NOT in the action bar where "+ New engagement" was', async () => {
    profileBody = profilePayload({ jobber_client_id: '136289662' }, [kitchen])
    const { host, unmount } = await mountProfile({ onSendToJobber: () => {} })
    const bar = host.querySelector('[aria-label="Card actions"]')!
    expect(bar.contains(newJobBtn(host)!)).toBe(false)
    expect(bar.textContent).not.toContain('New engagement')
    expect(bar.textContent).not.toContain('New job')
    // Its header row is the Engagements label.
    expect(newJobBtn(host)!.parentElement!.textContent).toContain('Engagements')
    await unmount()
  })

  it('an UNLINKED client does not get it — the action bar\'s Send to Jobber is their first job', async () => {
    profileBody = profilePayload({ jobber_client_id: null })
    const { host, unmount } = await mountProfile({ onSendToJobber: () => {} })
    expect(newJobBtn(host)).toBeNull()
    expect(host.querySelector('[aria-label="Card actions"]')!.textContent).toContain('Send to Jobber')
    await unmount()
  })

  it('hidden when read-only, and when no send is wired', async () => {
    profileBody = profilePayload({ jobber_client_id: '136289662' })
    const ro = await mountProfile({ onSendToJobber: () => {}, readOnly: true })
    expect(newJobBtn(ro.host)).toBeNull()
    await ro.unmount()
    const noWire = await mountProfile({})
    expect(newJobBtn(noWire.host)).toBeNull()
    await noWire.unmount()
  })
})

// ═══ the send window tells the truth for a linked client ═══════
describe('Send to Jobber — a linked client is reused, and the window says so', () => {
  const person = (over: any = {}) => ({
    id: 'lead-9', name: 'Martha Wassel', locationName: 'Chattanooga', outreachTimeline: [],
    jobberClient: null, jobberRef: null, ...over,
  })

  it('linked (jobberRef = the Jobber client id) → "existing Jobber client", never "A new client will be created"', async () => {
    const { host, unmount } = await mount(
      <SendToJobberModal person={person({ jobberRef: '136289662' })} onDone={() => {}} onClose={() => {}} />
    )
    expect(host.textContent).toContain('existing Jobber client · JC-136289662')
    expect(host.textContent).not.toContain('A new client will be created')
    await unmount()
  })

  it('unlinked → still says a new client will be created (unchanged)', async () => {
    const { host, unmount } = await mount(
      <SendToJobberModal person={person()} onDone={() => {}} onClose={() => {}} />
    )
    expect(host.textContent).toContain('A new client will be created in Jobber.')
    await unmount()
  })
})

// ═══ the new card shows up — and it is the bedroom, not the kitchen ═══
describe('after-send poll — a second job surfaces its OWN engagement', () => {
  it('reconcileSentPolls skips the engagements the client already had (knownIds)', () => {
    const pending = [{ clientId: 'lead-9', startedAt: now, knownIds: ['eng-kitchen'] }]
    // Tick 1: only the kitchen exists → keep waiting (it is NOT the answer).
    const t1 = reconcileSentPolls(pending, [kitchen], now + 3000)
    expect(t1.injects).toHaveLength(0)
    expect(t1.stillPending).toHaveLength(1)
    // Tick 2: the bedroom lands → it, and only it, is injected.
    const t2 = reconcileSentPolls(pending, [kitchen, bedroom], now + 6000)
    expect(t2.injects.map((r: any) => r.id)).toEqual(['eng-bedroom'])
    expect(t2.stillPending).toHaveLength(0)
  })

  it('without knownIds the old behavior holds (first open row for the client)', () => {
    const t = reconcileSentPolls([{ clientId: 'lead-9', startedAt: now }], [kitchen], now + 3000)
    expect(t.injects.map((r: any) => r.id)).toEqual(['eng-kitchen'])
  })

  describe('HiveShell', () => {
    let container: HTMLDivElement
    let root: Root
    const render = async (props: any) => {
      await act(async () => { root.render(React.createElement(HiveShell, props)) })
      await act(async () => { await Promise.resolve() })
    }
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    })
    afterEach(async () => {
      await act(async () => { root.unmount() })
      container.remove()
      vi.useRealTimers()
    })

    it('a new job for a client with an open kitchen polls until the bedroom lands, then stops', async () => {
      const base = { engagements: [kitchen], locFilter: 'all', currentLocationUuid: 'loc-uuid-1', people: [] }
      await render({ ...base, jobberLinks: {} })
      // The send confirms (BeeHub stamps the link) — no engagement_id: a new job.
      const link = { jobber_client_id: '136289662', jobber_request_id: '77', engagement_id: null, sent_at: now }
      openRows = [kitchen] // webhook hasn't founded yet
      await render({ ...base, jobberLinks: { 'lead-9': link } })
      await act(async () => { await vi.advanceTimersByTimeAsync(3_500) })
      expect(openCalls, 'it polls even though the client already has open work').toBe(1)

      openRows = [kitchen, bedroom] // the bedroom is founded
      await act(async () => { await vi.advanceTimersByTimeAsync(3_500) })
      expect(openCalls).toBe(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(openCalls, 'matched the bedroom → stopped').toBe(2)
    })

    it('a send that rode an existing engagement (engagement_id) does not poll', async () => {
      const base = { engagements: [kitchen], locFilter: 'all', currentLocationUuid: 'loc-uuid-1', people: [] }
      await render({ ...base, jobberLinks: {} })
      const link = { jobber_client_id: '136289662', jobber_request_id: '78', engagement_id: 'eng-kitchen', sent_at: now }
      await render({ ...base, jobberLinks: { 'lead-9': link } })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(openCalls).toBe(0)
    })

    it('a client\'s SECOND send is tracked too (per send, not per client)', async () => {
      const base = { engagements: [], locFilter: 'all', currentLocationUuid: 'loc-uuid-1', people: [] }
      await render({ ...base, jobberLinks: {} })
      openRows = [kitchen]
      await render({ ...base, jobberLinks: { 'lead-9': { jobber_client_id: '1', jobber_request_id: '77', sent_at: now } } })
      await act(async () => { await vi.advanceTimersByTimeAsync(3_500) })
      expect(openCalls).toBe(1) // kitchen found → stops
      openRows = [kitchen, bedroom]
      await render({ ...base, engagements: [kitchen], jobberLinks: { 'lead-9': { jobber_client_id: '1', jobber_request_id: '88', sent_at: now + 1 } } })
      await act(async () => { await vi.advanceTimersByTimeAsync(3_500) })
      expect(openCalls, 'the second send enqueued its own poll').toBe(2)
    })
  })
})

// ═══ "Keep local for now" is gone everywhere; phones can send ═══
const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block + JSX {/* */} comments
  .replace(/(^|[^:])\/\/.*$/gm, '$1')    // line comments (not the // in a URL)

describe('no local-only start anywhere — desktop or phone', () => {
  it('no screen under components/ offers "Keep local"', () => {
    const offenders = walk(join(process.cwd(), 'components'))
      .filter(f => /\.(jsx|tsx|js|ts)$/.test(f))
      // Comments may name it (the history of why it went); code may not.
      .filter(f => /Keep local/.test(stripComments(readFileSync(f, 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('the phone New sheet is wired to a real send and mounts its own send window', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    const at = src.indexOf('Quick-capture FAB target')
    expect(at).toBeGreaterThan(-1)
    const phone = src.slice(at, src.indexOf('<BottomNav />', at))
    expect(phone).not.toContain('onSendToJobber={null}')
    expect(phone).toContain('onSendToJobber={p=>setFabSendPerson(p)}')
    expect(phone).toContain('<SendToJobberModal')
    expect(phone).toContain('person={fabSendPerson}')
  })
})
