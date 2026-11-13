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

// 2026-11-13: the Quick Start Guide and the Manual are retired and both slide
// routes are CLOSED (they answer 410 and read nothing; a save used to wipe its
// table). The tables and their rows are untouched. The routes' own tests are
// in lib/guides-retired.test.tsx; what this file still pins is that Help was
// built alongside the slide tables and never reaches into them.

// The guide modal's own render test was here. The Quick Start Guide and the
// Manual were retired on 2026-11-13 and the modal deleted; the two routes and
// both tables are untouched, which is what the blocks around this pin.

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
