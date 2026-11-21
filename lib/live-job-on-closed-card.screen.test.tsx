// @vitest-environment happy-dom
//
// Ruling 2 on the screen (Kevin, 2026-11-21): a card a PERSON closed, with a
// live job made in Jobber after that, says "This person has a new job in
// Jobber." on the client page, and the ordinary Reopen beside it is the one
// tap. It is never folded away under "Show more closed". A read-only seat
// sees the note but is offered no Reopen. Real ClientProfile, canned reads.
import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const at = (d: string) => `2026-${d}T14:00:00Z`
const card = (id: string, over: any) => ({ id, title: id, founded_by: 'request', created_at: at('06-01'), total_invoiced: 0, total_paid: 0, balance_owing: 0, quotes: [], jobs: [], invoices: [], assessments: [], ...over })
const profile = (flag: boolean) => ({
  client: { id: 'lead-9', name: 'Anna Client', email: 'a@x.com', phone: '(303) 555-0100', created_at: at('05-01'), location_uuid: 'loc-1', paid_amount: 0 },
  referred_us: [], contacts: [], touchpoints: [], buzz_notes: [], job_notes: [],
  engagements: [
    card('Newest closed', { stage: 'Closed Lost', closed_reason: 'Price too high', closed_at: at('11-01'), created_at: at('10-01') }),
    card('Second closed', { stage: 'Closed Won', closed_reason: 'won', closed_at: at('10-20'), created_at: at('09-01') }),
    card('Garage', { stage: 'Closed Lost', closed_reason: 'No response', closed_at: at('09-28'), created_at: at('08-01'), ...(flag ? { new_job_in_jobber: true } : {}) }),
  ],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 3 },
})

let posted: string[] = []
function install(flag: boolean) {
  posted = []
  ;(globalThis as any).fetch = async (url: any, init: any = {}) => {
    const u = String(url)
    if ((init.method || 'GET') === 'POST') { posted.push(u); return { ok: true, status: 200, json: async () => ({ stage: 'Job in Progress' }) } }
    if (u.includes('/profile')) return { ok: true, status: 200, json: async () => profile(flag) }
    if (u.includes('/api/partners')) return { ok: true, status: 200, json: async () => [] }
    return { ok: true, status: 200, json: async () => ({}) }
  }
}
const mount = async (props: any = {}) => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<ClientProfile clientId="lead-9" onClose={() => {}} {...props} />) })
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const noteRow = (host: Element) => host.querySelector('[data-new-job-note]')?.parentElement as HTMLElement | null

afterEach(() => { document.body.innerHTML = '' })

describe('the note on the client page', () => {
  it('shows on the flagged card even though it is the third closed card (not folded away), full strength, with Reopen beside it', async () => {
    install(true)
    const { host, unmount } = await mount()
    const note = host.querySelector('[data-new-job-note]')!
    expect(note.textContent).toBe('This person has a new job in Jobber. Reopen the card if they are back.')
    const row = noteRow(host)!
    expect(row.textContent).toContain('Garage')
    expect(row.style.opacity).toBe('1')
    expect(host.textContent).not.toContain('more closed') // nothing is left folded, so no button that would show nothing
    const reopen = Array.from(row.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Reopen')!
    await act(async () => { reopen.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(posted).toEqual(['/api/engagements/Garage/reopen'])
    await unmount()
  })
  it('a read-only seat sees the note and no way to reopen', async () => {
    install(true)
    const { host, unmount } = await mount({ readOnly: true })
    expect(host.querySelector('[data-new-job-note]')!.textContent).toBe('This person has a new job in Jobber.')
    expect(Array.from(noteRow(host)!.querySelectorAll('button')).map(b => b.textContent?.trim())).not.toContain('Reopen')
    await unmount()
  })
  it('no flag, no note, and the third closed card stays folded as before', async () => {
    install(false)
    const { host, unmount } = await mount()
    expect(host.querySelector('[data-new-job-note]')).toBeNull()
    expect(host.textContent).not.toContain('Garage')
    expect(host.textContent).toContain('Show 1 more closed')
    await unmount()
  })
})
