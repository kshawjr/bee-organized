// The shared tokens of the new look — components/design/tokens.js.
//
// 1) The table is what the export says: every colour is the exact hex of the
//    oklch() written beside it (converted here independently, so a typo in
//    either the hex or the comment fails).
// 2) Settings → Emails still carries its own copy (ET / ER / ESHADOW / EF in
//    components/settings/EmailsScreen.jsx, from 2026-10-30). Until that copy
//    is folded into this file, the two must not drift.
// 3) Dark mode is carried as a COMMENT: nothing exports it, nothing reads it.
// 4) The two older token files are not part of this and were not changed.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as TOKENS from '@/components/design/tokens'
import { T, R, SHADOW, FONT, FONT_STYLESHEET_HREF, alpha } from '@/components/design/tokens'
import { ET, ER, ESHADOW, EF } from '@/components/settings/EmailsScreen'

const SRC = readFileSync(join(process.cwd(), 'components/design/tokens.js'), 'utf8')

// CSS Color 4: oklch → oklab → linear sRGB → sRGB, rounded to 8 bits.
function oklchToHex(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h), b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return '#' + lin.map(v => {
    const c = Math.min(1, Math.max(0, v))
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(g * 255).toString(16).padStart(2, '0')
  }).join('').toUpperCase()
}

// `name: '#HEX', // oklch(L C H)` — live lines and the commented dark ones.
const pairs = (text: string) =>
  Array.from(text.matchAll(/(\w+):\s*'(#[0-9A-F]{6})',\s*\/\/ oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g))
    .map(m => ({ name: m[1], hex: m[2], L: +m[3], C: +m[4], H: +m[5] }))

const darkStart = SRC.indexOf('DARK MODE — NOT BUILT')
const LIGHT_SRC = SRC.slice(0, darkStart)
const DARK_SRC = SRC.slice(darkStart, SRC.indexOf('export const R ='))

describe('the light table is the export, converted exactly', () => {
  it('every exported colour has its oklch() beside it, and the hex is that oklch()', () => {
    const light = pairs(LIGHT_SRC)
    expect(light.map(p => p.name).sort()).toEqual(Object.keys(T).sort())
    for (const p of light) {
      expect(p.hex, `${p.name} oklch(${p.L} ${p.C} ${p.H})`).toBe(oklchToHex(p.L, p.C, p.H))
      expect((T as Record<string, string>)[p.name]).toBe(p.hex)
    }
  })

  it('the gold is the new gold, not today\'s #d4a046', () => {
    expect(T.gold).toBe('#C69856')
    expect(SRC.toLowerCase()).not.toContain('#d4a046')
  })
})

describe('dark mode is carried, commented and unused', () => {
  it('the dark values are there, each the exact hex of its oklch()', () => {
    const dark = pairs(DARK_SRC)
    expect(dark.length).toBe(27)
    for (const p of dark) expect(p.hex, `dark ${p.name}`).toBe(oklchToHex(p.L, p.C, p.H))
    expect(dark.find(p => p.name === 'background')!.hex).toBe('#0F1310')
  })

  it('every dark line is a comment, and nothing dark is exported', () => {
    const lines = DARK_SRC.split('\n').filter(l => /#[0-9A-F]{6}/.test(l))
    expect(lines.length).toBe(27)
    for (const l of lines) expect(l.trimStart().startsWith('//'), l).toBe(true)
    expect(Object.keys(TOKENS).filter(k => /dark/i.test(k))).toEqual([])
    expect(Object.keys(TOKENS).sort()).toEqual(['FONT', 'FONT_STYLESHEET_HREF', 'HONEYCOMB', 'R', 'SHADOW', 'T', 'alpha'])
  })

  it('no rebuilt screen asks the browser about dark mode', () => {
    for (const f of ['components/design/tokens.js', 'components/settings/SettingsShell.jsx']) {
      expect(readFileSync(join(process.cwd(), f), 'utf8'), f).not.toContain('prefers-color-scheme')
    }
  })
})

describe('the Emails copy has not drifted from the shared table', () => {
  it('every colour Emails declares is the shared colour of the same name', () => {
    // ONE known difference, left alone in this slice (Emails is not touched):
    // ET.primaryFg is '#FBFAF8' — the page background's hex — where the
    // export's primary-foreground converts to '#FAF8F5'. One step in two
    // channels, on the text of dark buttons; invisible, but not equal.
    const known: Record<string, string> = { primaryFg: '#FBFAF8' }
    for (const [name, hex] of Object.entries(ET as Record<string, string>)) {
      if (name in known) { expect(hex, `ET.${name} (known difference)`).toBe(known[name]); continue }
      expect((T as Record<string, string>)[name], `T.${name} vs ET.${name}`).toBe(hex)
    }
    expect(T.primaryFg).toBe('#FAF8F5')
  })

  it('corners, shadows and font stacks match', () => {
    for (const [k, v] of Object.entries(ER as Record<string, string>)) expect((R as Record<string, string>)[k], `R.${k}`).toBe(v)
    expect(SHADOW).toEqual(ESHADOW)
    expect(FONT).toEqual(EF)
  })

  it('both screens ask for the fonts at the same address, so the browser fetches them once', () => {
    const emails = readFileSync(join(process.cwd(), 'components/settings/EmailsScreen.jsx'), 'utf8')
    expect(emails).toContain(`<link rel="stylesheet" href="${FONT_STYLESHEET_HREF}" />`)
  })
})

describe('the file stays what it says it is', () => {
  it('pure: imports nothing', () => {
    expect(SRC).not.toMatch(/^\s*import\s/m)
    expect(SRC).not.toMatch(/require\(/)
  })

  it('alpha() turns a hex into an rgba()', () => {
    expect(alpha('#C69856', 0.5)).toBe('rgba(198,152,86,0.5)')
  })

  it('the two older token files are untouched by this slice and do not import this one', () => {
    for (const f of ['components/ui/tokens.js', 'components/hive/shared/tokens.js']) {
      expect(readFileSync(join(process.cwd(), f), 'utf8'), f).not.toContain('design/tokens')
    }
  })
})
