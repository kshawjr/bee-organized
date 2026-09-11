// @vitest-environment happy-dom
//
// Inline client-name editing — UI half (shared/NameField, mounted on the
// ClientProfile header and the EngagementPanel masthead). Under test:
//
//   * the pencil exists at all (Linda Dibias couldn't rename a client:
//     the header was plain text)
//   * inline-edit standard composition: EditPencil in view mode, three
//     inputs + ✓/✗ in edit mode, Esc cancels with zero writes
//   * the PATCH carries the THREE PARTS and never the display string
//   * NOT linked to Jobber → the edit still saves and the toast says
//     plainly that it stopped here
//   * linked + synced → the toast says synced
//   * THE HONESTY RULE, BEHAVIOURALLY: linked + REJECTED → the toast is
//     an ERROR toast carrying the failure. This is the assertion that
//     catches the mutation, from the rendered component's actual
//     behaviour rather than from a regex over its source.
//   * a failed save keeps the edit OPEN with the draft intact
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import NameField from '@/components/hive/shared/NameField'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The Lamb record, as it really is in the table — the shape a one-string
// editor would mangle by splitting.
const LAMB = {
  name: 'Jerry & Carri Lamb',
  first_name: 'Jerry & Carri',
  last_name: 'Lamb',
  company: null,
}

