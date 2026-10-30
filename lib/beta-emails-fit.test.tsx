// @vitest-environment happy-dom
//
// THE EMAILS SCREEN FITS (2026-10-30, Kevin looking at it live at ~1100px:
// "the right side of the screen is very compressed and you can't see the
// end"). The cause was the Settings section wrapper — `display:grid` with the
// implicit `auto` column. A grid item's min-width is auto, so the column grew
// to the screen's widest content (five Look cards at 150px+) and pushed past
// the right edge, where html/body overflow-x:hidden cut it off.
//
// happy-dom has no layout engine and ignores @media in computed styles, so
// these pins hold the CHAIN and the BUDGET rather than measuring pixels:
//
//   • every level from the Settings content column to the Emails column can
//     shrink (minWidth 0 / minmax(0, 1fr)); the column is centred and capped
//   • nothing on the mounted screen asks for more fixed width than a phone
//     leaves (390px − 32px page padding − 42px section = 316px), except
//     inside the two places the design scrolls on purpose
//   • the Look row: a scroller below 640px, five columns from 640px — in the
//     stylesheet the screen renders, with no inline style overriding it
//   • a group header is a bordered button with a hover state, and reports
//     open / closed to assistive tech
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHub from '@/components/BeeHub'
import { ET } from '@/components/settings/EmailsScreen'
const { SettingsScreen, EmailsList } = BeeHub as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = '2b3c4d5e-1111-4222-8333-444455556666'
const loc = {
  id: LOC, name: 'Kansas City', address: '1 Main', phone: '(816) 555-0100', bookingLink: 'https://cal.example.com/kc',
  reviewsLink: '', ratePerHour: '$95', serviceRadius: '', timezone: 'America/Chicago', assessmentType: 'in-person',
  smsEnabled: false, jobberConnected: false, jobberAccountId: null, crmStatus: 'active',
  sendFromName: 'Bee Organized Kansas City', sendFromEmail: 'kc@beeorganized.com', replyToEmail: 'kc@beeorganized.com',
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const mountScreen = async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('project-type-senders')) return { ok: true, status: 200, json: async () => ({
      base_sender_email: 'kc@beeorganized.com',
      project_types: ['Home or Office Organizing', 'Moving/Relocation'],
      project_type_groups: [{ label: 'Home or Office Organizing', drip_category: 'general' }, { label: 'Moving/Relocation', drip_category: 'move' }],
      assignments: [{ id: 'a1', project_type: 'Moving/Relocation', sender_name: 'A person with a rather long name indeed', sender_email: 'a.person.with.a.long.address@beeorganized.com', sender_reply_to: null, sender_is_custom: false, source_user_id: 'u1', domain_warning: false }],
      people: [{ id: 'u1', name: 'A person with a rather long name indeed', email: 'a.person.with.a.long.address@beeorganized.com', role: 'manager', domain_warning: false }],
    }) }
    // A real sequence, so the email rows are on the page too.
    if (u === `/api/locations/${LOC}/drip-paths`) return { ok: true, status: 200, json: async () => ({
      default_drip_path: 'organizing-b', default_move_drip_path: 'moving-b',
      paths: [{ id: 'p-org', location_uuid: LOC, path_key: 'organizing-b', name: 'Org b', is_active: true, is_default: true,
        steps: [1, 2, 3, 4].map(o => ({ id: `s${o}`, step_order: o, delay_days: (o - 1) * 5, channel: 'email', subject: `A subject line that is fairly long for step ${o}`,
          body: 'Body', master_template_id: null, template_name: null, template_legacy_id: null, is_active: true })) }],
    }) }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
  await act(async () => { root.render(<SettingsScreen selectedLoc={loc} initialSection="emails" isSuperAdmin />) })
  await act(async () => {}); await act(async () => {})
  return container.querySelector('[data-emails-ui]') as HTMLElement
}

const px = (v: string | undefined | null) => {
  const m = String(v || '').match(/^(\d+(?:\.\d+)?)px$/)
  return m ? Number(m[1]) : null
}

