// What "Add to Slack" asks a franchise's workspace for (2026-11-12).
//
// Slack fixes permissions at install, so this list was decided as a whole
// before 43 owners were asked to reconnect once: seven added together, and
// one — reading their messages — deliberately never asked for.
// Read from the real redirect the connect route builds, not from a copy.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'u1', role: 'super_admin', location_id: null } }), maybeSingle: async () => ({ data: { id: 'u1', role: 'super_admin', location_id: null } }) }) }) }),
  }),
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => {
    const b: any = {}
    for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'lt']) b[m] = () => b
    b.maybeSingle = async () => ({ data: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', location_id: 'loc_test', name: 'Test' }, error: null })
    b.single = b.maybeSingle
    b.then = (res: any) => Promise.resolve({ data: null, error: null }).then(res)
    return b
  } },
}))

import { GET as connectGET } from '@/app/api/slack/connect/route'

const ADDED = ['pins:write', 'pins:read', 'channels:join', 'bookmarks:write', 'files:write', 'reactions:write', 'groups:write']
const BEFORE = ['chat:write', 'chat:write.public', 'channels:read', 'channels:manage', 'incoming-webhook', 'users:read', 'users:read.email']

async function asked(): Promise<string[]> {
  const res = await connectGET(new NextRequest('http://x/api/slack/connect?location_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
  const to = res.headers.get('location')
  expect(to, 'the connect route should redirect to Slack').toBeTruthy()
  const url = new URL(to!)
  expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
  expect(url.searchParams.get('user_scope')).toBeNull()        // nothing is asked on a person's behalf
  return (url.searchParams.get('scope') || '').split(',')
}

beforeEach(() => {
  process.env.SLACK_CLIENT_ID = 'cid'; process.env.SLACK_CLIENT_SECRET = 'sec'
  process.env.NEXT_PUBLIC_APP_URL = 'https://hub.test'
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the permissions the "Add to Slack" link asks for', () => {
  it('exactly the seven added on 2026-11-12, on top of the seven it already asked for — fourteen, each once, nothing else', async () => {
    const scopes = await asked()
    expect(scopes).toEqual([...BEFORE, ...ADDED])
    expect(ADDED).toHaveLength(7)
    expect(new Set(scopes).size).toBe(14)
    expect(scopes.every(s => /^[a-z-]+(:[a-z.]+)*$/.test(s))).toBe(true)   // no stray space or empty entry
  })

  it('NOT channels:history — and no other permission to read a workspace’s messages or files', async () => {
    const scopes = await asked()
    expect(scopes).not.toContain('channels:history')
    for (const s of scopes) {
      expect(s, s).not.toMatch(/:history$/)
      expect(s, s).not.toMatch(/^(search|files:read|im|mpim|groups:read|groups:history|admin|usergroups|dnd|emoji|team|links|remote_files|calls|conversations\.connect)/)
    }
    // The only ":read" permissions are the three named here.
    expect(scopes.filter(s => /:read/.test(s)).sort()).toEqual(['channels:read', 'pins:read', 'users:read', 'users:read.email'])
  })

  it('nothing in the app calls a Slack method that would need to read messages', () => {
    const { readdirSync, statSync } = require('node:fs'); const { join } = require('node:path')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n: string) => {
      const p = join(dir, n)
      if (n === 'node_modules' || n.startsWith('.')) return []
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|jsx|mjs)$/.test(n) && !/\.test\./.test(n) ? [p] : []
    })
    const hits = ['app', 'lib', 'components', 'scripts'].flatMap(walk).filter(f => /conversations\.(history|replies)|search\.messages|channels:history/.test(
      readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')))
    expect(hits).toEqual([])
  })

  it('the two asked for with nothing using them yet say so where the list is, so nobody deletes them as dead', () => {
    const src = readFileSync('app/api/slack/connect/route.ts', 'utf8')
    const block = src.slice(src.indexOf('REQUESTED ON PURPOSE, NOT USED YET'), src.indexOf('const SLACK_SCOPES'))
    expect(block).toContain('DO NOT DELETE AS DEAD')
    for (const s of ['groups:write', 'pins:read', 'channels:join', 'bookmarks:write', 'files:write', 'reactions:write']) expect(block, s).toContain(s)
    expect(block).toMatch(/groups:write[\s\S]*PRIVATE channels[\s\S]*address/)
    expect(block).toMatch(/DELIBERATELY NOT REQUESTED: channels:history/)
  })
})
