// @vitest-environment happy-dom
//
// The bees row on the engagement panel — a read-only mirror (2026-11-12).
//
// Jobber owns who is on a job (lib/jobber-crew-mirror.ts). The panel shows it:
// faces directly under the assignee corner, in the corner's own treatment,
// with no way to change them; the job's Slack lines under the identity row;
// "Put this job in Slack" in the ··· menu.
//
// These mount the REAL EngagementPanel (and so the real AssigneeCorner,
// RecordMenu and BeesOnJob pieces) against a canned server. happy-dom lays
// nothing out, so what is pinned here is structure, order, sizes-as-declared
// and what is and is not in the document. What it LOOKS like was checked in a
// real browser at 1280 and 390 wide; no test here can see pixels.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { BEES_FROM_JOBBER, NO_BEES_YET, PUT_IN_SLACK, RECONNECT_LINE, MAX_BEE_FACES } from '@/components/hive/BeesOnJob'
import { FACE_OVERLAP } from '@/components/hive/shared/AssigneeCorner'
import { assigneeSyncNote } from '@/components/hive/shared/AssigneeSyncStatus'
import { beeSlackNote } from '@/components/hive/shared/BeeSlackStatus'
import BeeRosterSettings from '@/components/hive/BeeRosterSettings'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ENG = 'eng-1'
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const bee = (i: number, name: string, extra: any = {}) => ({
  id: `bee-${i}`, name, email: `b${i}@bee.test`, is_active: true, removed_at: null,
  slack_user_id: `U${i}`, slack_checked_at: '2026-11-01', assigned_at: `2026-11-01T00:00:0${i}Z`, ...extra,
})
const ANA = bee(1, 'Ana Bee'), SAM = bee(2, 'Sam Carpenter'), NORA = bee(3, 'Nora Nobody'), UNA = bee(4, 'Una Unchecked'), ZOE = bee(5, 'Zoe New')
const READY = { connected: true, canManageChannels: true, canReconnect: true, channelsSetUp: true, channel: null, closed: false, reconcile: null }
const CHANNEL = { id: 'C1', name: 'sarah-mcallister-pantry', archived: false }

let engBody: any, beesBody: any, calls: { url: string; method: string; body: any }[], channelAnswer: any, toasts: any[]
let host: HTMLElement, root: ReturnType<typeof createRoot>

const res = (j: any, status = 200) => ({ ok: status < 400, status, json: async () => j }) as any
beforeEach(() => {
  document.body.innerHTML = ''
  calls = []; toasts = []
  engBody = {
    engagement: {
      id: ENG, title: 'Pantry reset', stage: 'Request', founded_by: 'manual', location_uuid: LOC, project_type: 'Pantry',
      created_at: '2026-11-01T00:00:00Z', stage_entered_at: '2026-11-01T00:00:00Z', description: null,
      closed_at: null, closed_reason: null, closed_note: null, total_invoiced: 0, total_paid: 0, balance_owing: 0,
    },
    assignees: [{ hub_user_id: 'u1', name: 'Olive Owner' }, { hub_user_id: 'u2', name: 'Mona Manager' }],
    children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] },
    drip: null,
    client: { id: 'lead-1', name: 'Sarah McAllister', location_name: 'Test Location', email: null, phone: null, address: null, city: null, state: null, zip: null, request_details: null, source: null, referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0, jobber_connected: true },
  }
  beesBody = { setUp: true, bees: [ANA, SAM], roster: [ANA, SAM, NORA, UNA, ZOE], canAddBees: true, slack: { ...READY } }
  channelAnswer = () => res({ ok: true, already: false, channel: CHANNEL, bees: [ANA, SAM], problems: [] })
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
    const u = String(url), method = init.method || 'GET'
    calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : null })
    if (u.endsWith('/bees') && method === 'GET') return res(beesBody)
    if (u.endsWith('/slack-channel') && method === 'POST') return channelAnswer()
    if (u.endsWith('/slack-channel') && method === 'PATCH') return res({ ok: true })
    if (u.includes('/assignees')) return res({ assignees: engBody.assignees, jobber_sync: { request: 'skipped', job: 'none', assessment: 'failed', mapped: 1, unmapped: 0, visitsTouched: 0 } })
    if (u.includes('/api/engagements/')) return res(engBody)
    return res({})
  }))
})
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.unstubAllGlobals() })

