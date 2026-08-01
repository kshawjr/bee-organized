// @vitest-environment happy-dom
//
// issue 162: the admin "Invite Owner" form (InviteOwnerModal) shipped a stale
// prefilled billing note ("Zee Bee Tester — corp-sponsored launch. 2027-03-01
// conversion target.") and the wrong payment-source default (prepaid_corporate)
// into production, plus a prefilled 2027-03-01 paid-through that made brand-new
// franchises look paid up. This mounts the REAL component and asserts the
// corrected defaults so a future edit can't quietly reintroduce either:
//   - payment_source defaults to 'direct'
//   - Paid Through Date is empty
//   - Billing Notes is empty
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// The form only fetches on submit; a benign default keeps any stray call safe.
;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any

import { InviteOwnerModal } from '@/components/BeeHub'

function mount(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

describe('InviteOwnerModal — corrected defaults (issue 162)', () => {
  let view: ReturnType<typeof mount> | null = null

  afterEach(() => { view?.unmount(); view = null })

  function render() {
    view = mount(
      <InviteOwnerModal
        location={{ id: 'loc_test', name: 'Test Location', state: 'CO' }}
        onSuccess={() => {}}
        onClose={() => {}}
      />,
    )
    return view.container
  }

  it("payment_source defaults to 'direct' (not prepaid_corporate)", () => {
    const container = render()
    const buttons = Array.from(container.querySelectorAll('button'))
    // The selected payment-source button is the only one rendering a ✓ marker.
    const selected = buttons.filter(b => b.textContent?.includes('✓'))
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toContain('Direct')
    expect(selected[0].textContent).not.toContain('Prepaid corporate')

    // And the two corporate options are NOT selected.
    const prepaid = buttons.find(b => b.textContent?.includes('Prepaid corporate'))
    const sponsored = buttons.find(b => b.textContent?.includes('Corporate sponsored'))
    expect(prepaid?.textContent).not.toContain('✓')
    expect(sponsored?.textContent).not.toContain('✓')
  })

  it('Paid Through Date is empty by default', () => {
    const container = render()
    const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement | null
    expect(dateInput).not.toBeNull()
    expect(dateInput!.value).toBe('')
  })

  it('Billing Notes is empty by default (no stale prefilled note)', () => {
    const container = render()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    expect(textarea!.value).toBe('')
    // Guard the exact string that shipped, so it can't creep back in verbatim.
    expect(container.textContent).not.toContain('Zee Bee Tester')
    expect(container.textContent).not.toContain('2027-03-01')
  })
})
