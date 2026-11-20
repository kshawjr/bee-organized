// @vitest-environment happy-dom
//
// WHY THIS TEST EXISTS. On 2026-09-29 a stray click beside a record closed
// it and dropped whatever was half-typed (a buzz note, a name edit, a call
// note, a new-client form: 43e72f6). On 2026-09-30 Kevin extended that to
// "nothing closes on an outside click, anywhere" (75363e9), so no window,
// sheet, menu or picker could throw away a person's typing by accident.
//
// THE LINE SINCE 2026-11-19 (Kevin: "i wrote that rule because people were
// clearing out. just leave everything else except filters and pop up"). The
// reason still holds, so the rule is NARROWED, not retired:
//   · CLOSES ON A CLICK AWAY: things that hold no typing and no choice
//     waiting to be confirmed — filter menus, pickers where a tap applies at
//     once, the ··· menus, the account / location / profile menus, the
//     Settings dropdowns. They do it through ONE hook,
//     components/ui/useClickAway.js, and only the components named in
//     CLICK_AWAY_ALLOWED below may call it.
//   · CLOSES ONLY BY ITS OWN BUTTONS: every pop-up window and sheet, anything
//     holding typing, and every "are you sure?" step (even one shown inside a
//     ··· menu). Section 1b pins that with a real pointer press.
//
// Before 2026-11-19 every menu here was: closes by its OWN control:
//   · a menu — picking an item, or pressing its trigger (···) again
//   · a picker — its own Done / Cancel
//   · a popover or modal — its own ✕ / Close / Cancel
// Escape is kept wherever it already existed.
//
// Pinned three ways:
//   1. behaviour — each shared hive/feedback component: an outside click
//      leaves it open, its own control closes it, Esc still does where
//      it did before;
//   2. the codebase sweep — no document click/mousedown listener, no
//      "target === currentTarget" backdrop, and no close handler sitting
//      on a non-button element (a backdrop / scrim / click-catcher);
//   3. nothing unclosable — every full-screen layer in the app contains a
//      control that closes it, plus the four spots that had NO other way
//      out before this change (two source pickers, the location picker,
//      the assignee pickers) now carry one.
//
// ONE EXCEPTION, by Kevin's ruling of 2026-11-19 (slice 6 feedback): the
// menus on the new Network screens (components/network/NetworkListScreen.jsx,
// its one shared Menu) DO close on a click anywhere outside — "anywhere on
// the screen should clear the prompt." The sweep lets that one listener
// through by file and by its marker, and nothing else. Every other screen
// keeps the 2026-09-30 rule until Kevin rules on it.
//
// Deliberately NOT in scope: type-ahead suggestion lists that fold away
// when their text field loses focus (address autofill, company search).
// They close on leaving the field, not on a click, and have no control
// of their own to close by — see the commit message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { CardMenu } from '@/components/hive/shared/cardKit'
import PickerModal from '@/components/hive/shared/PickerModal'
import MetaSelect from '@/components/hive/MetaSelect'
import IdentityScopeControl from '@/components/hive/IdentityScopeControl'
import AssigneeCorner from '@/components/hive/shared/AssigneeCorner'
import EngagementAssignees from '@/components/hive/shared/EngagementAssignees'
import FeedbackModal from '@/components/feedback/FeedbackModal'
import { FilterButton, FilterPopover, CheckRow } from '@/components/hive/shared/FilterPopover'
import { ESelect, EDialog } from '@/components/settings/EmailsScreen'
import OverlayShell from '@/components/hive/OverlayShell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const fire = (el: Element, type: 'click' | 'mousedown') => act(async () => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
})
// An "outside click" the way a browser delivers it: pointerdown, mousedown,
// then click, on the page behind (document.body) or a window's own dimmed
// backdrop, not on anything the component owns.
const clickOutside = async (target: Element = document.body) => {
  await act(async () => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true })) })
  await fire(target, 'mousedown')
  await fire(target, 'click')
}
const click = (el: Element) => fire(el, 'click')
const escape = () => act(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
})
const btn = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)

beforeEach(() => {
  document.body.innerHTML = ''
  ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ lookups: [], items: [], location: null }) }))
})

