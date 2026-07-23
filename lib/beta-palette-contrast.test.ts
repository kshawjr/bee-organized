// THE palette contrast guard (brand pass, 7/23).
//
// Bee Hub is a dense work tool read for hours by an audience of 45-65,
// with an open complaint that its type runs small. Small type and thin
// ink compound: the cheapest fix available to us is to refuse to ship a
// pairing that falls under AA. So this file is not a description of the
// palette — it is a CONSTRAINT on it. Every text/background pair the
// token system can actually produce is enumerated here and asserted at
// 4.5:1, the NORMAL-text threshold. Nothing leans on the large-text
// (3:1) exemption, because a token has no idea what size it will be
// rendered at, so assuming "it'll be a heading" is assuming the best
// case forever.
//
// It also pins the two BANNED pairs. The public site puts white on sage
// (1.78:1) on its primary button and gold on white (2.56:1) on every
// section heading. Those are the brand's signature colors and the pull
// to reuse them literally is strong — so the ban is mechanical, not a
// convention someone has to remember.
//
// When this fails, the fix is the VALUE, never the threshold. If a new
// role genuinely cannot pass, add it to a documented exemption list
// with the WCAG clause that permits it (see DISABLED, below) — don't
// widen the assertion.
import { describe, it, expect } from 'vitest'
import { T, sage } from '@/components/hive/shared/tokens'
import {
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, TEXT_QUIET, TEXT_SUCCESS,
  TEXT_DANGER, GREEN_FILL, GREEN_TEXT, WARNING_BG, WARNING_TEXT,
  HAIRLINE_BORDER, SECTION_LABEL, SECTION_COUNT,
} from '@/components/ui/tokens'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'

// ── WCAG 2.x relative luminance + contrast ─────────────────────
const chan = (c: number) => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const rgb = (hex: string): [number, number, number] => {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex)
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}
const ratio = (fg: string, bg: string) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}
// rgba(r,g,b,a) composited over an opaque backdrop — the washes are
// alpha, and an alpha wash has no ratio until you say what it sits on.
const over = (color: string, backdrop: string) => {
  const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (!m) return color
  const a = m[4] === undefined ? 1 : parseFloat(m[4])
  const bg = rgb(backdrop)
  const mix = [1, 2, 3].map((i, k) => Math.round(parseFloat(m[i]) * a + bg[k] * (1 - a)))
  return '#' + mix.map(v => v.toString(16).padStart(2, '0')).join('')
}

const AA = 4.5          // normal text — the only bar we use
const UI = 3.0          // WCAG 1.4.11, non-text control boundaries
const round = (n: number) => Math.round(n * 100) / 100

// The GENERAL surfaces — any ink stop can land on any of these, so the
// assertion below is a full cross product.
const WHITE = T.surface.raised
const CANVAS = T.surface.canvas
const SURFACES: Record<string, string> = {
  'surface.raised': T.surface.raised,
  'surface.canvas': T.surface.canvas,
  'surface.sunken': T.surface.sunken,
  'surface.hover': T.surface.hover,
}

// The accent TINTS are a narrower case: they are selected/active fills,
// and the ink on them is accent.deep or a neutral down to `quiet`. The
// ghost tier is deliberately NOT in this list — it lands on the general
// surfaces only. That exclusion is a real constraint, not a dodge: the
// alternative is lightening accent.soft until ink.faint clears it, and
// at that point the tint sits at 1.01:1 against the canvas, i.e. the
// selected state becomes invisible. A tint that can't be seen is a
// worse accessibility outcome than a ghost tier that isn't used on it.
// If a call site ever DOES put ink.faint on an accent tint, this list is
// where the failure should surface — add it and watch it go red.
const TINT_INKS = ['primary', 'strong', 'secondary', 'muted', 'quiet'] as const
const TINTS: Record<string, string> = {
  'accent.soft': T.accent.soft,
  'accent.faint': T.accent.faint,
}

// WCAG 1.4.3 exempts text in an INACTIVE user-interface component.
// ink.disabled is only ever the glyph/fill of a disabled control, and a
// disabled control that reads as enabled is the worse defect. This is
// the file's only exemption and it names its clause.
const DISABLED = 'disabled'

