// @vitest-environment happy-dom
// ─────────────────────────────────────────────────────────────
// issue 148 — assignee → Jobber status line under the EngagementPanel picker.
//
// POST/DELETE /api/engagements/:id/assignees returns a jobber_sync object
// nobody read. AssigneeSyncStatus turns it into ONE inline line, SILENT on a
// clean push, speaking up only when the owner needs to know: a failed Jobber
// leg (retry) or unmapped people (assigned in Bee Hub only).
//
// Mount cases (the four the issue names):
//   · clean push       → renders nothing
//   · a failed leg     → renders the failure line
//   · unmapped > 0     → renders the count
//   · null (not on Jobber) → renders nothing
//
// Confirmed shape (read live from lib/engagement-assignee-sync
// AssignmentSyncResult, post issues 147 + 153):
//   { request:'skipped', job, assessment, mapped, unmapped, visitsTouched } | null
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AssigneeSyncStatus, { assigneeSyncNote } from '@/components/hive/shared/AssigneeSyncStatus'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// A clean, fully-synced push: every leg landed, nobody unmapped.
const clean = { request: 'skipped', job: 'synced', assessment: 'synced', mapped: 2, unmapped: 0, visitsTouched: 3 }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mount = (sync: any) => act(() => root.render(<AssigneeSyncStatus sync={sync} />))
const line = () => container.querySelector('[data-bee-assignee-sync]')

describe('AssigneeSyncStatus (issue 148)', () => {
  it('renders nothing on a clean, fully-synced push', () => {
    mount(clean)
    expect(line()).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders nothing when sync is null (location not connected to Jobber)', () => {
    mount(null)
    expect(line()).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders the failure line when the job leg failed', () => {
    mount({ ...clean, job: 'failed' })
    const el = line()
    expect(el).not.toBeNull()
    expect(el!.textContent).toMatch(/couldn’t update Jobber/)
    expect(el!.textContent).toMatch(/Try again shortly/)
  })

  it('renders the failure line when the assessment leg failed (issue 147 leg)', () => {
    mount({ ...clean, assessment: 'failed' })
    expect(line()!.textContent).toMatch(/couldn’t update Jobber/)
  })

  it('renders the count when unmapped > 0 (plural)', () => {
    mount({ ...clean, mapped: 1, unmapped: 2 })
    const txt = line()!.textContent || ''
    expect(txt).toMatch(/2 of these people aren’t linked to Jobber/)
    expect(txt).toMatch(/assigned in Bee Hub only/)
  })

  it('renders singular copy when exactly one is unmapped', () => {
    mount({ ...clean, mapped: 1, unmapped: 1 })
    expect(line()!.textContent).toMatch(/One of these people isn’t linked to Jobber/)
  })

  it('a failed leg wins over unmapped — the retry matters more than the FYI', () => {
    mount({ ...clean, job: 'failed', unmapped: 3 })
    const txt = line()!.textContent || ''
    expect(txt).toMatch(/couldn’t update Jobber/)
    expect(txt).not.toMatch(/Bee Hub only/)
  })

  it('the pure mapper agrees with the four cases', () => {
    expect(assigneeSyncNote(null)).toBeNull()
    expect(assigneeSyncNote(clean)).toBeNull()
    expect(assigneeSyncNote({ ...clean, job: 'failed' })?.tone).toBe('fail')
    expect(assigneeSyncNote({ ...clean, assessment: 'failed' })?.tone).toBe('fail')
    expect(assigneeSyncNote({ ...clean, unmapped: 2 })?.tone).toBe('info')
  })
})
