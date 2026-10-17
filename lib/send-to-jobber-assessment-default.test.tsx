// @vitest-environment happy-dom
//
// Send to Jobber — the in-person/virtual choice starts on the client's own
// type, else the location default, else in-person (lib/assessment-type.ts).
// The screen asks GET /api/leads/:id/assessment-type when it opens; an owner's
// own pick is never overwritten by that answer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import SendToJobberModal from '@/components/hive/SendToJobberModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const person = (over: any = {}) => ({
  id: 'p1',
  name: 'Sarah Mitchell',
  outreachTimeline: [],
  assessment: null,
  assessmentType: null,            // what mapLeadToPerson gives every real lead
  addresses: [{ street: '123 Main St', city: 'Denver', state: 'CO' }],
  jobberClient: null,
  locationName: 'Denver',
  ...over,
})

let host: HTMLDivElement
let root: Root
let posts: any[]
let gets: string[]
let lookup: any
let release: (() => void) | null

beforeEach(() => {
  posts = []; gets = []; lookup = { resolved: 'virtual' }; release = null
  global.fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.endsWith('/assessment-type')) {
      gets.push(u)
      if (release === null && lookup?.__hold) await new Promise<void>(r => { release = r })
      return { ok: true, status: 200, json: async () => lookup } as any
    }
    if (u.includes('/send-to-jobber') && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body))
      return { ok: true, status: 200, json: async () => ({ success: true, jobber_request_id: '777' }) } as any
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
  }) as any
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  if (host) host.remove()
  vi.restoreAllMocks()
})

const mount = async (p: any) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<SendToJobberModal person={p} onDone={() => {}} onClose={() => {}} />) })
  await act(async () => {})
}
const buttons = () => Array.from(host.querySelectorAll('button'))
const contains = (t: string) => buttons().find(b => (b.textContent || '').includes(t))
const aria = (l: string) => buttons().find(b => b.getAttribute('aria-label') === l)
const setInput = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const sendWithAssessment = async (pick?: string) => {
  await act(async () => { aria('Create a Request')!.click() })
  await act(async () => { contains('Continue')!.click() })
  await act(async () => { aria('Include assessment')!.click() })
  if (pick) await act(async () => { aria(pick)!.click() })
  await setInput(host.querySelector('input[aria-label="Assessment date"]') as HTMLInputElement, '2026-08-01')
  await act(async () => { contains('Review')!.click() })
  await act(async () => { contains('Send to Jobber')!.click() })
  await act(async () => {}); await act(async () => {})
}

describe('Send to Jobber starts on the right assessment type', () => {
  it('asks the server for this lead and starts on its answer (location default virtual)', async () => {
    await mount(person())
    expect(gets).toEqual(['/api/leads/p1/assessment-type'])
    await sendWithAssessment()
    expect(posts[0].assessment_type).toBe('virtual')
  })

  it('a server answer of in-person stays in-person', async () => {
    lookup = { resolved: 'in-person' }
    await mount(person())
    await sendWithAssessment()
    expect(posts[0].assessment_type).toBe('in-person')
  })

  it('lookup fails → in-person, and the send still works', async () => {
    lookup = null
    await mount(person())
    await sendWithAssessment()
    expect(posts[0].assessment_type).toBe('in-person')
  })

  it('a type already on the person (sent earlier this session) wins; no lookup', async () => {
    await mount(person({ assessmentType: 'in-person' }))
    expect(gets).toEqual([])
    await sendWithAssessment()
    expect(posts[0].assessment_type).toBe('in-person')
  })

  it('an owner’s own pick is never overwritten by a late answer', async () => {
    lookup = { resolved: 'virtual', __hold: true }
    await mount(person())
    await act(async () => { aria('Create a Request')!.click() })
    await act(async () => { contains('Continue')!.click() })
    await act(async () => { aria('Include assessment')!.click() })
    await act(async () => { aria('In-Person')!.click() })      // owner picks before the answer lands
    await act(async () => { release!() })
    await act(async () => {}); await act(async () => {})
    await setInput(host.querySelector('input[aria-label="Assessment date"]') as HTMLInputElement, '2026-08-01')
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    await act(async () => {}); await act(async () => {})
    expect(posts[0].assessment_type).toBe('in-person')
  })
})