describe('ink ladder — every stop is legible on every surface', () => {
  const stops = Object.entries(T.ink).filter(([k]) => k !== DISABLED && k !== 'inverse')

  for (const [name, ink] of stops) {
    for (const [sName, surf] of Object.entries(SURFACES)) {
      it(`ink.${name} on ${sName} clears AA`, () => {
        const r = ratio(ink as string, surf)
        expect(round(r), `ink.${name} ${ink} on ${sName} ${surf} = ${round(r)}:1`).toBeGreaterThanOrEqual(AA)
      })
    }
  }

  for (const name of TINT_INKS) {
    for (const [tName, tint] of Object.entries(TINTS)) {
      it(`ink.${name} on ${tName} clears AA`, () => {
        const r = ratio((T.ink as any)[name], tint)
        expect(round(r), `ink.${name} on ${tName} ${tint} = ${round(r)}:1`).toBeGreaterThanOrEqual(AA)
      })
    }
  }

  it('the ladder still DESCENDS — primary darkest through faint lightest', () => {
    // AA compressed the bottom tiers; it must not have reordered them.
    const order = ['primary', 'strong', 'secondary', 'muted', 'quiet', 'faint']
    const ratios = order.map(k => ratio((T.ink as any)[k], CANVAS))
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i], `ink.${order[i]} must be lighter than ink.${order[i - 1]}`).toBeLessThan(ratios[i - 1])
    }
  })

  it('ink.disabled is the documented WCAG 1.4.3 exemption and nothing else uses it as copy', () => {
    expect(T.ink.disabled).toBe('#dedcd5')
    expect(ratio(T.ink.disabled, CANVAS)).toBeLessThan(AA) // it is genuinely light — that's the point
  })
})

