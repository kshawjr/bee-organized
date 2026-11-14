// @vitest-environment happy-dom
//
// TWO OPEN CARDS FOR ONE CLIENT — the card's half (2026-11-13).
// The rule, the server refusals and the self-close are pinned in
// lib/beta-twin-cards.test.ts. This file pins what an owner can SEE and
// REACH on the real engagement card:
//   · a flagged card says so, names where the work is, and links to the other
//   · "Close as duplicate" exists only on the empty card of a pair whose
//     other card has work — not on the card with the work, not when neither
//     has work, never for a read-only viewer; where it is absent there is no
//     button to click and nothing to tab to
//   · one tap posts once, to the one route, with no body
//   · a card with no pair shows nothing
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import EngagementPanel from '@/components/hive/EngagementPanel'
import TwinCardFlag from '@/components/hive/shared/TwinCardFlag'
import { findTwinCard } from '@/components/hive/shared/twinCards'

const Panel: any = EngagementPanel
const Flag: any = TwinCardFlag

const at = (day: string) => `2026-${day}T20:00:00Z`
const CARDS = (workOn: 'newer' | 'neither' | 'both') => [
  { id: 'eng-a', client_id: 'lead-9', title: 'Engagement – Oct 2026', stage: workOn === 'both' ? 'Estimate' : 'Request', founded_by: 'request', location_uuid: 'loc-1', total_invoiced: 0, created_at: at('10-22'), work: workOn === 'both' ? 'quote' : null, first_work_at: workOn === 'both' ? at('10-25') : null },
  { id: 'eng-b', client_id: 'lead-9', title: 'Engagement – Oct 2026', stage: workOn === 'neither' ? 'Request' : 'Estimate', founded_by: 'request', location_uuid: 'loc-1', total_invoiced: 0, created_at: at('10-23'), work: workOn === 'neither' ? null : 'quote', first_work_at: workOn === 'neither' ? null : at('10-24') },
]
const twinFor = (id: string, workOn: 'newer' | 'neither' | 'both' = 'newer') => findTwinCard(CARDS(workOn), id)

// What GET /api/engagements/:id answers for card `id`.
const payload = (id: string, twin: any, over: any = {}) => {
  const me = CARDS('newer').find(c => c.id === id)!
  return {
    engagement: { id, title: me.title, stage: me.stage, founded_by: 'request', created_at: me.created_at, stage_entered_at: me.created_at, location_uuid: 'loc-1', client_id: 'lead-9', project_type: null, description: null, total_invoiced: 0, total_paid: 0, balance_owing: 0, ...over },
    children: {
      service_requests: [{ id: `sr-${id}`, jobber_request_id: id === 'eng-a' ? '6001' : '6002', requested_at: me.created_at, request_url: null }],
      assessments: [], jobs: [], invoices: [], notes: [], touchpoints: [],
      quotes: id === 'eng-b' ? [{ id: 'q1', status: 'sent', total: 900, sent_at: at('10-24') }] : [],
    },
    twin,
    client: {
      id: 'lead-9', name: 'Heather Blue', first_name: 'Heather', last_name: 'Blue', email: 'h@x.com', phone: '(830) 555-0100',
      request_details: null, source: 'Website', referred_by_kind: null, referred_by_id: null, referred_by_name: null,
      buzz: [], lifetime_paid: 0, prior_engagements: 1, other_open: 1,
      engagements: CARDS('newer').map(c => ({ id: c.id, title: c.title, stage: c.stage, created_at: c.created_at, total_invoiced: 0, total_paid: 0 })),
    },
  }
}

