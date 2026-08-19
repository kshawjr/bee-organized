// @vitest-environment node
//
// issue 311 — the checkout wait screen tells the truth.
//
// Ashley at loc_chattanooga paid by ACH on 2026-08-19. Stripe delivered
// checkout.session.completed with payment_status=unpaid — correct for a
// delayed payment method — the webhook rightly declined to activate, and
// StripeCheckoutWait polled every 4s for twenty minutes under copy reading
// "usually within a few seconds. No need to do anything."
//
// This pins the four behaviours the fix rests on:
//   • the poll stops at a deadline rather than re-arming forever
//   • stopping never renders as failure
//   • the delayed-payment case names DAYS, never seconds
//   • a card session is unchanged — it activates in seconds and keeps doing so
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkoutWaitPhase,
  checkoutWaitCopy,
  isPollingPhase,
  showsReopenCheckout,
  SETTLING_AFTER_SECONDS,
  DEADLINE_SECONDS,
  type CheckoutWaitPhase,
} from '@/lib/stripe-wait-phase'

const PHASES: CheckoutWaitPhase[] = ['confirming', 'settling', 'delayed']
const SRC = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

// The component's body, so a match cannot come from some other screen.
const COMPONENT = (() => {
  const i = SRC.indexOf('function StripeCheckoutWait(')
  const j = SRC.indexOf('// ─── ScheduleRemovalModal ───', i)
  expect(i).toBeGreaterThan(-1)
  expect(j).toBeGreaterThan(i)
  return SRC.slice(i, j)
})()

describe('issue 311 — the poll stops at a deadline', () => {
  it('the deadline is a real, finite number of seconds', () => {
    expect(Number.isFinite(DEADLINE_SECONDS)).toBe(true)
    expect(DEADLINE_SECONDS).toBeGreaterThan(SETTLING_AFTER_SECONDS)
  })

  it('every phase up to the deadline is still polling', () => {
    for (let t = 0; t < DEADLINE_SECONDS; t += 1) {
      expect(isPollingPhase(checkoutWaitPhase(t))).toBe(true)
    }
  })

  it('at the deadline, and forever after, it is NOT polling', () => {
    for (const t of [DEADLINE_SECONDS, DEADLINE_SECONDS + 1, 20 * 60, 86_400]) {
      expect(checkoutWaitPhase(t)).toBe('delayed')
      expect(isPollingPhase(checkoutWaitPhase(t))).toBe(false)
    }
  })

  it('the component gates its re-arm on the deadline — the 20-minute spin is gone', () => {
    // The old body re-armed unconditionally: `if (!stopped) pollTimer = setTimeout(poll, 4000)`.
    expect(COMPONENT).toMatch(/if \(!stopped && !pastDeadline\(\)\) pollTimer = setTimeout\(poll, 4000\)/)
    expect(COMPONENT).not.toMatch(/if \(!stopped\) pollTimer = setTimeout\(poll, 4000\)/)
  })

  it('the deadline is measured on the wall clock, not the render-tick state', () => {
    // `elapsed` is captured once by the effect's closure and would freeze at 0,
    // so a state-derived deadline would never fire. Date.now() is the guard.
    expect(COMPONENT).toMatch(/const startedAt = Date\.now\(\)/)
    expect(COMPONENT).toMatch(/DEADLINE_SECONDS/)
  })

  it('the deadline still fires when every poll throws (offline)', () => {
    // pastDeadline() is evaluated on the re-arm path, which is reached from the
    // catch as well as the success path — so a dead network cannot spin forever.
    const reArm = COMPONENT.slice(COMPONENT.indexOf('} catch {}'))
    expect(reArm).toMatch(/pastDeadline\(\)/)
  })
})

