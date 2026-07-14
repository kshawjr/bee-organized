// @vitest-environment node
//
// Layer 1 (PRIMARY lockout): middleware bounces a hub_user whose access has
// been removed (disabled_at IS NOT NULL) on EVERY non-exempt route — even
// with a fully valid session — INDEPENDENTLY of the auth ban (Layer 2).
//   • App route  → 307 redirect to /access-removed
//   • API route  → 403 { error: 'access_removed' }
//   • Exempt paths (/access-removed, /auth*, /api/auth*) always pass so the
//     removed user can read the notice and sign out.
//   • An enabled user, and an unauthenticated request, pass through.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => {
  const state: any = { user: { id: 'u1' } as any, disabled_at: null as string | null }
  const reset = () => { state.user = { id: 'u1' }; state.disabled_at = null }
  return { state, reset }
})

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.state.user } }) },
    from: () => {
      const b: any = {}
      b.select = () => b
      b.eq = () => b
      b.single = async () => ({
        data: h.state.user ? { disabled_at: h.state.disabled_at } : null,
        error: null,
      })
      return b
    },
  }),
}))

import { middleware } from '@/middleware'

const reqFor = (path: string) => new NextRequest(new URL('http://localhost' + path))

beforeEach(() => h.reset())

describe('middleware Layer-1 disabled-user bounce', () => {
  it('redirects a disabled user to /access-removed on an app route (valid session, still bounced)', async () => {
    h.state.disabled_at = '2026-07-14T00:00:00Z'
    const res = await middleware(reqFor('/hive'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/access-removed')
  })

  it('returns 403 access_removed for a disabled user on an API route', async () => {
    h.state.disabled_at = '2026-07-14T00:00:00Z'
    const res = await middleware(reqFor('/api/leads'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('access_removed')
  })

  it('does NOT redirect the /access-removed page itself (no loop)', async () => {
    h.state.disabled_at = '2026-07-14T00:00:00Z'
    const res = await middleware(reqFor('/access-removed'))
    expect(res.status).not.toBe(307)
    expect(res.headers.get('location')).toBeNull()
  })

  it('lets a disabled user reach sign-out (/api/auth/signout exempt)', async () => {
    h.state.disabled_at = '2026-07-14T00:00:00Z'
    const res = await middleware(reqFor('/api/auth/signout'))
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(307)
  })

  it('lets an auth route through for a disabled user', async () => {
    h.state.disabled_at = '2026-07-14T00:00:00Z'
    const res = await middleware(reqFor('/auth/login'))
    expect(res.status).not.toBe(307)
  })

  it('passes an ENABLED user through untouched', async () => {
    h.state.disabled_at = null
    const res = await middleware(reqFor('/hive'))
    expect(res.status).not.toBe(307)
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes an unauthenticated request through (auth handled elsewhere)', async () => {
    h.state.user = null
    const res = await middleware(reqFor('/hive'))
    expect(res.status).not.toBe(307)
    expect(res.headers.get('location')).toBeNull()
  })
})
