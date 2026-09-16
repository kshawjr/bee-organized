// @vitest-environment happy-dom
//
// THE LEAD MENU'S TYPE HIERARCHY — the actions read first.
//
// cd03c92 added a section heading per group and a description per item, and
// the actions stopped popping: the thing you are CHOOSING competed with the
// thing explaining it. The fix is weight and colour, not size — the menu had
// already grown and a taller menu on a dense worklist is its own problem.
//
// WHAT THIS FILE DOES NOT DO, deliberately. It does not assert a computed
// pixel size. jsdom does not load app/globals.css, so the 16px !important
// button floor does not exist here — a test that read getComputedStyle would
// pass in CI while the real screen rendered every level at 16px. That exact
// class of false green has cost this project a day already.
//
// WHAT IT PINS INSTEAD — the MECHANISM, which is what actually decides
// whether the hierarchy survives:
//   1. label and description take DIFFERENT style sources, and the label is
//      the heavier of the two
//   2. the destructive colour lands on the LABEL element and the description
//      beside it stays neutral
//   3. the heading is the quietest colour of the three, and is not a control
//   4. no fontSize is set on the <button> itself — the floor would discard
//      it, so type must live on the spans
//   5. both menus spend the SAME shared style module, so they cannot drift
//   6. "Mark as Junk" renders with its capital
//
// THE RENDERED RESULT STILL NEEDS KEVIN'S EYES. Nothing here can tell him
// whether the label now pops; it can only tell him the mechanism that would
// make it pop is wired and shared.
//
// Menu assertions are DOCUMENT-scoped: the Inbox menu portals into body, the
// card menu does not.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import ClientProfile from '@/components/hive/ClientProfile'
import { DISPOSITIONS } from '@/components/hive/shared/leadDispositions'
import { menuLabelType, menuDescriptionType, menuHeadingType, menuRowBox } from '@/components/hive/shared/menuType'
import { T } from '@/components/hive/shared/tokens'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const person = (over: any = {}) => ({
  id: 'p-1', name: 'Sarah Watts', email: 's@e.com', phone: '(561) 555-0199',
  locationId: 'loc-uuid-1', created: daysAgo(3),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null,
  jobberRef: null, outreachTimeline: [], ...over,
})
const profilePayload = () => ({
  client: { id: 'lead-9', name: 'Sarah Watts', first_name: 'Sarah', last_name: 'Watts',
    email: 's@e.com', phone: '(561) 555-0199', address: '12 Oak St', stage: 'New',
    created_at: daysAgo(30), tags: [], jobber_client_id: null, is_junk: false,
    snoozed_until: null, inbox_dismissed_at: null, assigned_to: null },
  referred_us: [], referred_us_total: 0, contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
})