// ═══ 1. behaviour, component by component ══════════════════════
describe('card ··· menu (CardMenu)', () => {
  const items = (onPick = () => {}) => [{ key: 'a', label: 'Do a thing', onPick }]

  it('a click away closes it and picks nothing; the ··· again closes it too', async () => {
    const onPick = vi.fn()
    const { host, unmount } = await mount(<CardMenu items={items(onPick)} />)
    await click(host.querySelector('button[aria-label="More"]')!)
    await clickOutside()
    expect(host.textContent).not.toContain('Do a thing')
    expect(onPick).not.toHaveBeenCalled()
    await click(host.querySelector('button[aria-label="More"]')!)
    expect(host.textContent).toContain('Do a thing')
    await click(host.querySelector('button[aria-label="More"]')!)
    expect(host.textContent).not.toContain('Do a thing')
    await unmount()
  })

  it('while it asks "are you sure?", a click away does NOT close it and does not say yes', async () => {
    const onPick = vi.fn()
    const confirmItems = [{ key: 'del', label: 'Delete client', onPick, danger: true, confirm: { prompt: 'Delete Dana?', yes: 'Yes, delete', no: 'Keep' } }]
    const { host, unmount } = await mount(<CardMenu items={confirmItems as any} />)
    await click(host.querySelector('button[aria-label="More"]')!)
    await click(btn(host, 'Delete client')!)
    expect(host.textContent).toContain('Delete Dana?')
    await clickOutside()
    expect(host.textContent).toContain('Delete Dana?')
    expect(onPick).not.toHaveBeenCalled()
    await click(btn(host, 'Keep')!)
    expect(onPick).not.toHaveBeenCalled()
    await unmount()
  })

  it('no invisible click-catcher sits over the page while it is open', async () => {
    const { host, unmount } = await mount(<CardMenu items={items()} />)
    await click(host.querySelector('button[aria-label="More"]')!)
    // The menu itself is position:absolute; any FIXED layer here would be a
    // click-catcher sitting over the page (and the ··· itself). (happy-dom
    // drops the inset shorthand, so match on position alone.)
    const catcher = [...host.querySelectorAll('div')].find(d => /position:\s*fixed/.test(d.getAttribute('style') || ''))
    expect(catcher).toBeUndefined()
    await unmount()
  })

  it('picking an item closes it; Esc still closes it', async () => {
    const onPick = vi.fn()
    const { host, unmount } = await mount(<CardMenu items={items(onPick)} />)
    await click(host.querySelector('button[aria-label="More"]')!)
    await click(btn(host, 'Do a thing')!)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('Do a thing')
    await click(host.querySelector('button[aria-label="More"]')!)
    await escape()
    expect(host.textContent).not.toContain('Do a thing')
    await unmount()
  })
})

describe('tag picker (PickerModal)', () => {
  const props = (over: any = {}) => ({
    category: 'client_tags', locationId: 'loc-1', selected: [], mode: 'multi' as const,
    allowCreate: true, title: 'Tags', subtitle: 'sub', onSave: () => {}, onClose: () => {}, ...over,
  })

  it('a click on its dimmed backdrop leaves it open; Cancel closes it; Esc still does', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<PickerModal {...props({ onClose })} />)
    await clickOutside(host.querySelector('.bee-picker-modal')!)
    expect(onClose).not.toHaveBeenCalled()
    await click(btn(host, 'Cancel')!)
    expect(onClose).toHaveBeenCalledTimes(1)
    await escape()
    expect(onClose).toHaveBeenCalledTimes(2)
    await unmount()
  })
})

describe('meta chip picker (MetaSelect)', () => {
  const OPTS = ['Referral', 'Google']
  const pop = (host: Element) => host.querySelector('.bee-meta-pop')

  it('a click away closes it and saves nothing; the chip again, a pick, or Esc closes it', async () => {
    const onPick = vi.fn()
    const { host, unmount } = await mount(<MetaSelect label="Source" value="Referral" options={OPTS} onPick={onPick} />)
    const chip = host.querySelector('button')!
    await click(chip)
    await clickOutside()
    expect(pop(host)).toBeNull()
    expect(onPick).not.toHaveBeenCalled()
    await click(chip)
    await click(chip)
    expect(pop(host)).toBeNull()

    await click(chip)
    await click(btn(host, 'Google')!)
    expect(onPick).toHaveBeenCalledWith('Google')
    expect(pop(host)).toBeNull()

    await click(chip)
    await escape()
    expect(pop(host)).toBeNull()
    await unmount()
  })
})

