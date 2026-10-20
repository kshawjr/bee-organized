// @vitest-environment node
//
// Other's route-suggestion Slack card (lib/route-suggestion-slack.ts) and the
// card it becomes after a button. Built from REAL suggestions: the territory
// snapshot + Census points that pin stage 3.
import { describe, it, expect, vi } from 'vitest'

// The card builder is pure, but lib/slack-bot builds a client on load.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => ({}) } }))
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRouteSuggestionSlackMessage,
  buildResolvedRouteMessage,
  placeLine,
  OTHER_CARD_COLOR,
  encodeAcceptValue,
  decodeAcceptValue,
  ROUTE_LEAVE,
  ROUTE_NO_COVERAGE,
  SUGGEST_BLOCK_ID,
  ACTIONS_BLOCK_ID,
  DONE_BLOCK_ID,
} from '@/lib/route-suggestion-slack'
import { buildRouteSuggestion } from '@/lib/route-suggestion'
import { rankNearestLocations, type ClaimedZip, type ZipPoint } from '@/lib/zip-proximity'
import { buildLeadSlackMessage } from '@/lib/slack-bot'

const snap = JSON.parse(readFileSync(join(process.cwd(), 'lib/fixtures/zip-proximity-snapshot.json'), 'utf8'))
const CLAIMS: ClaimedZip[] = snap.claims
const COORDS = new Map<string, ZipPoint>(Object.entries(snap.coords as Record<string, [number, number, string | null, string[]]>)
  .map(([zip, [lat, lng, state, states]]) => [zip, { lat, lng, state, states }]))
const suggestionFor = (zip: any, state: any = null) =>
  buildRouteSuggestion({ id: 'lead-1', zip, state }, rankNearestLocations({ zip, leadState: state, coords: COORDS, claims: CLAIMS, limit: 60 }))

const LEAD = (over: any = {}) => ({
  id: 'lead-1', name: 'Jessica Example', email: 'j@example.com', phone: '2395550100', project_type: 'Garage',
  request_details: 'Two-car garage', preferred_contact: 'Text', source: 'Instagram',
  address: '123 Corkscrew Rd', city: 'Estero', state: 'FL', zip: '33928', ...over,
})
const card = (zip: any, state: any = null, leadUrl: string | null = 'https://hive.example/clients/lead-1') =>
  buildRouteSuggestionSlackMessage({ lead: LEAD({ zip }), suggestion: suggestionFor(zip, state), leadUrl })
const blocksOf = (m: { attachments: any[] }) => m.attachments[0].blocks as any[]
const actionsOf = (m: { attachments: any[] }) => blocksOf(m).find((b) => b.block_id === ACTIONS_BLOCK_ID).elements as any[]
const suggestText = (m: { attachments: any[] }) => blocksOf(m).find((b) => b.block_id === SUGGEST_BLOCK_ID).text.text as string
const buttonTexts = (m: { attachments: any[] }) => actionsOf(m).map((e) => e.text.text)

