// @vitest-environment happy-dom
//
// A STATUS CHANGE TELLS THE OWNER SOMETHING.
//
// Kevin moved an item to "On the list" and it stayed in "Waiting to hear from
// us" — correctly, because he typed nothing, so the owner had heard nothing.
// That is how Lynette got "On the roadmap" in July and silence since.
//
// So picking On the list or Looking at it fills an EMPTY reply box with a
// starting sentence the admin can edit. Pre-filled, not sent: a person reads
// the words before an owner does. What this file pins:
//   · each of the two statuses fills its own sentence
//   · words the admin typed are never overwritten
//   · switching swaps the default only while it is untouched
//   · saving the default sends it, and the item moves to the replied group
//     through the EXISTING grouping (which reads the reply, not the status)
//   · clearing the box still saves the status, with a plain warning that
//     nobody is being told — never a block
//   · no other status pre-fills anything
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen, { STATUS_DEFAULT_REPLY } from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

const ON_THE_LIST = 'Thanks for this. We have agreed to build it and it is on the list. I will come back here when it ships rather than closing it quietly.'
const LOOKING = 'Thanks for this. We are looking at it properly before we commit either way, and I will come back with an answer.'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const item = (over: any) => ({
  id: 'b1', title: 'Email notifications assigned to only the owner', description: 'Words.', type: 'feature', status: 'submitted',
  user_id: 'owner-1', submitter_name: 'Lynette Ewy', submitter_email: 'lynette@kc.com',
  location_id: 'loc-2', location_name: 'Kansas City', created_at: daysAgo(90), updated_at: daysAgo(90),
  admin_response: null, admin_response_at: null, reply_seen_at: null, attachments: [], replies: [],
  is_internal: false, assigned_to: null, assigned_to_name: null, looks_shipped: false,
  ...over,
})

// A stand-in for the PATCH route: merges what was sent into the row and
// returns it, as the real route does (including the reply becoming
// admin_response). The grouping then reads the row exactly as it would live.
function server(rows: any[]) {
  const store = rows.map(r => ({ ...r }))
  const patches: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    const ok = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body)
      patches.push(body)
      const row = store.find(r => u.endsWith(`/${r.id}`))!
      Object.assign(row, body.status ? { status: body.status } : {}, body.admin_response ? { admin_response: body.admin_response, admin_response_at: new Date().toISOString() } : {})
      return ok({ ...row, reply_email: body.admin_response ? { sent: true, to: row.submitter_email, kind: 'reply' } : null })
    }
    if (u.startsWith('/api/admin/feedback/analysis')) return ok({ analyses: [], clusters: [], drafts: [] })
    return ok({ items: store.map(r => ({ ...r })) })
  }))
  return { store, patches }
}