describe('account & scope popover (IdentityScopeControl)', () => {
  const SUPER = {
    name: 'Kevin Shaw', email: 'kevin@bmave.com', initials: 'KS',
    roleLabel: 'Super Admin', roleBadgeTint: 'warning' as const,
    isSuperAdmin: true,
    locationLabel: 'All locations', locationCount: 3, canSwitchLocation: true,
  }
  const open = (host: Element) => host.querySelector('[data-section]')

  it('a click away closes it and opens nothing; its trigger again closes it; Esc still does', async () => {
    const onOpenViewAs = vi.fn(); const onOpenLocationPicker = vi.fn()
    const { host, unmount } = await mount(<IdentityScopeControl {...SUPER} onOpenViewAs={onOpenViewAs} onOpenLocationPicker={onOpenLocationPicker} />)
    const trigger = host.querySelector('button[aria-label="Account and scope"]')!
    await click(trigger)
    await clickOutside()
    expect(open(host)).toBeNull()
    expect(onOpenViewAs).not.toHaveBeenCalled()
    expect(onOpenLocationPicker).not.toHaveBeenCalled()
    await click(trigger)
    expect(open(host)).toBeTruthy()
    await clickOutside(host.querySelector('[data-section]')!)
    expect(open(host)).toBeTruthy() // a press inside the menu is not a click away
    await click(trigger)
    expect(open(host)).toBeNull()
    await click(trigger)
    await escape()
    expect(open(host)).toBeNull()
    await unmount()
  })
})

describe('assignee pickers — multi-select, so they got a Done', () => {
  const USERS = [
    { id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', locationId: 'loc-1', jobberUserId: 'j1' },
    { id: 'u2', name: 'Wendy Ortiz', email: 'wendy@x.com', locationId: 'loc-1', jobberUserId: null },
  ]

  it('AssigneeCorner: a click away closes it and sends nothing; Done closes; trigger again closes; Esc closes', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" />
    )
    const trigger = host.querySelector('button[aria-haspopup="true"]')!
    const isOpen = () => host.textContent!.includes('Wendy Ortiz')
    await click(trigger)
    await clickOutside()
    expect(isOpen()).toBe(false)
    expect((globalThis as any).fetch).not.toHaveBeenCalled() // nobody assigned or unassigned
    await click(trigger)
    await click(btn(host, 'Done')!)
    expect(isOpen()).toBe(false)
    await click(trigger); await click(trigger)
    expect(isOpen()).toBe(false)
    await click(trigger); await escape()
    expect(isOpen()).toBe(false)
    await unmount()
  })

  it('EngagementAssignees: a click away closes it and sends nothing; Done closes; trigger again closes; Esc closes', async () => {
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1" assignees={[]} users={USERS} jobberConnected onChange={() => {}} setToast={() => {}} />
    )
    const trigger = host.querySelector('button[aria-label="Assign a team member"]')!
    const isOpen = () => !!btn(host, 'Done')
    await click(trigger)
    await clickOutside()
    expect(isOpen()).toBe(false)
    expect((globalThis as any).fetch).not.toHaveBeenCalled()
    await click(trigger)
    await click(btn(host, 'Done')!)
    expect(isOpen()).toBe(false)
    await click(trigger); await click(trigger)
    expect(isOpen()).toBe(false)
    await click(trigger); await escape()
    expect(isOpen()).toBe(false)
    await unmount()
  })
})

