// @vitest-environment happy-dom
//
// Send to Jobber → Create a Job: the optional visit time on the form
// (2026-11-14, Kevin's ruling: "add an option to choose a time and make that
// optional, and with a note they can adjust later but won't show on your
// calendar without one").
//   · no time → the POST body is exactly today's (no visit_start/visit_end)
//   · a time  → visit_start (and visit_end when picked) ride the body
//   · the "won't show on your calendar" note can NOT appear once a time is set
//   · a refused visit keeps the modal open, says the job IS in Jobber and the
//     time did not book; Done then closes it with the usual patch
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import SendToJobberModal, { jobScheduleNote, jobDateLabel } from '@/components/hive/SendToJobberModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const person = (over: any = {}) => ({
  id: 'p1', name: 'Sarah Mitchell', outreachTimeline: [], assessment: null, assessmentType: 'in-person',
  addresses: [{ street: '123 Main St', city: 'Denver', state: 'CO' }], jobberClient: null, locationName: 'Denver',
  ...over,
})

let host: HTMLDivElement
let root: Root
let posts: any[] = []
let sendResponse: any
let onDone: any

const mount = async () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(<SendToJobberModal person={person()} onDone={onDone} onClose={() => {}} />) })
}
beforeEach(() => {
  posts = []
  onDone = vi.fn()
  sendResponse = { success: true, match_status: 'matched_existing', jobber_client_id: '555', jobber_job_id: '424242' }
  global.fetch = vi.fn(async (url: any, opts: any = {}) => {
    if (String(url).includes('/send-to-jobber') && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body))
      return { ok: true, status: 200, json: async () => sendResponse } as any
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
  }) as any
})
afterEach(async () => { if (root) await act(async () => root.unmount()); if (host) host.remove(); vi.restoreAllMocks() })

const buttons = () => Array.from(host.querySelectorAll('button'))
const contains = (t: string) => buttons().find(b => (b.textContent || '').includes(t))
const aria = (l: string) => buttons().find(b => b.getAttribute('aria-label') === l)
const setInput = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const setSelect = async (el: HTMLSelectElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })) })
}
const flush = async () => { await act(async () => { await Promise.resolve() }); await act(async () => { await Promise.resolve() }) }
const q = (sel: string) => host.querySelector(sel) as any
const toJobDetails = async () => {
  await mount()
  await act(async () => { aria('Create a Job')!.click() })
  await act(async () => { contains('Continue')!.click() })
  await setInput(q('input[aria-label="Job work description"]'), 'Garage cleanout')
  await setInput(q('input[aria-label="Job price"]'), '450')
}
const sendIt = async () => {
  await act(async () => { contains('Review')!.click() })
  await act(async () => { contains('Send to Jobber')!.click() })
  await flush()
}
const NOTE = "won't show on your Jobber calendar"

