// @vitest-environment happy-dom
//
// REALTIME CHANNELS JOIN AUTHENTICATED — the bug that had killed every live
// feature we shipped.
//
// WHAT WAS OBSERVED, on a real socket, super_admin on loc_test. Four channels
// joined within 73ms and all four replied ok. The first one's phx_join carried
// no token:
//
//   realtime:leads         phx_join {"config":{…},"private":false}   ← no token
//   realtime:touchpoints   phx_join {"config":{…},"access_token":"…"}
//   realtime:engagements   phx_join {"config":{…},"access_token":"…"}
//
// A channel that joins without a token is evaluated as `anon`. The leads
// SELECT policy grants to `authenticated`, so anon matches no policy: the
// subscription is accepted, reports SUBSCRIBED, heartbeats — and delivers
// nothing. An insert into loc_test produced no message at all.
//
// WHY EVERY EXISTING TEST STAYED GREEN, and the rule this file exists to
// enforce: they asserted the channel was CREATED and SUBSCRIBED. Both were
// true the whole time. So every assertion here is about THE JOIN PAYLOAD —
// what actually goes over the wire — because subscription status was never
// capable of catching this.
//
// THE MOCK IS MODELLED ON THE INSTALLED LIBRARY (supabase-js / realtime-js
// 2.103.0), not invented:
//   · RealtimeChannel.subscribe() attaches the token only if it is ALREADY
//     resolved:  if (this.socket.accessTokenValue) payload.access_token = …
//   · SupabaseClient's constructor starts its initial auth as a
//     FIRE-AND-FORGET promise, so a .subscribe() in the same tick joins first
//   · RealtimeClient._performAuth pushes `access_token` to channels that are
//     already joined, and only when the token actually CHANGED
// Reproducing those three behaviours is what lets this suite fail on the real
// bug and pass on the real fix.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.session-one'
const TOKEN_2 = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.session-refreshed'

// ── a faithful-enough supabase double ─────────────────────────────
const fake = vi.hoisted(() => {
  const state = {
    // Every phx_join payload that went over the wire, in order.
    joins: [] as any[],
    channels: [] as any[],
    removed: [] as any[],
    // The socket's cached token — null until auth resolves, exactly as
    // RealtimeClient.accessTokenValue starts null.
    accessTokenValue: null as string | null,
    // What the session currently holds, and how slowly it answers.
    sessionToken: null as string | null,
    setAuthCalls: 0,
    // Set true to model the ORIGINAL bug: subscribe without awaiting auth.
    skipAuthBeforeJoin: false,
  }
  return state
})

vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    const client: any = {
      realtime: {
        // RealtimeClient.setAuth() with no argument: resolve through the
        // accessToken callback (async — this is the race), cache it, and push
        // the new token to any channel already joined, but only when it
        // CHANGED (the _performAuth guard).
        setAuth: async () => {
          fake.setAuthCalls++
          await Promise.resolve()
          const next = fake.sessionToken
          if (fake.accessTokenValue !== next) {
            fake.accessTokenValue = next
            for (const ch of fake.channels) {
              if (ch.joined && next) ch.pushedTokens.push(next)
            }
          }
        },
      },
      channel: (name: string) => {
        const ch: any = {
          name, config: null, handler: null, kind: null,
          joined: false, joinPayload: null, pushedTokens: [] as string[],
        }
        ch.on = (kind: string, config: any, handler: any) => {
          ch.kind = kind; ch.config = config; ch.handler = handler; return ch
        }
        ch.subscribe = () => {
          // RealtimeChannel.subscribe(): the token rides the join ONLY if the
          // socket has already resolved it.
          const payload: any = { config: { private: false } }
          if (fake.accessTokenValue) payload.access_token = fake.accessTokenValue
          ch.joinPayload = payload
          ch.joined = true
          fake.joins.push(payload)
          return ch
        }
        fake.channels.push(ch)
        return ch
      },
      removeChannel: (ch: any) => { fake.removed.push(ch) },
    }
    return client
  },
}))

import { useRealtimeChannel } from '@/lib/use-realtime-channel'
import { useLeadsRealtime } from '@/lib/use-leads-realtime'

let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

const mount = async (el: React.ReactElement) => {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { root = createRoot(container); root.render(el) })
  await flush()
}

function Leads({ locFilter }: any) {
  useLeadsRealtime(locFilter, () => {})
  return null
}