const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let calls: { url: string; init: any }[] = []
function installFetch(card: any, close: () => any = () => json({ id: 'eng-a', stage: 'Closed Lost', prev_stage: 'Request', closed_reason: 'duplicate_card', closed_note: "Closed as a duplicate. The quote is on this client's other card, opened Oct 23, 2026.", closed_at: at('11-13'), other: { id: 'eng-b', client_id: 'lead-9', title: 'Engagement – Oct 2026', stage: 'Estimate', created_at: at('10-23') } })) {
  calls = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.endsWith('/close-duplicate')) return close()
    if (/\/api\/engagements\/[^/]+$/.test(u)) return json(card)
    if (u.includes('/api/client-files')) return json({ files: [] })
    return json({})
  })
}
const writes = () => calls.filter(c => c.init?.method && c.init.method !== 'GET')

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = async (el: Element | null | undefined) => {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
  await act(async () => { await Promise.resolve() })
}
const buttonsSaying = (host: Element, re: RegExp) => Array.from(host.querySelectorAll('button')).filter(b => re.test(b.textContent || ''))
const openPanel = (id: string, props: any = {}) =>
  mount(<Panel engagementId={id} onClose={() => {}} lookupOptions={{ sources: [], projectTypes: [], closeLostReasons: [] }} {...props} />)

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('on the real card', () => {
  it('the EMPTY card of a pair: says there are two, says where the quote is, links to it, and offers the close', async () => {
    installFetch(payload('eng-a', twinFor('eng-a')))
    const opened: any[] = []
    const { host, unmount } = await openPanel('eng-a', { onOpenEngagement: (e: any) => opened.push(e) })
    const flag = host.querySelector('[data-twin-flag]')!
    expect(flag.getAttribute('data-twin-flag')).toBe('empty')
    expect(flag.querySelector('[data-twin-headline]')!.textContent).toBe('Two cards are open for Heather.')
    expect(flag.querySelector('[data-twin-body]')!.textContent).toBe('The quote is on the other card, opened Oct 23. This card has no quote, job or invoice on it. If they are the same job, close this one as a duplicate. Nothing changes in Jobber.')
    expect(flag.querySelector('[data-twin-close-duplicate]')!.textContent).toBe('Close as duplicate')
    await click(flag.querySelector('[data-twin-open-other]'))
    expect(opened).toEqual([{ id: 'eng-b', client_id: 'lead-9', title: 'Engagement – Oct 2026', stage: 'Estimate', created_at: at('10-23') }])
    expect(writes()).toEqual([])
    await unmount()
  })

  it('the card WITH the work: says so, links to the empty one, and has no close button at all', async () => {
    installFetch(payload('eng-b', twinFor('eng-b')))
    const { host, unmount } = await openPanel('eng-b', { onOpenEngagement: () => {} })
    const flag = host.querySelector('[data-twin-flag]')!
    expect(flag.getAttribute('data-twin-flag')).toBe('worked')
    expect(flag.querySelector('[data-twin-body]')!.textContent).toBe('This is the card with the quote. The other card, opened Oct 22, has no quote, job or invoice on it. If they are the same job, open that card and close it as a duplicate.')
    expect(flag.querySelector('[data-twin-open-other]')!.getAttribute('data-twin-open-other')).toBe('eng-a')
    expect(host.querySelector('[data-twin-close-duplicate]')).toBeNull()
    expect(buttonsSaying(host, /duplicate/i)).toEqual([])
    await unmount()
  })

  it('work on NEITHER: both flagged, no close button', async () => {
    installFetch(payload('eng-a', twinFor('eng-a', 'neither')))
    const { host, unmount } = await openPanel('eng-a', { onOpenEngagement: () => {} })
    expect(host.querySelector('[data-twin-flag]')!.getAttribute('data-twin-flag')).toBe('neither')
    expect(host.querySelector('[data-twin-body]')!.textContent).toContain('Neither has a quote or a job yet.')
    expect(buttonsSaying(host, /duplicate/i)).toEqual([])
    await unmount()
  })

  it('work on BOTH: the server sends no twin, and the card shows no flag', async () => {
    expect(twinFor('eng-a', 'both')).toBeNull()
    expect(twinFor('eng-b', 'both')).toBeNull()
    installFetch(payload('eng-a', null))
    const { host, unmount } = await openPanel('eng-a', { onOpenEngagement: () => {} })
    expect(host.textContent).toContain('Heather Blue') // the card did render
    expect(host.querySelector('[data-twin-flag]')).toBeNull()
    expect(host.textContent).not.toMatch(/Two cards are open|duplicate/i)
    await unmount()
  })

  it('a single card with no pair: nothing', async () => {
    const p = payload('eng-a', null)
    p.client.engagements = p.client.engagements.slice(0, 1)
    p.client.other_open = 0
    installFetch(p)
    const { host, unmount } = await openPanel('eng-a', { onOpenEngagement: () => {} })
    expect(host.textContent).toContain('Heather Blue')
    expect(host.querySelector('[data-twin-flag]')).toBeNull()
    expect(host.textContent).not.toMatch(/Two cards are open|duplicate/i)
    await unmount()
  })

  it('a card that is already closed shows no flag even if a twin were sent', async () => {
    installFetch(payload('eng-a', twinFor('eng-a'), { stage: 'Closed Lost', closed_reason: 'Price too high', closed_at: at('11-01') }))
    const { host, unmount } = await openPanel('eng-a', { onOpenEngagement: () => {} })
    expect(host.querySelector('[data-twin-flag]')).toBeNull()
    await unmount()
  })

  it('ONE TAP: posts once to the close route with no body, then the card says what happened and links to the work', async () => {
    installFetch(payload('eng-a', twinFor('eng-a')))
    const changed: any[] = []; const toasts: any[] = []; const opened: any[] = []
    const { host, unmount } = await openPanel('eng-a', { onOpenEngagement: (e: any) => opened.push(e), onChanged: (...a: any[]) => changed.push(a), setToast: (t: any) => toasts.push(t) })
    await click(host.querySelector('[data-twin-close-duplicate]'))
    expect(writes()).toEqual([{ url: '/api/engagements/eng-a/close-duplicate', init: { method: 'POST' } }])
    const flag = host.querySelector('[data-twin-flag]')!
    expect(flag.getAttribute('data-twin-flag')).toBe('closed')
    expect(flag.querySelector('[data-twin-closed-line]')!.textContent).toBe("Closed as a duplicate. The quote is on this client's other card, opened Oct 23, 2026.")
    // The tap has no "are you sure", so the card says how to take it back —
    // on the screen only, never in the note the close stored.
    expect(flag.querySelector('[data-twin-reopen-hint]')!.textContent).toBe('If that was wrong, Reopen in the ··· menu brings it back.')
    expect(host.querySelector('[data-twin-close-duplicate]')).toBeNull() // gone: nothing left to tap
    expect(changed).toEqual([['eng-a', { stage: 'Closed Lost', closed_reason: 'duplicate_card', closed_note: "Closed as a duplicate. The quote is on this client's other card, opened Oct 23, 2026.", closed_at: at('11-13') }]])
    expect(toasts).toEqual([{ kind: 'success', msg: 'Closed as a duplicate' }])
    await click(flag.querySelector('[data-twin-open-other]'))
    expect(opened[0].id).toBe('eng-b')
    await unmount()
  })

  it('the server says no: the card stays open, says why, and nothing is shown as closed', async () => {
    installFetch(payload('eng-a', twinFor('eng-a')), () => json({ error: 'card_has_work', message: 'This card has a quote, job or invoice on it, so it is not a duplicate.' }, 409))
    const changed: any[] = []; const toasts: any[] = []
    const { host, unmount } = await openPanel('eng-a', { onChanged: (...a: any[]) => changed.push(a), setToast: (t: any) => toasts.push(t) })
    await click(host.querySelector('[data-twin-close-duplicate]'))
    expect(toasts).toEqual([{ kind: 'error', msg: 'Not closed: This card has a quote, job or invoice on it, so it is not a duplicate.' }])
    expect(changed).toEqual([])
    expect(host.querySelector('[data-twin-flag]')!.getAttribute('data-twin-flag')).toBe('empty')
    await unmount()
  })

  it('READ-ONLY viewer on the empty card: sees the flag and the link, and has no close button', async () => {
    installFetch(payload('eng-a', twinFor('eng-a')))
    const { host, unmount } = await openPanel('eng-a', { readOnly: true, onOpenEngagement: () => {} })
    expect(host.querySelector('[data-twin-flag]')!.getAttribute('data-twin-flag')).toBe('empty')
    expect(host.querySelector('[data-twin-open-other]')).not.toBeNull()
    expect(host.querySelector('[data-twin-close-duplicate]')).toBeNull()
    expect(buttonsSaying(host, /duplicate/i)).toEqual([])
    expect(writes()).toEqual([])
    await unmount()
  })
})

