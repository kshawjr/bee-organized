// @vitest-environment happy-dom
//
// THE inline-edit affordance standard (Kevin 7/10) — visible pencils +
// explicit save. shared/inlineEdit.jsx is the single source:
//
//   A) EditPencil: readable muted ink (#6b6a64, NOT ghost #c9c7c0),
//      class bee-edit-pencil (globals.css darkens on row hover). The ✎
//      glyph in the hive chunk lives ONLY in inlineEdit.jsx — no
//      private pencils.
//   B) InlineEditControls: green ✓ commits, muted ✗ cancels with zero
//      writes; Enter/Esc (⌘-Enter in textareas) still work — buttons
//      make the path visible, they don't replace the shortcuts.
//   C) Saving state: in-flight disables the pair (+ input) so a double
//      tap can't double-save; a FAILED save keeps edit mode open with
//      the inline error and the draft intact.
//   D) Adopters: ContactField (both mounts), EditableDesc (ClientProfile
//      + PersonCard request_details), EngagementPanel description —
//      whose private descBlock copy was consolidated onto EditableDesc.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import ContactField from '@/components/hive/shared/ContactField'
import EditableDesc from '@/components/hive/EditableDesc'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { PENCIL_INK } from '@/components/hive/shared/inlineEdit'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── DOM helpers (the beta-contact-edit idiom) ──────────────────
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
  const proto = el.tagName === 'TEXTAREA'
    ? (globalThis as any).window.HTMLTextAreaElement.prototype
    : (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (el: Element, k: string, mods: any = {}) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }))
})
const saveBtn = (host: Element) => host.querySelector('button[aria-label="Save"]') as HTMLButtonElement | null
const cancelBtn = (host: Element) => host.querySelector('button[aria-label="Cancel"]') as HTMLButtonElement | null
const pencil = (host: Element) => host.querySelector('.bee-edit-pencil') as HTMLElement | null

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

// ── A) the pencil is findable, and there's exactly one of it ──
describe('EditPencil — readable, standard, no private forks', () => {
  it('ContactField view mode renders the standard pencil at readable ink (not ghost-gray)', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { host, unmount } = await mount(
      <ContactField kind="phone" leadId="l1" value="(561) 555-0100" onSaved={() => {}} setToast={() => {}} />
    )
    const p = pencil(host)!
    expect(p).toBeTruthy()
    expect([PENCIL_INK, 'rgb(107, 106, 100)']).toContain(p.style.color)
    await unmount()
  })

  it('EditableDesc view mode renders the same standard pencil', async () => {
    const { host, unmount } = await mount(<EditableDesc text="Garage reset" onSave={() => {}} />)
    expect(pencil(host)).toBeTruthy()
    await unmount()
  })

  it('cursor pins: the ✎ shows a POINTER even inside cursor:text host rows (the affordance must not go mute)', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { host, unmount } = await mount(
      <ContactField kind="phone" leadId="l1" value="(561) 555-0100" onSaved={() => {}} setToast={() => {}} />
    )
    expect(pencil(host)!.style.cursor).toBe('pointer')
    await unmount()
  })

  it('source sweep: no hive file RENDERS a private ✎ — the glyph in code lives only in shared/inlineEdit.jsx (comment prose exempt)', () => {
    const root = 'components/hive'
    const isComment = (line: string) => /^(\/\/|\*|\/\*|\{\/\*)/.test(line.trim())
    const offenders = (readdirSync(root, { recursive: true }) as string[])
      .filter(f => /\.(jsx?|tsx?)$/.test(f))
      .filter(f => f !== join('shared', 'inlineEdit.jsx'))
      .filter(f => readFileSync(join(root, f), 'utf8').split('\n').some(l => l.includes('✎') && !isComment(l)))
    expect(offenders).toEqual([])
  })
})

