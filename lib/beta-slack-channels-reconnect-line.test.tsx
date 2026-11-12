// @vitest-environment happy-dom
//
// Job channels, slice 1 — the reconnect line on the Slack card.
//
//   • connected, but the install predates channels:manage (or is unknown) →
//     one line + a Reconnect Slack button that goes through the existing
//     /api/slack/connect round trip;
//   • connected with the scope → nothing new;
//   • not connected → unchanged (Add to Slack, no reconnect line);
//   • the line lives in the Slack card only — no banner anywhere else.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHub from '@/components/BeeHub'

// BeeHub.jsx is plain JS; its named exports are invisible to the type check.
const SlackCard = (BeeHub as any).SlackCard as React.ComponentType<any>

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LINE = 'Reconnect Slack to turn on channels for your jobs.'
const NEW_SCOPES =
  'chat:write,chat:write.public,channels:read,channels:manage,incoming-webhook,users:read,users:read.email'
const OLD_SCOPES = 'chat:write,chat:write.public,channels:read,incoming-webhook,users:read,users:read.email'

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let hrefValue: string

beforeEach(() => {
  hrefValue = ''
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    get: () => hrefValue,
    set: (v: string) => { hrefValue = v },
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const mount = async (location: Record<string, any>) => {
  await act(async () => {
    root.render(
      <SlackCard
        settings={{ location: { locId: 'portland-01', slackChannelName: '#leads', slackTeamName: 'Portland', ...location } }}
        updateLocation={() => {}}
      />,
    )
  })
}

const text = () => container.textContent || ''
const button = (t: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined

describe('the Slack card', () => {
  it('connected with unknown (null) scopes → the reconnect line and button', async () => {
    await mount({ slackConnected: true, slackScopes: null })
    expect(text()).toContain(LINE)
    expect(button('Reconnect Slack')).toBeTruthy()
  })

  it('connected with old scopes → the reconnect line; the button uses the existing connect flow', async () => {
    await mount({ slackConnected: true, slackScopes: OLD_SCOPES })
    expect(text()).toContain(LINE)
    await act(async () => { button('Reconnect Slack')!.click() })
    expect(hrefValue).toBe('/api/slack/connect?location_id=portland-01')
  })

  // What the box says. It used to promise "Your lead posts keep working either
  // way" while a reconnect could move or break them. With the lead-channel
  // guard (lib/slack-lead-channel.ts, pinned in beta-slack-lead-channel-guard)
  // the promise is true — and the owner is told Slack is about to ask them to
  // pick a channel, so the question does not look like it matters.
  it('says Slack will ask for a channel, that the pick does not matter, and names the channel lead posts stay in', async () => {
    await mount({ slackConnected: true, slackScopes: null, slackChannelName: '#leads' })
    expect(container.querySelector('[data-slack-reconnect-words]')!.textContent).toBe(
      'Reconnect Slack to turn on channels for your jobs. Slack will ask you to pick a channel. It doesn’t matter which one: your lead posts stay in #leads.')
    expect(text()).not.toContain('keep working either way')
  })

  it('a stored channel name without its # still reads as a channel; with no name stored it says so plainly', async () => {
    await mount({ slackConnected: true, slackScopes: null, slackChannelName: 'new-leads' })
    expect(container.querySelector('[data-slack-reconnect-words]')!.textContent).toContain('your lead posts stay in #new-leads.')
    act(() => root.unmount()); root = createRoot(container)
    await mount({ slackConnected: true, slackScopes: null, slackChannelName: '' })
    expect(container.querySelector('[data-slack-reconnect-words]')!.textContent).toContain('your lead posts stay in the channel they go to now.')
  })

  it('Manage connection no longer says a reconnect moves the channel: it says Disconnect, then connect again', async () => {
    await mount({ slackConnected: true, slackScopes: NEW_SCOPES })
    const manage = Array.from(container.querySelectorAll('button')).find(b => /manage/i.test(b.textContent || ''))!
    await act(async () => { manage.click() })
    expect(text()).toContain('Moving lead posts to another channel? Disconnect, then connect again and pick it. Reconnect keeps the channel you have, unless you choose a different workspace.')
    expect(text()).not.toContain('Posting to a different channel or workspace? Reconnect.')
  })

  it('connected with channels:manage → nothing new', async () => {
    await mount({ slackConnected: true, slackScopes: NEW_SCOPES })
    expect(text()).not.toContain(LINE)
    expect(button('Reconnect Slack')).toBeUndefined()
    expect(container.querySelector('[data-slack-channels-reconnect]')).toBeNull()
    // The ordinary connected card is still there.
    expect(button('Send test message')).toBeTruthy()
  })

  it('not connected → unchanged: Add to Slack, no reconnect line', async () => {
    await mount({ slackConnected: false, slackScopes: null })
    expect(button('Add to Slack')).toBeTruthy()
    expect(text()).not.toContain(LINE)
    expect(button('Reconnect Slack')).toBeUndefined()
  })

  it('the line is in the Slack card only — the screen nowhere else mentions it', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    expect(src.split(LINE).length - 1).toBe(1)
    const card = src.indexOf('export function SlackCard(')
    const at = src.indexOf(LINE)
    const nextFn = src.indexOf('\nfunction ', card + 10)
    expect(at).toBeGreaterThan(card)
    expect(at).toBeLessThan(nextFn)
  })
})
