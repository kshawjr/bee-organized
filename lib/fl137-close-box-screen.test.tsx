// @vitest-environment happy-dom
// FL-137/135 (Kevin, 2026-11-28): the Closed Lost box ON SCREEN, in the real
// wizard. Unticked by default and sent as "no"; ticked is sent as "yes"; no
// box at all on Junk Lead; at Test Location it names Mailchimp, elsewhere not.
import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import CloseLostWizardJs from '@/components/hive/shared/CloseLostWizard'
// An untyped .jsx component: typed loosely at the boundary.
const CloseLostWizard = CloseLostWizardJs as unknown as React.FC<any>

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const TEST_LOC = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
let patches: any[] = []
beforeEach(() => {
  patches = []
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    if (String(url).startsWith('/api/engagements/') && init?.method === 'PATCH') patches.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ id: 'e1', stage: 'Closed Lost' }) }
  }
})
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, done: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
const btn = (host: Element, text: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === text)!
const box = (host: Element) => host.querySelector('[data-testid="nurture-box"]')
const reasons = ['Price too high', 'Junk Lead', 'No response']

async function closeWith(host: Element, reason: string) {
  await click(btn(host, reason))
  await click(btn(host, 'Next'))
  await click(btn(host, 'Close as lost'))
}

describe('the Closed Lost box, on screen', () => {
  it('starts unticked, and closing without touching it sends "no"', async () => {
    const { host, done } = await mount(<CloseLostWizard engagementId="e1" leadId="L1" locationUuid={TEST_LOC} reasons={reasons} />)
    expect((box(host)!.querySelector('input') as HTMLInputElement).checked).toBe(false)
    await closeWith(host, 'Price too high')
    expect(patches).toEqual([{ stage: 'Closed Lost', closed_reason: 'Price too high', nurture: false }])
    await done()
  })
  it('ticked, it sends "yes"', async () => {
    const { host, done } = await mount(<CloseLostWizard engagementId="e1" leadId="L1" locationUuid={TEST_LOC} reasons={reasons} />)
    await click(box(host)!.querySelector('input')!)
    await closeWith(host, 'Price too high')
    expect(patches[0]).toMatchObject({ nurture: true })
    await done()
  })
  it('Junk Lead: no box, and no answer is sent', async () => {
    const { host, done } = await mount(<CloseLostWizard engagementId="e1" leadId="L1" locationUuid={TEST_LOC} reasons={reasons} />)
    await click(btn(host, 'Junk Lead'))
    expect(box(host)).toBeNull()
    await closeWith(host, 'Junk Lead')
    expect(patches).toEqual([{ stage: 'Closed Lost', closed_reason: 'Junk Lead' }])
    await done()
  })
  it('the words: Nurturing and Mailchimp at Test Location; Nurturing only where Mailchimp is coming soon', async () => {
    let m = await mount(<CloseLostWizard engagementId="e1" leadId="L1" locationUuid={TEST_LOC} reasons={reasons} />)
    expect(box(m.host)!.textContent).toContain('Add them to Nurturing and Mailchimp')
    await m.done()
    m = await mount(<CloseLostWizard engagementId="e1" leadId="L1" locationUuid="e7b05e53-7bd7-48de-a13b-10018c8b1b08" reasons={reasons} />)
    expect(box(m.host)!.textContent).toContain('Add them to Nurturing')
    expect(box(m.host)!.textContent).not.toContain('Mailchimp')
    await m.done()
  })
})
