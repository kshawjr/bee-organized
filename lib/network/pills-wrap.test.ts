// Kevin, 2026-11-20 (seen on the preview): the Network type pills WRAP, and
// Filters stays at the right end of their first line at every width.
// happy-dom lays nothing out, so this pins the CSS that does it; the widths
// were measured in Chromium (1440 down to 360) when it was built: Filters on
// the pills' first line at all ten, nothing past the screen's edge.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'components/network/NetworkListScreen.jsx'), 'utf8')
const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('`', src.indexOf('const CSS = `') + 14))

describe('the type pills wrap; Filters stays put', () => {
  it('the row never wraps Filters onto its own line: the pills shrink and wrap inside their own space', () => {
    expect(css).toContain('[data-network-ui] .nw-refine{display:flex;align-items:flex-start;gap:10px;margin-top:12px;padding-bottom:12px;border-bottom:1px solid ${T.border};flex-wrap:nowrap}')
    expect(css).toContain('[data-network-ui] .nw-pills{display:flex;gap:6px;flex:1 1 auto;min-width:0;flex-wrap:wrap}')
    expect(css).toMatch(/\.nw-menu-row\{display:flex;gap:8px;flex-shrink:0;margin-left:auto;/)
  })
  it('no width turns the wrap off or brings back the sideways scroll', () => {
    const pillRules = css.split('\n').filter((l) => /\.nw-pills\{|\.nw-refine\{/.test(l))
    for (const r of pillRules) {
      expect(r).not.toMatch(/\.nw-pills\{[^}]*nowrap/)
      expect(r).not.toMatch(/\.nw-pills\{[^}]*overflow-x/)
      expect(r).not.toMatch(/\.nw-refine\{[^}]*flex-wrap:wrap/)
    }
  })
})
