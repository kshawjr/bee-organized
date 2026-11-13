// @vitest-environment happy-dom
//
// THE OUTCOME OF A REACH-OUT IS SHOWN WHERE THE REACH-OUT IS SHOWN.
//
// Reported by a Palm Beach owner: he logged a call as "No answer", it saved,
// and Recent activity read "Call · Ankur · 2 hours ago" and nothing else.
// 568 outcomes across 34 locations had been saved since July and none of them
// were on screen.
//
// WHY IT HAPPENED, and what each block below guards:
//
//   1) The picker was added on the belief that the outcome was "already
//      rendered by Timeline". Recent activity is a different component
//      (NotesStream) and it never drew status.            → block A
//   2) Recent activity is fed by two server reads (the client card's and the
//      engagement's) whose column lists predate the picker and never named
//      `status`, so even a list that wanted it had nothing to draw. The form
//      WROTE a column no read asked for.                   → block D
//   3) The Timeline tab did have it, but only inside a row once tapped open,
//      as "Status: no answer".                             → block B
//   4) The company record in Network was handed status and ignored it.
//                                                          → block C
//
// touchpoints.status is NOT only an outcome: drips carry 'sent'/'failed',
// system lines and notes carry 'done'/'pending', and 13 old "Follow-up · …"
// reach-outs carry 'pending'. None of those may be dressed up as the result
// of a call, and the 1,214 reach-outs with no status must read as before.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NotesStream from '@/components/hive/NotesStream'
import NetworkCompanyRecord from '@/components/hive/NetworkCompanyRecord'
import { buildTimelineItems } from '@/components/hive/shared/Timeline'
import { OUTCOMES, outcomeLabel, withOutcome } from '@/components/hive/shared/touchOutcome'
import { OUTCOMES as PICKER_OUTCOMES } from '@/components/hive/TouchpointModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const NOW = Date.now()
const hoursAgo = (n: number) => new Date(NOW - n * 3600000).toISOString()