describe('the card', () => {
  it('Estero 33928: three hive buttons with miles, the highlighted one green, Leave in Other, Open; no Log call', () => {
    const m = card('33928')
    expect(buttonTexts(m)).toEqual(['Miami · 48 mi', 'Sarasota · 70 mi', 'Fort Lauderdale · 82 mi', 'Leave in Other', 'Open in Bee Hub'])
    const els = actionsOf(m)
    expect(els[0].style).toBe('primary')
    expect(els[1].style).toBeUndefined()
    expect(els[2].style).toBeUndefined()
    expect(els.map((e) => e.action_id)).toEqual(['route_accept_0', 'route_accept_1', 'route_accept_2', ROUTE_LEAVE, undefined])
    expect(els[3].value).toBe('lead-1')
    expect(els[4].url).toBe('https://hive.example/clients/lead-1')
    expect(JSON.stringify(m)).not.toContain('log_call')
    expect(suggestText(m)).toBe('📍 Closest hives to *33928*:')
  })

  it('each hive button carries the lead and the hive, readable back', () => {
    const els = actionsOf(card('33928'))
    expect(decodeAcceptValue(els[0].value)).toEqual({ lead: 'lead-1', to: 'loc_miami' })
  })

  // Kevin, 20 Oct 2026: Leslie is deciding WHERE it goes, not working it.
  it('carries ONLY the name, the place, the suggestion and the buttons — in that order', () => {
    const m = card('33928')
    const blocks = blocksOf(m)
    expect(blocks.map((b) => b.block_id ?? b.type)).toEqual(['section', SUGGEST_BLOCK_ID, ACTIONS_BLOCK_ID, 'context', 'divider'])
    expect(blocks[0].text.text).toBe('*Jessica Example*\nEstero, FL 33928')
    expect(blocks[3].elements[0].text).toBe('Other · via Bee Hub')
  })

  it.each([
    ['phone', '2395550100'], ['phone label', 'Phone'], ['email', 'j@example.com'], ['email label', 'Email'],
    ['project type', 'Garage'], ['project label', 'Project'], ['preferred contact', 'Preferred contact'],
    ['what they told us', 'Two-car garage'], ['details label', 'What they told us'],
    ['source', 'Instagram'], ['street', 'Corkscrew'],
  ])('leaves out the %s', (_what, text) => {
    expect(JSON.stringify(card('33928'))).not.toContain(text)
  })

  it('the stripe is neutral grey whatever the project type (on a franchise card the colour IS the type)', () => {
    for (const project_type of ['Moving', 'Home Organizing', null]) {
      const m = buildRouteSuggestionSlackMessage({ lead: LEAD({ project_type }), suggestion: suggestionFor('33928'), leadUrl: null })
      expect(m.attachments[0].color).toBe(OTHER_CARD_COLOR)
    }
    expect(OTHER_CARD_COLOR).toBe('#6b7280')
  })

  it('no location at all → says so, rather than a blank line', () => {
    const m = buildRouteSuggestionSlackMessage({ lead: LEAD({ city: null, state: null, zip: null, address: null }), suggestion: suggestionFor(null), leadUrl: null })
    expect(blocksOf(m)[0].text.text).toBe('*Jessica Example*\n_No location given_')
  })

  it('a name with < or & is escaped', () => {
    const m = buildRouteSuggestionSlackMessage({ lead: LEAD({ name: 'A <b> & C' }), suggestion: suggestionFor('33928'), leadUrl: null })
    expect(blocksOf(m)[0].text.text).toBe('*A &lt;b&gt; &amp; C*\nEstero, FL 33928')
  })

  it('Riverside 92503 near-tie: no button is green, and the card says why', () => {
    const m = card('92503')
    expect(actionsOf(m).some((e) => e.style === 'primary')).toBe(false)
    expect(suggestText(m)).toContain('within a few miles of each other')
  })

  it('Schaumburg 60173 (163 mi): a red "Not in our service area" with a confirm that says it emails the customer', () => {
    const m = card('60173')
    const btn = actionsOf(m).find((e) => e.action_id === ROUTE_NO_COVERAGE)!
    expect(btn.text.text).toBe('Not in our service area')
    expect(btn.style).toBe('danger')
    expect(btn.value).toBe('lead-1')
    expect(btn.confirm.text.text).toContain("emails Jessica Example that we don't serve their area")
    expect(suggestText(m)).toContain('The nearest hive is 163 mi away.')
    expect(actionsOf(m).some((e) => e.style === 'primary')).toBe(false)
  })

  it.each([['33928'], ['92503'], ['68310'], ['89509']])('%s (in area or claimed): NO "Not in our service area" button', (zip) => {
    expect(actionsOf(card(zip)).some((e) => e.action_id === ROUTE_NO_COVERAGE)).toBe(false)
  })

  it.each([
    [null, "📍 This lead has no zip, so Bee Hub can't suggest a hive."],
    ['K1A 0B1', '📍 The zip "K1A 0B1" isn\'t a US zip, so Bee Hub can\'t suggest a hive.'],
    ['11111', "📍 *11111* isn't in the Census zip list (often a PO box), so Bee Hub can't measure from it."],
  ])('zip %j: only Leave in Other (and Open), never Not in our service area — and the card says why', (zip, words) => {
    const m = card(zip)
    expect(buttonTexts(m)).toEqual(['Leave in Other', 'Open in Bee Hub'])
    expect(suggestText(m)).toBe(words)
  })

  it('a claimed zip names the claimant as the one green button, no miles', () => {
    const m = card('89509')
    expect(buttonTexts(m)).toEqual(['Reno', 'Leave in Other', 'Open in Bee Hub'])
    expect(actionsOf(m)[0].style).toBe('primary')
    expect(suggestText(m)).toBe("📍 *89509* is on *Reno*'s zip list.")
  })

  it('two claimants: both, neither green, and the card says corporate has not settled it', () => {
    const s = buildRouteSuggestion({ id: 'lead-1', zip: '80126', state: null }, {
      status: 'unknown_zip', zip: '80126',
      claimedBy: [{ slug: 'loc_denver', name: 'Denver', lifecycle_status: 'onboarding' }, { slug: 'loc_westdenver', name: 'West Denver', lifecycle_status: 'active' }],
    })
    const m = buildRouteSuggestionSlackMessage({ lead: LEAD({ zip: '80126' }), suggestion: s, leadUrl: null })
    expect(buttonTexts(m)).toEqual(['Denver', 'West Denver', 'Leave in Other'])
    expect(actionsOf(m).some((e) => e.style === 'primary')).toBe(false)
    expect(suggestText(m)).toContain("Corporate hasn't settled which one covers it.")
  })

  it('a state that disagrees with the zip adds a warning line', () => {
    expect(suggestText(card('33928', 'IA'))).toContain('⚠️ The lead says *IA*, but zip 33928 is somewhere else.')
    expect(suggestText(card('33928', 'FL'))).not.toContain('⚠️')
  })

  it('no suggestion (it failed) still makes a card: Leave in Other and a plain line', () => {
    const m = buildRouteSuggestionSlackMessage({ lead: LEAD(), suggestion: null, leadUrl: null })
    expect(buttonTexts(m)).toEqual(['Leave in Other'])
    expect(suggestText(m)).toContain("couldn't work out a suggestion")
  })

  it('no lead URL → no Open button', () => {
    expect(buttonTexts(card('33928', null, null))).not.toContain('Open in Bee Hub')
  })

  it('the preview line says it needs a hive', () => {
    const m = card('33928')
    expect(m.text).toBe('📍 New lead in Other — needs a hive')
    expect(m.attachments[0].fallback).toBe(m.text)
  })
})