// ── DOM helpers (the beta-address-edit idiom) ───────────────────
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const type = (el: Element, value: string) => act(async () => {
  const proto = (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const keyDown = (el: Element, key: string) => act(async () => {
  el.dispatchEvent(new (globalThis as any).window.KeyboardEvent('keydown', { key, bubbles: true }))
})

const q = (host: Element, sel: string) => host.querySelector(sel)!
const input = (host: Element, label: string) =>
  host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
const saveBtn = (host: Element) => q(host, 'button[aria-label="Save"]')

// Response builders — name_writeback is what the route returns.
const respond = (body: any, ok = true) => ({
  ok,
  json: async () => body,
})
const WB_SYNCED = { first_name: 'unchanged', last_name: 'updated', company: 'unchanged' }
const WB_REJECTED = { first_name: 'unchanged', last_name: 'failed', company: 'unchanged' }

let fetchMock: any
let toasts: any[]

function setup(overrides: any = {}) {
  toasts = []
  return {
    leadId: 'lead-1',
    value: LAMB,
    setToast: (t: any) => toasts.push(t),
    onSaved: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  fetchMock = vi.fn()
  ;(globalThis as any).fetch = fetchMock
})
afterEach(() => { vi.restoreAllMocks() })

describe('NameField — the pencil that did not exist', () => {
  it('renders the name with an edit pencil, and opening it shows the THREE parts', async () => {
    const { host, unmount } = await mount(<NameField {...setup()} />)

    expect(host.textContent).toContain('Jerry & Carri Lamb')
    const pencil = q(host, '.bee-edit-pencil')
    expect(pencil).toBeTruthy()

    await click(q(host, '[data-name-row="1"]'))

    // Three fields, prefilled from the stored parts — nothing is split or
    // guessed out of the display string.
    expect(input(host, 'First name').value).toBe('Jerry & Carri')
    expect(input(host, 'Last name').value).toBe('Lamb')
    expect(input(host, 'Company').value).toBe('')
    await unmount()
  })

  it('readOnly hides the pencil and the row does not open', async () => {
    const { host, unmount } = await mount(<NameField {...setup()} readOnly />)
    expect(host.querySelector('.bee-edit-pencil')).toBeNull()
    await click(q(host, '[data-name-row="1"]'))
    expect(host.querySelector('input[aria-label="First name"]')).toBeNull()
    await unmount()
  })

  it('the preview shows what the header will read — the derivation is visible before saving', async () => {
    const { host, unmount } = await mount(<NameField {...setup()} />)
    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'Last name'), 'Lambert')
    expect(q(host, '[data-name-preview="1"]').textContent).toContain('Jerry & Carri Lambert')
    await unmount()
  })

  it('Esc cancels with ZERO writes', async () => {
    const { host, unmount } = await mount(<NameField {...setup()} />)
    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'Last name'), 'Lambert')
    await keyDown(input(host, 'Last name'), 'Escape')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Jerry & Carri Lamb')
    await unmount()
  })

  it('saves the THREE PARTS — never the derived display string', async () => {
    fetchMock.mockResolvedValue(respond({ lead: { name: 'Jerry & Carri Lambert' } }))
    const props = setup({ jobberLinked: false })
    const { host, unmount } = await mount(<NameField {...props} />)

    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'Last name'), 'Lambert')
    await click(saveBtn(host))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/leads/lead-1')
    expect(opts.method).toBe('PATCH')
    const sent = JSON.parse(opts.body)
    expect(sent).toEqual({ first_name: 'Jerry & Carri', last_name: 'Lambert', company: '' })
    expect(sent.name).toBeUndefined() // the route derives it; we never send it
    await unmount()
  })

  it('an unchanged save fires no PATCH at all', async () => {
    const { host, unmount } = await mount(<NameField {...setup()} />)
    await click(q(host, '[data-name-row="1"]'))
    await click(saveBtn(host))
    expect(fetchMock).not.toHaveBeenCalled()
    await unmount()
  })

  it('refuses to empty every part — a client is never renamed to nothing', async () => {
    const { host, unmount } = await mount(<NameField {...setup()} />)
    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'First name'), '')
    await type(input(host, 'Last name'), '')
    await click(saveBtn(host))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(host.textContent).toContain('first name, last name, or company')
    await unmount()
  })

  // ── the reporting, AFTER the fact ───────────────────────────────────────

  it('NOT linked to Jobber: the edit saves anyway and says plainly that it stopped here', async () => {
    // Never block the edit on the absence of a Jobber link. This is Linda's
    // case exactly — a website lead at New with no jobber_client_id.
    fetchMock.mockResolvedValue(respond({ lead: { name: 'Jerry & Carri Lambert' } }))
    const { host, unmount } = await mount(<NameField {...setup()} jobberLinked={false} />)

    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'Last name'), 'Lambert')
    await click(saveBtn(host))

    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('success')
    expect(toasts[0].msg).toContain('isn’t in Jobber yet')
    await unmount()
  })

  it('linked and synced: the toast says synced', async () => {
    fetchMock.mockResolvedValue(respond({ lead: { name: 'Jerry & Carri Lambert' }, name_writeback: WB_SYNCED }))
    const { host, unmount } = await mount(<NameField {...setup()} jobberLinked />)

    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'Last name'), 'Lambert')
    await click(saveBtn(host))

    expect(toasts[0].kind).toBe('success')
    expect(toasts[0].msg).toBe('Name updated · synced to Jobber')
    await unmount()
  })

  // ── THE ONE THAT MATTERS ────────────────────────────────────────────────
  // IF BEE HUB SAVES BUT JOBBER REJECTS IT, SAY SO. A success reported for
  // work that did not happen cost six days on the Philly import.
  //
  // This asserts on the RENDERED component's behaviour, so flipping the
  // toast kind to a bare 'success' in NameField.jsx turns this red — the
  // mutation test, run for real.

  it('HONESTY RULE: Bee Hub saves but Jobber rejects → an ERROR toast, never a green tick', async () => {
    fetchMock.mockResolvedValue(respond({ lead: { name: 'Jerry & Carri Lambert' }, name_writeback: WB_REJECTED }))
    const { host, unmount } = await mount(<NameField {...setup()} jobberLinked />)

    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'Last name'), 'Lambert')
    await click(saveBtn(host))

    expect(toasts).toHaveLength(1)
    // THE assertion. Not 'success'.
    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].msg).toContain('Jobber sync failed')
    expect(toasts[0].msg).toContain('saved in Bee Hub only')
    await unmount()
  })

  it('HONESTY RULE: a HALF-applied change is an error toast too', async () => {
    fetchMock.mockResolvedValue(respond({
      lead: { name: 'Jerry Lambert' },
      name_writeback: { first_name: 'updated', last_name: 'failed', company: 'unchanged' },
    }))
    const { host, unmount } = await mount(<NameField {...setup()} jobberLinked />)

    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'First name'), 'Jerry')
    await click(saveBtn(host))

    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].msg).toContain('partial')
    await unmount()
  })

  it('the local record still updates on a rejected sync — Bee Hub really did save', async () => {
    fetchMock.mockResolvedValue(respond({ lead: { name: 'Jerry & Carri Lambert' }, name_writeback: WB_REJECTED }))
    const props = setup({ jobberLinked: true })
    const { host, unmount } = await mount(<NameField {...props} />)

    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'Last name'), 'Lambert')
    await click(saveBtn(host))

    expect(props.onSaved).toHaveBeenCalledTimes(1)
    expect(props.onSaved.mock.calls[0][0]).toEqual({
      first_name: 'Jerry & Carri', last_name: 'Lambert', company: null, name: 'Jerry & Carri Lambert',
    })
    await unmount()
  })

  it('a FAILED save keeps the edit open with the draft intact', async () => {
    fetchMock.mockResolvedValue(respond({ error: 'name_cannot_be_empty', detail: 'nope' }, false))
    const { host, unmount } = await mount(<NameField {...setup()} />)

    await click(q(host, '[data-name-row="1"]'))
    await type(input(host, 'Last name'), 'Lambert')
    await click(saveBtn(host))

    // Never silently drop a draft.
    expect(input(host, 'Last name').value).toBe('Lambert')
    expect(host.textContent).toContain('Save failed')
    expect(toasts[0].kind).toBe('error')
    await unmount()
  })

  // ── the company shape ───────────────────────────────────────────────────

  it('a company record opens with the company field filled and the person fields empty', async () => {
    const DECK = { name: 'Deck Construction Group LLC', first_name: null, last_name: null, company: 'Deck Construction Group LLC' }
    fetchMock.mockResolvedValue(respond({ lead: { name: 'Deck Construction Group, LLC' } }))
    const { host, unmount } = await mount(<NameField {...setup({ value: DECK })} />)

    await click(q(host, '[data-name-row="1"]'))
    expect(input(host, 'First name').value).toBe('')
    expect(input(host, 'Last name').value).toBe('')
    expect(input(host, 'Company').value).toBe('Deck Construction Group LLC')

    await type(input(host, 'Company'), 'Deck Construction Group, LLC')
    // The preview proves the company is the display name when nobody is named.
    expect(q(host, '[data-name-preview="1"]').textContent).toContain('Deck Construction Group, LLC')
    await click(saveBtn(host))

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent).toEqual({ first_name: '', last_name: '', company: 'Deck Construction Group, LLC' })
    await unmount()
  })
})
