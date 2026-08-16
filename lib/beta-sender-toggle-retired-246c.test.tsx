// @vitest-environment happy-dom
//
// Issue 246 step 3 — THE ORPHANED SENDER TOGGLE, DELETED.
//
// Step 2 retired locations.split_senders_enabled: it deleted setSplitEnabled()
// from lib/project-type-senders.ts, deleted the PATCH export from
// /api/locations/[id]/project-type-senders, and stopped selecting the column in
// getSenderConfig — so `enabled` left the GET payload too. What it did not do
// is touch ProjectTypeSenders, the component whose only job was to flip that
// flag, and which step 1 had already moved onto the Emails tab.
//
// The result was a control that could not fail loudly: the click PATCHed a
// route with no PATCH export, took the 405, and re-GET a payload with no
// `enabled` key, so the switch flipped on and snapped straight back off. No
// error surfaced. Nothing in the toolchain objected either — BeeHub.jsx is
// .jsx so there is no type error, no lint rule covers a fetch to a dead verb,
// and no test mounted the component.
//
// The fix is deletion, not repair, and the reason is not tidiness. The UI the
// toggle gated wrote location_project_type_senders under the OPPOSITE model to
// the one that replaced it: one person → many types (a person picker plus a
// type multi-select) where NewLeadsSection is one type → one person (a select
// per row). Two editors over one table under contradictory models is a worse
// failure than a dead switch, because both would appear to work.
//
// PINNED HERE:
//   1 · the toggle and everything it gated are gone from the Emails tab, and
//       the tab asks the senders route for nothing at all
//   2 · the three sending identity rows still save, each to its own column
//   3 · the card now says it is the DEFAULT and where the exception is set
//   4 · New leads still owns per-type handlers, unaffected
//   5 · nothing under components/ calls a verb the route does not export
//
// (5) is the general guard — see the note above that describe block for what
// it does and does not cover.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen, CurrentUserContext, CurrentLocationContext } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// A REAL uuid. This is load-bearing: realLocId is gated on UUID_RE, and with a
// non-uuid locId the deleted component used to short-circuit to "Sender routing
// becomes available once your location is saved" and never render its toggle at
// all. A test that mounted with a placeholder id would have passed against the
// unfixed code, which is the whole failure mode this file exists to catch.
const LOC = '132b42c2-0000-4000-8000-000000000001'

const currentUser = {
  id: '9a8b7c6d-1111-4222-8333-444455556666',
  email: 'owner@bee.test',
  name: 'Lynette Ewy',
  role: 'franchise',
  locationId: LOC,
  first_name: 'Lynette',
  last_name: 'Ewy',
  phone: '(816) 555-0100',
  booking_link: null,
}

const currentLocation = {
  id: LOC,
  name: 'Bee Organized Kansas City',
  sender_name: 'Bee Organized KC',
  send_from_email: 'hello@kc.beeorganized.test',
  reply_to_email: 'replies@kc.beeorganized.test',
  lifecycle_status: 'active',
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: Array<{ url: string; method: string; body: any }>

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    return { ok: true, status: 200, json: async () => ({}) }
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

// Fresh root per mount: SettingsScreen seeds activeSection once with useState
// and never re-reads the prop, so reusing a root shows the first section and
// every assertion silently passes against stale DOM. Same reason as the sibling
// comms-tabs suite.
const mount = async (initialSection: string) => {
  await act(async () => root.unmount())
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={currentUser}>
        <CurrentLocationContext.Provider value={currentLocation}>
          <SettingsScreen initialSection={initialSection} franchiseRole="owner" />
        </CurrentLocationContext.Provider>
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})   // flush mount-time fetches
  return container
}