// The five states, as they are stored. `pending` is the real shape of the 13
// legacy rows: no method, a "Follow-up · …" label.
const ROWS = {
  reached:   { id: 'r1', kind: 'reach_out', method: 'call', label: 'Reach-out', status: 'reached',   notes: null, occurred_at: hoursAgo(1) },
  voicemail: { id: 'r2', kind: 'reach_out', method: 'call', label: 'Reach-out', status: 'voicemail', notes: 'asked her to ring back', occurred_at: hoursAgo(2) },
  no_answer: { id: 'r3', kind: 'reach_out', method: 'call', label: 'Reach-out', status: 'no_answer', notes: null, occurred_at: hoursAgo(3) },
  pending:   { id: 'r4', kind: 'reach_out', method: null,   label: 'Follow-up · say hi', status: 'pending', notes: null, occurred_at: hoursAgo(4) },
  none:      { id: 'r5', kind: 'reach_out', method: 'call', label: 'Reach-out', status: null,        notes: null, occurred_at: hoursAgo(5) },
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('the rule itself (shared/touchOutcome)', () => {
  it('names the three outcomes and nothing else', () => {
    expect(outcomeLabel(ROWS.reached)).toBe('Reached')
    expect(outcomeLabel(ROWS.voicemail)).toBe('Left voicemail')
    expect(outcomeLabel(ROWS.no_answer)).toBe('No answer')
    expect(outcomeLabel(ROWS.pending)).toBeNull()
    expect(outcomeLabel(ROWS.none)).toBeNull()
    expect(outcomeLabel({ kind: 'reach_out', status: '' })).toBeNull()
    expect(outcomeLabel(null)).toBeNull()
  })

  it('never reads another kind\'s status as a call outcome', () => {
    expect(outcomeLabel({ kind: 'drip', status: 'sent' })).toBeNull()
    expect(outcomeLabel({ kind: 'drip', status: 'failed' })).toBeNull()
    expect(outcomeLabel({ kind: 'system', status: 'done' })).toBeNull()
    expect(outcomeLabel({ kind: 'note', status: 'done' })).toBeNull()
    // Even one of the three words, on a row that is not a reach-out.
    expect(outcomeLabel({ kind: 'system', status: 'reached' })).toBeNull()
  })

  it('joins a headline and its outcome one way', () => {
    expect(withOutcome('Call', ROWS.no_answer)).toBe('Call · No answer')
    expect(withOutcome('Call', ROWS.none)).toBe('Call')
  })

  it('the picker offers exactly the words the lists can show', () => {
    // One list, imported by the picker — a fourth outcome added to the form
    // cannot be one the screens do not know.
    expect(PICKER_OUTCOMES).toBe(OUTCOMES)
    for (const o of OUTCOMES) expect(outcomeLabel({ kind: 'reach_out', status: o.value })).toBe(o.label)
  })
})

describe('A) Recent activity (NotesStream — the client card and the engagement)', () => {
  const mount = (rows: any[]) => {
    const items = rows.map(r => ({ t: 'touch', ts: r.occurred_at, user_label: 'Ankur Patel', ...r }))
    act(() => root.render(<NotesStream label="Recent activity" items={items} onPost={() => {}} nowMs={NOW} />))
    return Array.from(host.querySelectorAll('p')).map(p => p.textContent || '').filter(t => t.includes('Ankur Patel'))
  }

  it('shows each outcome beside the method, and reads cleanly without one', () => {
    const lines = mount([ROWS.reached, ROWS.voicemail, ROWS.no_answer, ROWS.pending, ROWS.none])
    expect(lines).toHaveLength(5)
    expect(lines[0]).toMatch(/^Call · Reached\s*Ankur Patel · /)
    // Outcome sits between the method and the note.
    expect(lines[1]).toMatch(/^Call · Left voicemail — asked her to ring back\s*Ankur Patel · /)
    expect(lines[2]).toMatch(/^Call · No answer\s*Ankur Patel · /)
    // Legacy follow-up: its own words, no invented outcome, no raw 'pending'.
    expect(lines[3]).toMatch(/^Follow-up · say hi\s*Ankur Patel · /)
    expect(lines[3]).not.toMatch(/pending/i)
    // No status: exactly what it was before this change.
    expect(lines[4]).toMatch(/^Call\s*Ankur Patel · /)
    expect(host.textContent).not.toMatch(/undefined|null|no_answer/)
  })

  it('leaves drip and system lines alone — their status is not an outcome', () => {
    const lines = mount([
      { id: 'd1', kind: 'drip', method: 'email', label: 'Thank you for reaching out!', status: 'sent', notes: null, occurred_at: hoursAgo(1) },
      { id: 's1', kind: 'system', method: 'system', label: 'Client created', status: 'done', notes: null, occurred_at: hoursAgo(2) },
    ])
    expect(lines[0]).toMatch(/^Thank you for reaching out!\s*Ankur Patel/)
    expect(lines[1]).toMatch(/^Client created\s*Ankur Patel/)
    expect(host.textContent).not.toMatch(/sent|done/)
  })
})

describe('B) Timeline tab (client card, engagement, Network person)', () => {
  const past = (rows: any[]) => buildTimelineItems({ touchpoints: rows }, { items: [] }, { nowMs: NOW }).past

  it('puts the outcome on the row itself, not only inside the opened detail', () => {
    const items = past([ROWS.reached, ROWS.voicemail, ROWS.no_answer, ROWS.pending, ROWS.none])
    expect(items.map((i: any) => i.summary)).toEqual([
      'Call · Reached', 'Call · Left voicemail', 'Call · No answer', 'Follow-up · say hi', 'Call',
    ])
  })

  it('opened detail says "Outcome: No answer" once, in the picker\'s words', () => {
    const [it0] = past([ROWS.no_answer])
    expect(it0.detail.outcome).toBe('No answer')
    // Not also the raw "Status: no answer" line underneath.
    expect(it0.detail.status).toBeNull()
  })

  it('a reach-out with no status carries neither line', () => {
    const [it0] = past([ROWS.none])
    expect(it0.detail.outcome).toBeNull()
    expect(it0.detail.status).toBeNull()
  })

  it('a status that is not an outcome keeps the raw Status line it always had', () => {
    const [legacy] = past([ROWS.pending])
    expect(legacy.detail.outcome).toBeNull()
    expect(legacy.detail.status).toBe('pending')
    const [drip] = past([{ id: 'd1', kind: 'drip', method: 'email', label: 'Welcome', status: 'failed', occurred_at: hoursAgo(1) }])
    expect(drip.summary).toBe('Welcome')
    expect(drip.detail.status).toBe('failed')
  })

  it('the detail panel draws the Outcome line', () => {
    const src = readFileSync('components/hive/shared/Timeline.jsx', 'utf8')
    expect(src).toMatch(/d\.outcome && <DetailLine>Outcome: \{d\.outcome\}<\/DetailLine>/)
  })
})

describe('C) Network › company record ("Touchpoints · everyone here")', () => {
  it('shows the outcome beside the method, and nothing extra without one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url)
      const body = u.includes('/touchpoints')
        ? { touchpoints: [
            { id: 't1', partner_id: 'p1', partner_name: 'Karen Martinez', kind: 'reach_out', method: 'call', label: 'Reach-out', status: 'voicemail', notes: null, occurred_at: hoursAgo(5) },
            { id: 't2', partner_id: 'p1', partner_name: 'Karen Martinez', kind: 'reach_out', method: 'coffee', label: 'Reach-out', status: null, notes: null, occurred_at: hoursAgo(50) },
          ] }
        : { company: {}, referred: [], totals: { count: 0, converted: 0, revenue: 0 }, total: 0, people: [] }
      return { ok: true, status: 200, json: async () => body }
    }))
    const company = { id: 'co1', name: 'Meridian Realty', industry: 'Real Estate', locationId: 'loc-1', addresses: [], isDeleted: false }
    const partners = [{ id: 'p1', name: 'Karen Martinez', companyId: 'co1', title: 'Agent', stage: 'Active Partner', tags: [], lastContactedAt: hoursAgo(5), isDeleted: false }]
    await act(async () => {
      root.render(<NetworkCompanyRecord company={company} partners={partners} onClose={() => {}} />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const block = host.querySelector('[data-testid="company-touchpoints"]')!
    const rows = Array.from(block.querySelectorAll('div > div')).map(d => d.textContent || '').filter(t => t.includes('with Karen'))
    expect(rows.some(t => t.startsWith('Call · Left voicemailwith Karen Martinez'))).toBe(true)
    expect(rows.some(t => t.startsWith('Coffeewith Karen Martinez'))).toBe(true)
  })
})