describe('the content column is centred and capped, and the page never scrolls sideways', () => {
  it('every level from the Settings content column down can shrink', async () => {
    const screen = await mountScreen()
    // Walk up from the Emails screen to the Settings flex row.
    const chain: HTMLElement[] = []
    for (let el = screen as HTMLElement | null; el && el !== container; el = el.parentElement) chain.push(el)
    const grid = chain.find(el => el.style.display === 'grid')!
    expect(grid, 'the section wrapper').toBeTruthy()
    expect(grid.style.gridTemplateColumns.replace(/\s/g, '')).toBe('minmax(0,1fr)')
    const column = chain.find(el => el.style.flex === '1 1 auto')!
    expect(column.style.minWidth, 'the Settings content column').toBe('0')
    expect(screen.style.minWidth, 'the Emails screen').toBe('0')
  })

  it('the Emails column is centred, 896px at most, with the export’s side padding', async () => {
    const screen = await mountScreen()
    const page = screen.querySelector('[data-emails-page]') as HTMLElement
    expect(page.style.maxWidth).toBe('896px')
    expect(page.style.margin).toBe('0px auto')
    expect(page.style.padding, 'padding comes from the stylesheet, by width').toBe('')
    const css = Array.from(screen.querySelectorAll('style')).map(s => s.textContent).join('\n').replace(/\s/g, '')
    expect(css).toContain('[data-emails-page]{padding:24px16px}')
    expect(css).toContain('@media(min-width:640px){[data-emails-page]{padding:40px32px}}')
  })
})