// Section body only — every section label also appears in both navs, so
// container.textContent would match the rail while showing another section.
const bodyText = () => {
  const clone = container.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[data-settings-nav]').forEach(n => n.remove())
  return clone.textContent ?? ''
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE TOGGLE, AND EVERYTHING IT GATED, IS GONE
// ═══════════════════════════════════════════════════════════════════════════
describe('the retired sender toggle no longer renders on Emails', () => {
  it('the Emails tab still renders the sending identity card', async () => {
    // The control group. If this fails the rest of the file is meaningless,
    // because "the toggle is absent" is trivially true of a blank tab.
    //
    // The 'Sending identity' heading went in issue 303 — the card now leads
    // with what the SHOWN SEQUENCE sends as and carries the location trio as a
    // labelled fallback. The three rows are what makes the tab non-blank, so
    // they are what the control group asserts.
    await mount('emails')
    const txt = bodyText()
    expect(txt).toContain('Send From Name')
    expect(txt).toContain('Send From Email')
    expect(txt).toContain('Reply-To Email')
  })

  it('the toggle copy is gone', async () => {
    await mount('emails')
    expect(bodyText()).not.toContain('Send certain project types from someone else')
  })

  it('everything the toggle gated is gone with it', async () => {
    // The one-person-to-many-types editor — the contradictory model, and the
    // real reason this was a deletion rather than a repair.
    //
    // The stub answers the senders route with enabled:true and a full config.
    // That matters: the gated UI only ever rendered when the payload said
    // enabled, so a default `{}` stub leaves it hidden and the assertion below
    // passes against the UNFIXED component too. Written that way this test was
    // vacuous — it passed on pre-deletion code on the first run.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
      const senders = String(url).includes('project-type-senders')
      return {
        ok: true,
        status: 200,
        json: async () => senders ? {
          enabled: true,                        // the retired flag, spoken aloud
          base_sender_email: 'hello@kc.beeorganized.test',
          base_sender_domain: 'kc.beeorganized.test',
          project_types: ['Moving/Relocation', 'Home or Office Organizing'],
          project_type_groups: [
            { label: 'Moving/Relocation', drip_category: 'move' },
            { label: 'Home or Office Organizing', drip_category: 'general' },
          ],
          assignments: [],
          people: [{ id: 'u-carol', name: 'Carol Kern', email: 'carol@bee.test', role: 'manager', domain_warning: false }],
        } : {},
      }
    }))
    await mount('emails')
    const txt = bodyText()
    expect(txt).not.toContain('Assign a sender')
    expect(txt).not.toContain('Choose a team member')
    expect(txt).not.toContain('Project types (unassigned only)')
    expect(txt).not.toContain('Default sender')
    expect(txt).not.toContain('Could not load sender routing')
  })

  it('the identity card carries no switch at all', async () => {
    // Copy-independent: catches a reinstatement that renames the label.
    await mount('emails')
    expect(container.querySelectorAll('[role="switch"]').length).toBe(0)
  })

  it('the Emails tab READS the senders route and never writes to it', async () => {
    // WAS: "asks the senders route for nothing at all", including the GET.
    //
    // Issue 303 deliberately reinstates the GET, and the distinction matters
    // more than the old blanket ban did. What made the orphaned toggle a defect
    // was that a second surface EDITED location_project_type_senders under a
    // model contradicting NewLeadsSection's — one person → many types against
    // one type → one person. Two editors over one table, both appearing to
    // work. A read has none of that: this tab now REPORTS what each job type
    // sends as, because a card that showed the location default under a
    // per-sequence toggle was telling an owner the wrong name.
    //
    // So the invariant is re-aimed at the thing that was actually dangerous:
    // Emails may look, and may not touch.
    await mount('emails')
    const senders = calls.filter(c => c.url.includes('project-type-senders'))
    expect(senders.length, 'the tab reads the config it reports on').toBeGreaterThan(0)
    const writes = senders.filter(c => (c.method || 'GET') !== 'GET')
    expect(writes, JSON.stringify(writes)).toEqual([])
  })

  it('and hosts no per-type editor of its own', async () => {
    // The other half of the same invariant, stated where a reader will find it:
    // reporting is allowed, deciding is not. New leads owns the controls.
    await mount('emails')
    const card = container.querySelector('[data-sequence-sender-card]') as HTMLElement
    expect(card, 'the sequence sender card').toBeTruthy()
    expect(card.querySelectorAll('select')).toHaveLength(0)
    const txt = bodyText()
    expect(txt).not.toContain('Who handles it')
    expect(txt).not.toContain('What it sends as')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE THREE ROWS THAT SURVIVED STILL SAVE
// ═══════════════════════════════════════════════════════════════════════════
// Deleting a sibling out of a card is exactly the edit that takes a working
// row with it, and these three are the only writable thing left on the card.
describe('the sending identity rows still save', () => {
  // Rows are keyed by their visible label; each opens with its own Edit button.
  const editRow = async (label: string, next: string) => {
    const row = Array.from(container.querySelectorAll('div')).find(d => {
      const p = d.querySelector(':scope > div > div > p')
      return p?.textContent?.trim() === label
    })
    expect(row, `row "${label}" not found`).toBeTruthy()
    const edit = Array.from(row!.querySelectorAll('button')).find(b => b.textContent === 'Edit')
    expect(edit, `Edit button for "${label}" not found`).toBeTruthy()
    await act(async () => { edit!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const input = row!.querySelector('input') as HTMLInputElement
    expect(input, `input for "${label}" not found`).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, next)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = Array.from(row!.querySelectorAll('button')).find(b => b.textContent === 'Save')
    expect(save, `Save button for "${label}" not found`).toBeTruthy()
    await act(async () => { save!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }

  const patchBody = () => {
    const patch = calls.find(c => c.method === 'PATCH' && c.url === `/api/locations/${LOC}`)
    expect(patch, `no PATCH to /api/locations/${LOC}; saw ${JSON.stringify(calls)}`).toBeTruthy()
    return patch!.body
  }

  it.each([
    ['Send From Name',  'Bee Organized Overland Park', 'sender_name'],
    ['Send From Email', 'hi@op.beeorganized.test',     'send_from_email'],
    ['Reply-To Email',  'replies@op.beeorganized.test', 'reply_to_email'],
  ])('%s saves to its own column', async (label, next, column) => {
    await mount('emails')
    calls.length = 0
    await editRow(label as string, next as string)
    expect(patchBody()).toEqual({ [column as string]: next })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE CARD'S COPY TELLS THE TRUTH NOW
// ═══════════════════════════════════════════════════════════════════════════
describe('the card says default, and says where the exception lives', () => {
  it('names itself the default rather than the only answer', async () => {
    // The old line — "The name and address your new-lead follow-up emails come
    // from" — read as absolute while resolveProjectTypeSenderOverride was
    // already replacing it per job type. That was survivable while the override
    // was a control ON this card. Step 2 moved it to another tab, and the line
    // became a statement with no visible exception anywhere near it.
    //
    // Step 3 answered that with the WORD "default". Issue 303 answered it
    // properly: the card now names the actual per-type senders, so the location
    // trio does not have to describe its own exceptions in prose — it sits under
    // "Everything else" and says when that is. The word was only ever a proxy
    // for "this is not the whole answer", so the assertion moves to the thing
    // the word stood for.
    await mount('emails')
    const txt = bodyText()
    expect(txt).toContain('Everything else')
    expect(txt).toMatch(/any kind of job you have not given to someone/)
    // Still says where the exception is SET, which is the half step 3 added.
    expect(txt).toMatch(/New leads/)
  })

  it('does not promise to be the only sender', async () => {
    await mount('emails')
    expect(bodyText()).not.toContain('The name and address your new-lead follow-up emails come from.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · NEW LEADS STILL OWNS PER-TYPE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
// The behaviour of those dropdowns is pinned in beta-new-leads-246b. What this
// checks is the thing step 3 could plausibly have broken: that the surface is
// still mounted and still the ONLY caller of the route.
describe('New leads is unaffected, and is now the sole caller', () => {
  it('still mounts NewLeadsSection with the real location uuid', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    expect(src).toContain('<NewLeadsSection realLocId={realLocId}')
  })

  it('exactly one component WRITES to the senders route, and it is that one', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    // Slice the section rather than grepping the file: a whole-file count would
    // be satisfied by any caller anywhere, which is precisely how the orphan
    // survived review.
    const a = src.indexOf('export function NewLeadsSection(')
    const b = src.indexOf('function fmtCents(', a + 1)
    expect(a, 'NewLeadsSection not found').toBeGreaterThan(-1)
    expect(b, 'end marker not found').toBeGreaterThan(a)
    const inside = src.slice(a, b)
    const outside = src.slice(0, a) + src.slice(b)
    expect(inside).toContain('project-type-senders')

    // WAS: no other caller at all. Issue 303 adds a second READER — the Emails
    // tab reports what each job type sends as — and the ban narrows to what was
    // actually dangerous. The orphaned toggle was a second EDITOR of
    // location_project_type_senders under the opposite model to this one, and
    // two editors over one table both appear to work. A reader cannot do that.
    //
    // So: every fetch to the route outside NewLeadsSection must be a GET. This
    // reads the option bag of each call rather than trusting the surrounding
    // prose, so a future POST added anywhere else in the file fails here.
    const others = Array.from(
      outside.matchAll(/fetch\(\s*`[^`]*project-type-senders`\s*,\s*\{([\s\S]{0,200}?)\}/g),
    ).map(m => m[1])
    expect(others.length, 'the Emails tab reader should be found').toBeGreaterThan(0)
    for (const opts of others) {
      expect(opts, `a non-GET call outside NewLeadsSection: ${opts}`).not.toMatch(/method\s*:/)
    }
    // And no bare-URL write can hide behind a missing option bag either.
    expect(outside).not.toMatch(/project-type-senders[\s\S]{0,120}method\s*:\s*['"](POST|PUT|PATCH|DELETE)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · THE GENERAL GUARD — no component calls a verb its route does not export
// ═══════════════════════════════════════════════════════════════════════════
// THIS is the check that would have caught issue 246 step 3 at step 2.
//
// What it does: walks every fetch() in components/ whose URL is an /api/ path,
// resolves that path against app/api/**/route.ts (matching [param] segments),
// and asserts the route file exports the method being called.
//
// What it deliberately does NOT do: prove a route exists for every fetch. URLs
// built across variables are common here and an "unresolvable" bucket that
// nobody can clear is a guard people learn to skip. Unresolvable targets are
// counted and reported, not failed — the assertion is only about calls whose
// route we positively identified. That keeps it at zero false alarms, which is
// what makes it survivable.
//
// Scope note: this catches verb-level rot (a deleted export), not payload rot
// (a field the handler stopped reading). getSenderConfig dropping `enabled`
// from its response would still slip past — that half needs a mount test, which
// is what section 1 is.
describe('every component fetch names a verb its route exports', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(entry => {
      const p = join(dir, entry)
      return statSync(p).isDirectory() ? walk(p) : [p]
    })

  const ROUTES = (() => {
    const root = join(process.cwd(), 'app/api')
    const map = new Map<string, Set<string>>()
    for (const f of walk(root)) {
      if (!/route\.tsx?$/.test(f)) continue
      const src = readFileSync(f, 'utf8')
      const verbs = new Set<string>()
      for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/g)) {
        verbs.add(m[1])
      }
      // '/api/locations/[id]/project-type-senders'
      const url = '/api/' + f.slice(root.length + 1).replace(/\/route\.tsx?$/, '')
      map.set(url, verbs)
    }
    return map
  })()

  // A fetch URL with template holes → the route key it matches, or null.
  // `/api/locations/${realLocId}/project-type-senders` → the [id] route.
  //
  // Two rules, both learned by getting this wrong first:
  //   · STATIC BEATS DYNAMIC, as in Next itself. Without it /api/hub_users/me
  //     resolves to /api/hub_users/[id] and every real call looks broken —
  //     17 false alarms on first run, which would have made the guard useless.
  //   · An INTERPOLATED segment can only fill a [param] slot. `${endpoint}`
  //     against a literal route segment is a URL we cannot pin down, so it goes
  //     to the unresolved bucket instead of matching whatever sorts first.
  // A tie on specificity is likewise unresolved, never a guess.
  const resolve = (raw: string): string | null => {
    const path = raw.split('?')[0].replace(/\/+$/, '')
    if (!path.startsWith('/api/')) return null
    const parts = path.split('/')
    let best: string | null = null
    let bestStatic = -1
    let tied = false
    for (const key of ROUTES.keys()) {
      const kp = key.split('/')
      if (kp.length !== parts.length) continue
      let statics = 0
      let ok = true
      for (let i = 0; i < kp.length; i++) {
        if (/^\[.*\]$/.test(kp[i])) continue            // [param] takes any value
        if (parts[i].includes('${')) { ok = false; break }   // value ≠ literal
        if (kp[i] !== parts[i]) { ok = false; break }
        statics++
      }
      if (!ok) continue
      if (statics > bestStatic) { bestStatic = statics; best = key; tied = false }
      else if (statics === bestStatic) tied = true
    }
    return tied ? null : best
  }

  it('holds across every component, with no unresolvable target left silent', () => {
    const files = walk(join(process.cwd(), 'components')).filter(f => /\.(jsx?|tsx?)$/.test(f))
    const problems: string[] = []
    let checked = 0
    const unresolved: string[] = []

    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // Strip comments first: a commented-out fetch is documentation, and a
      // guard that fails on prose gets deleted rather than obeyed.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const rel = f.slice(process.cwd().length + 1)

      // Variables that hold an /api/ URL, so `fetch(base, …)` is checkable.
      // NOT optional cleverness: the defect this whole file commemorates was
      // written exactly that way —
      //     const base = realLocId ? `/api/locations/${realLocId}/…` : null
      //     fetch(base, { method:'PATCH', … })
      // A literals-only scanner reports zero problems on it. A name bound to
      // two different /api/ URLs is dropped rather than guessed at.
      const vars = new Map<string, string | null>()
      for (const v of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
        const lit = v[2].match(/[`'"](\/api\/[^`'"]*)[`'"]/)
        if (!lit) continue
        vars.set(v[1], vars.has(v[1]) && vars.get(v[1]) !== lit[1] ? null : lit[1])
      }

      // fetch(`...`, { ... method:'PATCH' ... }) — literal or variable target,
      // plus the bare-GET form with no init object.
      for (const m of code.matchAll(/fetch\(\s*(?:[`'"]([^`'"]+)[`'"]|([A-Za-z_$][\w$]*))\s*(?:,\s*\{([\s\S]{0,400}?)\})?\s*\)/g)) {
        const url = m[1] ?? (m[2] ? vars.get(m[2]) : null)
        if (!url || !url.startsWith('/api/')) continue
        const verb = (m[3]?.match(/method\s*:\s*['"](\w+)['"]/)?.[1] || 'GET').toUpperCase()
        const key = resolve(url)
        if (!key) { unresolved.push(`${rel}: ${verb} ${url}`); continue }
        checked++
        const verbs = ROUTES.get(key)!
        if (!verbs.has(verb)) {
          problems.push(`${rel}: ${verb} ${url} → ${key}/route.ts exports only [${[...verbs].sort().join(', ')}]`)
        }
      }
    }

    // The guard must actually be looking at something. If a refactor changes
    // how components call the API, this trips before the assertion below can
    // pass vacuously.
    expect(checked, 'no component fetches were resolvable — the guard has gone blind').toBeGreaterThan(20)
    expect(problems, `\n${problems.length} component call(s) to a verb the route does not export:\n  · ${problems.join('\n  · ')}\n`).toEqual([])
    // Reported, never failed — see the note above this describe block.
    if (unresolved.length) console.info(`[verb-guard] ${unresolved.length} unresolvable target(s), not checked:\n  ${unresolved.join('\n  ')}`)
  })
})