describe('filter menu (FilterPopover: Clients, Inbox, the board)', () => {
  function Harness({ onTick }: { onTick: () => void }) {
    const [open, setOpen] = React.useState(false)
    return (
      <div style={{ position: 'relative' }}>
        <FilterButton count={0} open={open} onToggle={() => setOpen((v) => !v)} />
        <FilterPopover open={open} count={0} onClear={() => {}} onClose={(() => setOpen(false)) as any}>
          <CheckRow label="Has phone" checked={false} onToggle={onTick} />
        </FilterPopover>
      </div>
    )
  }
  const pop = () => document.querySelector('.bee-filter-pop')
  it('a click away closes it and ticks nothing; a press inside does not; its button toggles; Esc is not its job', async () => {
    const onTick = vi.fn()
    const { host, unmount } = await mount(<Harness onTick={onTick} />)
    const button = btn(host, 'Filters')!
    await click(button)
    expect(pop()).toBeTruthy()
    await clickOutside(pop()!)
    expect(pop()).toBeTruthy()
    await clickOutside()
    expect(pop()).toBeNull()
    expect(onTick).not.toHaveBeenCalled()
    await clickOutside(button) // a real press on its own button opens it…
    expect(pop()).toBeTruthy()
    await clickOutside(button) // …and a second one closes it, not close-then-reopen
    expect(pop()).toBeNull()
    await unmount()
  })
  it('without an onClose (a caller that has not opted in) it does not close on a click away', async () => {
    const { unmount } = await mount(<FilterPopover open count={0} onClear={() => {}}><span>x</span></FilterPopover>)
    await clickOutside()
    expect(pop()).toBeTruthy()
    await unmount()
  })
})