const mount = async (props: any = {}) => {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<EngagementPanel engagementId={ENG} people={[]} onClose={() => {}} setToast={(t: any) => toasts.push(t)}
      lookupOptions={{ sources: [], projectTypes: ['Pantry'], closeLostReasons: [] } as any}
      locationUsers={[{ id: 'u1', name: 'Olive Owner', locationId: LOC, jobberUserId: 'J1' }]} {...props} />)
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}
const click = async (el: Element | null | undefined) => {
  expect(el, 'the thing to click').toBeTruthy()
  await act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 0)) })
}
const doc = () => document.body
const people = () => host.querySelector('[data-masthead-people]') as HTMLElement
const beeRow = () => host.querySelector('[data-bee-bees]') as HTMLElement | null
const typeBand = () => {
  let el = host.querySelector('button[aria-label="Edit type"]') as HTMLElement | null
  while (el && !/border-top/.test(el.getAttribute('style') || '')) el = el.parentElement
  return el!
}
const openMenu = async () => { await click(host.querySelector('[data-bee-record-menu-trigger]')) }
const menuLabels = () => Array.from(doc().querySelectorAll('[data-bee-record-menu] [role="menuitem"]')).map(b => b.textContent!.trim())
const menuItem = (label: string) => Array.from(doc().querySelectorAll('[data-bee-record-menu] [role="menuitem"]')).find(b => b.textContent!.trim() === label)
const beeWrites = () => calls.filter(c => /\/bees(\?|$)/.test(c.url) && c.method !== 'GET')
const code = (file: string) => readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n')