describe('placeLine — city, state, zip; never the street', () => {
  it.each([
    [{ city: 'Estero', state: 'FL', zip: '33928' }, 'Estero, FL 33928'],
    [{ city: ' Estero ', state: ' FL ', zip: ' 33928 ' }, 'Estero, FL 33928'],
    [{ city: 'Estero', state: 'FL', zip: null }, 'Estero, FL'],
    [{ city: 'Estero', state: null, zip: '33928' }, 'Estero, 33928'],
    [{ city: null, state: 'FL', zip: '33928' }, 'FL 33928'],
    [{ city: null, state: null, zip: '33928' }, '33928'],
    [{ city: 'Estero', state: null, zip: null }, 'Estero'],
    [{ city: '', state: '  ', zip: null }, null],
    [{ city: null, state: null, zip: null }, null],
  ])('%j → %j', (lead, line) => {
    expect(placeLine(lead as any)).toBe(line)
  })
})

describe('franchise cards are NOT stripped — the owner works the lead from them', () => {
  it('buildLeadSlackMessage still carries phone, email, project, preferred contact, what they told us, Log call', () => {
    const all = JSON.stringify(buildLeadSlackMessage({ lead: LEAD(), locationName: 'Miami', leadUrl: null }))
    for (const text of ['*Phone:*', '*Email:*', '*Project:*', 'Garage', '*Preferred contact:*', 'What they told us', 'Two-car garage', 'Instagram', 'log_call']) {
      expect(all).toContain(text)
    }
  })
})

describe('the card after a button — edited in place', () => {
  it('the suggestion and buttons are replaced by one line, where the buttons were; the details stay', () => {
    const posted = card('33928')
    const before = blocksOf(posted)
    const at = before.findIndex((b) => b.block_id === SUGGEST_BLOCK_ID)
    const edited = buildResolvedRouteMessage(posted, '✅ Moved to *Miami* by Leslie Mullins.')
    const after = blocksOf(edited)
    expect(after.some((b) => b.block_id === SUGGEST_BLOCK_ID || b.block_id === ACTIONS_BLOCK_ID)).toBe(false)
    expect(after[at]).toEqual({ type: 'context', block_id: DONE_BLOCK_ID, elements: [{ type: 'mrkdwn', text: '✅ Moved to *Miami* by Leslie Mullins.' }] })
    expect(after.length).toBe(before.length - 1)
    expect(JSON.stringify(edited)).toContain('*Jessica Example*')
    expect(edited.attachments[0].color).toBe(posted.attachments[0].color)
    expect(edited.text).toBe(posted.text)
  })

  it('editing an edited card replaces the line rather than stacking a second one', () => {
    const once = buildResolvedRouteMessage(card('33928'), 'first')
    const twice = buildResolvedRouteMessage(once, 'second')
    const done = blocksOf(twice).filter((b) => b.block_id === DONE_BLOCK_ID)
    expect(done).toHaveLength(1)
    expect(done[0].elements[0].text).toBe('second')
  })

  it('no original message still produces a valid edit', () => {
    expect(buildResolvedRouteMessage(undefined, 'x').attachments[0].blocks).toEqual([
      { type: 'context', block_id: DONE_BLOCK_ID, elements: [{ type: 'mrkdwn', text: 'x' }] },
    ])
  })
})

describe('the button value', () => {
  it('round-trips', () => {
    expect(decodeAcceptValue(encodeAcceptValue('lead-9', 'loc_reno'))).toEqual({ lead: 'lead-9', to: 'loc_reno' })
  })
  it.each([['not json'], ['{}'], ['{"lead":"x"}'], ['{"lead":"","to":"y"}'], [null], [42]])('%j → null', (v) => {
    expect(decodeAcceptValue(v)).toBeNull()
  })
})