describe('issue 311 — stopping never renders as failure', () => {
  // The payment may genuinely still land: the webhook retries for days and an
  // async_payment_succeeded arriving later activates normally (issue 197).
  const FAILURE_WORDS = [
    'failed', 'failure', 'error', 'declined', 'rejected', 'unsuccessful',
    'went wrong', 'problem', 'could not', "couldn't", 'unable', 'expired',
    'cancelled', 'canceled', 'try again',
  ]

  it('the terminal phase carries no failure vocabulary', () => {
    const c = checkoutWaitCopy('delayed')
    const text = `${c.heading} ${c.body} ${c.note ?? ''}`.toLowerCase()
    for (const word of FAILURE_WORDS) {
      expect(text, `terminal copy must not say "${word}"`).not.toContain(word)
    }
  })

  it('no phase claims failure', () => {
    for (const phase of PHASES) {
      const c = checkoutWaitCopy(phase)
      const text = `${c.heading} ${c.body} ${c.note ?? ''}`.toLowerCase()
      for (const word of FAILURE_WORDS) {
        expect(text, `${phase} copy must not say "${word}"`).not.toContain(word)
      }
    }
  })

  it('the terminal phase reassures rather than alarms', () => {
    const c = checkoutWaitCopy('delayed')
    const text = `${c.body} ${c.note ?? ''}`.toLowerCase()
    expect(text).toContain('automatically')
    expect(text).toContain('safe')
  })

  it('it does not offer to reopen checkout once a transfer may be in flight', () => {
    // A second session would be a second $550: the idempotency key buckets at
    // 60s, and the location is not active, so nothing short-circuits it.
    expect(showsReopenCheckout('confirming')).toBe(true)
    expect(showsReopenCheckout('settling')).toBe(false)
    expect(showsReopenCheckout('delayed')).toBe(false)
    expect(COMPONENT).toMatch(/payUrl && showsReopenCheckout\(phase\)/)
  })

  it('Back is still reachable in every phase — the owner is never trapped', () => {
    expect(COMPONENT).toMatch(/onClick=\{onBack\}/)
    // …and it is outside the phase-gated block that hides the reopen link.
    const backIdx = COMPONENT.indexOf('onClick={onBack}')
    const reopenIdx = COMPONENT.indexOf('showsReopenCheckout(phase)')
    expect(backIdx).toBeGreaterThan(reopenIdx)
  })
})

describe('issue 311 — a delayed payment names days, not seconds', () => {
  it('the terminal copy names days', () => {
    const c = checkoutWaitCopy('delayed')
    const text = `${c.body} ${c.note ?? ''}`.toLowerCase()
    expect(text).toMatch(/business days/)
    expect(text).toMatch(/three to five/)
  })

  it('the terminal copy names the payment method in plain words', () => {
    const text = JSON.stringify(checkoutWaitCopy('delayed')).toLowerCase()
    expect(text).toContain('bank transfer')
    expect(text).toContain('ach')
  })

  it('the terminal copy never promises seconds, and never asks her to wait here', () => {
    const c = checkoutWaitCopy('delayed')
    const text = `${c.heading} ${c.body} ${c.note ?? ''}`.toLowerCase()
    expect(text).not.toContain('second')
    expect(text).not.toContain('minute')
    expect(text).toContain('close this page')
  })

  it('it tells her she will be emailed, so the screen is not the channel', () => {
    const c = checkoutWaitCopy('delayed')
    expect(`${c.heading} ${c.body}`.toLowerCase()).toContain('email')
  })

  it('the bank-transfer answer is on screen from the FIRST frame, not only at the deadline', () => {
    // The whole point: an ACH payer should not have to sit through 90s to
    // learn today is not the day.
    const first = checkoutWaitCopy(checkoutWaitPhase(0))
    expect(first.body.toLowerCase()).toContain('bank transfer')
    expect(first.body.toLowerCase()).toContain('days')
  })

  it('the settling phase leads with the transfer story and names days', () => {
    const c = checkoutWaitCopy('settling')
    const text = `${c.body} ${c.note ?? ''}`.toLowerCase()
    expect(text).toContain('bank transfer')
    expect(text).toMatch(/business days/)
  })

  it('"usually within a few seconds" is no longer an unconditional promise', () => {
    // The exact sentence that was wrong. It survives only as a clause about
    // CARDS, never as the whole story.
    expect(COMPONENT).not.toContain('usually within a few seconds. No need to do anything')
    const confirming = checkoutWaitCopy('confirming').body
    expect(confirming).toContain('usually within a few seconds')
    expect(confirming.toLowerCase()).toContain('card payment finishes here')
  })
})