describe('no time picked behaves exactly as today', () => {
  it('a date and no time: body is { creation_type, line_items, scheduled_at } and nothing else', async () => {
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    await sendIt()
    expect(posts).toEqual([{ creation_type: 'job_direct', line_items: [{ name: 'Garage cleanout', unitPrice: 450, quantity: 1 }], scheduled_at: '2026-11-20' }])
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('the time pickers only appear once there is a date', async () => {
    await toJobDetails()
    expect(q('select[aria-label="Visit start time"]')).toBeNull()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    expect(q('select[aria-label="Visit start time"]')).toBeTruthy()
  })
})

describe('a time picked rides the send', () => {
  it('start + end → visit_start and visit_end in the location\'s "HH:mm"', async () => {
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    await setSelect(q('select[aria-label="Visit start time"]'), '09:00')
    await setSelect(q('select[aria-label="Visit end time"]'), '12:30')
    await sendIt()
    expect(posts[0]).toEqual({ creation_type: 'job_direct', line_items: [{ name: 'Garage cleanout', unitPrice: 450, quantity: 1 }], scheduled_at: '2026-11-20', visit_start: '09:00', visit_end: '12:30' })
  })

  it('start only → visit_start, no visit_end (Jobber\'s usual length)', async () => {
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    await setSelect(q('select[aria-label="Visit start time"]'), '14:00')
    await sendIt()
    expect(posts[0].visit_start).toBe('14:00')
    expect('visit_end' in posts[0]).toBe(false)
  })

  it('the end list only offers times after the start, and moving the start past the end clears it', async () => {
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    await setSelect(q('select[aria-label="Visit start time"]'), '09:00')
    const ends = Array.from((q('select[aria-label="Visit end time"]') as HTMLSelectElement).options).map(o => o.value).filter(Boolean)
    expect(ends[0]).toBe('09:15')
    expect(ends.every(v => v > '09:00')).toBe(true)
    await setSelect(q('select[aria-label="Visit end time"]'), '10:00')
    await setSelect(q('select[aria-label="Visit start time"]'), '11:00')
    expect((q('select[aria-label="Visit end time"]') as HTMLSelectElement).value).toBe('')
  })

  it('clearing the date clears the time, so a time can never ride without a date', async () => {
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    await setSelect(q('select[aria-label="Visit start time"]'), '09:00')
    await setInput(q('input[aria-label="Job start date"]'), '')
    await sendIt()
    expect(posts[0]).toEqual({ creation_type: 'job_direct', line_items: [{ name: 'Garage cleanout', unitPrice: 450, quantity: 1 }] })
  })
})

describe('the note cannot appear when a time has been set', () => {
  it('on the form: note with no time, gone with a time, back when the time is removed', async () => {
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    expect(host.textContent).toContain(NOTE)
    expect(q('[data-job-schedule-note]').getAttribute('data-job-schedule-note')).toBe('note')
    await setSelect(q('select[aria-label="Visit start time"]'), '09:00')
    expect(host.textContent).not.toContain(NOTE)
    expect(q('[data-job-schedule-note]').getAttribute('data-job-schedule-note')).toBe('booked')
    expect(host.textContent).toContain("Goes on your Jobber calendar November 20, 2026, at 9:00 AM for Jobber's usual visit length (your location's time)")
    await setSelect(q('select[aria-label="Visit start time"]'), '')
    expect(host.textContent).toContain(NOTE)
  })

  it('jobScheduleNote: every input with a start returns the booked line, never the note', () => {
    for (const end of ['', '10:00', '21:00']) {
      const n = jobScheduleNote('2026-11-20', '09:00', end)
      expect(n.kind).toBe('booked')
      expect(n.text).not.toContain(NOTE)
    }
    expect(jobScheduleNote('2026-11-20', '', '').kind).toBe('note')
    expect(jobScheduleNote('', '', '').kind).toBe('note')
  })

  it('the review screen: with a time it names the visit; without, it says not on your calendar yet', async () => {
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    await act(async () => { contains('Review')!.click() })
    expect(host.textContent).toContain('no time, so not on your calendar yet')
    await act(async () => { contains('Back')!.click() })
    await setSelect(q('select[aria-label="Visit start time"]'), '09:00')
    await setSelect(q('select[aria-label="Visit end time"]'), '12:00')
    await act(async () => { contains('Review')!.click() })
    expect(host.textContent).toContain('Visit on your Jobber calendar')
    expect(host.textContent).toContain('November 20, 2026 · 9:00 AM – 12:00 PM')
    expect(host.textContent).not.toContain('not on your calendar')
  })

  it('jobDateLabel reads the calendar day as written (no UTC slip to the 19th)', () => {
    expect(jobDateLabel('2026-11-20')).toBe('November 20, 2026')
  })
})

describe('a refused visit still leaves the job, and says so', () => {
  it('keeps the modal open: the job is in Jobber, the time did not book, Jobber\'s words shown; Done closes with the patch', async () => {
    sendResponse = { ...sendResponse, visit: { booked: false, error: 'startAt needs to be before endAt' } }
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    await setSelect(q('select[aria-label="Visit start time"]'), '09:00')
    await sendIt()
    expect(onDone).not.toHaveBeenCalled()
    const box = q('[data-visit-refused]')
    expect(box).toBeTruthy()
    expect(box.textContent).toContain('The job is in Jobber · JOB-424242')
    expect(box.textContent).toContain("The visit time didn't book")
    expect(box.textContent).toContain('Jobber said: startAt needs to be before endAt')
    await act(async () => { contains('Done')!.click() })
    expect(onDone).toHaveBeenCalledTimes(1)
    const [patch, ids] = onDone.mock.calls[0]
    expect(ids.jobber_job_id).toBe('424242')
    expect(patch.stage).toBe('Job in Progress')
    expect(patch.outreachTimeline.map((e: any) => e.label)).toContain('Visit time not booked — add it in Jobber')
  })

  it('a booked visit closes straight away and logs the visit on the timeline', async () => {
    sendResponse = { ...sendResponse, visit: { booked: true, date: '2026-11-20', start: '09:00', end: '12:00' } }
    await toJobDetails()
    await setInput(q('input[aria-label="Job start date"]'), '2026-11-20')
    await setSelect(q('select[aria-label="Visit start time"]'), '09:00')
    await setSelect(q('select[aria-label="Visit end time"]'), '12:00')
    await sendIt()
    expect(q('[data-visit-refused]')).toBeNull()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][0].outreachTimeline.map((e: any) => e.label)).toContain('Visit booked in Jobber — 2026-11-20, 9:00 AM–12:00 PM')
  })
})