describe('Settings dropdown (ESelect)', () => {
  const OPTS = [{ value: 'days', label: 'Days' }, { value: 'weeks', label: 'Weeks' }]
  it('a click away closes the list and changes nothing; the button and Escape still close it', async () => {
    const onChange = vi.fn()
    const { host, unmount } = await mount(<ESelect id="wait-unit" ariaLabel="Wait measured in" value="days" options={OPTS} onChange={onChange} />)
    const button = host.querySelector('button[role="combobox"]')!
    const list = () => host.querySelector('[role="listbox"]')
    await click(button)
    expect(list()).toBeTruthy()
    await clickOutside()
    expect(list()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    await click(button); await click(button)
    expect(list()).toBeNull()
    await click(button)
    await act(async () => { list()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(list()).toBeNull()
    await unmount()
  })
  it('inside a window: a click away closes only the list; the window and the choice in it stay', async () => {
    const onClose = vi.fn()
    function Win() {
      const [unit, setUnit] = React.useState('weeks')
      return <EDialog label="Timing" title="Change the wait" onClose={onClose}>
        <ESelect id="wait-unit" ariaLabel="Wait measured in" value={unit} options={OPTS} onChange={setUnit} />
      </EDialog>
    }
    const { host, unmount } = await mount(<Win />)
    await click(host.querySelector('button[role="combobox"]')!)
    await clickOutside()
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(host.querySelector('[data-edialog]')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(host.querySelector('button[role="combobox"]')!.getAttribute('data-value')).toBe('weeks')
    await unmount()
  })
})

// ═══ 1b. windows and sheets: still closed ONLY by their own buttons ═════
describe('pop-up windows and sheets ignore a click away, with a real pointer press', () => {
  it('a record window (OverlayShell): a press on its backdrop and on the page leaves it open, typing intact', async () => {
    const onClose = vi.fn()
    function Rec() {
      const [v, setV] = React.useState('')
      return <OverlayShell onClose={onClose} isMobile={false}><input aria-label="note" value={v} onChange={(e) => setV(e.target.value)} /></OverlayShell>
    }
    const { host, unmount } = await mount(<Rec />)
    const input = () => document.querySelector('input[aria-label="note"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), 'Gate code 4471')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    const backdrop = document.querySelector('[data-overlay-backdrop]')!
    await clickOutside(backdrop)
    await clickOutside()
    expect(onClose).not.toHaveBeenCalled()
    expect(input().value).toBe('Gate code 4471')
    void host
    await unmount()
  })
  it('a Settings window (EDialog): a press on its dimmed layer leaves it open', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<EDialog label="x" title="Edit" onClose={onClose}><input aria-label="body" /></EDialog>)
    const layer = host.querySelector('[data-emails-ui] > div[aria-hidden]')!
    await clickOutside(layer)
    await clickOutside()
    expect(onClose).not.toHaveBeenCalled()
    await unmount()
  })
})

// The Ask Bee Hub panel had its own block here; the panel was deleted on
// 2026-11-13 with the rest of Ask Bee Hub.

describe('feedback form (FeedbackModal)', () => {
  it('a press on its backdrop or the page leaves it open WITH the typing in it; its ✕ closes it', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" onClose={onClose} />)
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
    await click(host.querySelector('[data-intake-door]')!) // pick a kind of report: the form asks its first question
    const field = () => host.querySelector('[data-feedback-modal] [data-intake-field], [data-feedback-modal] textarea, [data-feedback-modal] input:not([type="file"]):not([type="checkbox"]):not([type="radio"])') as HTMLInputElement | HTMLTextAreaElement | null
    expect(field(), 'the feedback form has a text box').toBeTruthy()
    const proto = field() instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field(), 'The Send button does nothing')
      field()!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickOutside(host.querySelector('[data-feedback-modal]')!)
    await clickOutside()
    expect(onClose).not.toHaveBeenCalled()
    expect(field()!.value).toBe('The Send button does nothing')
    await click(host.querySelector('[data-feedback-modal] button[aria-label="Close"]')!)
    expect(onClose).toHaveBeenCalledTimes(1)
    await unmount()
  })
})

// ═══ 2. the codebase sweep ═════════════════════════════════════
const SOURCES = execSync('git ls-files components app', { encoding: 'utf8' })
  .split('\n')
  .filter(f => /\.(jsx|tsx|js)$/.test(f) && !f.includes('.test.'))
const read = (f: string) => readFileSync(f, 'utf8')

describe('codebase sweep: outside-click closers only where Kevin drew the line', () => {
  // The ONLY click-away in Bee Hub is the hook, and only these may call it.
  // Each holds no typing and no choice waiting to be confirmed. Adding a
  // window, a sheet or anything with a text box to this list is exactly the
  // September accident (43e72f6) again: do not, unless Kevin says so.
  const CLICK_AWAY_ALLOWED: Record<string, string> = {
    'components/network/NetworkListScreen.jsx': 'Network menus: Tags, Filters, Add contacts, More',
    'components/hive/shared/FilterPopover.jsx': 'filter menus on Clients, Inbox and the board (applied as ticked)',
    'components/hive/shared/cardKit.jsx': 'client card ··· menu (not while asking "are you sure?")',
    'components/hive/shared/RecordMenu.jsx': 'client record ··· menu',
    'components/hive/InboxScreen.jsx': 'Inbox row ··· menu (not its "are you sure?" step, never the Bin question)',
    'components/hive/MetaSelect.jsx': 'stage / source chips: a tap saves at once',
    'components/hive/shared/AssigneeCorner.jsx': '"who\'s assigned" picker: each tick saves at once',
    'components/hive/shared/EngagementAssignees.jsx': '"who\'s assigned" picker: each tick saves at once',
    'components/hive/IdentityScopeControl.jsx': 'account and scope menu',
    'components/settings/EmailsScreen.jsx': 'Settings dropdown (ESelect) only; EDialog is a window and does not',
    'components/BeeHub.jsx': 'the location picker and the phone profile menu only',
  }
  it('no document/window click, mousedown, pointerdown or touchstart listener anywhere but the one click-away hook', () => {
    const hits: string[] = []
    for (const f of SOURCES) {
      read(f).split('\n').forEach((l, i) => {
        if (/addEventListener\(\s*['"](mousedown|mouseup|click|pointerdown|pointerup|touchstart)['"]/.test(l)) hits.push(`${f}:${i + 1}`)
      })
    }
    expect(hits.map((h) => h.replace(/:\d+$/, ''))).toEqual(['components/ui/useClickAway.js'])
  })
  it('only the components on the list call it, and none of them is a window or a sheet', () => {
    const callers = SOURCES.filter((f) => f !== 'components/ui/useClickAway.js' && /\buseClickAway\(/.test(read(f))).sort()
    expect(callers).toEqual(Object.keys(CLICK_AWAY_ALLOWED).sort())
  })
  it('the windows and sheets themselves never call it', () => {
    const WINDOWS = [
      'components/hive/OverlayShell.jsx', 'components/hive/shared/PickerModal.jsx', 'components/feedback/FeedbackModal.jsx',
      'components/hive/shared/CloseWizardKit.jsx', 'components/network/ContactSheet.jsx', 'components/network/AddContactDialog.jsx',
      'components/network/ImportDialog.jsx', 'components/network/ConfirmChange.jsx', 'components/network/TagDialog.jsx',
    ]
    for (const f of WINDOWS) expect(read(f), f).not.toMatch(/useClickAway/)
    // In the two files that hold both, the windows stay out: EDialog and the BeeHub modals.
    const emails = read('components/settings/EmailsScreen.jsx')
    const edialog = emails.slice(emails.indexOf('export function EDialog'), emails.indexOf('export function EDialog') + 2500)
    expect(edialog).not.toMatch(/useClickAway/)
    expect(read('components/BeeHub.jsx').match(/useClickAway\(/g)).toHaveLength(2)
  })
  it('the hook only closes: it is handed a close and nothing that saves, picks or clears', () => {
    const hook = read('components/ui/useClickAway.js')
    expect(hook).toMatch(/document\.addEventListener\('pointerdown', press, true\)/)
    expect(hook).toMatch(/document\.removeEventListener\('pointerdown', press, true\)/)
    for (const f of Object.keys(CLICK_AWAY_ALLOWED)) {
      for (const m of Array.from(read(f).matchAll(/useClickAway\(([\s\S]*?)\n?\s*\)\s*$/gm))) {
        expect(m[1], f).not.toMatch(/onPick|onChange|onSave|onConfirm|onClear|clear|save|setTagFilter|setFilters/i)
      }
    }
  })

  it('no "target === currentTarget" backdrop closer', () => {
    const hits = SOURCES.filter(f => /\.target\s*===\s*\w+\.currentTarget\)\s*on(Close|Cancel)/.test(read(f)))
    expect(hits).toEqual([])
  })

  it('no close handler on a non-button element (backdrop, scrim or click-catcher)', () => {
    const HANDLER = /(onClick|onMouseDown|onPointerDown)\s*(=\s*\{|:)\s*([^\n]{0,120})/g
    const CLOSEISH = /^(on(Close|Cancel|Dismiss)\b|close\b|dismiss\b|\(\)\s*=>\s*\{?\s*(if\s*\(!?\w+\)\s*)?(set\w+\((false|null)\)|on(Close|Cancel)\(\)|close\(\))|\w+\s*\?\s*undefined\s*:\s*on)/
    const hits: string[] = []
    for (const f of SOURCES) {
      const s = read(f)
      for (const m of s.matchAll(HANDLER)) {
        if (!CLOSEISH.test(m[3].trim())) continue
        const pre = s.slice(0, m.index)
        const lt = pre.lastIndexOf('<'), ce = pre.lastIndexOf('createElement(')
        const tag = ce > lt
          ? (pre.slice(ce).match(/createElement\(\s*["']?(\w+)/) || [])[1]
          : (pre.slice(lt).match(/<\s*([\w.]+)/) || [])[1]
        if (!tag || tag === 'button' || tag === 'a' || /^[A-Z]/.test(tag)) continue
        hits.push(`${f}:${s.slice(0, m.index).split('\n').length} <${tag}> ${m[3].trim().slice(0, 50)}`)
      }
    }
    expect(hits).toEqual([])
  })
})

// ═══ 3. nothing left unclosable ════════════════════════════════
describe('nothing unclosable', () => {
  // Every full-screen fixed layer must contain its own way out. Layers that
  // ignore the pointer (confetti, click-through wrappers) are skipped.
  // The React.createElement layers in BeeHub can't be walked by indentation — each is pinned explicitly
  // below instead.
  const WALK_EXEMPT = new Set([
    'components/BeeHub.jsx#partner-popup', 'components/BeeHub.jsx#partner-delete',
    'components/BeeHub.jsx#jobber-history',
  ])
  const CLOSE_CONTROL = /onClick(=\{|:)\s*(\(\)\s*=>\s*\{?\s*)?(on(Close|Cancel|Done|Dismiss)\b|close\b|set\w+\((false|null)\)|\(\)\s*=>\s*on(Close|Cancel)\(\))|>\s*(Cancel|Close|Done|Got it|OK|×|✕)\s*<|aria-label[=:]\s*['"]Close|['"](×|✕|Cancel|Close|Done)['"]/

  it('every full-screen layer contains a control that closes it', () => {
    const unclosable: string[] = []
    for (const f of SOURCES) {
      const L = read(f).split('\n')
      for (let i = 0; i < L.length; i++) {
        const head = L.slice(i, i + 6).join(' ')
        if (!/position\s*:\s*['"]fixed['"]/.test(L[i])) continue
        if (!/inset\s*:\s*['"]?0\b|top\s*:\s*0\s*,\s*left\s*:\s*0\s*,\s*right\s*:\s*0\s*,\s*bottom\s*:\s*0/.test(head)) continue
        if (/pointerEvents/.test(L.slice(i, i + 8).join(' '))) continue
        let c = i
        for (let j = i; j > Math.max(-1, i - 8); j--) { if (/<div\b|createElement\(|^\s*"div"/.test(L[j])) { c = j; break } }
        if (!/<div\b/.test(L[c])) continue // createElement layers: pinned explicitly below
        const ind = L[c].length - L[c].trimStart().length
        let e = c + 1
        while (e < L.length && e < c + 900) {
          const t = L[e]; const k = t.length - t.trimStart().length
          if (t.trim() && k <= ind && /^(<\/div>|\)|\}|\/>)/.test(t.trim())) break
          e++
        }
        const sub = L.slice(c, e + 1).join('\n')
        if (!CLOSE_CONTROL.test(sub)) {
          unclosable.push(`${f}:${c + 1}`)
        }
        i = e
      }
    }
    expect(unclosable).toEqual([])
    expect(WALK_EXEMPT.size).toBe(3)   // was 4: the Ask Bee Hub phone wrapper went with the panel (2026-11-13)
  })

  const beehub = read('components/BeeHub.jsx')

  it('the createElement layers each keep their own close (partner popup ✕ on both breakpoints, delete Cancel, Jobber history ×)', () => {
    const popup = beehub.slice(beehub.indexOf('Sticky close X pinned absolute'), beehub.indexOf('Sticky close X pinned absolute') + 9000)
    expect(popup).toMatch(/!isMobile && React\.createElement\(\s*"button",\s*\{\s*onClick: onClose/)
    expect(popup).toMatch(/isMobile && React\.createElement\([\s\S]*onClick: onClose/)
    const del = beehub.slice(beehub.indexOf('popup === "delete" &&'), beehub.indexOf('popup === "delete" &&') + 4000)
    expect(del).toMatch(/"button",\s*\{\s*onClick: \(\) => setPopup\(null\)[\s\S]*"Cancel"/)
    const hist = beehub.slice(beehub.indexOf('popup === "jobber-history" &&'), beehub.indexOf('popup === "jobber-history" &&') + 4000)
    expect(hist).toMatch(/"button",\s*\{\s*onClick: \(\) => setPopup\(null\)/)
  })

  it('both "Select Source" sheets — whose only way out WAS the outside tap — now have a Cancel', () => {
    const sheets = beehub.split('Select Source</p>').slice(1).map(s => s.slice(0, 2500))
    expect(sheets).toHaveLength(2)
    for (const s of sheets) expect(s).toMatch(/<button onClick=\{\(\)=>setShowSourcePicker\(false\)\}[^>]*>Cancel<\/button>/)
  })

  it('the location picker has its own ✕, and the desktop trigger toggles it (it used to only open)', () => {
    expect(beehub).toMatch(/<button onClick=\{\(\)=>setShowLocPicker\(false\)\} aria-label="Close location picker"/)
    expect(beehub).toContain('onClickLocation={()=>setShowLocPicker(v=>!v)}')
    expect(beehub).not.toContain('onClickLocation={()=>setShowLocPicker(true)}')
  })

  it('the board description popup lets clicks through its transparent layer and keeps its ×', () => {
    const at = beehub.indexOf('{descPopup&&(')
    const block = beehub.slice(at, at + 1500)
    expect(block).toContain("position:'fixed', inset:0, zIndex:8000, pointerEvents:'none'")
    expect(block).toContain("pointerEvents:'auto'")
    expect(block).toMatch(/<button onClick=\{\(\)=>setDescPopup\(null\)\}/)
  })

  it('Esc is kept wherever it was (menus, pickers, panels touched here)', () => {
    for (const f of [
      'components/hive/shared/cardKit.jsx', 'components/hive/shared/RecordMenu.jsx', 'components/hive/InboxScreen.jsx',
      'components/hive/shared/PickerModal.jsx', 'components/hive/MetaSelect.jsx', 'components/hive/IdentityScopeControl.jsx',
      'components/hive/shared/AssigneeCorner.jsx', 'components/hive/shared/EngagementAssignees.jsx',
    ]) expect(read(f), f).toMatch(/key === 'Escape'/)
  })
})