describe('the flag on its own — what can be reached', () => {
  // Everything a keyboard can land on inside the flag.
  const focusable = (host: Element) => Array.from(host.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')).map(e => (e.textContent || '').trim())

  it.each([
    ['the card with the work', twinFor('eng-b'), false],
    ['neither card has work', twinFor('eng-a', 'neither'), false],
    ['the empty card, read-only viewer', twinFor('eng-a'), true],
  ])('%s: the only thing to click or tab to is the link to the other card', async (_label, twin, readOnly) => {
    installFetch({})
    const { host, unmount } = await mount(<Flag twin={twin} firstName="Heather" engagementId="eng-x" readOnly={readOnly} onOpenOther={() => {}} />)
    expect(focusable(host)).toEqual(['Open the other card'])
    expect(host.innerHTML).not.toMatch(/close-duplicate|Close as duplicate/)
    await unmount()
  })

  it('the empty card, writable: two buttons, the link first', async () => {
    installFetch({})
    const { host, unmount } = await mount(<Flag twin={twinFor('eng-a')} firstName="Heather" engagementId="eng-a" onOpenOther={() => {}} />)
    expect(focusable(host)).toEqual(['Open the other card', 'Close as duplicate'])
    await unmount()
  })

  it('with nowhere to open the other card (no link handed in) the words still stand', async () => {
    installFetch({})
    const { host, unmount } = await mount(<Flag twin={twinFor('eng-b')} firstName="Heather" engagementId="eng-b" />)
    expect(host.querySelector('[data-twin-headline]')).not.toBeNull()
    expect(focusable(host)).toEqual([])
    await unmount()
  })

  it('no twin, no flag', async () => {
    const { host, unmount } = await mount(<Flag twin={null} firstName="Heather" engagementId="eng-a" />)
    expect(host.innerHTML).toBe('')
    await unmount()
  })

  it('a double tap posts once', async () => {
    let release: (v: any) => void = () => {}
    installFetch({}, () => new Promise(r => { release = r }))
    const closed: any[] = []
    const { host, unmount } = await mount(<Flag twin={twinFor('eng-a')} firstName="Heather" engagementId="eng-a" onClosed={(j: any) => closed.push(j)} />)
    const btn = host.querySelector('[data-twin-close-duplicate]') as HTMLButtonElement
    await act(async () => { btn.click(); btn.click() })
    expect(writes()).toHaveLength(1)
    expect(btn.disabled).toBe(true)
    await act(async () => { release(json({ id: 'eng-a', stage: 'Closed Lost' })) })
    await act(async () => { await Promise.resolve() })
    expect(closed).toHaveLength(1)
    await unmount()
  })
})

describe('where the close write lives', () => {
  it('the panel never carries its own copy: the post is in TwinCardFlag, the panel only reflects it', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    expect(panel).not.toContain('close-duplicate')
    expect(panel).toContain("import TwinCardFlag from './shared/TwinCardFlag'")
    const flag = readFileSync('components/hive/shared/TwinCardFlag.jsx', 'utf8')
    expect(flag.match(/close-duplicate/g)!.length).toBeGreaterThan(0)
    expect(flag).toContain("{ method: 'POST' }")
  })
  it('the shell hands the card the way to open another card', () => {
    expect(readFileSync('components/hive/HiveShell.jsx', 'utf8')).toContain('onOpenEngagement={openEngagement}')
  })
})
