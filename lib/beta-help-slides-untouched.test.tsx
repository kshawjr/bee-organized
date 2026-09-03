// @vitest-environment happy-dom
//
// guide_slides AND manual_slides STILL RENDER EXACTLY AS BEFORE.
//
// The Help section is built ALONGSIDE the Quick Start Guide and the Manual,
// not on top of them. This pins that:
//   · the two slide routes read their own tables and return the same shape
//   · the guide modal renders a slide the way it did
//   · the Help migration never names either table
//   · nothing in the new Help code imports from or writes to the slide paths
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import fs from 'node:fs'
import path from 'node:path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => {
  const state: any = { rows: {} as Record<string, any[]>, reads: [] as string[] }
  return { state }
})
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: (t: string) => ({
      select: () => ({
        order: async () => { h.state.reads.push(t); return { data: h.state.rows[t] || [], error: null } },
      }),
    }),
  }),
}))

import { GET as guideGET } from '@/app/api/guide-slides/route'
import { GET as manualGET } from '@/app/api/manual-slides/route'
import HowToGuideModal from '@/components/guide/HowToGuideModal'

const slideRow = (over: any) => ({
  id: 'g1', slot: 0, icon: '🐝', chapter: 'Start', color: '#1a2e2b', title: 'Welcome',
  body: 'Hello there.', bullets: ['one', 'two'], screenshot_url: null, screenshots: ['https://x/a.png'], ...over,
})

beforeEach(() => { h.state.rows = {}; h.state.reads = [] })

describe('the slide routes are unchanged', () => {
  it('GET /api/guide-slides reads guide_slides and returns the same shape', async () => {
    h.state.rows.guide_slides = [slideRow({})]
    const body = await (await guideGET()).json()
    expect(h.state.reads).toEqual(['guide_slides'])
    expect(body.slides).toEqual([{
      icon: '🐝', chapter: 'Start', color: '#1a2e2b', title: 'Welcome', body: 'Hello there.',
      bullets: ['one', 'two'], screenshot: 'https://x/a.png', screenshots: ['https://x/a.png'],
    }])
  })

  it('GET /api/manual-slides reads manual_slides and returns the same shape, video_url included', async () => {
    h.state.rows.manual_slides = [slideRow({ video_url: 'https://youtu.be/abcdefg' })]
    const body = await (await manualGET()).json()
    expect(h.state.reads).toEqual(['manual_slides'])
    expect(body.slides[0]).toMatchObject({ title: 'Welcome', video_url: 'https://youtu.be/abcdefg', screenshot: 'https://x/a.png' })
  })
})

describe('the guide modal still renders a slide', () => {
  it('title, body and bullets', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<HowToGuideModal onClose={() => {}} onDismiss={() => {}} slides={[{ icon: '🐝', chapter: 'Start', color: '#1a2e2b', title: 'Welcome', body: 'Hello there.', bullets: ['one', 'two'], screenshot: null, screenshots: [] }]} />)
    })
    expect(host.textContent).toContain('Welcome')
    expect(host.textContent).toContain('Hello there.')
    expect(host.textContent).toContain('one')
    await act(async () => root.unmount())
    host.remove()
  })
})

describe('the Help build leaves the slide tables alone', () => {
  const root = path.resolve(__dirname, '..')
  it('the migration never names guide_slides or manual_slides', () => {
    const sql = fs.readFileSync(path.join(root, 'migrations/help_entries.sql'), 'utf8')
    // The one mention allowed is the sentence saying they are not touched.
    const mentions = sql.split('\n').filter(l => /guide_slides|manual_slides/.test(l))
    expect(mentions).toEqual(['-- guide_slides and manual_slides are NOT touched by this file.'])
  })

  it('no Help source file reads or writes the slide tables or routes', () => {
    const files = [
      'lib/help-content.ts', 'components/help/HelpScreen.jsx', 'components/help/HelpEntryForm.jsx', 'components/help/helpMedia.js',
      'app/api/help/entries/route.ts', 'app/api/help/entries/[id]/route.ts', 'app/api/help/entries/[id]/move/route.ts', 'app/api/help/media/sign/route.ts',
    ]
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8')
      expect(src, f).not.toMatch(/guide_slides|manual_slides|guide-slides|manual-slides/)
    }
  })
})