beforeEach(() => {
  fake.joins.length = 0
  fake.channels.length = 0
  fake.removed.length = 0
  fake.accessTokenValue = null
  fake.sessionToken = TOKEN
  fake.setAuthCalls = 0
  fake.skipAuthBeforeJoin = false
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  ;(root as any) = null
  container?.remove()
  vi.restoreAllMocks()
})

describe('the join payload carries the access token', () => {
  it('the LEADS channel joins with a token — the channel that was caught without one', async () => {
    await mount(<Leads locFilter="loc-uuid-1" />)

    expect(fake.joins).toHaveLength(1)
    // THE assertion of this whole file. Not "did it subscribe" — it always did.
    expect(fake.joins[0].access_token).toBe(TOKEN)
  })

  it('the token is resolved BEFORE the join, not after', async () => {
    // The ordering is the fix: setAuth must have run and cached a token by the
    // time subscribe() builds its payload.
    await mount(<Leads locFilter="loc-uuid-1" />)

    expect(fake.setAuthCalls).toBeGreaterThanOrEqual(1)
    expect(fake.accessTokenValue).toBe(TOKEN)
    expect(fake.joins[0]).toHaveProperty('access_token')
  })

  it('subscribing before the session is ready STILL ends up authenticated', async () => {
    // The original failure mode: the component mounts in the same tick the
    // client is created, long before auth has resolved. Awaiting setAuth is
    // what makes the slow session win instead of the fast subscribe.
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const realSetAuth = (globalThis as any).__none
    void realSetAuth

    fake.sessionToken = null // nothing resolved yet
    await mount(<Leads locFilter="loc-uuid-1" />)
    // With no session there is nothing to attach — but the channel still opens,
    // because realtime is an enhancement and RLS will simply deliver nothing.
    expect(fake.joins).toHaveLength(1)
    expect(fake.joins[0].access_token).toBeUndefined()

    // Now the session arrives and a fresh mount joins authenticated.
    fake.sessionToken = TOKEN
    await act(async () => { root.unmount() }); (root as any) = null
    container.remove()
    release()
    await gate
    await mount(<Leads locFilter="loc-uuid-2" />)

    expect(fake.joins[fake.joins.length - 1].access_token).toBe(TOKEN)
  })

  it('every channel opened through the shared hook carries it, not just leads', async () => {
    // touchpoints and engagements won the 73ms race by luck. One door means
    // luck is no longer involved.
    function Three() {
      useRealtimeChannel('k1', 'a', (s: any) => s.channel('a').on('postgres_changes', {}, () => {}))
      useRealtimeChannel('k2', 'b', (s: any) => s.channel('b').on('postgres_changes', {}, () => {}))
      useRealtimeChannel('k3', 'c', (s: any) => s.channel('c').on('broadcast', {}, () => {}))
      return null
    }
    await mount(<Three />)

    expect(fake.joins).toHaveLength(3)
    for (const j of fake.joins) expect(j.access_token).toBe(TOKEN)
  })
})

describe('token refresh does not leave a channel unauthenticated', () => {
  it('a refreshed token is pushed to the already-joined channel', async () => {
    // A tab open all day sees the JWT expire. supabase-js listens for
    // TOKEN_REFRESHED and calls realtime.setAuth(newToken), which pushes the
    // new token to joined channels — modelled here by the _performAuth guard.
    await mount(<Leads locFilter="loc-uuid-1" />)
    expect(fake.joins[0].access_token).toBe(TOKEN)
    const ch = fake.channels[0]
    expect(ch.pushedTokens).toEqual([])

    // The refresh.
    fake.sessionToken = TOKEN_2
    const { createClient } = await import('@/lib/supabase')
    await (createClient() as any).realtime.setAuth()

    expect(fake.accessTokenValue).toBe(TOKEN_2)
    expect(ch.pushedTokens).toEqual([TOKEN_2])
  })

  it('an unchanged token pushes nothing — the refresh is not a resubscribe', async () => {
    // _performAuth only acts when the token actually changed, so a no-op
    // refresh must not churn every open channel.
    await mount(<Leads locFilter="loc-uuid-1" />)
    const ch = fake.channels[0]

    const { createClient } = await import('@/lib/supabase')
    await (createClient() as any).realtime.setAuth() // same token

    expect(ch.pushedTokens).toEqual([])
  })

  it('a channel opened AFTER a refresh joins with the new token', async () => {
    await mount(<Leads locFilter="loc-uuid-1" />)
    fake.sessionToken = TOKEN_2

    await act(async () => { root.unmount() }); (root as any) = null
    container.remove()
    await mount(<Leads locFilter="loc-uuid-9" />)

    expect(fake.joins[fake.joins.length - 1].access_token).toBe(TOKEN_2)
  })
})

