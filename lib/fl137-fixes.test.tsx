// @vitest-environment happy-dom
// FL-137/135, the fixes from Kevin's live test (2026-11-28):
//   fix 2 — a refused Mailchimp send is a centre dialog that stays until the
//           owner dismisses it, says what DID happen, which journey, what to do;
//   fix 3 — after an Add, the Nurturing list and its tab count update with no
//           page refresh (each asks the server to read afresh).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'
import { showMailchimpRefused, isMailchimpRefusal, refusalWords } from '@/components/hive/shared/MailchimpRefusedDialog'
import CloseLostWizardJs from '@/components/hive/shared/CloseLostWizard'
import NetworkTabsJs from '@/components/network/NetworkTabs'
import { loadNurturingList } from '@/lib/network/nurturing-read'

const CloseLostWizard = CloseLostWizardJs as unknown as React.FC<any>
const NetworkTabs = NetworkTabsJs as unknown as React.FC<any>
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const TEST_LOC = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
const LIVE = { sent: false, outcome: 'signup_flows_live', words: 'Not sent to Mailchimp: a welcome journey is switched on in Mailchimp, and it would email them. Pause it first.', flows: ['Welcome new subscribers'] }

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, done: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
const dialog = () => document.querySelector('[data-mailchimp-refused]')
const gotIt = () => document.querySelector('[data-act="got-it"]')!
beforeEach(() => { document.body.innerHTML = '' })

describe('fix 2: the refusal is a centre dialog that stays until dismissed', () => {
  it('opens only for a refusal — never for sent, already there, or Mailchimp not open here', () => {
    expect(isMailchimpRefusal(LIVE)).toBe(true)
    for (const outcome of ['added', 'already_there', 'not_open']) expect(isMailchimpRefusal({ sent: outcome === 'added', outcome, words: '' })).toBe(false)
    expect(isMailchimpRefusal(null)).toBe(false)
  })
  it('says what DID happen, that they were not sent, which journey, and what to do', () => {
    const w = refusalWords({ name: 'Sophie Stephens', did: 'is in Nurturing', result: LIVE })
    expect(w.did).toBe('Sophie Stephens is in Nurturing.')
    expect(w.notSent).toBe('Sophie Stephens was not sent to Mailchimp.')
    expect(w.why).toContain('“Welcome new subscribers”')
    expect(w.todo).toContain('pause that journey in Mailchimp')
  })
  it('stays on screen — a minute later it is still there — and only "Got it" closes it', async () => {
    vi.useFakeTimers()
    await act(async () => { showMailchimpRefused({ name: 'Sophie Stephens', did: 'is in Nurturing', result: LIVE }) })
    expect(dialog()).not.toBeNull()
    expect(dialog()!.getAttribute('role')).toBe('alertdialog')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(dialog()).not.toBeNull()
    // a tap on the dimmed background does not close it
    await click(dialog()!)
    expect(dialog()).not.toBeNull()
    await click(gotIt())
    expect(dialog()).toBeNull()
    vi.useRealTimers()
  })
  it('the Lost wizard opens it after the close saves — and it outlives the wizard', async () => {
    ;(globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'e1', stage: 'Closed Lost', nurture: { nurture: 'in', mailchimp: 'in', saved: true, name: 'Sophie Stephens', mailchimpResult: LIVE } }) })
    let closed = false
    const w = await mount(<CloseLostWizard engagementId="e1" leadId="L1" locationUuid={TEST_LOC} reasons={['Price too high']} onClosed={() => { closed = true }} />)
    const btn = (t: string) => Array.from(w.host.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === t)!
    await click(w.host.querySelector('[data-testid="nurture-box"] input')!)
    await click(btn('Next')); await click(btn('Close as lost'))
    expect(closed).toBe(true)
    await w.done() // the wizard is gone…
    expect(dialog()).not.toBeNull() // …the dialog is not
    expect(dialog()!.textContent).toContain('Sophie Stephens is in Nurturing.')
    expect(dialog()!.textContent).toContain('Welcome new subscribers')
  })
  it('no toast carries the refusal any more, and every screen that asks for a send opens the dialog', () => {
    expect(readFileSync('components/hive/shared/CloseLostWizard.jsx', 'utf8')).not.toContain('mcWords')
    for (const f of ['components/hive/shared/CloseLostWizard.jsx', 'components/hive/shared/CloseEngagementConfirm.jsx', 'components/hive/shared/WriteOffWizard.jsx']) {
      expect(readFileSync(f, 'utf8'), f).toContain('afterCloseMailchimp(j, showMailchimpRefused)')
    }
    expect(readFileSync('components/hive/SendToJobberModal.jsx', 'utf8')).toContain("showMailchimpRefused({ name: person.name, did: 'was sent to Jobber', result })")
    expect(readFileSync('components/network/NurtureAddDialog.jsx', 'utf8')).toContain("did: 'was added to Nurturing', result: json?.mailchimp })")
  })
})