describe('D) every server read that feeds a touchpoint list asks for the outcome', () => {
  // The original fault: a column list written before the picker existed.
  // Any route that reads touchpoints with a NAMED column list including
  // `method` is reading them to show them, and must name `status` too.
  // (select('*') and id-only bookkeeping reads are not caught, by design.)
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : []
  })

  it('no display read names method without status', () => {
    const offenders: string[] = []
    let seen = 0
    for (const file of [...walk('app/api'), ...walk('lib')]) {
      const src = readFileSync(file, 'utf8')
      const re = /from\('touchpoints'\)\s*\.select\('([^']*)'/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const cols = m[1].split(',').map(c => c.trim())
        if (!cols.includes('method')) continue
        seen++
        if (!cols.includes('status')) offenders.push(`${file}: select('${m[1]}')`)
      }
    }
    expect(offenders).toEqual([])
    // The scan must actually be finding the reads, or it proves nothing.
    expect(seen).toBeGreaterThanOrEqual(5)
  })

  it('the two reads behind Recent activity, by name', () => {
    expect(readFileSync('app/api/clients/[id]/profile/route.ts', 'utf8'))
      .toContain("from('touchpoints').select('id, kind, method, label, status, notes, occurred_at, engagement_id, user_id')")
    expect(readFileSync('app/api/engagements/[id]/route.ts', 'utf8'))
      .toContain("from('touchpoints').select('id, kind, method, label, status, notes, occurred_at, user_id')")
  })
})
