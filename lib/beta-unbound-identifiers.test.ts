// Unbound identifiers fail the suite.
//
// WHY THIS EXISTS. 1733156: Home crashed for every user because App's
// DashboardScreen mount said `allOverview={allOverview}` where the binding in
// scope was named `initialAllOverview`. BeeHub.jsx is JS, so `next build`
// cannot catch an unbound identifier, and source-pin tests cannot either (the
// string IS in the source; it just doesn't resolve). The same sweep then found
// SIX more pre-existing unbound references in BeeHub.jsx (setCrmStatus ×2,
// livePrices, getTierPrice, locationSeats ×2) plus a seventh (tpl) from the
// template stage-2 work — every one a ReferenceError waiting on a click.
//
// This test parses every non-test .js/.jsx file under components/, lib/ and
// app/ and resolves every identifier reference against its scope chain
// (lib/unboundScan.mjs). One unbound reference anywhere fails the suite.
// .ts/.tsx are excluded on purpose: `next build` type-checks those already.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
// @ts-ignore — plain-JS module, no declaration file
import { scanSource } from './unboundScan.mjs'

const ROOTS = ['components', 'lib', 'app']

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(p, out)
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(p)
  }
  return out
}

describe('unbound identifier sweep', () => {
  it('every identifier reference in every js/jsx file resolves', () => {
    const files = ROOTS.flatMap(r => collectFiles(r))
    // If this ever reads 0, the walk broke — that must fail loudly, not pass
    // as a vacuous green.
    expect(files.length).toBeGreaterThan(50)

    const hits = files.flatMap(f => scanSource(readFileSync(f, 'utf8'), f))
    const report = hits.map(
      (h: any) => `${h.file}:${h.line}:${h.column} — "${h.name}" does not resolve to any binding or known global`
    )
    expect(report).toEqual([])
  })

  it('the scanner catches the allOverview class of bug (self-check)', () => {
    // The exact shape that took Home down: a JSX prop whose value identifier
    // exists in the source under a DIFFERENT name.
    const buggy = `
      import React from 'react'
      function Screen({ allOverview }) { return <div>{allOverview.count}</div> }
      export default function App({ initialAllOverview }) {
        return <Screen allOverview={allOverview} />
      }
    `
    const hits = scanSource(buggy, 'synthetic.jsx')
    expect(hits.map((h: any) => h.name)).toEqual(['allOverview'])

    // Negative control: the fixed version is clean.
    const fixed = buggy.replace('allOverview={allOverview}', 'allOverview={initialAllOverview}')
    expect(scanSource(fixed, 'synthetic.jsx')).toEqual([])
  })

  it('understands the scoping the codebase actually uses (no false positives)', () => {
    // Hoisting, destructuring w/ defaults, catch params, JSX member tags,
    // shorthand object values, typeof-on-undeclared — all legal, all clean.
    const legal = `
      import * as NS from 'x'
      const { a, b = a, ...rest } = someObj()
      function someObj() { return {} }
      export function C({ list = [] }) {
        try { risky() } catch (err) { console.log(err) }
        for (const item of list) NS.track(item)
        const tpl = list[0]
        const pair = { tpl }
        if (typeof maybeGlobalFlag !== 'undefined') NS.track(pair)
        return <NS.Widget data={pair}>{list.map(x => <span key={x}>{x}</span>)}</NS.Widget>
      }
      function risky() {}
    `
    expect(scanSource(legal, 'synthetic.jsx')).toEqual([])
    // …but shorthand for a name that is NOT in scope is the tpl bug.
    expect(
      scanSource('const tmpl = {}; export const x = { master: tmpl, tpl }', 'synthetic.js')
        .map((h: any) => h.name)
    ).toEqual(['tpl'])
  })
})