describe('issue 311 — a card session is unchanged', () => {
  it('the first 20 seconds — where every card lands — are the confirming phase', () => {
    for (const t of [0, 1, 3, 7, 19, SETTLING_AFTER_SECONDS - 1]) {
      expect(checkoutWaitPhase(t)).toBe('confirming')
    }
    expect(checkoutWaitPhase(SETTLING_AFTER_SECONDS)).toBe('settling')
  })

  it('the card window is comfortably wider than the first poll at 3s', () => {
    expect(COMPONENT).toMatch(/pollTimer = setTimeout\(poll, 3000\)/)
    expect(SETTLING_AFTER_SECONDS).toBeGreaterThan(3)
  })

  it('the success path is untouched — until() still fires onPaid() and returns', () => {
    expect(COMPONENT).toMatch(/untilRef\.current\(json\)/)
    expect(COMPONENT).toMatch(/onPaidRef\.current\(json\)/)
    // Returning WITHOUT re-arming is what stops the poll on success.
    expect(COMPONENT).toMatch(/onPaidRef\.current\(json\)\s*\n\s*return/)
  })

  it('activation is still detected in the terminal phase if it somehow lands', () => {
    // The deadline stops the POLL, not the component: an in-flight request that
    // resolves after it still fires onPaid.
    const body = COMPONENT.slice(COMPONENT.indexOf('const poll ='))
    const untilIdx = body.indexOf('untilRef.current(json)')
    const deadlineIdx = body.indexOf('pastDeadline()', body.indexOf('} catch {}'))
    expect(untilIdx).toBeLessThan(deadlineIdx)
  })

  it('still polls the same read-only endpoint at the same 4s cadence', () => {
    expect(COMPONENT).toMatch(/\/api\/locations\/\$\{locationId\}\/activation-status/)
    expect(COMPONENT).toMatch(/cache:'no-store'/)
    expect(COMPONENT).toMatch(/setTimeout\(poll, 4000\)/)
  })
})

describe('issue 311 — layout', () => {
  it('controls do not stretch', () => {
    // The column is display:flex/column, whose default align-items:stretch
    // pulled both buttons edge-to-edge.
    expect(COMPONENT).toMatch(/const controlStyle = \{ alignSelf:'center'/)
    // Each <button ...> opening tag — a non-greedy /<button[\s\S]*?>/ would
    // stop at the '>' of an inline arrow function, so slice a window instead.
    const buttons = COMPONENT.split('<button').slice(1).map(c => c.slice(0, 400))
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    for (const b of buttons) expect(b).toContain('...controlStyle')
  })
})

describe('issue 311 — phase helper is total', () => {
  it('degenerate elapsed values start at the beginning, never at the deadline', () => {
    for (const t of [NaN, -1, -0.5]) expect(checkoutWaitPhase(t as number)).toBe('confirming')
  })

  it('every phase has non-empty heading and body', () => {
    for (const phase of PHASES) {
      const c = checkoutWaitCopy(phase)
      expect(c.heading.length).toBeGreaterThan(0)
      expect(c.body.length).toBeGreaterThan(0)
    }
  })

  it('an unknown phase falls back to confirming rather than rendering blank', () => {
    expect(checkoutWaitCopy('nonsense' as CheckoutWaitPhase)).toEqual(checkoutWaitCopy('confirming'))
  })
})