describe('nothing on the screen is clipped at 1100px (or 390px)', () => {
  // The narrowest case: 390 − 32 (page) − 42 (section padding + border).
  const BUDGET = 316
  it(`no fixed width outside the design's own scrollers is wider than ${BUDGET}px`, async () => {
    const screen = await mountScreen()
    // Open every fold so everything is on the page.
    for (let i = 0; i < 4; i++) {
      const closed = Array.from(screen.querySelectorAll('button[aria-expanded="false"]')) as HTMLElement[]
      if (!closed.length) break
      await act(async () => { for (const b of closed) b.click() })
    }
    const scrollsOnPurpose = (el: Element) => !!el.closest('[data-look-row], [data-jumpnav], [role="listbox"]')
    const clippedOnPurpose = (el: Element) => {
      for (let p = el.parentElement; p && p !== screen; p = p.parentElement) {
        if (p.style.overflow === 'hidden' && px(p.style.height) != null) return true   // EmailFrame's scaled box
      }
      return false
    }
    expect(screen.querySelectorAll('li[data-email-row]').length, 'email rows are on the page').toBeGreaterThan(2)
    const over: string[] = []
    for (const el of Array.from(screen.querySelectorAll('*')) as HTMLElement[]) {
      if (!el.style || scrollsOnPurpose(el) || clippedOnPurpose(el)) continue
      for (const prop of ['width', 'minWidth', 'flexBasis'] as const) {
        const n = px(el.style[prop])
        if (n != null && n > BUDGET) over.push(`<${el.tagName.toLowerCase()} ${prop}=${n}px> ${(el.textContent || '').slice(0, 40)}`)
      }
      const flex = el.style.flex.match(/(\d+)px/)
      if (flex && Number(flex[1]) > BUDGET) over.push(`<${el.tagName.toLowerCase()} flex=${el.style.flex}>`)
      for (const m of Array.from(el.style.gridTemplateColumns.matchAll(/minmax\((\d+)px/g))) {
        if (Number(m[1]) > BUDGET) over.push(`<${el.tagName.toLowerCase()} grid min ${m[1]}px>`)
      }
    }
    expect(over).toEqual([])
  })

  it('the "By kind of job" dropdowns take their width from the stylesheet: full on a phone, 224px from 640px', async () => {
    const screen = await mountScreen()
    const css = Array.from(screen.querySelectorAll('style')).map(s => s.textContent).join('\n').replace(/\s/g, '')
    expect(css).toContain('[data-emails-ui][data-handler-q]{flex:11100%;min-width:0}')
    expect(css).toContain('@media(min-width:640px){[data-emails-ui][data-handler-q]{flex:00224px}')
    const qs = Array.from(screen.querySelectorAll('[data-handler-q]')) as HTMLElement[]
    expect(qs.length).toBeGreaterThan(0)
    for (const q of qs) {
      expect(q.style.width).toBe('')
      expect((q.querySelector('[data-eselect]') as HTMLElement).style.width).toBe('100%')
    }
  })
})

describe('the Look row scrolls on a phone and is a grid on a desktop', () => {
  it('as the stylesheet the screen renders says, with no inline layout to override it', async () => {
    const screen = await mountScreen()
    const row = screen.querySelector('#style [data-look-row]') as HTMLElement
    expect(row.getAttribute('role')).toBe('radiogroup')
    for (const p of ['display', 'overflowX', 'gridTemplateColumns', 'gridAutoFlow', 'gridAutoColumns'] as const) expect(row.style[p], p).toBe('')
    const css = Array.from(screen.querySelectorAll('style')).map(s => s.textContent).join('\n').replace(/\s/g, '')
    expect(css).toContain('[data-look-row]{display:flex;gap:12px;overflow-x:auto;')
    expect(css).toContain('[data-look-row]>*{flex:00160px;')
    expect(css).toContain('@media(min-width:640px){[data-look-row]{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));overflow-x:visible}')
  })
})

describe('a group header', () => {
  const steps = [1, 2].map(o => ({ id: `db_${o}`, dbId: `st-${o}`, order: o, type: 'email', delay_days: (o - 1) * 5, subject: `S${o}`, body: 'b', isActive: true }))
  const mount = async () => {
    await act(async () => { root.render(<EmailsList pathSteps={{ p: steps }} masterSteps={{}} templates={[]} generalDefault="p" moveDefault={null} />) })
  }
  const header = (title: string) => (Array.from(container.querySelectorAll('[data-fold-header]')) as HTMLElement[]).find(b => b.textContent!.startsWith(title))!

  it('is one bordered button, the whole header, with a hover fill', async () => {
    await mount()
    const b = header('After a job is finished')
    expect(b.tagName).toBe('BUTTON')
    expect(b.style.width).toBe('100%')
    expect(b.style.borderRadius).toBe('14px')
    expect(b.style.border.toLowerCase()).toMatch(new RegExp(`1px solid (${ET.border.toLowerCase()}|rgb\\(225, 226, 220\\))`))
    expect(b.style.padding).toBe('12px')
    expect(b.getAttribute('data-ehover')).toBe('muted')
    expect(b.textContent).toContain('Counted from the day the job closes')      // the blurb is inside it
    expect(b.querySelector('svg')).toBeTruthy()                                     // the chevron
    // The hover rule the attribute selects is in the screen's stylesheet.
    const { EmailsFonts } = await import('@/components/settings/EmailsScreen')
    const host = document.createElement('div'); document.body.appendChild(host)
    const r2 = createRoot(host); await act(async () => { r2.render(<EmailsFonts />) })
    expect(host.querySelector('style')!.textContent).toContain('[data-ehover="muted"]:not(:disabled):hover{background-color:#F2F2EE')
    act(() => r2.unmount()); host.remove()
  })

  it('reports open and closed to assistive tech, and names what it controls', async () => {
    await mount()
    const b = header('After a job is finished')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(b.getAttribute('aria-controls')!)).toBeNull()
    await act(async () => { b.click() })
    const open = header('After a job is finished')
    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(open.getAttribute('aria-controls')!)).toBeTruthy()
    expect(open.parentElement!.tagName).toBe('H3')                                // a heading AND a fold
  })

  it('the corporate section’s fold is the same full-width header', async () => {
    const screen = await mountScreen()
    const fold = screen.querySelector('#masters [data-fold-header]') as HTMLElement
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(fold.style.width).toBe('100%')
    expect(fold.style.borderRadius).toBe('14px')
    expect(fold.getAttribute('data-ehover')).toBe('muted')
    expect(fold.textContent).toContain('The wording every location starts with')
  })
})
