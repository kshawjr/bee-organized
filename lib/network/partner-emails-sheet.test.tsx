// @vitest-environment happy-dom
//
// Partner emails, slice 5 (2026-11-23): the PARTNER EMAILS part of a
// contact sheet (components/network/PartnerEmails.jsx), driven in a real
// React tree with a recording fake fetch. What is checked is what the owner
// sees and what is sent: a sequence KEY (never an id), the yes before
// anything, a quiet line (not a dead button) when the partner cannot be
// emailed, and "from the beginning" in the confirmation.
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import PartnerEmails, { progressWords, cannotStartWords } from '@/components/network/PartnerEmails'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ID = '11111111-2222-4333-8444-555555555555'
const SEQS = [
  { pathKey: 'partner-introduction', name: 'Partner introduction', description: 'd1', available: true, why: null, copy: 'master',
    emails: [{ order: 1, when: 'Right away', subject: 'Great to meet you' }, { order: 2, when: '3 months later', subject: 'Thinking of you and your clients' }] },
  { pathKey: 'partner-power-introduction', name: 'Power Partner introduction', description: 'd2', available: true, why: null, copy: 'master',
    emails: [{ order: 1, when: 'Right away', subject: 'Great to meet you' }] },
]
const ACTIVE = { pathKey: 'partner-introduction', name: 'Partner introduction', status: 'active', step: 2, total: 2, sent: 1, nextSendAt: '2027-02-21T15:00:00Z' }
const view = (o: any = {}) => ({ canReceive: true, blockReason: null, locationActive: true, sequences: SEQS, progress: [], ...o })

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string; body: any }[] = []
const mount = async (v: any, answers: Record<string, any> = {}) => {
  calls = []
  let current = v
  const f = vi.fn(async (url: string, init?: any) => {
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url, method, body })
    if (method !== 'GET') {
      const a = answers[method] || { status: 200, json: { started: true, firstEmail: { sent: true } }, next: view({ progress: [ACTIVE] }) }
      if (a.status === 200 && a.next) current = a.next
      return { ok: a.status === 200, status: a.status, json: async () => a.json }
    }
    return { ok: true, status: 200, json: async () => current }
  })
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(React.createElement(PartnerEmails as any, { contactId: ID, name: 'Taylor Capen', first: 'Taylor', fetchImpl: f })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const $ = (s: string) => document.querySelector(s) as HTMLElement | null
const click = async (el: HTMLElement | null) => { if (!el) throw new Error('missing element'); await act(async () => { el.click() }); await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = '' })

