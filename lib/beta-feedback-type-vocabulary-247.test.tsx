// @vitest-environment happy-dom
//
// issue 247 step 2 — the type vocabulary, and the read sites that used to
// degrade quietly once decision/hazard could exist.
//
// Nine of the ten read sites had an else-branch, which is exactly why this
// needed pinning: an unknown type never threw, it just came out wearing another
// type's word. These cover the three that mattered, plus the composer:
//
//   · the triage type chips RECONCILE with Everything, for the four types and
//     for anything outside them (the "Other" honesty valve)
//   · system health never prints "feature" on a hazard
//   · the composer offers all four and files through POST /api/admin/feedback
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import {
  FEEDBACK_TYPES, INTERNAL_ONLY_TYPES, isKnownFeedbackType, isInternalOnlyType,
  feedbackTypeChipLabel, feedbackTypeChipStyle,
} from '@/lib/feedback-types'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const item = (over: any) => ({
  description: 'body text', status: 'submitted', user_id: 'u1',
  submitter_name: 'Someone', location_id: 'loc-1', location_name: 'Palm Beach',
  created_at: daysAgo(3), updated_at: daysAgo(3), attachments: [], ...over,
})

// Two of each of the four, plus one row carrying a type the UI has never seen —
// the case that makes the chips stop summing if nothing catches it.
const MIXED = [
  item({ id: 'b1', type: 'bug', title: 'bug one' }),
  item({ id: 'b2', type: 'bug', title: 'bug two' }),
  item({ id: 'f1', type: 'feature', title: 'idea one' }),
  item({ id: 'd1', type: 'decision', title: 'decision one' }),
  item({ id: 'd2', type: 'decision', title: 'decision two' }),
  item({ id: 'z1', type: 'hazard', title: 'hazard one' }),
  item({ id: 'x1', type: 'chore', title: 'a type nobody has seen' }),
]

let host: HTMLElement | null = null
let root: any = null

const mount = async (items: any[], props: any = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('transfer-targets')) {
      return { ok: true, status: 200, json: async () => ({ targets: [{ id: 'loc-1', name: 'Palm Beach' }] }) }
    }
    if (init?.method === 'POST') {
      return { ok: true, status: 201, json: async () => ({ id: 'new-1' }) }
    }
    return { ok: true, status: 200, json: async () => ({ items }) }
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={{ id: 'kevin' } as any}>
        <AdminFeedbackScreen onOpenCountChange={() => {}} {...props} />
      </CurrentUserContext.Provider>,
    )
  })
  return host
}

afterEach(() => {
  if (root) act(() => root.unmount())
  if (host) host.remove()
  host = null; root = null
  vi.unstubAllGlobals()
})

// Chip text arrives as "Bugs · 2" — pull the trailing number per label.
const chipCount = (el: HTMLElement, label: string): number | null => {
  const btn = [...el.querySelectorAll('button')].find(b =>
    (b.textContent || '').trim().startsWith(label))
  if (!btn) return null
  const m = (btn.textContent || '').match(/(\d+)\s*$/)
  return m ? Number(m[1]) : null
}

