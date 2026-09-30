// @vitest-environment happy-dom
//
// Nothing closes on an outside click, anywhere (Kevin, 2026-09-30 —
// extends the 2026-09-29 overlay decision to every screen, menu, picker
// and popover). Each one closes by its OWN control instead:
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
import AskBeeHubPanel from '@/components/hive/AskBeeHubPanel'
import FeedbackModal from '@/components/feedback/FeedbackModal'

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
// An "outside click" the way a browser delivers it: mousedown then click,
// on the page behind (document.body), not on anything the component owns.
const clickOutside = async (target: Element = document.body) => {
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

  it('an outside click leaves it open; the ··· again closes it', async () => {
    const { host, unmount } = await mount(<CardMenu items={items()} />)
    await click(host.querySelector('button[aria-label="More"]')!)
    await clickOutside()
    expect(host.textContent).toContain('Do a thing')
    await click(host.querySelector('button[aria-label="More"]')!)
    expect(host.textContent).not.toContain('Do a thing')
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

  it('an outside click leaves it open; the chip again, a pick, or Esc closes it', async () => {
    const onPick = vi.fn()
    const { host, unmount } = await mount(<MetaSelect label="Source" value="Referral" options={OPTS} onPick={onPick} />)
    const chip = host.querySelector('button')!
    await click(chip)
    await clickOutside()
    expect(pop(host)).toBeTruthy()
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

  it('an outside click leaves it open; its trigger again closes it; Esc still does', async () => {
    const { host, unmount } = await mount(<IdentityScopeControl {...SUPER} />)
    const trigger = host.querySelector('button[aria-label="Account and scope"]')!
    await click(trigger)
    await clickOutside()
    expect(open(host)).toBeTruthy()
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

  it('AssigneeCorner: outside click leaves it open; Done closes; trigger again closes; Esc closes', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" />
    )
    const trigger = host.querySelector('button[aria-haspopup="true"]')!
    const isOpen = () => host.textContent!.includes('Wendy Ortiz')
    await click(trigger)
    await clickOutside()
    expect(isOpen()).toBe(true)
    await click(btn(host, 'Done')!)
    expect(isOpen()).toBe(false)
    await click(trigger); await click(trigger)
    expect(isOpen()).toBe(false)
    await click(trigger); await escape()
    expect(isOpen()).toBe(false)
    await unmount()
  })

  it('EngagementAssignees: outside click leaves it open; Done closes; trigger again closes; Esc closes', async () => {
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1" assignees={[]} users={USERS} jobberConnected onChange={() => {}} setToast={() => {}} />
    )
    const trigger = host.querySelector('button[aria-label="Assign a team member"]')!
    const isOpen = () => !!btn(host, 'Done')
    await click(trigger)
    await clickOutside()
    expect(isOpen()).toBe(true)
    await click(btn(host, 'Done')!)
    expect(isOpen()).toBe(false)
    await click(trigger); await click(trigger)
    expect(isOpen()).toBe(false)
    await click(trigger); await escape()
    expect(isOpen()).toBe(false)
    await unmount()
  })
})

describe('Ask Bee Hub panel', () => {
  it.each([['desktop float', false], ['phone sheet', true]])('%s: an outside click leaves it open; its ✕ closes it; Esc still does', async (_l, isMobile) => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<AskBeeHubPanel isMobile={isMobile} screenName="Home" onClose={onClose} />)
    await clickOutside()
    if (isMobile) await clickOutside(host.firstElementChild!) // the dimmed scrim itself
    expect(onClose).not.toHaveBeenCalled()
    await click(host.querySelector('button[aria-label="Close help chat"]')!)
    expect(onClose).toHaveBeenCalledTimes(1)
    await escape()
    expect(onClose).toHaveBeenCalledTimes(2)
    await unmount()
  })
})

describe('feedback form (FeedbackModal)', () => {
  it('a mousedown + click on its backdrop leaves it open; its ✕ closes it', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" onClose={onClose} />)
    await clickOutside(host.querySelector('[data-feedback-modal]')!)
    expect(onClose).not.toHaveBeenCalled()
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

describe('codebase sweep: no outside-click closers left', () => {
  it('no document/window click, mousedown, pointerdown or touchstart listener', () => {
    const hits: string[] = []
    for (const f of SOURCES) {
      read(f).split('\n').forEach((l, i) => {
        if (/addEventListener\(\s*['"](mousedown|mouseup|click|pointerdown|pointerup|touchstart)['"]/.test(l)) hits.push(`${f}:${i + 1}`)
      })
    }
    expect(hits).toEqual([])
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
  // Four React.createElement layers in BeeHub + the Ask Bee Hub phone
  // wrapper can't be walked by indentation — each is pinned explicitly
  // below instead.
  const WALK_EXEMPT = new Set([
    'components/BeeHub.jsx#partner-popup', 'components/BeeHub.jsx#partner-delete',
    'components/BeeHub.jsx#jobber-history', 'components/hive/AskBeeHubPanel.jsx#phone-wrapper',
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
        if (!CLOSE_CONTROL.test(sub) && !(f.endsWith('AskBeeHubPanel.jsx') && sub.includes('{panel}'))) {
          unclosable.push(`${f}:${c + 1}`)
        }
        i = e
      }
    }
    expect(unclosable).toEqual([])
    expect(WALK_EXEMPT.size).toBe(4)
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
      'components/hive/shared/AssigneeCorner.jsx', 'components/hive/shared/EngagementAssignees.jsx', 'components/hive/AskBeeHubPanel.jsx',
    ]) expect(read(f), f).toMatch(/key === 'Escape'/)
  })
})
