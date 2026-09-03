// @vitest-environment node
//
// ASK BEE HUB — the suggest-where-to-look license is revoked.
//
// The old instructions told the assistant, when the screen didn't answer,
// to "suggest where they might look" with examples like "the ··· menu on
// that card" — and both real incidents (the invented Add-address button,
// the invented drag-to-closed) were that clause executing as written.
//
// HONESTY ABOUT WHAT THESE TESTS PROVE: they pin the INSTRUCTIONS the
// model receives — the part we control and the part that was actually at
// fault (the inventions were instructed behavior, not defiance). Whether
// the model complies on every question is monitored where the last two
// failures surfaced: the feedback queue. No test here calls the model.
import { describe, it, expect } from 'vitest'
import { buildSystem } from '@/lib/help-chat-prompt'

const SCREEN = {
  name: 'Clients',
  detail: 'Clients · Search · Inbox · Snooze · Log Reach Out · Send to Jobber · Mario Delgado · Final Processing',
}

describe('the license is gone', () => {
  it('no longer tells the model to suggest where to look, and the seed examples are gone', () => {
    const sys = buildSystem(SCREEN)
    expect(sys).not.toContain('suggest where they might look')
    expect(sys).not.toContain('try the Settings screen')
    expect(sys).not.toContain('the ··· menu on that card')
  })

  it('carries the hard rule: never name an off-screen control, do not guess', () => {
    const sys = buildSystem(SCREEN)
    expect(sys).toContain('NEVER name or describe a button, menu')
    expect(sys).toContain('unless its name appears in the screen context')
    expect(sys).toContain('Do not guess what the app "probably" has')
  })

  it('the dead end is replaced with a real next step — the Ask the team in Help link', () => {
    const sys = buildSystem(SCREEN)
    expect(sys).toContain("say plainly that")
    expect(sys).toContain("you can't see that from here")
    expect(sys).toContain('"Ask the\nteam in Help" link')
    expect(sys).toContain('pick Ask a question')
    // the retired affordance can no longer be named
    expect(sys).not.toContain('Report Bug or')
  })
})

describe('screen-answerable questions keep their material', () => {
  it('the live screen text still rides the prompt, and naming what is ON it stays licensed', () => {
    const sys = buildSystem(SCREEN)
    // The context the model may freely cite:
    expect(sys).toContain('Send to Jobber')
    expect(sys).toContain('Final Processing')
    expect(sys).toContain('You may freely name')
    // The always-safe fixed affordances under the chat itself:
    expect(sys).toContain('"Quick Start Guide"')
    expect(sys).toContain('"Manual"')
  })

  it('with no screen detail at all, the rule still stands and nothing dangles', () => {
    const sys = buildSystem(null)
    expect(sys).toContain('NEVER name or describe a button, menu')
    expect(sys).toContain('(No extra on-screen detail was captured.)')
  })
})

// The two known cases, pinned at the instruction layer: the phrases that
// seeded each invention cannot reach the model, and the rule that forbids
// the invented answers travels with EVERY request, screen or no screen.
describe('the two real incidents cannot be re-instructed', () => {
  it("Linette's case: nothing invites inventing an Add button on an address question", () => {
    const sys = buildSystem({ name: 'Clients', detail: 'Mario Delgado · 10 Old Rd, Fairway, KS' })
    expect(sys).not.toMatch(/suggest where/i)
    expect(sys).toContain('a control you invent')
  })

  it("Lori's case: nothing invites inventing a drag gesture on a closing question", () => {
    const sys = buildSystem({ name: 'Clients', detail: 'Final Processing · 11 clients' })
    expect(sys).not.toContain('menu on that card')
    expect(sys).toContain('screen, or gesture')
  })
})
