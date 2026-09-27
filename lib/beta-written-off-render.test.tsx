// @vitest-environment happy-dom
//
// The written-off close ON SCREEN (2026-09-27): the closed-outcome line a
// written-off deal renders says "Written off" with the amount and the
// owner's reason in full — never "Closed lost", never "Closed won" — and the
// owing override's line is untouched beside it.
import { describe, it, expect, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import ClosedSummary from '@/components/hive/shared/ClosedSummary'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
const render = (engagement: any) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(<ClosedSummary engagement={engagement} />) })
  return host
}
afterEach(() => { host?.remove(); host = null })

describe('ClosedSummary — written off is its own verdict', () => {
  it('Erin: "Written off · $7,694 · date", the reason in full, no "lost"', () => {
    const el = render({
      stage: 'Closed Lost', closed_reason: 'written_off', written_off_amount: 7694.29,
      closed_at: '2026-09-27T12:00:00Z', closed_note: 'Four payments of $150, then nothing. Not worth sending to collections.',
    })
    const verdict = el.querySelector('[data-bee-closed-verdict]')!
    expect(verdict.getAttribute('data-bee-closed-verdict')).toBe('written_off')
    expect(el.textContent).toContain('Written off · $7,694')
    expect(el.textContent!.toLowerCase()).not.toContain('closed lost')
    expect(el.textContent!.toLowerCase()).not.toContain('closed won')
    const reason = el.querySelector('[data-bee-written-off-reason]')!
    expect(reason.textContent).toContain('Not worth sending to collections.')
  })

  it('an ordinary Lost still reads "Closed lost"', () => {
    const el = render({ stage: 'Closed Lost', closed_reason: 'No response', closed_at: '2026-09-27T12:00:00Z' })
    expect(el.querySelector('[data-bee-closed-verdict]')!.getAttribute('data-bee-closed-verdict')).toBe('lost')
    expect(el.textContent).toContain('Closed lost')
  })

  it('the owing override still reads "Closed won · balance still showing" — the two never look alike', () => {
    const el = render({ stage: 'Closed Won', closed_reason: 'won_balance_owing', balance_owing: 1743.69, closed_at: '2026-09-24T12:00:00Z', closed_note: 'bad debt' })
    expect(el.querySelector('[data-bee-closed-verdict]')!.getAttribute('data-bee-closed-verdict')).toBe('won')
    expect(el.textContent).toContain('Closed won · balance still showing')
    expect(el.querySelector('[data-bee-over-balance-reason]')).toBeTruthy()
    expect(el.querySelector('[data-bee-written-off-reason]')).toBeFalsy()
  })
})