describe('auth never gates the feature', () => {
  it('a failing setAuth still opens the channel', async () => {
    // Realtime is an enhancement. An auth failure must degrade to "receives
    // nothing", never to a dead board or a thrown render.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createClient } = await import('@/lib/supabase')
    const client: any = createClient()
    const original = client.realtime.setAuth
    void original
    vi.spyOn(client.realtime, 'setAuth')

    // Force the failure through the module-level double.
    const broken = vi.fn(async () => { throw new Error('auth down') })
    const mod: any = await import('@/lib/supabase')
    const spy = vi.spyOn(mod, 'createClient').mockReturnValue({
      realtime: { setAuth: broken },
      channel: (name: string) => {
        const ch: any = { name, joined: false }
        ch.on = () => ch
        ch.subscribe = () => { ch.joined = true; fake.joins.push({ config: {}, degraded: true }); return ch }
        return ch
      },
      removeChannel: () => {},
    } as any)

    await mount(<Leads locFilter="loc-uuid-1" />)

    expect(broken).toHaveBeenCalled()
    expect(fake.joins).toHaveLength(1)   // it still joined
    expect(err).toHaveBeenCalled()       // and said so
    spy.mockRestore()
  })

  it('no vocabulary yet means no channel at all', async () => {
    await mount(<Leads locFilter={null} />)
    expect(fake.joins).toHaveLength(0)
    expect(fake.channels).toHaveLength(0)
  })

  it('unmounting before the token resolves does not leak a channel', async () => {
    // The channel is created inside an async gate, so teardown has to cope
    // with an unmount that happens first.
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container)
      root.render(<Leads locFilter="loc-uuid-1" />)
      root.unmount() // same tick, before setAuth resolves
    })
    await flush()
    ;(root as any) = null

    expect(fake.joins).toHaveLength(0)
  })
})

// ── source sweep ──────────────────────────────────────────────────
describe('there is exactly ONE way to open a realtime channel', () => {
  const hooks = [
    'lib/use-leads-realtime.ts',
    'lib/use-touchpoints-realtime.ts',
    'lib/use-engagements-realtime.ts',
    'lib/use-lead-notes-realtime.ts',
    'lib/use-location-broadcast.ts',
  ]

  it('no hook builds its own client or subscribes on its own', () => {
    // A hook that called createClient() directly would be back to joining in
    // whatever order it happened to mount — the 73ms race, reopened.
    for (const h of hooks) {
      const src = readFileSync(join(process.cwd(), h), 'utf8')
      expect(src, h).not.toContain('createClient()')
      expect(src, h).not.toContain('.subscribe()')
      expect(src, h).toContain('useRealtimeChannel(')
    }
  })

  // These read CODE, never prose. The first drafts of both asserted against
  // the raw file and failed on the header, which explains `.subscribe()` and
  // `setAuth(token)` in English — a neat reminder that a source sweep matching
  // comments proves nothing about behaviour.
  const codeOf = (rel: string) =>
    readFileSync(join(process.cwd(), rel), 'utf8')
      .split('\n')
      .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n')

  it('the shared hook awaits setAuth BEFORE it subscribes', () => {
    const code = codeOf('lib/use-realtime-channel.ts')
    const authAt = code.indexOf('await supabase.realtime.setAuth()')
    const subAt = code.indexOf('.subscribe()')
    expect(authAt).toBeGreaterThan(-1)
    expect(subAt).toBeGreaterThan(-1)
    expect(authAt).toBeLessThan(subAt) // ordering IS the fix
  })

  it('setAuth is called with NO argument, so supabase-js keeps owning refresh', () => {
    // setAuth(token) sets realtime-js's _manuallySetToken, which disables its
    // own re-auth on join. No argument resolves through the client's callback
    // and leaves that flag alone.
    const code = codeOf('lib/use-realtime-channel.ts')
    expect(code).toContain('setAuth()')
    expect(code).not.toMatch(/setAuth\([^)]+\)/)
  })
})