let root: any
beforeEach(() => {
  ;(globalThis as any).fetch = vi.fn(async (url: any) => {
    if (/\/profile/.test(String(url))) return { ok: true, json: async () => profilePayload() } as any
    return { ok: true, json: async () => ({}) } as any
  })
  document.body.innerHTML = ''
})
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null; document.body.innerHTML = ''; vi.restoreAllMocks()
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return host
}
const click = (el: Element | null | undefined) => act(async () => {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const openInbox = async () => {
  const host = await mount(<InboxScreen people={[person()]} engagements={[]} locFilter="all"
    closeLostReasons={['Went quiet']} setToast={() => {}} />)
  await click(host.querySelector('button[aria-label="More"]'))
  return host
}
const openCard = async () => {
  const host = await mount(<ClientProfile clientId="lead-9" onClose={() => {}} />)
  await click([...host.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === 'More'))
  return host
}

const row = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement
const labelOf = (testid: string) => row(testid).querySelector('[data-menu-label]') as HTMLElement
const descOf = (testid: string) => row(testid).querySelector('[data-menu-description]') as HTMLElement

// Colours are compared through the SAME normalisation path: a probe element
// gets the token applied, so "does this element carry that token" is asked
// without ever writing a literal into the test.
const asRendered = (token: string) => {
  const probe = document.createElement('div')
  probe.style.color = token
  return probe.style.color
}

describe('1 — label and description take different style sources', () => {
  it('the shared module exports them as separate objects', () => {
    expect(menuLabelType(false)).not.toEqual(menuDescriptionType)
    expect(menuLabelType(false).fontWeight).not.toBe(menuDescriptionType.fontWeight)
  })

  it('the label is the HEAVIER of the two', () => {
    expect(Number(menuLabelType(false).fontWeight)).toBeGreaterThan(Number(menuDescriptionType.fontWeight))
  })

  it('and that reaches the rendered rows', async () => {
    await openInbox()
    expect(labelOf('menu-close').style.fontWeight).toBe(String(menuLabelType(false).fontWeight))
    expect(descOf('menu-close').style.fontWeight).toBe(String(menuDescriptionType.fontWeight))
    expect(labelOf('menu-close').style.fontWeight).not.toBe(descOf('menu-close').style.fontWeight)
  })

  it('the label is the darkest ink; the description is lighter', async () => {
    await openInbox()
    expect(labelOf('menu-close').style.color).toBe(asRendered(T.ink.primary))
    expect(descOf('menu-close').style.color).toBe(asRendered(T.ink.quiet))
    expect(labelOf('menu-close').style.color).not.toBe(descOf('menu-close').style.color)
  })
})

describe('2 — the destructive colour lands on the LABEL', () => {
  it('the junk label is danger; its description is not', async () => {
    await openInbox()
    expect(labelOf('menu-junk').style.color).toBe(asRendered(T.state.danger.strong))
    // A red description would shout the explanation. It stays neutral.
    expect(descOf('menu-junk').style.color).toBe(asRendered(T.ink.quiet))
    expect(descOf('menu-junk').style.color).not.toBe(asRendered(T.state.danger.strong))
  })

  it('the row itself is not red — only the verb inside it', async () => {
    await openInbox()
    expect(row('menu-junk').style.color).not.toBe(asRendered(T.state.danger.strong))
  })

  it('a non-destructive row carries no danger anywhere', async () => {
    await openInbox()
    for (const id of ['menu-dismiss', 'menu-network', 'menu-close']) {
      expect(labelOf(id).style.color, id).not.toBe(asRendered(T.state.danger.strong))
    }
  })

  it('the armed confirmation keeps its prompt neutral, red on the verb', async () => {
    await openInbox()
    await click(row('menu-junk'))
    const prompt = document.querySelector('[data-menu-confirm-prompt]') as HTMLElement
    expect(prompt).toBeTruthy()
    expect(prompt.style.color).not.toBe(asRendered(T.state.danger.strong))
    const yes = document.querySelector('[data-testid="menu-confirm-junk-yes"] [data-menu-label]') as HTMLElement
    expect(yes.style.color).toBe(asRendered(T.state.danger.strong))
  })
})

describe('3 — the heading is the quietest of the three', () => {
  it('lighter than the description, which is lighter than the label', () => {
    // The ordering, read off the shared module rather than off the screen.
    const ladder = [menuLabelType(false).color, menuDescriptionType.color, menuHeadingType.color]
    expect(ladder).toEqual([T.ink.primary, T.ink.quiet, T.ink.faint])
    expect(new Set(ladder).size).toBe(3) // three distinct tiers, not two
  })

  it('it was previously DARKER than the description — the inversion is gone', () => {
    // T.ink.muted sits a step darker than T.ink.quiet on the ink scale, so a
    // muted heading out-ranked the explanation beneath it.
    expect(menuHeadingType.color).not.toBe(T.ink.muted)
  })

  it('and it is a label, not a control — it orients, it is not an option', async () => {
    await openInbox()
    const h = document.querySelector('[data-bee-row-menu] [data-menu-heading]') as HTMLElement
    expect(h).toBeTruthy()
    expect(h.tagName).toBe('P')
    expect(h.closest('button')).toBeNull()
  })

  it('is lighter in weight than it was, without shrinking', () => {
    expect(Number(menuHeadingType.fontWeight)).toBeLessThan(600)  // was 600
    expect(menuHeadingType.fontSize).toBe('10.5px')               // unchanged
  })
})

describe('4 — the type reaches the browser (the 16px floor)', () => {
  it('globals.css really does floor button font-size', () => {
    // The rule this whole arrangement works around. Asserted from the
    // stylesheet SOURCE, because jsdom never loads it.
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')
    expect(css).toMatch(/input,select,button,textarea\{[^}]*font-size:16px!important/)
  })

  it('so the row button sets NO fontSize — type lives on the spans', async () => {
    await openInbox()
    expect(menuRowBox).not.toHaveProperty('fontSize')
    expect(row('menu-close').style.fontSize).toBe('')
    expect(labelOf('menu-close').style.fontSize).not.toBe('')
    expect(descOf('menu-close').style.fontSize).not.toBe('')
  })

  it('and no menu row reaches for .bee-small-action, which would flatten all three', async () => {
    await openInbox()
    for (const id of ['menu-dismiss', 'menu-network', 'menu-close', 'menu-junk']) {
      expect(row(id).className || '', id).not.toContain('bee-small-action')
    }
  })
})

describe('5 — both menus spend the same shared style', () => {
  it('neither file re-declares the type inline', () => {
    for (const f of ['components/hive/InboxScreen.jsx', 'components/hive/shared/cardKit.jsx']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      // cardKit lives INSIDE shared/, so its path is './menuType'; the Inbox
      // reaches in as './shared/menuType'. Either is the same module.
      expect(src, f).toMatch(/from '\.(\/shared)?\/menuType'/)
      expect(src, f).toContain('menuLabelType(')
      expect(src, f).toContain('menuDescriptionType')
    }
  })

  it('the card menu renders the same label treatment as the Inbox menu', async () => {
    await openInbox()
    const fromInbox = {
      weight: labelOf('menu-close').style.fontWeight,
      size: labelOf('menu-close').style.fontSize,
      color: labelOf('menu-close').style.color,
    }
    await act(async () => { root.unmount() }); root = null; document.body.innerHTML = ''

    await openCard()
    const cardLabel = [...document.querySelectorAll('[data-menu-label]')]
      .find(e => (e.textContent || '').trim() === 'Close') as HTMLElement
    expect(cardLabel).toBeTruthy()
    expect({ weight: cardLabel.style.fontWeight, size: cardLabel.style.fontSize, color: cardLabel.style.color })
      .toEqual(fromInbox)
  })

  it('and the same danger treatment', async () => {
    await openCard()
    const junkLabel = [...document.querySelectorAll('[data-menu-label]')]
      .find(e => (e.textContent || '').trim() === DISPOSITIONS.junk.label) as HTMLElement
    expect(junkLabel.style.color).toBe(asRendered(T.state.danger.strong))
  })

  it('no raw colour value anywhere in the shared style', () => {
    const src = readFileSync(join(process.cwd(), 'components/hive/shared/menuType.js'), 'utf8')
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/rgba?\(/)
  })
})

describe('6 — "Mark as Junk" carries its capital', () => {
  it('in the Inbox row menu', async () => {
    await openInbox()
    expect(labelOf('menu-junk').textContent!.trim()).toBe('Mark as Junk')
  })

  it('in the client card menu', async () => {
    await openCard()
    const labels = [...document.querySelectorAll('[data-menu-label]')].map(e => (e.textContent || '').trim())
    expect(labels).toContain('Mark as Junk')
    expect(labels).not.toContain('Mark as junk')
  })

  it('and its own confirmation agrees with it', async () => {
    await openInbox()
    await click(row('menu-junk'))
    const body = document.body.textContent || ''
    expect(body).toContain('as Junk?')            // the prompt
    expect(body).toContain('Yes, mark as Junk')   // the verb
    expect(body).not.toContain('as junk?')
  })
})
