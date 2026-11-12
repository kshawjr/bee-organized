// @vitest-environment happy-dom
//
// The switch on Settings › Slack: "Make a Slack channel for every new job"
// (2026-11-12, slice 3 of 3). components/hive/SlackAutoChannels.jsx against a
// canned server. The rules themselves are the server's and are tested in
// lib/beta-job-channel-auto.test.ts; this pins what the owner sees and what
// the screen sends. What it LOOKS like was checked in a real browser at 1280,
// 390 and 320 wide.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import SlackAutoChannels, { AUTO_LABEL, AUTO_OFF_LINE, AUTO_NEEDS_RECONNECT, AUTO_OWNER_ONLY, autoOnLine, autoCappedLine } from '@/components/hive/SlackAutoChannels'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OFF = { setUp: true, on: false, since: null, capped: false, cap: 15, connected: true, reconnected: true, canSet: true }
const ON = { ...OFF, on: true, since: '2026-11-12T21:02:00Z' }

let answer: any, postAnswer: any, calls: { url: string; method: string; body: any }[]
let host: HTMLElement, root: ReturnType<typeof createRoot>
const res = (j: any, status = 200) => ({ ok: status < 400, status, json: async () => j }) as any

beforeEach(() => {
  document.body.innerHTML = ''; calls = []; answer = { ...OFF }; postAnswer = null
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
    const method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: String(url), method, body })
    if (method === 'POST') return postAnswer ? postAnswer(body) : res({ ...answer, on: body.on, since: body.on ? '2026-11-12T21:02:00Z' : null })
    return res(answer)
  }))
})
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.unstubAllGlobals() })

const mount = async () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(<SlackAutoChannels locationId={LOC} />) })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}
const sw = () => host.querySelector('[data-slack-auto-switch]') as HTMLButtonElement | null
const tap = async () => { await act(async () => { sw()!.click(); await new Promise(r => setTimeout(r, 0)) }) }
const posts = () => calls.filter(c => c.method === 'POST')