describe('the bees row sits directly under the assignee corner and uses its treatment', () => {
  it('one right-aligned column in the masthead: the assignee corner first, the bees directly under it, nothing between', async () => {
    await mount()
    const col = people()
    expect(col.style.display).toBe('flex')
    expect(col.style.flexDirection).toBe('column')
    expect(col.style.alignItems).toBe('flex-end')
    expect(col.children).toHaveLength(2)
    expect(col.children[0].querySelector('button')!.getAttribute('aria-label')).toMatch(/^Assigned to Olive Owner, Mona Manager/)
    expect(col.children[1]).toBe(beeRow())
    // …and that column is in the identity row, beside the ··· menu.
    expect(col.parentElement!.querySelector('[data-bee-record-menu-trigger]')).not.toBeNull()
  })

  it('the same faces: the corner’s size, ring and overlap, at most three then +N, every name in the title', async () => {
    beesBody.bees = [ANA, SAM, NORA, UNA, ZOE]
    await mount()
    const col = people()
    const discs = (row: Element) => Array.from(row.querySelectorAll('span[aria-hidden]')).filter(d => (d as HTMLElement).style.borderRadius) as HTMLElement[]
    const [a] = discs(col.children[0]); const beeDiscs = discs(beeRow()!)
    expect(beeDiscs).toHaveLength(MAX_BEE_FACES)
    for (const d of beeDiscs) {
      expect(d.style.width).toBe(a.style.width)          // 24px — T.avatar.corner
      expect(d.style.height).toBe(a.style.height)
      expect(d.style.fontSize).toBe(a.style.fontSize)
      expect(d.style.border).toBe(a.style.border)        // the ring
    }
    expect(a.style.width).toBe('24px')
    const wraps = Array.from(beeRow()!.querySelectorAll('[data-bee-face]')) as HTMLElement[]
    expect(wraps.map(w => w.style.marginLeft)).toEqual(['0px', FACE_OVERLAP, FACE_OVERLAP])
    const assigneeWraps = Array.from(col.children[0].querySelectorAll('button > span > span')) as HTMLElement[]
    expect(assigneeWraps[1].style.marginLeft).toBe(FACE_OVERLAP)
    expect(beeRow()!.querySelector('[data-bee-more]')!.textContent).toBe('+2')
    expect(beeRow()!.querySelector('button')!.getAttribute('title')).toBe('Ana Bee, Sam Carpenter, Nora Nobody, Una Unchecked, Zoe New')
    expect(beeRow()!.querySelector('button')!.style.padding).toBe(col.children[0].querySelector('button')!.style.padding)
  })

  // 8px cut the second initial off every face but the last, in BOTH clusters:
  // "OO" read "OC", "AB" read "AE". Seen in a browser, not by a test — this
  // only stops the number drifting back.
  it('faces tuck by 4px, not 8: at 8 the second initial of every face but the last was cut off', () => {
    expect(FACE_OVERLAP).toBe('-4px')
    expect(code('components/hive/shared/AssigneeCorner.jsx')).not.toMatch(/'-8px'/)
    expect(code('components/hive/BeesOnJob.jsx')).not.toMatch(/'-8px'/)
  })

  it('nobody on the job yet: a dashed ghost like the corner’s, with no "+" (nothing is added here), and it keeps its label', async () => {
    beesBody.bees = []
    await mount()
    const ghost = beeRow()!.querySelector('[data-bee-ghost]') as HTMLElement
    expect(ghost.style.border).toMatch(/dashed/)
    expect(ghost.style.width).toBe('24px')
    expect(ghost.textContent).toBe('')
    expect(beeRow()!.querySelector('[data-bee-label]')!.textContent).toBe('Bees')
  })

  it('the one difference is a quiet "Bees" label; on a phone it is dropped when there are faces (it was costing the client’s name) and kept on an empty ring', async () => {
    await mount()
    expect(beeRow()!.querySelector('[data-bee-label]')!.textContent).toBe('Bees')
    expect(people().children[0].textContent).not.toMatch(/assign/i)        // the corner stays label-free
    const src = code('components/hive/BeesOnJob.jsx')
    expect(src).toMatch(/\(!isMobile \|\| n === 0\) && \(/)
    expect(code('components/hive/EngagementPanel.jsx')).toMatch(/<BeeCorner ctl=\{jobBees\} isMobile=\{isMobile\} \/>/)
  })

  it('the row is not shown where it could never fill: no bees and a location not reconnected for job channels', async () => {
    beesBody.bees = []
    beesBody.slack = { ...READY, canManageChannels: false }
    await mount()
    expect(beeRow()).toBeNull()
    expect(people().children).toHaveLength(1)
  })

  it('before the bees tables exist nothing of this renders', async () => {
    beesBody = { setUp: false }
    await mount()
    expect(host.querySelector('[data-bee-bees], [data-bee-slack-lines]')).toBeNull()
    await openMenu()
    expect(menuLabels()).not.toContain(PUT_IN_SLACK)
  })
})

describe('nothing in the Type band mentions bees', () => {
  it('the band is Type alone again: no bee text, no bee element, one cell', async () => {
    await mount()
    const band = typeBand()
    expect(band.textContent).not.toMatch(/bee|slack/i)
    expect(band.querySelector('[data-bee-bees], [data-bee-face], [data-bee-channel], [data-bee-make-channel]')).toBeNull()
    expect(band.children).toHaveLength(1)
    expect(band.textContent).toMatch(/^Type/)
  })

  it('in the source, the bees pieces are mounted before the band, and nothing after it', () => {
    const src = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    const band = src.indexOf('<MicroLabel>Type</MicroLabel>')
    for (const piece of ['<BeeCorner', '<BeeSlackLines', '<BeeChannelDialog']) {
      expect(src.split(piece).length - 1, piece).toBe(1)
      expect(src.indexOf(piece), piece).toBeLessThan(band)
    }
    expect(src).not.toMatch(/<BeesOnJob\b/)
  })
})

describe('there is no way to change a job’s bees from the panel', () => {
  it('clicking the faces opens a card that names everyone and says, in one line, the crew comes from Jobber — no picker', async () => {
    beesBody.bees = [ANA, SAM, NORA, UNA]
    await mount()
    await click(beeRow()!.querySelector('[data-bee-bees-trigger]'))
    const card = host.querySelector('[data-bee-bees-popover]')!
    expect(Array.from(card.querySelectorAll('[data-bee-name] > span:last-child')).map(n => n.textContent)).toEqual(['Ana Bee', 'Sam Carpenter', 'Nora Nobody', 'Una Unchecked'])
    expect(card.querySelector('[data-bee-from-jobber]')!.textContent).toBe(BEES_FROM_JOBBER)
    expect(BEES_FROM_JOBBER).toBe('Bees come from Jobber: whoever is on this job’s visits. Change it there.')
    expect(card.textContent).toContain('Bees on this job')
    // Nothing to tick, type or add.
    expect(card.querySelector('input, select, textarea, [role="checkbox"], [data-bee-picker], [data-bee-id]')).toBeNull()
    expect(Array.from(card.querySelectorAll('button')).map(b => b.textContent)).toEqual(['Done'])
  })

  it('an empty row says so and still says where it comes from', async () => {
    beesBody.bees = []
    await mount()
    await click(beeRow()!.querySelector('[data-bee-bees-trigger]'))
    const card = host.querySelector('[data-bee-bees-popover]')!
    expect(card.querySelector('[data-bee-none]')!.textContent).toBe(NO_BEES_YET)
    expect(card.querySelector('[data-bee-from-jobber]')!.textContent).toBe(BEES_FROM_JOBBER)
  })

  it('clicking every bees control on the panel never sends a write for a bee', async () => {
    await mount()
    await click(beeRow()!.querySelector('[data-bee-bees-trigger]'))
    for (const el of Array.from(host.querySelectorAll('[data-bee-bees] *'))) {
      await act(async () => { (el as HTMLElement).click?.(); await new Promise(r => setTimeout(r, 0)) })
    }
    expect(beeWrites()).toEqual([])
    expect(calls.filter(c => c.url.endsWith('/bees'))).toHaveLength(1)   // the one read
  })

  it('the code that could tick a bee is gone: no picker file, and the panel’s bees module only ever READS /bees', () => {
    expect(existsSync('components/hive/shared/BeePicker.jsx')).toBe(false)
    const src = code('components/hive/BeesOnJob.jsx')
    expect(src).not.toMatch(/BeePicker|onToggle|bee_id|method: 'DELETE'/)
    const fetches = src.match(/fetch\(`[^`]+`[^)]*\)?/g) || []
    expect(fetches.filter(f => /\/bees/.test(f))).toEqual(['fetch(`/api/engagements/${engagementId}/bees`)'])
    expect(code('components/hive/EngagementPanel.jsx')).not.toMatch(/BeePicker/)
  })

  it('a read-only user sees the same faces and the same card', async () => {
    await mount({ readOnly: true })
    expect(beeRow()!.querySelectorAll('[data-bee-face]')).toHaveLength(2)
    await click(beeRow()!.querySelector('[data-bee-bees-trigger]'))
    expect(host.querySelector('[data-bee-from-jobber]')!.textContent).toBe(BEES_FROM_JOBBER)
  })
})

describe('"Put this job in Slack" lives in the ··· menu', () => {
  it('reconnected, no channel yet: the item is in the menu, and the old button is nowhere', async () => {
    await mount()
    expect(host.querySelector('[data-bee-make-channel]')).toBeNull()
    expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent!.trim() === PUT_IN_SLACK)).toBe(false)
    await openMenu()
    expect(menuLabels()).toContain(PUT_IN_SLACK)
    // Beside the other record actions, not instead of them.
    expect(menuLabels()).toEqual(expect.arrayContaining(['Set a reminder', 'Report a problem with this engagement', 'Mark as Closed Lost']))
  })

  const HIDDEN: [string, () => void, any?][] = [
    ['the location has not reconnected Slack', () => { beesBody.slack = { ...READY, canManageChannels: false } }],
    ['the location has no Slack at all', () => { beesBody.slack = { ...READY, connected: false, canManageChannels: false } }],
    ['Slack is not connected, whatever else the server says (fails closed)', () => { beesBody.slack = { ...READY, connected: false } }],
    ['the job already has a channel', () => { beesBody.slack = { ...READY, channel: CHANNEL } }],
    ['the job is closed', () => { beesBody.slack = { ...READY, closed: true } }],
    ['the channel columns are not set up', () => { beesBody.slack = { ...READY, channelsSetUp: false } }],
    ['the user is read-only', () => {}, { readOnly: true }],
  ]
  for (const [why, arrange, props] of HIDDEN) {
    it(`hidden — no item at all — when ${why}`, async () => {
      arrange()
      await mount(props || {})
      await openMenu()
      expect(menuLabels().length).toBeGreaterThan(0)          // the menu itself is there
      expect(menuLabels()).not.toContain(PUT_IN_SLACK)
      expect(doc().textContent).not.toContain(PUT_IN_SLACK)
    })
  }

  it('picking it opens the same confirm: the channel’s name, who is added, and that the channel follows Jobber — with nothing to tick', async () => {
    await mount()
    await openMenu()
    await click(menuItem(PUT_IN_SLACK))
    expect(doc().querySelector('[data-bee-record-menu]')).toBeNull()      // the menu closed
    const text = doc().textContent!
    expect(text).toContain('A public channel called #sarah-mcallister-pantry')
    expect(text).toContain('The bees on this job are added, and the location owner too, as long as Slack knows the email they use for Bee Hub.')
    expect(doc().querySelector('[data-bee-dialog-who]')!.textContent).toBe('On this job now: Ana Bee, Sam Carpenter.')
    expect(text).toContain('When the people on this job’s visits change in Jobber, the channel follows.')
    expect(doc().querySelector('[data-bee-picker], [data-bee-id], input[type="checkbox"]')).toBeNull()
    expect(calls.some(c => c.method === 'POST')).toBe(false)             // nothing made yet
  })

  it('with nobody on the job, the confirm says the channel waits for them', async () => {
    beesBody.bees = []
    await mount()
    await openMenu(); await click(menuItem(PUT_IN_SLACK))
    expect(doc().querySelector('[data-bee-dialog-who]')!.textContent).toBe(`${NO_BEES_YET} The channel is made now and they are added when they are.`)
  })

  it('Make the channel posts once, the channel line appears under the row, and the item leaves the menu', async () => {
    await mount()
    await openMenu(); await click(menuItem(PUT_IN_SLACK))
    await click(doc().querySelector('[data-bee-make-channel-confirm]'))
    expect(calls.filter(c => c.method === 'POST').map(c => c.url)).toEqual([`/api/engagements/${ENG}/slack-channel`])
    expect(host.querySelector('[data-bee-channel]')!.textContent).toBe('Slack channel #sarah-mcallister-pantry')
    expect(doc().querySelector('[data-bee-make-channel-confirm]')).toBeNull()
    expect(toasts.at(-1)).toEqual({ kind: 'success', msg: 'Made #sarah-mcallister-pantry in Slack' })
    await openMenu()
    expect(menuLabels()).not.toContain(PUT_IN_SLACK)
  })

  it('when the server refuses, its own words are shown and nothing changes on the panel', async () => {
    channelAnswer = () => res({ error: 'not_ready', message: 'Reconnect Slack first — this location can’t make channels yet.' }, 409)
    await mount()
    await openMenu(); await click(menuItem(PUT_IN_SLACK))
    await click(doc().querySelector('[data-bee-make-channel-confirm]'))
    expect(toasts.at(-1)).toEqual({ kind: 'error', msg: 'Reconnect Slack first — this location can’t make channels yet.' })
    expect(host.querySelector('[data-bee-channel]')).toBeNull()
  })

  it('an owner who could not be added to the new channel is named under the row', async () => {
    channelAnswer = () => res({ ok: true, channel: CHANNEL, bees: [ANA, SAM], problems: [{ status: 'owner_not_in_slack', bee: 'Olive Owner', email: 'olive@home.com' }] })
    await mount()
    await openMenu(); await click(menuItem(PUT_IN_SLACK))
    await click(doc().querySelector('[data-bee-make-channel-confirm]'))
    expect(host.querySelector('[data-bee-slack-lines] [data-bee-bees-slack]')!.textContent)
      .toBe('Olive Owner, the owner, wasn’t added to the channel: nobody in your Slack uses olive@home.com, the email they sign in to Bee Hub with. Add them in Slack.')
  })

  // The server half is unchanged and still pinned where it was: the POST
  // refuses (closed job, not reconnected, no Slack) BEFORE any Slack call —
  // lib/beta-job-channels.test.tsx, "Part B — making the channel". This pins
  // that the route file itself did not move in this slice.
  it('the server route that refuses before calling Slack is byte-for-byte what was pushed', () => {
    expect(createHash('sha256').update(readFileSync('app/api/engagements/[id]/slack-channel/route.ts')).digest('hex'))
      .toBe('da053ab5fd04abd1428da9dc9f6c81e9ec85a1c45418001e16fb80bba1627ca6')
  })
})

describe('the lines under the identity row, and their order', () => {
  const afterIdentityRow = () => {
    const row = people().parentElement!
    const out: string[] = []
    for (let el = row.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.hasAttribute('data-bee-assignee-sync')) out.push('assignee line')
      else if (el.hasAttribute('data-bee-slack-lines')) out.push('slack lines')
      else if (el.querySelector('button[aria-label="Edit type"]')) out.push('type band')
      else out.push('title row')
    }
    return out
  }

  it('assignee line, then the job’s Slack lines, then the title row, then Type', async () => {
    beesBody.slack = { ...READY, channel: CHANNEL }
    engBody.assignees = []
    await mount()
    await click(host.querySelector('[aria-label="Assign a team member"]'))
    await click(Array.from(host.querySelectorAll('button')).find(b => b.textContent!.includes('Olive Owner')))
    expect(afterIdentityRow()).toEqual(['assignee line', 'slack lines', 'title row', 'type band'])
  })

  it('a channel reads "Slack channel #name"; an archived one says so; a long name is clipped, not wrapped', async () => {
    beesBody.slack = { ...READY, closed: true, channel: { ...CHANNEL, archived: true } }
    await mount()
    const line = host.querySelector('[data-bee-channel]') as HTMLElement
    expect(line.textContent).toBe('Slack channel #sarah-mcallister-pantry · archived')
    expect(line.style.textOverflow).toBe('ellipsis')
    expect(line.style.whiteSpace).toBe('nowrap')
  })

  it('not reconnected: the reconnect line, for someone who can reconnect — and nobody else', async () => {
    beesBody.slack = { ...READY, canManageChannels: false }
    await mount()
    expect(host.querySelector('[data-bee-reconnect]')!.textContent).toBe(`${RECONNECT_LINE} Settings › Slack.`)
    act(() => root.unmount()); host.remove()
    beesBody.slack = { ...READY, canManageChannels: false, canReconnect: false }
    await mount()
    expect(host.querySelector('[data-bee-reconnect]')).toBeNull()
    expect(host.querySelector('[data-bee-slack-lines]')).toBeNull()
    act(() => root.unmount()); host.remove()
    beesBody.slack = { ...READY, canManageChannels: false }
    await mount({ readOnly: true })
    expect(host.querySelector('[data-bee-reconnect]')).toBeNull()
  })

  it('the "when this job reopened" box is there until Got it', async () => {
    beesBody.slack = { ...READY, channel: CHANNEL, reconcile: { at: '2026-11-04T12:00:00Z', items: [{ status: 'still_in_channel', bee: 'Sam Carpenter', channel: CHANNEL.name, bee_id: 'bee-2' }] } }
    await mount()
    const box = host.querySelector('[data-bee-slack-lines] [data-bee-reconcile]')!
    expect(box.textContent).toMatch(/When this job reopened/)
    expect(box.textContent).toMatch(/Sam Carpenter is off this job in Bee Hub, but is STILL IN #sarah-mcallister-pantry/)
    await click(host.querySelector('[data-bee-reconcile-ok]'))
    expect(calls.some(c => c.method === 'PATCH' && c.url === `/api/engagements/${ENG}/slack-channel` && c.body?.clear_problems === true)).toBe(true)
    expect(host.querySelector('[data-bee-reconcile]')).toBeNull()
  })

  it('with nothing to say, nothing is rendered between the identity row and the title', async () => {
    await mount()
    expect(afterIdentityRow()).toEqual(['title row', 'type band'])
  })
})

describe('a location with no Slack shows faces and not a word about Slack', () => {
  it('faces, the card, the menu — and "Slack" nowhere on the panel, visible or in a title', async () => {
    beesBody.slack = { connected: false, canManageChannels: false, canReconnect: true, channelsSetUp: true, channel: null, closed: false, reconcile: null }
    await mount()
    expect(beeRow()!.querySelectorAll('[data-bee-face]')).toHaveLength(2)
    await click(beeRow()!.querySelector('[data-bee-bees-trigger]'))
    expect(host.querySelector('[data-bee-from-jobber]')).not.toBeNull()
    await openMenu()
    expect(menuLabels().length).toBeGreaterThan(0)
    expect(host.querySelector('[data-bee-slack-lines]')).toBeNull()
    expect(doc().textContent).not.toMatch(/slack/i)
    for (const el of Array.from(doc().querySelectorAll('[title],[aria-label]'))) {
      expect((el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '')).not.toMatch(/slack/i)
    }
  })
})

// Only the per-job tick went. Typing a bee by hand is still the route for
// someone in Slack but not in Jobber, or whose Slack email differs.
describe('Settings still lets someone add, edit, remove and bring back a bee', () => {
  const kept = { id: 'b1', name: 'Hattie Hand', email: 'hattie@home.test', is_active: true, removed_at: null, slack_user_id: null, slack_checked_at: null }
  const gone = { id: 'b2', name: 'Rita Removed', email: 'rita@bee.test', is_active: false, removed_at: '2026-11-01T00:00:00Z', slack_user_id: null, slack_checked_at: null }
  let sent: { url: string; method: string; body: any }[]
  const mountRoster = async () => {
    sent = []
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
      const method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null
      sent.push({ url: String(url), method, body })
      if (method === 'GET') return res({ bees: [kept, gone], slackConnected: false, locationName: 'Test Location' })
      if (method === 'POST') return res({ bee: { ...kept, id: 'b3', name: body.name, email: body.email } })
      const id = String(url).split('/bees/')[1]
      const row = id === 'b2' ? gone : kept
      return res({ bee: { ...row, ...(body.name ? { name: body.name, email: body.email } : {}), ...(typeof body.active === 'boolean' ? { is_active: body.active } : {}) } })
    }))
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root.render(<BeeRosterSettings {...({ locationId: LOC, locationName: 'Test Location' } as any)} />) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
  const type = async (el: Element | null, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, v); el!.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const submit = async (form: Element | null) => { await act(async () => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 0)) }) }
  const writes = () => sent.filter(c => c.method !== 'GET')

  it('add: the form posts the name and email', async () => {
    await mountRoster()
    await click(host.querySelector('[data-bee-add-open]'))
    await type(host.querySelector('[aria-label="Bee name"]'), 'Polly Pollen')
    await type(host.querySelector('[aria-label="Bee email"]'), 'polly@slack.test')
    await submit(host.querySelector('[data-bee-add]'))
    expect(writes()).toEqual([{ url: `/api/locations/${LOC}/bees`, method: 'POST', body: { name: 'Polly Pollen', email: 'polly@slack.test' } }])
    expect(host.textContent).toContain('Polly Pollen')
  })

  it('edit: a bee’s email can be changed (the fix for a Slack email that differs from the Jobber one)', async () => {
    await mountRoster()
    await click(host.querySelector('[data-bee="b1"] [aria-label="Edit Hattie Hand"]'))
    const inputs = host.querySelectorAll('[data-bee-edit] input')
    await type(inputs[1], 'hattie@slack.test')
    await submit(host.querySelector('[data-bee-edit]'))
    expect(writes()).toEqual([{ url: `/api/locations/${LOC}/bees/b1`, method: 'PATCH', body: { name: 'Hattie Hand', email: 'hattie@slack.test' } }])
  })

  it('remove: after a confirm, the bee is switched off, not deleted', async () => {
    await mountRoster()
    await click(host.querySelector('[data-bee="b1"] [aria-label="Remove Hattie Hand"]'))
    expect(writes()).toEqual([])                                            // nothing until confirmed
    await click(Array.from(host.querySelectorAll('[data-bee="b1"] button')).find(b => b.textContent === 'Remove'))
    expect(writes()).toEqual([{ url: `/api/locations/${LOC}/bees/b1`, method: 'PATCH', body: { active: false } }])
  })

  it('bring back: a removed bee is switched on again', async () => {
    await mountRoster()
    expect(host.querySelector('[data-bee-removed] summary')!.textContent).toContain('Removed bees (1)')
    await click(Array.from(host.querySelectorAll('[data-bee-removed] button')).find(b => b.textContent === 'Bring back'))
    expect(writes()).toEqual([{ url: `/api/locations/${LOC}/bees/b2`, method: 'PATCH', body: { active: true } }])
  })
})

describe('slice 1’s mirror is untouched, by fingerprint', () => {
  // This slice moves pixels. Who ends up on a job or in a channel is decided
  // by these files, and each is byte-for-byte what was pushed as d580087.
  // (Their behaviour is pinned by lib/beta-jobber-crew-mirror.test.ts and
  // lib/beta-job-channels.test.tsx; this pins that nobody edited them here.)
  const PUSHED: Record<string, string> = {
    'lib/jobber-crew-mirror.ts': 'f3df7822fb40c77cfbb8fe5e2abfc6192fdf28855eaa9a64314f082d417ad0ef',
    'lib/engagement-bees.ts': '327eea0f0d927f982819d6077ad05b912e6a70bccdc2e006e656f3db587ea0f6',
    'lib/jobber-webhook-handlers.ts': '6672c5b7993b174ad2c97a28b8310ccaaecaa6e8ef1ad25f3175209ff825fe6f',
    'app/api/cron/job-channels/route.ts': 'bec11c38d6fbab16104a897ad4444031534d92bf85db4238f207636e00705b60',
    'lib/location-bees.ts': 'a8870029550a48572bc08ae6a01ada11d60f468f86afffef1aef2d88b26450b7',
  }
  for (const [file, sha] of Object.entries(PUSHED)) {
    it(`${file} is what was pushed`, () => {
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(sha)
    })
  }
})

describe('the two small wording fixes', () => {
  it('the assignee line no longer says "or job": the picker has not written a job’s visits since slice 1', () => {
    const note = assigneeSyncNote({ request: 'skipped', job: 'none', assessment: 'failed', mapped: 1, unmapped: 0 })!
    expect(note.text).toBe('Saved here, but couldn’t update Jobber — the team may not show on the assessment yet. Try again shortly.')
    expect(note.text).not.toMatch(/or job|crew/)
  })

  it('a bee Slack does not know points at the screen that exists: Settings › Team and Seats, not "Settings › Bees"', () => {
    expect(beeSlackNote({ status: 'not_in_slack', bee: 'Nora', email: 'n@x.com' })!.text).toContain('Check their email in Settings › Team and Seats.')
    for (const f of ['components/hive/shared/BeeSlackStatus.jsx', 'app/api/engagements/[id]/bees/route.ts']) {
      expect(code(f), f).not.toMatch(/Settings › Bees/)
    }
  })

  describe('the Bees heading in Settings carries the location’s name', () => {
    const mountRoster = async (props: any, payload: any) => {
      vi.stubGlobal('fetch', vi.fn(async () => res(payload)))
      host = document.createElement('div'); document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => { root.render(<BeeRosterSettings {...props} />) })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      return host.querySelector('#team-bees-title')!.textContent
    }
    it('from the screen when it has one', async () => {
      expect(await mountRoster({ locationId: LOC, locationName: 'Kansas City' }, { bees: [], slackConnected: false, locationName: 'Something Else' })).toBe('Kansas City’s bees')
    })
    it('from the server when the screen was not handed one (an admin looking at a location)', async () => {
      expect(await mountRoster({ locationId: LOC, locationName: '' }, { bees: [], slackConnected: false, locationName: 'Northern Virginia' })).toBe('Northern Virginia’s bees')
    })
    it('plain "Bees" only when nobody knows the name', async () => {
      expect(await mountRoster({ locationId: LOC }, { bees: [], slackConnected: false, locationName: null })).toBe('Bees')
    })
    it('the route sends the name with the roster', () => {
      const src = code('app/api/locations/[id]/bees/route.ts')
      expect(src).toMatch(/from\('locations'\)\.select\('name'\)\.eq\('id', params\.id\)/)
      expect(src).toMatch(/slackConnected: slack\.connected, locationName \}/)
    })
  })
})
