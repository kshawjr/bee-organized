// @vitest-environment happy-dom
//
// FeedbackModal — the seed path (issue 131, design b). MOUNT tests: a record
// seed pre-fills the Submit form and its id-only `context` rides the POST, and
// the screenshot/attachment slot still works in the seeded flow (issue 116).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import FeedbackModal from '@/components/feedback/FeedbackModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Call = { url: string; method: string; body: any }
let calls: Call[] = []
const installFetch = () => {
  calls = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
    if (method !== 'GET') {
      // FormData upload bodies aren't JSON — record the URL only, never parse.
      const isUpload = u.includes('/upload')
      const body = isUpload ? '<form>' : (opts.body ? JSON.parse(opts.body) : null)
      calls.push({ url: u, method, body })
    }
    if (u.includes('/api/feedback/upload')) return json({ path: 'u1/uuid-screenshot.png', name: 'screenshot.png', size: 1234, type: 'image/png' })
    if (u.includes('/api/feedback') && method === 'POST') return json({ id: 'fb-1', title: 'Problem with Dana', status: 'submitted' }, 201)
    if (u.includes('/api/feedback')) return json({ items: [] }) // GET My Items
    return json({})
  })
}

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
const typeIn = (el: Element, value: string) => act(async () => {
  const proto = el.tagName === 'TEXTAREA'
    ? (globalThis as any).window.HTMLTextAreaElement.prototype
    : (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const btn = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
// The Submit ACTION button (the tab strip also has a button reading "Submit";
// the action button is the last one).
const submitBtn = (host: Element) =>
  [...host.querySelectorAll('button')].filter(b => (b.textContent || '').trim() === 'Submit').pop()!

const CONTEXT = { kind: 'client', lead_id: 'lead-9', location_id: 'loc-uuid-1', screen: 'Clients', path: '/clients/lead-9', origin: 'client_profile_menu' }
const SEED = { type: 'bug', title: 'Problem with Dana Client', context: CONTEXT }

beforeEach(() => { document.body.innerHTML = ''; installFetch() })

describe('seed pre-fills the Submit form', () => {
  it('opens on the Submit tab with the seeded title', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={SEED} onClose={() => {}} />)
    const title = host.querySelector('input[placeholder="Short summary"]') as HTMLInputElement
    expect(title).toBeTruthy()
    expect(title.value).toBe('Problem with Dana Client')
    await unmount()
  })
})

describe('the report submits WITH the record context attached', () => {
  it('POST /api/feedback carries the id-only context', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={SEED} onClose={() => {}} />)
    await typeIn(host.querySelector('textarea')!, 'The address on the invoice is wrong.')
    await click(submitBtn(host))

    const post = calls.find(c => c.url.includes('/api/feedback') && c.method === 'POST' && !c.url.includes('/upload'))
    expect(post).toBeTruthy()
    expect(post!.body.type).toBe('bug')
    expect(post!.body.title).toBe('Problem with Dana Client')
    expect(post!.body.description).toBe('The address on the invoice is wrong.')
    expect(post!.body.context).toEqual(CONTEXT)
    await unmount()
  })

  it('a plain (unseeded) submission sends NO context key', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" onClose={() => {}} />)
    await typeIn(host.querySelector('input[placeholder="Short summary"]')!, 'General idea')
    await typeIn(host.querySelector('textarea')!, 'Would be nice to export a CSV.')
    await click(submitBtn(host))
    const post = calls.find(c => c.url.includes('/api/feedback') && c.method === 'POST' && !c.url.includes('/upload'))
    expect(post).toBeTruthy()
    expect('context' in post!.body).toBe(false)
    await unmount()
  })
})

describe('screenshot slot — attaches in the seeded flow (issue 116)', () => {
  it('a selected image uploads, then rides the report as attachment metadata', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={SEED} onClose={() => {}} />)

    // The attach affordance is present…
    expect(btn(host, '📎 Add file')).toBeTruthy()
    const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()

    // …select a screenshot. defineProperty for files; make value writable so the
    // handler's `e.target.value = ''` (re-pick guard) doesn't throw in happy-dom.
    const file = new File(['x'], 'screenshot.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    Object.defineProperty(fileInput, 'value', { value: '', writable: true, configurable: true })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })) })

    // The chip for the selected file shows before submit.
    expect(host.textContent).toContain('screenshot.png')

    await typeIn(host.querySelector('textarea')!, 'See attached screenshot.')
    await click(submitBtn(host))

    // Upload happened first, then the report carried the uploaded metadata.
    const upload = calls.find(c => c.url.includes('/api/feedback/upload'))
    expect(upload).toBeTruthy()
    const post = calls.find(c => c.url.includes('/api/feedback') && c.method === 'POST' && !c.url.includes('/upload'))
    expect(post!.body.attachments).toHaveLength(1)
    expect(post!.body.attachments[0].name).toBe('screenshot.png')
    await unmount()
  })
})