// ═══════════════════════════════════════════════════════════════════
describe('the vocabulary itself', () => {
  it('knows exactly five types, two of them internal-only', () => {
    // 'question' joined as the third owner-fileable value (migrations/
    // feedback_question_answered.sql) — and it is NOT internal-only, which is
    // the pin that matters: the coupling constraint's fail-safe default would
    // have made it internal by accident.
    expect([...FEEDBACK_TYPES]).toEqual(['bug', 'feature', 'question', 'decision', 'hazard'])
    expect([...INTERNAL_ONLY_TYPES]).toEqual(['decision', 'hazard'])
    expect(isInternalOnlyType('decision')).toBe(true)
    expect(isInternalOnlyType('hazard')).toBe(true)
    expect(isInternalOnlyType('bug')).toBe(false)
    expect(isInternalOnlyType('question')).toBe(false)
    expect(isKnownFeedbackType('question')).toBe(true)
    expect(isKnownFeedbackType('chore')).toBe(false)
  })

  it('NEVER labels one type as another — the falsehood the old ternary printed', () => {
    // The bug: `type === 'bug' ? 'bug' : 'feature'` called a hazard a feature.
    expect(feedbackTypeChipLabel('hazard')).not.toBe('feature')
    expect(feedbackTypeChipLabel('decision')).not.toBe('feature')
    expect(feedbackTypeChipLabel('chore')).not.toBe('feature')
    // Each renders its own word, including one the UI has never seen.
    expect(feedbackTypeChipLabel('hazard')).toBe('hazard')
    expect(feedbackTypeChipLabel('decision')).toBe('decision')
    expect(feedbackTypeChipLabel('chore')).toBe('chore')
    // Only a missing value falls back, and to a word that claims nothing.
    expect(feedbackTypeChipLabel('')).toBe('unspecified')
    expect(feedbackTypeChipLabel(null)).toBe('unspecified')
  })

  it('gives an unknown type the neutral family, not another type\'s tone', () => {
    expect(feedbackTypeChipStyle('bug')).toBe('red')
    expect(feedbackTypeChipStyle('feature')).toBe('blue')
    expect(feedbackTypeChipStyle('question')).toBe('teal')
    expect(feedbackTypeChipStyle('decision')).toBe('purple')
    expect(feedbackTypeChipStyle('hazard')).toBe('amber')
    expect(feedbackTypeChipStyle('chore')).toBe('gray')
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('system health never renders a falsehood', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  for (const path of [
    'components/admin/SystemHealthScreen.jsx',
    'components/hive/HomeSystemHealth.jsx',
  ]) {
    it(`${path.split('/').pop()} no longer maps every non-bug to "feature"`, () => {
      const src = read(path)
      // Scoped to the JSX attribute, not the whole file: both files QUOTE the
      // old expression in a comment explaining what was wrong with it, and a
      // bare match would read that as the bug still being present.
      expect(src).not.toMatch(/label=\{[^}]*type === 'bug'/)
      expect(src).not.toMatch(/styleKey=\{[^}]*type === 'bug'/)
      expect(src).toContain('feedbackTypeChipLabel(item.type)')
      expect(src).toContain('feedbackTypeChipStyle(item.type)')
    })
  }
})

// ═══════════════════════════════════════════════════════════════════
describe('the triage type chips reconcile with Everything', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('every type has a chip, and the chips sum to Everything', async () => {
    const el = await mount(MIXED)
    const everything = chipCount(el, 'Everything')
    expect(everything).toBe(7)

    const bugs = chipCount(el, 'Bugs')
    const ideas = chipCount(el, 'Ideas')
    const questions = chipCount(el, 'Questions')
    const decisions = chipCount(el, 'Decisions')
    const hazards = chipCount(el, 'Hazards')
    const other = chipCount(el, 'Other')

    expect([bugs, ideas, questions, decisions, hazards, other]).toEqual([2, 1, 0, 2, 1, 1])
    // THE INVARIANT. Before this, Bugs + Ideas was 3 against Everything's 7 and
    // nothing on screen said where the other four went.
    expect((bugs! + ideas! + questions! + decisions! + hazards! + other!)).toBe(everything)
  })

  it('the internal-only chips stay hidden until such an item exists', async () => {
    const onlyOwnerTypes = [
      item({ id: 'b1', type: 'bug', title: 'bug one' }),
      item({ id: 'f1', type: 'feature', title: 'idea one' }),
    ]
    const el = await mount(onlyOwnerTypes)
    expect(chipCount(el, 'Everything')).toBe(2)
    expect(chipCount(el, 'Decisions')).toBeNull()
    expect(chipCount(el, 'Hazards')).toBeNull()
    expect(chipCount(el, 'Other')).toBeNull()
    // …and the OWNER-fileable chips are always offered — Questions included,
    // at zero, because the chip must exist before the first question arrives —
    // and still reconcile on their own.
    expect(chipCount(el, 'Questions')).toBe(0)
    expect(chipCount(el, 'Bugs')! + chipCount(el, 'Ideas')! + chipCount(el, 'Questions')!).toBe(2)
  })

  it('"Other" appears only when a row carries a type outside the four', async () => {
    const known = FEEDBACK_TYPES.map((t, i) => item({ id: `k${i}`, type: t, title: t }))
    const el = await mount(known)
    expect(chipCount(el, 'Other')).toBeNull()
    expect(
      chipCount(el, 'Bugs')! + chipCount(el, 'Ideas')! + chipCount(el, 'Questions')! +
      chipCount(el, 'Decisions')! + chipCount(el, 'Hazards')!,
    ).toBe(chipCount(el, 'Everything'))
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('the internal composer', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const openComposer = async (el: HTMLElement) => {
    const btn = [...el.querySelectorAll('button')]
      .find(b => (b.textContent || '').includes('File an internal item'))
    expect(btn, 'the composer button should be on the elevated mount').toBeTruthy()
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }

  it('is offered on the ELEVATED mount and not on the franchise one', async () => {
    const elevated = await mount(MIXED)
    expect([...elevated.querySelectorAll('button')].some(b =>
      (b.textContent || '').includes('File an internal item'))).toBe(true)

    if (root) act(() => root.unmount())
    host?.remove()

    // The franchise mount is the one that passes onReportFeedback.
    const franchise = await mount(MIXED, { onReportFeedback: () => {} })
    expect([...franchise.querySelectorAll('button')].some(b =>
      (b.textContent || '').includes('File an internal item'))).toBe(false)
  })

  it('offers all four types, including the two an owner can never file', async () => {
    const el = await mount(MIXED)
    await openComposer(el)
    const labels = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim())
    for (const label of ['Bug', 'Idea', 'Decision', 'Hazard']) {
      expect(labels, `composer should offer ${label}`).toContain(label)
    }
  })

  it('explains what the two new words mean — the hint follows the selection', async () => {
    const el = await mount(MIXED)
    await openComposer(el)
    const pick = async (label: string) => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === label)
      await act(async () => { b!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    }
    // Only the SELECTED type's hint renders — the form asks about one thing.
    expect(document.body.textContent).toContain('Something is broken.')

    await pick('Decision')
    expect(document.body.textContent).toContain('A call waiting on a person')

    await pick('Hazard')
    expect(document.body.textContent).toContain('A known risk that has not gone wrong yet')
  })

  it('states plainly that an owner never sees it', async () => {
    const el = await mount(MIXED)
    await openComposer(el)
    expect(document.body.textContent).toContain('never appears on an owner')
  })

  it('POSTs to the admin route with the chosen type and the location tag', async () => {
    const el = await mount(MIXED)
    await openComposer(el)

    const pick = (label: string) => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === label)
      expect(b, `type button ${label}`).toBeTruthy()
      return b!
    }
    await act(async () => { pick('Hazard').dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const title = document.querySelector('#internal-title') as HTMLInputElement
    const desc = document.querySelector('#internal-desc') as HTMLTextAreaElement
    const loc = document.querySelector('#internal-loc') as HTMLSelectElement
    const set = (node: any, value: string, proto: any) => {
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
      setter.call(node, value)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => {
      set(title, 'past-due touchpoints will burst-email', HTMLInputElement.prototype)
      set(desc, 'the backlog fires on the first nurture run', HTMLTextAreaElement.prototype)
    })
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(loc, 'loc-1')
      loc.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const file = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'File it')
    await act(async () => { file!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const posts = (globalThis.fetch as any).mock.calls.filter((c: any[]) => c[1]?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe('/api/admin/feedback')
    const sent = JSON.parse(posts[0][1].body)
    expect(sent).toMatchObject({
      type: 'hazard',
      title: 'past-due touchpoints will burst-email',
      location_id: 'loc-1',
    })
    // is_internal is the ROUTE's business — the client never sends it, so it
    // cannot be got wrong here.
    expect(sent).not.toHaveProperty('is_internal')
  })
})