async function mount(rows: any[], me = 'admin-1') {
  const srv = server(rows)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={{ id: me, email: 'kevin@bmave.com' } as any}>
        <AdminFeedbackScreen />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { host, srv, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = async (el: Element | null | undefined) => {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}
const openFirst = (host: Element) => click([...host.querySelectorAll('[data-row] button')].pop())
const reply = (host: Element) => host.querySelector('#fb-reply') as HTMLTextAreaElement
const pick = (host: Element, value: string) => act(async () => {
  const sel = host.querySelector('select[aria-label="Status"]') as HTMLSelectElement
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})
const type = (host: Element, text: string) => act(async () => {
  const ta = reply(host)
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})
const saveButton = (host: Element) => [...host.querySelectorAll('button')].find(b => /^Save( and email .+)?$/.test((b.textContent || '').trim())) as HTMLButtonElement
const sectionOf = (host: Element, id: string) => host.querySelector(`[data-row="${id}"]`)?.closest('[data-section]')?.getAttribute('data-section')

afterEach(() => { vi.unstubAllGlobals() })

describe('the two default sentences', () => {
  it('are the agreed words', () => {
    expect(STATUS_DEFAULT_REPLY).toEqual({ planned: ON_THE_LIST, under_review: LOOKING })
  })

  it('picking On the list on an empty box fills its sentence', async () => {
    const { host, unmount } = await mount([item({})])
    await openFirst(host)
    expect(reply(host).value).toBe('')
    await pick(host, 'planned')
    expect(reply(host).value).toBe(ON_THE_LIST)
    await unmount()
  })

  it('picking Looking at it fills its own sentence', async () => {
    const { host, unmount } = await mount([item({})])
    await openFirst(host)
    await pick(host, 'under_review')
    expect(reply(host).value).toBe(LOOKING)
    await unmount()
  })

  it('the sentence is a starting point — it can be edited, and the edit is what is sent', async () => {
    const { host, srv, unmount } = await mount([item({})])
    await openFirst(host)
    await pick(host, 'planned')
    await type(host, `${ON_THE_LIST} Probably early December.`)
    await click(saveButton(host))
    expect(srv.patches).toEqual([{ status: 'planned', admin_response: `${ON_THE_LIST} Probably early December.` }])
    await unmount()
  })
})

describe('never overwrites what the admin wrote', () => {
  it('typed text survives picking On the list, and survives Looking at it', async () => {
    const { host, unmount } = await mount([item({})])
    await openFirst(host)
    await pick(host, 'answered') // move off submitted first, so typing cannot auto-move the dropdown
    await type(host, 'Lynette — we are building this for Kansas City first.')
    await pick(host, 'planned')
    expect(reply(host).value).toBe('Lynette — we are building this for Kansas City first.')
    await pick(host, 'under_review')
    expect(reply(host).value).toBe('Lynette — we are building this for Kansas City first.')
    await unmount()
  })

  it('a default the admin edited is theirs now — switching status keeps it', async () => {
    const { host, unmount } = await mount([item({})])
    await openFirst(host)
    await pick(host, 'planned')
    await type(host, ON_THE_LIST.replace('the list', 'the list for November'))
    await pick(host, 'under_review')
    expect(reply(host).value).toBe(ON_THE_LIST.replace('the list', 'the list for November'))
    await unmount()
  })
})

describe('switching between the two', () => {
  it('swaps the untouched default both ways', async () => {
    const { host, unmount } = await mount([item({})])
    await openFirst(host)
    await pick(host, 'planned')
    expect(reply(host).value).toBe(ON_THE_LIST)
    await pick(host, 'under_review')
    expect(reply(host).value).toBe(LOOKING)
    await pick(host, 'planned')
    expect(reply(host).value).toBe(ON_THE_LIST)
    await unmount()
  })

  it('moving on to a status with no sentence takes the untouched default back out', async () => {
    const { host, unmount } = await mount([item({})])
    await openFirst(host)
    await pick(host, 'planned')
    await pick(host, 'declined')
    expect(reply(host).value).toBe('')
    await unmount()
  })
})

describe('saving', () => {
  it('saving with the default sends it, and the item moves to the replied group', async () => {
    const { host, srv, unmount } = await mount([item({})])
    expect(sectionOf(host, 'b1')).toBe('decide')
    await openFirst(host)
    await pick(host, 'planned')
    const consequences = [...host.querySelectorAll('[data-consequence]')].map(e => e.getAttribute('data-consequence'))
    expect(consequences).toEqual(['status', 'reply', 'email'])
    expect(saveButton(host).textContent).toBe('Save and email Lynette')
    await click(saveButton(host))
    expect(srv.patches).toEqual([{ status: 'planned', admin_response: ON_THE_LIST }])
    // The grouping reads the reply, not the status: with a reply on it the
    // row is now under "We said yes", in the replied group.
    await click([...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Close'))
    expect(sectionOf(host, 'b1')).toBe('build')
    expect(host.querySelector('[data-tile-group="replied"] [data-group-count="replied"]')!.textContent).toBe('1')
    await unmount()
  })

  it('clearing the box still changes the status — not blocked — and the warning says nobody is told', async () => {
    const { host, srv, unmount } = await mount([item({})])
    await openFirst(host)
    await pick(host, 'planned')
    await type(host, '')
    const warning = host.querySelector('[data-consequence="nobody-told"]') as HTMLElement
    expect(warning).toBeTruthy()
    expect(warning.textContent).toBe('Nobody is being told. Lynette Ewy will not hear that it moved to On the list.')
    expect(warning.style.fontWeight).toBe('700')
    const save = saveButton(host)
    expect(save.textContent).toBe('Save')
    expect(save.disabled).toBe(false)
    await click(save)
    expect(srv.patches).toEqual([{ status: 'planned' }])
    expect(srv.store[0].status).toBe('planned')
    // No reply, so the grouping leaves it where it was: still waiting to hear.
    await click([...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Close'))
    expect(sectionOf(host, 'b1')).toBe('decide')
    await unmount()
  })

  it('the warning goes away once there are words again', async () => {
    const { host, unmount } = await mount([item({})])
    await openFirst(host)
    await pick(host, 'under_review')
    expect(host.querySelector('[data-consequence="nobody-told"]')).toBeNull()
    await type(host, '')
    expect(host.querySelector('[data-consequence="nobody-told"]')).toBeTruthy()
    await type(host, 'Back soon.')
    expect(host.querySelector('[data-consequence="nobody-told"]')).toBeNull()
    await unmount()
  })
})

describe('the other statuses pre-fill nothing', () => {
  it('Building it now, Answered, Fixed and Not planned leave an empty box empty', async () => {
    for (const s of ['in_progress', 'answered', 'shipped', 'declined']) {
      const { host, unmount } = await mount([item({})])
      await openFirst(host)
      await pick(host, s)
      expect(reply(host).value, s).toBe('')
      await unmount()
    }
  })

  it('With the team pre-fills nothing either (from an unreplied item that had moved)', async () => {
    const { host, unmount } = await mount([item({ status: 'planned' })])
    await openFirst(host)
    await pick(host, 'submitted')
    expect(reply(host).value).toBe('')
    await unmount()
  })

  it('your own report and internal items never get the owner-facing sentence', async () => {
    for (const over of [{ user_id: 'admin-1' }, { is_internal: true, type: 'bug' }]) {
      const { host, unmount } = await mount([item(over)])
      await openFirst(host)
      await pick(host, 'planned')
      expect(reply(host).value, JSON.stringify(over)).toBe('')
      await unmount()
    }
  })
})