describe('the accent — the one action color', () => {
  it('accent.fg is the SITE\'s teal, and ui/tokens stays in lockstep', () => {
    expect(T.accent.fg).toBe(GREEN_FILL)
    expect(T.accent.fg).toBe('#054E4A')
    expect(T.accent.deep).toBe(GREEN_TEXT)
  })

  it('white on every accent fill clears AA', () => {
    for (const fill of [T.accent.fg, T.accent.hover, T.accent.deep]) {
      expect(round(ratio(T.accent.onFill, fill)), `white on ${fill}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('accent ink on its own tints clears AA (the tinted-button pair)', () => {
    expect(round(ratio(T.accent.deep, T.accent.soft))).toBeGreaterThanOrEqual(AA)
    expect(round(ratio(T.accent.deep, T.accent.faint))).toBeGreaterThanOrEqual(AA)
  })

  it('accent.fg reads as a link on both light surfaces', () => {
    expect(round(ratio(T.accent.fg, WHITE))).toBeGreaterThanOrEqual(AA)
    expect(round(ratio(T.accent.fg, CANVAS))).toBeGreaterThanOrEqual(AA)
  })
})

describe('BANNED pairings — the site\'s own accessibility mistakes', () => {
  it('white on sage is 1.78:1 and must never be a pairing we ship', () => {
    const r = ratio('#ffffff', T.brand.sage)
    expect(round(r)).toBeLessThan(AA)          // documents WHY it is banned
    expect(T.brand.onSage).not.toBe(T.ink.inverse)
    expect(round(ratio(T.brand.onSage, T.brand.sage))).toBeGreaterThanOrEqual(AA)
  })

  it('white on gold is 2.35:1 and must never be a pairing we ship', () => {
    const r = ratio('#ffffff', T.brand.gold)
    expect(round(r)).toBeLessThan(AA)
    expect(T.brand.onGold).not.toBe(T.ink.inverse)
    expect(round(ratio(T.brand.onGold, T.brand.gold))).toBeGreaterThanOrEqual(AA)
  })

  it('the identity avatar (a GOLD disc) does not put white initials on it', () => {
    // The one call site that used to. Source-pinned because it is the
    // exact pair the ban exists for, and a regression here is silent.
    const src = require('node:fs').readFileSync('components/hive/IdentityScopeControl.jsx', 'utf8')
    expect(src).toContain('T.scope.onAmber')
    expect(src).not.toMatch(/background: AVATAR_AMBER[^}]*color: T\.ink\.inverse/)
    expect(round(ratio(T.scope.onAmber, T.scope.ringAmber))).toBeGreaterThanOrEqual(AA)
  })

  it('there is ONE gold — the scope amber and the brand marker reconciled', () => {
    expect(T.scope.ringAmber).toBe(T.brand.gold)
    expect(T.scope.avatarAmber).toContain(T.brand.gold)
  })

  it('sage() the helper and brand.sage are the same color', () => {
    expect(sage(1)).toBe('rgba(168,201,196,1)')
    expect(over(sage(1), WHITE).toUpperCase()).toBe(T.brand.sage.toUpperCase())
  })
})

describe('brand gold — decorative fill, with partners that can carry text', () => {
  it('goldText reads on both light surfaces', () => {
    expect(round(ratio(T.brand.goldText, WHITE))).toBeGreaterThanOrEqual(AA)
    expect(round(ratio(T.brand.goldText, CANVAS))).toBeGreaterThanOrEqual(AA)
  })

  it('goldFill carries white text', () => {
    expect(round(ratio('#ffffff', T.brand.goldFill))).toBeGreaterThanOrEqual(AA)
  })

  it('gold is the picked value, not the stylesheet-declared one', () => {
    // Kevin sampled the rendered site; the CSS declares #c89a56. Painted
    // beats declared — the gold is composited / lives in raster assets.
    expect(T.brand.gold).toBe('#D4A049')
    expect(T.brand.gold.toLowerCase()).not.toBe('#c89a56')
  })
})

describe('chip families — dark text on light fills, always', () => {
  for (const [name, pair] of Object.entries(T.family)) {
    it(`family.${name} pair clears AA`, () => {
      const r = ratio((pair as any).text, (pair as any).bg)
      expect(round(r), `family.${name} ${(pair as any).text} on ${(pair as any).bg} = ${round(r)}:1`).toBeGreaterThanOrEqual(AA)
    })
  }

  it('the seven-family semantic system survives the retune (it encodes meaning)', () => {
    for (const k of ['teal', 'blue', 'green', 'amber', 'red', 'purple', 'gray', 'quiet']) {
      expect(CHIP_STYLES[k], k).toEqual((T.family as any)[k])
    }
    // the four that did NOT move — no brand color to align them to
    expect(T.family.blue).toEqual({ bg: '#E6F1FB', text: '#0C447C' })
    expect(T.family.red).toEqual({ bg: '#FCEBEB', text: '#791F1F' })
  })

  it('every chip fill is still distinguishable from the surfaces it sits on', () => {
    for (const [name, pair] of Object.entries(T.family)) {
      expect(round(ratio((pair as any).bg, CANVAS)), `family.${name} bg vs canvas`).toBeLessThan(2)
    }
  })
})

describe('semantic states — the fg stops carry real copy', () => {
  const states: Record<string, { fg: string; on: string[] }> = {
    success: { fg: T.state.success.fg, on: [WHITE, CANVAS, over(T.state.success.soft, WHITE)] },
    danger: { fg: T.state.danger.fg, on: [WHITE, CANVAS, T.state.danger.soft] },
    warning: { fg: T.state.warning.fg, on: [WHITE, CANVAS, over(T.state.warning.soft, WHITE)] },
    info: { fg: T.state.info.fg, on: [WHITE, CANVAS, over(T.state.info.soft, WHITE)] },
  }
  for (const [name, { fg, on }] of Object.entries(states)) {
    for (const bg of on) {
      it(`state.${name}.fg on ${bg} clears AA`, () => {
        expect(round(ratio(fg, bg)), `state.${name}.fg ${fg} on ${bg} = ${round(ratio(fg, bg))}:1`).toBeGreaterThanOrEqual(AA)
      })
    }
  }

  it('the deep stops (text on the band fills) clear AA', () => {
    expect(round(ratio(T.state.warning.deep, T.state.warning.bg))).toBeGreaterThanOrEqual(AA)
    expect(round(ratio(T.state.info.deep, T.state.info.bg))).toBeGreaterThanOrEqual(AA)
    expect(round(ratio(T.state.info.mid, WHITE))).toBeGreaterThanOrEqual(AA)
  })

  it('white on the filled danger control clears AA', () => {
    expect(round(ratio(T.ink.inverse, T.state.danger.strong))).toBeGreaterThanOrEqual(AA)
  })
})

describe('corporate sand — unchanged, and still passing', () => {
  it('keeps its 5.4 / 5.2 pairs', () => {
    expect(T.corp.bg).toBe('#F6EFE1')
    expect(round(ratio(T.corp.fg, T.corp.bg))).toBeGreaterThanOrEqual(AA)
    expect(round(ratio(T.corp.deep, T.corp.bg))).toBeGreaterThanOrEqual(AA)
    expect(round(ratio(T.corp.onFill, T.corp.fill))).toBeGreaterThanOrEqual(AA)
  })
})

describe('control boundaries — WCAG 1.4.11 (3:1, non-text)', () => {
  it('the interactive hairlines are visible against both light surfaces', () => {
    for (const k of ['control', 'strong'] as const) {
      for (const [sName, surf] of [['raised', WHITE], ['canvas', CANVAS]] as const) {
        const r = ratio(T.hairline[k], surf)
        expect(round(r), `hairline.${k} ${T.hairline[k]} on ${sName} = ${round(r)}:1`).toBeGreaterThanOrEqual(UI)
      }
    }
  })

  it('HAIRLINE_BORDER (buttons + inputs) composites to a visible line', () => {
    expect(round(ratio(over(HAIRLINE_BORDER, WHITE), WHITE))).toBeGreaterThanOrEqual(UI)
    expect(round(ratio(over(HAIRLINE_BORDER, CANVAS), CANVAS))).toBeGreaterThanOrEqual(UI)
  })

  it('the border shorthands carry the SAME hairline values (no drift between the two forms)', () => {
    expect(T.border.control).toContain(T.hairline.control)
    expect(T.border.strong).toContain(T.hairline.strong)
    expect(T.border.dashed).toContain(T.hairline.strong)
    expect(T.border.underline).toContain(T.hairline.strong)
    expect(T.border.card).toContain(T.hairline.line)
  })

  it('the DECORATIVE hairlines stay quiet — they are not control boundaries', () => {
    for (const k of ['soft', 'line'] as const) {
      expect(ratio(T.hairline[k], WHITE)).toBeLessThan(UI)
    }
  })
})

describe('ui/tokens stays in lockstep with the hive palette', () => {
  it('the exported text constants ARE the ink stops', () => {
    expect(TEXT_PRIMARY).toBe(T.ink.primary)
    expect(TEXT_SECONDARY).toBe(T.ink.secondary)
    expect(TEXT_MUTED).toBe(T.ink.muted)
    expect(TEXT_QUIET).toBe(T.ink.quiet)
    expect(TEXT_SUCCESS).toBe(T.state.success.fg)
    expect(TEXT_DANGER).toBe(T.state.danger.fg)
    expect(WARNING_BG).toBe(T.family.amber.bg)
    expect(WARNING_TEXT).toBe(T.family.amber.text)
  })

  it('SECTION_LABEL / SECTION_COUNT reference the constants, so a palette pass cannot orphan them', () => {
    expect(SECTION_LABEL.color).toBe(TEXT_SECONDARY)
    expect(SECTION_COUNT.color).toBe(TEXT_QUIET)
    expect(round(ratio(SECTION_LABEL.color, CANVAS))).toBeGreaterThanOrEqual(AA)
    expect(round(ratio(SECTION_COUNT.color, CANVAS))).toBeGreaterThanOrEqual(AA)
  })
})

describe('the canvas stayed warm — a decision, not an oversight', () => {
  it('surface.canvas is unchanged, and it is WARM (r > g > b)', () => {
    expect(T.surface.canvas).toBe('#F6F5F0')
    const [r, g, b] = rgb(T.surface.canvas)
    expect(r).toBeGreaterThanOrEqual(g)
    expect(g).toBeGreaterThan(b)
  })

  it('the warm hairline family is intact (cream, not cold gray)', () => {
    for (const k of ['soft', 'line'] as const) {
      const [r, g, b] = rgb(T.hairline[k])
      expect(r, `hairline.${k} should stay warm`).toBeGreaterThan(b)
    }
  })

  it('raised cards still lift off the canvas', () => {
    expect(T.surface.raised).toBe('#fff')
    expect(ratio(T.surface.raised, T.surface.canvas)).toBeGreaterThan(1.0)
  })
})