// ── B+C) ContactField wears the controls ───────────────────────
describe('ContactField — explicit ✓/✗ beside the input', () => {
  let leadPatches: any[]
  const installFetch = (respond?: () => Promise<any>) => {
    leadPatches = []
    vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
      if (String(url).includes('/api/leads/') && opts.method === 'PATCH') {
        leadPatches.push(JSON.parse(opts.body))
        if (respond) return respond()
        return { ok: true, status: 200, json: async () => ({ lead: {} }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
  }
  const openEdit = async (host: Element) => { await click(host.querySelector('p')!) }
  const mountField = () => mount(
    <ContactField kind="phone" leadId="l1" value="(561) 555-0100" onSaved={() => {}} setToast={() => {}} />
  )

  it('edit mode shows the pair; check-click saves — one PATCH, edit closes', async () => {
    installFetch()
    const { host, unmount } = await mountField()
    await openEdit(host)
    expect(saveBtn(host)).toBeTruthy()
    expect(cancelBtn(host)).toBeTruthy()
    // Cursor pins for the edit-state row: both controls are pointers at
    // rest (globals.css carries NO button cursor reset — audited 7/10;
    // these inline styles are the single source, so pin them).
    expect(saveBtn(host)!.style.cursor).toBe('pointer')
    expect(cancelBtn(host)!.style.cursor).toBe('pointer')
    await type(host.querySelector('input')!, '(704) 555-0142')
    await click(saveBtn(host)!)
    expect(leadPatches).toEqual([{ phone: '(704) 555-0142' }])
    expect(host.querySelector('input')).toBeNull()
    await unmount()
  })

  it('✗ cancels: edit closes, ZERO writes, value untouched (Enter/Esc keyboard paths pinned in beta-contact-edit)', async () => {
    installFetch()
    const { host, unmount } = await mountField()
    await openEdit(host)
    await type(host.querySelector('input')!, '999')
    await click(cancelBtn(host)!)
    expect(host.querySelector('input')).toBeNull()
    expect(leadPatches).toEqual([])
    expect(host.textContent).toContain('(561) 555-0100')
    await unmount()
  })

  it('in-flight: pair + input disabled, second check-click cannot double-save', async () => {
    let release: any
    installFetch(() => new Promise(r => { release = r }))
    const { host, unmount } = await mountField()
    await openEdit(host)
    await type(host.querySelector('input')!, '(704) 555-0142')
    await click(saveBtn(host)!) // PATCH now hanging
    expect(saveBtn(host)!.disabled).toBe(true)
    expect(cancelBtn(host)!.disabled).toBe(true)
    expect(saveBtn(host)!.style.cursor).toBe('default') // busy: no false pointer
    expect(cancelBtn(host)!.style.cursor).toBe('default')
    expect((host.querySelector('input') as HTMLInputElement).disabled).toBe(true)
    await click(saveBtn(host)!) // disabled + saving-ref guard
    await act(async () => { release({ ok: true, status: 200, json: async () => ({ lead: {} }) }) })
    expect(leadPatches.length).toBe(1)
    expect(host.querySelector('input')).toBeNull() // closed after the release
    await unmount()
  })

  it('failed PATCH keeps edit mode open with the inline error, draft intact', async () => {
    installFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: 'nope' }) }))
    const { host, unmount } = await mountField()
    await openEdit(host)
    await type(host.querySelector('input')!, '(704) 555-0142')
    await click(saveBtn(host)!)
    expect(host.querySelector('input')).toBeTruthy()
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('(704) 555-0142')
    expect(host.textContent).toContain('Save failed: nope')
    await unmount()
  })
})

// ── B+C) EditableDesc wears the controls ───────────────────────
describe('EditableDesc — explicit ✓/✗ under the textarea', () => {
  it('check-click saves the trimmed draft and closes', async () => {
    const onSave = vi.fn(async () => true)
    const { host, unmount } = await mount(<EditableDesc text="Old text" onSave={onSave} />)
    await click(host.querySelector('[title="Click to edit"]')!)
    await type(host.querySelector('textarea')!, '  New plan  ')
    await click(saveBtn(host)!)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('New plan')
    expect(host.querySelector('textarea')).toBeNull()
    await unmount()
  })

  it('✗ cancels with zero saves; ⌘-Enter and Esc still work', async () => {
    const onSave = vi.fn(async () => true)
    const { host, unmount } = await mount(<EditableDesc text="Old text" onSave={onSave} />)
    await click(host.querySelector('[title="Click to edit"]')!)
    await type(host.querySelector('textarea')!, 'abandoned')
    await click(cancelBtn(host)!)
    expect(onSave).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Old text')
    // keyboard shortcuts survive the buttons
    await click(host.querySelector('[title="Click to edit"]')!)
    await type(host.querySelector('textarea')!, 'Chord save')
    await key(host.querySelector('textarea')!, 'Enter', { metaKey: true })
    expect(onSave).toHaveBeenCalledWith('Chord save')
    await click(host.querySelector('[title="Click to edit"]')!)
    await key(host.querySelector('textarea')!, 'Escape')
    expect(host.querySelector('textarea')).toBeNull()
    expect(onSave).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('onSave resolving false (host reverted) keeps the edit OPEN with the inline error + draft', async () => {
    const onSave = vi.fn(async () => false)
    const { host, unmount } = await mount(<EditableDesc text="Old text" onSave={onSave} />)
    await click(host.querySelector('[title="Click to edit"]')!)
    await type(host.querySelector('textarea')!, 'Doomed draft')
    await click(saveBtn(host)!)
    expect(host.querySelector('textarea')).toBeTruthy()
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Doomed draft')
    expect(host.textContent).toContain("Couldn't save — try again")
    await unmount()
  })
})

// ── D) EngagementPanel description rides the shared idiom ──────
describe('EngagementPanel description — consolidated onto EditableDesc', () => {
  it('source pin: EngagementPanel mounts EditableDesc; the private descBlock copy is gone', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    expect(panel).toContain("from './EditableDesc'")
    expect(panel).not.toContain('descBlock')
    expect(panel).not.toContain('descEditing')
  })

  it('functional: add-description → ✓ PATCHes /api/engagements with { description }', async () => {
    const engPatches: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url)
      if (u.includes('/api/engagements/') && opts.method === 'PATCH') {
        engPatches.push(JSON.parse(opts.body))
        return { ok: true, status: 200, json: async () => ({ id: 'eng-1', description: JSON.parse(opts.body).description }) }
      }
      if (u.includes('/api/engagements/')) {
        return { ok: true, status: 200, json: async () => ({
          engagement: { id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual', created_at: new Date().toISOString(), stage_entered_at: new Date().toISOString(), location_uuid: 'loc-1', project_type: null, description: null, total_invoiced: 0, total_paid: 0, balance_owing: 0 },
          children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] },
          client: { id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100', request_details: null, source: null, referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0 },
        }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} />
    )
    const addBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add a description'))!
    expect(addBtn).toBeTruthy()
    await click(addBtn)
    await type(host.querySelector('textarea')!, 'Full kitchen reset')
    await click(saveBtn(host)!)
    expect(engPatches).toEqual([{ description: 'Full kitchen reset' }])
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.textContent).toContain('Full kitchen reset')
    await unmount()
  })
})