describe('fix 3: after an Add, the list and its count update with no page refresh', () => {
  it('the screen asks for both afresh once, and shows the new person and the new count', async () => {
    const asked: string[] = []
    let added = false
    const row = (id: string, name: string) => ({ id, name, email: `${id}@example.com`, phone: null, city: null, zip: null, createdAt: '2026-11-28T10:00:00Z', needsContactInfo: false, lastActivity: null, noMarketing: false })
    ;(globalThis as any).fetch = async (url: string) => {
      const u = String(url); asked.push(u)
      const j = (b: any, s = 200) => ({ ok: s < 400, status: s, json: async () => b })
      if (u.startsWith('/api/network/counts')) return j({ network: 0, nurturing: added ? 2 : 1 })
      if (u.startsWith('/api/network/nurturing/add')) { added = true; return j({ ok: true, id: 'p2' }, 201) }
      if (u.startsWith('/api/network/nurturing')) {
        // the server's one-minute copy: only a fresh read knows about the Add
        const rows = added && u.includes('fresh=1') ? [row('p1', 'Pat Lee'), row('p2', 'Morgan Ellis')] : [row('p1', 'Pat Lee')]
        return j({ location: { id: TEST_LOC, name: 'Test Location' }, quietDays: 90, excluded: false, counts: { nurturing: rows.length, needsContactInfo: 0, hadQuoteOrAssessment: 0 }, total: rows.length, page: 0, size: 25, sort: 'az', rows, tags: [] })
      }
      return j({})
    }
    const t = await mount(<NetworkTabs locationId={TEST_LOC} locationName="Test Location" startOnNurturing />)
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(t.host.textContent).not.toContain('Morgan Ellis')
    expect(t.host.querySelector('[data-tab-count="nurture"]')!.textContent).toBe('(1)')
    asked.length = 0
    await click(t.host.querySelector('[data-act="nurture-add"]')!)
    const set = (sel: string, v: string) => act(async () => {
      const el = document.querySelector(sel) as HTMLInputElement
      Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await set('[data-field="first"]', 'Morgan'); await set('[data-field="email"]', 'morgan@example.com')
    await click(document.querySelector('[data-act="add"]')!)
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(t.host.textContent).toContain('Morgan Ellis')
    expect(t.host.querySelector('[data-tab-count="nurture"]')!.textContent).toBe('(2)')
    expect(asked.filter((u) => u.startsWith('/api/network/nurturing?')).every((u) => u.includes('fresh=1'))).toBe(true)
    expect(asked.find((u) => u.startsWith('/api/network/counts'))).toContain('fresh=1')
    // …and only that once: the next page turn uses the copy again.
    await t.done()
  })
  it('the server: fresh reads afresh and keeps the new answer; without it the minute-old copy is used', async () => {
    let reads = 0
    const db: any = { from: (table: string) => {
      const q: any = { select: () => q, eq: () => q, is: () => q, not: () => q, lt: () => q, order: () => q, maybeSingle: async () => ({ data: null, error: null }),
        range: async () => { if (table === 'leads') reads++; return { data: [], error: null } },
        then: (ok: any) => Promise.resolve({ count: 0, data: [], error: null }).then(ok) }
      return q
    } }
    const loc = { id: 'loc-fresh-test', slug: 'loc_fresh', name: 'X' }
    await loadNurturingList(db, loc); const a = reads
    await loadNurturingList(db, loc); expect(reads).toBe(a) // the copy
    await loadNurturingList(db, loc, { refresh: true }); expect(reads).toBeGreaterThan(a) // afresh
    const b = reads
    await loadNurturingList(db, loc); expect(reads).toBe(b) // and the fresh answer is the new copy
  })
  it('both routes pass fresh=1 through', () => {
    expect(readFileSync('app/api/network/nurturing/route.ts', 'utf8')).toContain("loadNurturingList(supabaseService, loc, { refresh: p.get('fresh') === '1' })")
    expect(readFileSync('app/api/network/counts/route.ts', 'utf8')).toContain("{ refresh: request.nextUrl.searchParams.get('fresh') === '1' }")
  })
})