describe('the switch for automatic job channels', () => {
  it('OFF by default: a real switch, off, named by its label, saying how a channel is made by hand', async () => {
    await mount()
    expect(sw()!.getAttribute('role')).toBe('switch')
    expect(sw()!.getAttribute('aria-checked')).toBe('false')
    expect(sw()!.disabled).toBe(false)
    expect(document.getElementById(sw()!.getAttribute('aria-labelledby')!)!.textContent).toBe(AUTO_LABEL)
    expect(AUTO_LABEL).toBe('Make a Slack channel for every new job')
    expect(host.querySelector('[data-slack-auto-off]')!.textContent).toBe(AUTO_OFF_LINE)
    expect(host.querySelector('[data-slack-auto-on], [data-slack-auto-capped], [data-slack-auto-reason]')).toBeNull()
    expect(calls).toEqual([{ url: `/api/locations/${LOC}/slack-auto-channels`, method: 'GET', body: null }])
  })

  it('opening the page changes nothing: one read, no write', async () => {
    await mount()
    expect(posts()).toEqual([])
  })

  it('tapping it on sends on:true once, and then says since when, what it does, what it leaves alone, and the ceiling', async () => {
    await mount()
    await tap()
    expect(posts()).toEqual([{ url: `/api/locations/${LOC}/slack-auto-channels`, method: 'POST', body: { on: true } }])
    expect(sw()!.getAttribute('aria-checked')).toBe('true')
    const line = host.querySelector('[data-slack-auto-on]')!.textContent!
    expect(line).toMatch(/^On since .+\. Each job created in Jobber after that gets its own channel/)
    expect(line).toContain(autoOnLine(15))
    expect(autoOnLine(15)).toBe('Each job created in Jobber after that gets its own channel, and people are added as you put them on its visits. Jobs you already had are left alone. Bee Hub makes at most 15 a day.')
    expect(host.querySelector('[data-slack-auto-off]')).toBeNull()
  })

  it('tapping it off sends on:false', async () => {
    answer = { ...ON }
    await mount()
    expect(sw()!.getAttribute('aria-checked')).toBe('true')
    await tap()
    expect(posts().map(p => p.body)).toEqual([{ on: false }])
    expect(sw()!.getAttribute('aria-checked')).toBe('false')
  })

  it('GREYED when the location has not reconnected: off, disabled, with the reason — and a tap sends nothing', async () => {
    answer = { ...OFF, reconnected: false }
    await mount()
    expect(sw()!.disabled).toBe(true)
    expect(sw()!.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('[data-slack-auto-reason]')!.textContent).toBe(AUTO_NEEDS_RECONNECT)
    expect(AUTO_NEEDS_RECONNECT).toBe('Reconnect Slack first. Until then Bee Hub can’t make channels for this location.')
    expect(sw()!.getAttribute('aria-describedby')).toBe(host.querySelector('[data-slack-auto-reason]')!.parentElement!.id)
    await tap()
    sw()!.disabled = false; await tap(); sw()!.disabled = true          // even with the browser forced
    expect(posts()).toEqual([])
  })

  it('on at a location that has since lost the permission: it can still be turned OFF', async () => {
    answer = { ...ON, reconnected: false }
    await mount()
    expect(sw()!.disabled).toBe(false)
    await tap()
    expect(posts().map(p => p.body)).toEqual([{ on: false }])
  })

  it('THE CEILING: says it is paused, why, what to do for the jobs it skipped, and that it restarts by itself', async () => {
    answer = { ...ON, capped: true }
    await mount()
    const box = host.querySelector('[data-slack-auto-capped]')!
    expect(box.textContent).toBe(autoCappedLine(15))
    expect(autoCappedLine(15)).toBe('Paused: 15 channels were made in 24 hours, the most Bee Hub makes on its own. Jobs created since then have no channel. To give one a channel, open the job and tap the Slack mark. It starts again by itself within 24 hours.')
    expect(box.getAttribute('role')).toBe('status')
    expect(sw()!.getAttribute('aria-checked')).toBe('true')          // still on: it is paused, not turned off
  })

  it('no ceiling notice when it is not capped, or when it is off', async () => {
    answer = { ...ON }
    await mount()
    expect(host.querySelector('[data-slack-auto-capped]')).toBeNull()
    act(() => root.unmount()); host.remove()
    answer = { ...OFF, capped: true }
    await mount()
    expect(host.querySelector('[data-slack-auto-capped]')).toBeNull()
  })

  it('someone who may not set it sees the state, greyed, and is told who can', async () => {
    answer = { ...ON, canSet: false }
    await mount()
    expect(sw()!.disabled).toBe(true)
    expect(sw()!.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[data-slack-auto-reason]')!.textContent).toBe(AUTO_OWNER_ONLY)
    await tap()
    expect(posts()).toEqual([])
  })

  it('when the server refuses, its own words are shown and the switch stays where it was', async () => {
    postAnswer = () => res({ error: 'not_reconnected', message: 'Reconnect Slack first. Bee Hub can’t make channels for this location yet.' }, 409)
    await mount()
    await tap()
    expect(sw()!.getAttribute('aria-checked')).toBe('false')
    const err = host.querySelector('[data-slack-auto-error]')!
    expect(err.textContent).toBe('Reconnect Slack first. Bee Hub can’t make channels for this location yet.')
    expect(err.getAttribute('role')).toBe('alert')
  })

  for (const [why, body] of [
    ['the migration has not run', { setUp: false }],
    ['Slack is not connected at all', { ...OFF, connected: false, reconnected: false }],
  ] as [string, any][]) {
    it(`renders nothing when ${why}`, async () => {
      answer = body
      await mount()
      expect(host.innerHTML).toBe('')
    })
  }

  it('renders nothing when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ error: 'x' }, 500)))
    await mount()
    expect(host.innerHTML).toBe('')
  })

  it('it lives in the Slack card, under the reconnect box, for a connected location', () => {
    const src = readFileSync('components/BeeHub.jsx', 'utf8')
    const card = src.slice(src.indexOf('export function SlackCard('))
    const mountAt = card.indexOf('{connected && !readOnly && <SlackAutoChannels locationId={locationId} />}')
    expect(mountAt).toBeGreaterThan(0)
    expect(mountAt).toBeGreaterThan(card.indexOf('data-slack-channels-reconnect'))
    expect(mountAt).toBeLessThan(card.indexOf('Send test message'))
    expect(src.split('<SlackAutoChannels').length - 1).toBe(1)
  })
})