describe('start: pick, see the emails and timing, confirm — then and only then one request', () => {
  it('the whole flow sends the sequence key and the yes, nothing else', async () => {
    await mount(view())
    expect($('[data-start-workflow]')?.textContent).toBe('Start email workflow')
    await click($('[data-start-workflow]'))
    const picker = $('[data-sequence-picker]')!
    expect(picker.textContent).toContain('Email Campaign')
    expect($('[data-picker-emails]')?.textContent).toContain('Right away, when you startGreat to meet you3 months laterThinking of you and your clients')
    await click($('[data-picker-continue]'))
    const confirm = $('[data-start-confirm]')!
    expect(confirm.textContent).toContain('Start email workflow?')
    expect(confirm.textContent).toContain('starts it from the beginning')
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]) // nothing sent before the yes
    await click($('[data-confirm-start]'))
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      { url: `/api/network/contacts/${ID}/sequences`, method: 'POST', body: { pathKey: 'partner-introduction', confirmed: true } },
    ])
    expect($('[data-progress="partner-introduction"]')?.textContent).toContain('Email 2 of 2 is next')
  })
  it('Cancel in the picker or the confirmation sends nothing', async () => {
    await mount(view())
    await click($('[data-start-workflow]')); await click($('[data-picker-cancel]'))
    await click($('[data-start-workflow]')); await click($('[data-picker-continue]')); await click($('[data-confirm-cancel]'))
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
  it('a finished or stopped one: the confirmation says the first email goes again', async () => {
    await mount(view({ progress: [{ ...ACTIVE, status: 'stopped', stoppedAt: '2026-11-23T16:00:00Z', stoppedReason: 'owner_stopped' }] }))
    await click($('[data-start-workflow]')); await click($('[data-picker-continue]'))
    expect($('[data-confirm-restart]')?.textContent).toBe('Taylor Capen was on this workflow before. Starting it again sends the first email again.')
  })
  it('a refusal from the server is said plainly, and nothing is shown as started', async () => {
    await mount(view(), { POST: { status: 409, json: { error: 'already_on_sequence' } } })
    await click($('[data-start-workflow]')); await click($('[data-picker-continue]')); await click($('[data-confirm-start]'))
    expect($('[data-start-error]')?.textContent).toBe('They’re already on this workflow. Nothing was changed.')
    expect($('[data-progress]')).toBeNull()
  })
  it('a sequence the partner is on now cannot be picked again', async () => {
    await mount(view({ progress: [ACTIVE] }))
    expect($('[data-start-workflow]')?.textContent).toBe('Start another email workflow')
    await click($('[data-start-workflow]'))
    expect(($('[data-sequence-choice="partner-introduction"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('on a sequence: which one, how far, and Stop', () => {
  it('shows step X of Y, and Stop asks first, then sends the key', async () => {
    await mount(view({ progress: [ACTIVE] }), { DELETE: { status: 200, json: { stopped: true }, next: view({ progress: [{ ...ACTIVE, status: 'stopped', stoppedAt: '2026-11-23T16:00:00Z', stoppedReason: 'owner_stopped' }] }) } })
    expect($('[data-progress-words]')?.textContent).toBe('Email 2 of 2 is next · goes Feb 21, 2027. 1 of 2 sent so far.')
    await click($('[data-stop]'))
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    await click($('[data-confirm-yes]'))
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([{ url: `/api/network/contacts/${ID}/sequences`, method: 'DELETE', body: { pathKey: 'partner-introduction', confirmed: true } }])
    expect($('[data-progress]')?.getAttribute('data-status')).toBe('stopped')
    expect($('[data-stop]')).toBeNull()
  })
})

describe('cannot be emailed: a quiet line, never a dead button', () => {
  for (const [reason, words] of [
    ['no_email', 'Add an email address for Taylor to start partner emails.'],
    ['unsubscribed', 'Taylor unsubscribed from partner emails, so none can be started.'],
    ['address_unsubscribed', 'Taylor unsubscribed from partner emails, so none can be started.'],
  ]) {
    it(reason, async () => {
      await mount(view({ canReceive: false, blockReason: reason }))
      expect($('[data-start-workflow]')).toBeNull()
      expect($('[data-cannot-start]')?.textContent).toBe(words)
      expect(document.querySelectorAll('button[disabled]').length).toBe(0)
    })
  }
  it('a location not active on Bee Hub', async () => {
    await mount(view({ locationActive: false }))
    expect($('[data-start-workflow]')).toBeNull()
    expect($('[data-cannot-start="location"]')).not.toBeNull()
  })
})

describe('the words', () => {
  it('progress', () => {
    expect(progressWords({ ...ACTIVE, step: 1, sent: 0 })).toBe('Email 1 of 2 is next · goes Feb 21, 2027. 0 of 2 sent so far.')
    expect(progressWords({ ...ACTIVE, status: 'completed', completedAt: '2027-02-21T15:30:00Z', sent: 2 })).toBe('Finished Feb 21, 2027 · all 2 sent.')
    expect(progressWords({ ...ACTIVE, status: 'stopped', stoppedReason: 'invalid_recipient', stoppedAt: null })).toBe('Stopped: the email address bounced · 1 of 2 sent.')
  })
  it('a failed check is not worded as "no address"', () => {
    expect(cannotStartWords({ canReceive: false, blockReason: 'check_failed', locationActive: true }, 'Taylor')).toMatch(/couldn’t check/)
  })
})

describe('the Emails screen rows at phone width (both groups use the one EmailRow)', () => {
  it('the Read / Edit / Pause / Remove group may not be wider than its card, so it wraps inside it', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('components/BeeHub.jsx', 'utf8')
    const row = src.slice(src.indexOf('function EmailRow('), src.indexOf('export const partwayWho'))
    const group = /<div style=\{\{([^}]*)\}\}>\s*<EBtn size="sm" onClick=\{onRead\}>Read<\/EBtn>/.exec(row)
    expect(group?.[1]).toContain("flexWrap:'wrap'")
    expect(group?.[1]).toContain("maxWidth:'100%'")
  })
})
