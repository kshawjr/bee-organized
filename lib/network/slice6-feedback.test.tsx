// @vitest-environment happy-dom
//
// Slice 6 feedback, from Kevin using the preview (2026-11-19). What this pins:
//
//   · NOT SURE YET IS FIRST in every list that shows the types: the shared
//     order (NET_TYPES), the add box's type picker, the import's column guide,
//     and no Network file keeps a type order of its own. (The pill row and the
//     groups on the list are pinned in list-screen.test.tsx and list.test.ts.)
//   · THE BULK BAR sits inside the content area, never under Bee Hub's left
//     menu: it is no longer centred on the whole window (left:50% and a
//     translate), its edges come from the left menu's width (--bee-rail-w)
//     on a desktop and 16px gutters on a phone, and it is never wider than
//     the list. happy-dom lays nothing out, so this pins the rules; the real
//     proof is the Chromium measurement in the report.
//   · The click-away menus are pinned in list-screen.test.tsx and
//     add-import-screens.test.tsx; the one exception to Bee Hub's sweep is in
//     lib/beta-no-outside-close.test.tsx.
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AddContactDialog from '@/components/network/AddContactDialog'
import ImportDialog from '@/components/network/ImportDialog'
import { NET_TYPES, TYPE_META } from '@/lib/network/types'
import { IMPORT_COLUMNS } from '@/lib/network/csv'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let root: any = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })
const mount = async (el: React.ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(el) })
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[]
const json = (body: any) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
const fetchImpl = vi.fn((url: string) => (url.startsWith('/api/lookups?') ? json({ lookups: [], location: { name: 'Seattle' } }) : json({ ok: true, mappings: {} })))
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

describe('Not sure yet is first wherever the types are listed', () => {
  it('the one shared order starts with Not sure yet', () => {
    expect(NET_TYPES[0]).toBe('unsure')
    expect(TYPE_META[NET_TYPES[0]!].label).toBe('Not sure yet')
  })
  it('the add box offers Not sure yet first', async () => {
    await mount(<AddContactDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onAdded={() => {}} fetchImpl={fetchImpl as any} />)
    expect($$('[data-types] [data-type]').map((b) => b.dataset.type)).toEqual(['unsure', 'partner', 'vendor', 'nurture', 'organization'])
    expect($$('[data-types] [data-type] b')[0]!.textContent).toBe('Not sure yet')
  })
  it('the import box’s column guide names unsure first', async () => {
    await mount(<ImportDialog locationId={LOC} locationName="Seattle" onClose={() => {}} fetchImpl={fetchImpl as any} />)
    const type = $$('[data-guide] dt').find((d) => d.textContent === 'Type')!
    expect(type.nextElementSibling!.textContent).toMatch(/^unsure, partner, vendor, nurture, or organization\./)
    expect(IMPORT_COLUMNS.find((c) => c.key === 'Type')!.help.startsWith('unsure,')).toBe(true)
  })
  it('no Network file keeps a type order of its own: every list goes through NET_TYPES', () => {
    const files = [
      ...readdirSync(join(process.cwd(), 'components/network')).map((f) => `components/network/${f}`),
      ...readdirSync(join(process.cwd(), 'lib/network')).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('.test.')).map((f) => `lib/network/${f}`),
      ...readdirSync(join(process.cwd(), 'app/api/network'), { recursive: true } as any).map(String).filter((f) => f.endsWith('.ts')).map((f) => `app/api/network/${f}`),
    ].filter((f) => /\.(jsx|tsx|ts|js)$/.test(f))
    const LIT = "'(?:partner|vendor|nurture|organization|unsure)'"
    const LIST = new RegExp(`\\[\\s*${LIT}(?:\\s*,\\s*${LIT}){2,}\\s*\\]`, 'g')
    const own: string[] = []
    for (const f of files) {
      for (const m of Array.from(read(f).matchAll(LIST))) if (!/^\[\s*'unsure'/.test(m[0])) own.push(`${f}: ${m[0]}`)
    }
    expect(own).toEqual([])
  })
})

describe('the bulk bar stays inside the content area', () => {
  const src = read('components/network/NetworkListScreen.jsx')
  const rules = Array.from(src.matchAll(/\[data-network-ui\] \.nw-bulk\{([^}]*)\}/g)).map((m) => m[1]!)
  const base = rules[0]!
  it('is not centred on the whole window any more (that put its left end under the left menu)', () => {
    expect(base).toMatch(/position:fixed/)
    expect(base).not.toMatch(/left:50%/)
    expect(base).not.toMatch(/translateX/)
    expect(base).not.toMatch(/100vw/)
  })
  it('takes its edges from the content area and is never wider than the list', () => {
    expect(base).toMatch(/left:32px;right:32px;margin:0 auto;max-width:1088px/)
    // the list itself: 1152 wide with 32px each side = 1088 of content
    expect(src).toMatch(/\.nw-wrap\{width:100%;max-width:1152px;margin:0 auto;padding:24px 32px 40px\}/)
  })
  it('on a desktop it starts after Bee Hub’s left menu, whatever its width', () => {
    expect(src).toContain('@media (min-width:768px){ [data-network-ui] .nw-bulk{left:calc(var(--bee-rail-w,0px) + 32px)} }')
    // the menu's width really is published under that name, and the content
    // area really starts after it at 768px and up
    expect(read('components/BeeHub.jsx')).toContain("'--bee-rail-w': `${railCollapsed ? RAIL_W_COLLAPSED : RAIL_W}px`")
    expect(read('app/globals.css')).toMatch(/@media\(min-width:768px\)\{[^\n]*\.bee-main\{margin-left:var\(--bee-rail-w,192px\)!important\}/)
  })
  it('on a phone it keeps a 16px gutter each side', () => {
    expect(src).toMatch(/@media \(max-width:600px\)\{ \[data-network-ui\] \.nw-bulk\{left:16px;right:16px;/)
  })
})
