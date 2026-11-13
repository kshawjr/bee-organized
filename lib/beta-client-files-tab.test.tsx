// @vitest-environment happy-dom
//
// CLIENT FILES — the screen (13 Nov 2026). components/hive/shared/FilesTab.jsx
// on the client card and on a job.
//
//   · THE TAB'S COUNT IS THE REAL NUMBER: the length of the list the tab
//     shows, on both cards, and it moves when a file is added or removed.
//     (It was a hardcoded 0 on the client card and absent on the job.)
//   · A read-only user is offered no way to add or remove. (That the SERVER
//     refuses them is lib/beta-client-files-routes.test.ts — the screen is a
//     courtesy, the route is the guard.)
//   · The states an owner can land in: nothing yet, one, many, a long name, a
//     PDF, mid-upload, a failed upload, not switched on, could not load.
//   · NOTHING OUTSIDE THE FILES TAB CHANGED, by fingerprint — rendered (both
//     cards, Overview and Timeline, writable and read-only, byte for byte
//     what commit 57331f8 rendered) and in source (take my named lines back
//     out of each touched file and it IS the 57331f8 file).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { cardFingerprints, installCardFetch, FP_NOW } from '@/lib/card-files-fingerprint.test.harness'
import BEFORE from '@/lib/__fixtures__/card-files.before.json'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const file = (n: number, over: any = {}) => ({
  id: `f${n}`, name: `photo ${n}.jpg`, mime_type: 'image/jpeg', size_bytes: 300 * 1024 * n, engagement_id: null,
  uploaded_by_label: 'Suzanne Allbee', created_at: `2026-11-0${n}T14:00:00Z`, has_preview: true, can_remove: true, ...over,
})
const LONG = 'IMG_20261104_Allbee_residence_garage_north_wall_before_decluttering_final_FINAL_v2 (3).jpg'

// A fetch that serves the two cards' own reads (the harness) and plays the
// files routes over a real little list, so add and remove change what the
// next read would say.
type Sent = { method: string; url: string; form?: FormData }
let sent: Sent[] = []
let uploadAnswer: (form: FormData) => { status: number; body: any } | Promise<{ status: number; body: any }>
function installFiles(list: any[], opts: { notReady?: boolean; failList?: boolean } = {}) {
  installCardFetch()
  const cards = (globalThis as any).fetch
  sent = []
  let n = 100
  uploadAnswer = (form) => {
    const f = form.get('file') as File
    return { status: 201, body: { file: file(1, { id: `new-${++n}`, name: f.name, mime_type: 'application/pdf', has_preview: false, engagement_id: (form.get('engagement_id') as string) || null }) } }
  }
  ;(globalThis as any).fetch = async (url: any, init: any = {}) => {
    const u = String(url)
    const method = init.method || 'GET'
    if (!u.includes('/api/client-files')) return cards(url, init)
    sent.push({ method, url: u, form: init.body instanceof FormData ? init.body : undefined })
    if (method === 'POST') {
      const a = await uploadAnswer(init.body)
      return { ok: a.status < 400, status: a.status, json: async () => a.body }
    }
    if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ deleted: true }) }
    if (opts.failList) return { ok: false, status: 500, json: async () => ({ error: 'list_failed' }) }
    const onlyJob = new URL(u, 'https://hub.test').searchParams.get('engagement_id')
    const rows = onlyJob ? list.filter(f => f.engagement_id === onlyJob) : list
    return { ok: true, status: 200, json: async () => (opts.notReady ? { files: [], not_ready: true } : { files: rows }) }
  }
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const click = (el: Element | null | undefined) => act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
const tab = (host: Element, label: string) => Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === `${label} tab`)!
const q = (host: Element, id: string) => host.querySelector(`[data-testid="${id}"]`)
const button = (host: Element, text: string) => Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').trim() === text)
const pick = async (host: Element, files: File[]) => {
  const input = q(host, 'files-input') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
}
const pdf = (name = 'Quote 1042.pdf') => new File([new TextEncoder().encode('%PDF-1.7 hello hello hello')], name, { type: 'application/pdf' })

const profile = (props: any = {}) => mount(<ClientProfile clientId="lead-9" onClose={() => {}} onSendToJobber={() => {}} {...props} />)
const panel = (props: any = {}) => mount(<EngagementPanel engagementId="eng-1" onClose={() => {}} lookupOptions={{ sources: ['Webform'], projectTypes: ['Client'], closeLostReasons: [] }} {...props} />)
const openFiles = async (host: Element) => { await click(tab(host, 'Files')); await settle() }

afterEach(() => { vi.useRealTimers() })

describe('the tab’s count is the real number', () => {
  it.each([[0], [1], [3]])('client card with %i file(s) says %i', async (n) => {
    installFiles(Array.from({ length: n }, (_, i) => file(i + 1)))
    const { host, unmount } = await profile()
    await settle()
    expect(tab(host, 'Files').textContent).toBe(`Files${n}`)
    await openFiles(host)
    expect(host.querySelectorAll('[data-testid^="file-row-"]').length).toBe(n)
    await unmount()
  })

  it('a job counts ITS files, not the client’s: 1 of the client’s 3', async () => {
    installFiles([file(1, { engagement_id: 'eng-1' }), file(2), file(3, { engagement_id: 'eng-other' })])
    const { host, unmount } = await panel()
    await settle()
    expect(tab(host, 'Files').textContent).toBe('Files1')
    expect(sent.some(s => s.method === 'GET' && s.url.includes('lead_id=lead-9') && s.url.includes('engagement_id=eng-1'))).toBe(true)
    await openFiles(host)
    expect(host.querySelectorAll('[data-testid^="file-row-"]').length).toBe(1)
    await unmount()
  })

  it('no number at all until the list is in — never a made-up 0', async () => {
    installFiles([file(1)])
    const real = (globalThis as any).fetch
    let release: () => void = () => {}
    ;(globalThis as any).fetch = async (url: any, init: any) => {
      if (String(url).includes('/api/client-files')) await new Promise<void>(r => { release = r })
      return real(url, init)
    }
    const { host, unmount } = await profile()
    expect(tab(host, 'Files').textContent).toBe('Files')
    await act(async () => { release() })
    await settle()
    expect(tab(host, 'Files').textContent).toBe('Files1')
    await unmount()
  })

  it('it moves: 2 → 3 when a file is added, → 2 when one is removed', async () => {
    installFiles([file(1), file(2)])
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    expect(tab(host, 'Files').textContent).toBe('Files2')
    await pick(host, [pdf()])
    expect(tab(host, 'Files').textContent).toBe('Files3')
    expect(host.textContent).toContain('3 files')
    await click(q(host, 'file-remove-f1'))
    expect(host.textContent).toContain('Remove this file for good? It can’t be brought back.')
    expect(sent.filter(s => s.method === 'DELETE')).toHaveLength(0) // asking is not removing
    await click(q(host, 'file-remove-confirm-f1'))
    await settle()
    expect(sent.filter(s => s.method === 'DELETE').map(s => s.url)).toEqual(['/api/client-files/f1'])
    expect(tab(host, 'Files').textContent).toBe('Files2')
    expect(q(host, 'file-row-f1')).toBeNull()
    await unmount()
  })
})

describe('what the tab shows', () => {
  it('nothing yet: says so plainly, offers Add files, and no longer promises files will "land here"', async () => {
    installFiles([])
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    expect(q(host, 'files-empty')!.textContent).toContain('No files yet.')
    expect(q(host, 'files-add')).toBeTruthy()
    expect(host.textContent).toContain('Photos and PDFs, up to 4 MB each.')
    expect(host.textContent).not.toContain('will land here')
    await unmount()
  })

  it('a photo and a PDF, a long name, who and when, and which job', async () => {
    installFiles([
      file(1, { name: LONG, engagement_id: 'eng-77' }),
      file(2, { name: 'Quote 1042.pdf', mime_type: 'application/pdf', has_preview: false }),
      file(3, { name: 'IMG_0042.HEIC', mime_type: 'image/heic', has_preview: false }),
    ])
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    const row1 = q(host, 'file-row-f1')!
    expect(row1.textContent).toContain(LONG)
    expect(row1.querySelector('a')!.getAttribute('title')).toBe(LONG)
    expect(row1.textContent).toContain('Suzanne Allbee · Nov 1, 2026 · 300 KB')
    expect(row1.textContent).toContain('re: Pantry refresh')
    // opens by id, in a new tab, telling the next page nothing
    const a = row1.querySelector('a')!
    expect(a.getAttribute('href')).toBe('/api/client-files/f1')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    // the photo shows its small preview; the PDF and the HEIC a plain tile
    expect(row1.querySelector('img')!.getAttribute('src')).toBe('/api/client-files/f1?preview=1')
    expect(q(host, 'file-tile-f2')!.textContent).toBe('PDF')
    expect(q(host, 'file-tile-f3')!.textContent).toBe('PHOTO')
    expect(q(host, 'file-row-f2')!.textContent).not.toContain('re:')
    await unmount()
  })

  it('on a job: says files added here also show on the client, and pins what is added to the job', async () => {
    installFiles([])
    const { host, unmount } = await panel()
    await settle(); await openFiles(host)
    expect(host.textContent).toContain('No files yet on this job.')
    expect(host.textContent).toContain('Files added here also show on the client’s Files tab.')
    await pick(host, [pdf()])
    const post = sent.find(s => s.method === 'POST')!
    expect(post.form!.get('lead_id')).toBe('lead-9')
    expect(post.form!.get('engagement_id')).toBe('eng-1')
    expect(tab(host, 'Files').textContent).toBe('Files1')
    await unmount()
  })

  it('mid-upload: the file is listed as "Adding…" and is not counted until it is really there', async () => {
    installFiles([file(1)])
    let finish: (v: any) => void = () => {}
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    uploadAnswer = () => new Promise(r => { finish = r })
    await pick(host, [pdf('Floor plan.pdf')])
    const row = q(host, 'file-upload-sending')!
    expect(row.textContent).toContain('Floor plan.pdf')
    expect(row.textContent).toContain('Adding…')
    expect(tab(host, 'Files').textContent).toBe('Files1')
    await act(async () => { finish({ status: 201, body: { file: file(2, { id: 'new-1', name: 'Floor plan.pdf' }) } }) })
    await settle()
    expect(q(host, 'file-upload-sending')).toBeNull()
    expect(tab(host, 'Files').textContent).toBe('Files2')
    await unmount()
  })

  it('a failed upload says why in the server’s words, is not counted, and can be tried again or dismissed', async () => {
    installFiles([file(1)])
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    uploadAnswer = () => ({ status: 415, body: { error: 'file_type_not_allowed', detail: 'Only photos (JPG, PNG, WebP or HEIC) and PDFs can be added here.' } })
    await pick(host, [new File(['hello'], 'notes.docx', { type: 'application/msword' })])
    const failed = q(host, 'file-upload-failed')!
    expect(failed.textContent).toContain('notes.docx')
    expect(failed.querySelector('[role="alert"]')!.textContent).toBe('Not added. Only photos (JPG, PNG, WebP or HEIC) and PDFs can be added here.')
    expect(tab(host, 'Files').textContent).toBe('Files1')

    uploadAnswer = () => ({ status: 201, body: { file: file(2, { id: 'new-9', name: 'notes.docx' }) } })
    await click(button(failed, 'Try again'))
    await settle()
    expect(q(host, 'file-upload-failed')).toBeNull()
    expect(tab(host, 'Files').textContent).toBe('Files2')

    uploadAnswer = () => ({ status: 413, body: {} }) // Vercel's own refusal carries no words
    await pick(host, [pdf('huge.pdf')])
    expect(q(host, 'file-upload-failed')!.textContent).toContain('over 4 MB')
    await click(button(q(host, 'file-upload-failed')!, 'Dismiss'))
    expect(q(host, 'file-upload-failed')).toBeNull()
    await unmount()
  })

  it('a file over 4 MB is stopped in the browser — it is never sent', async () => {
    installFiles([])
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    await pick(host, [new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'scan.pdf', { type: 'application/pdf' })])
    expect(q(host, 'file-upload-failed')!.textContent).toContain('over 4 MB')
    expect(sent.filter(s => s.method === 'POST')).toHaveLength(0)
    await unmount()
  })

  it('before the migration is run: "Files isn’t switched on yet", no Add, no number', async () => {
    installFiles([], { notReady: true })
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    expect(q(host, 'files-not-ready')!.textContent).toContain('Files isn’t switched on yet.')
    expect(q(host, 'files-add')).toBeNull()
    expect(q(host, 'files-input')).toBeNull()
    expect(tab(host, 'Files').textContent).toBe('Files')
    await unmount()
  })

  it('could not load: says so and offers Try again, and the tab shows no number', async () => {
    installFiles([file(1)], { failList: true })
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    expect(q(host, 'files-load-error')!.textContent).toContain('Couldn’t load the files.')
    expect(tab(host, 'Files').textContent).toBe('Files')
    await unmount()
  })
})

describe('a read-only user is offered nothing to add or remove', () => {
  it('with files: sees them, can open them; no Add, no file picker, no Remove', async () => {
    installFiles([file(1), file(2)])
    const { host, unmount } = await profile({ readOnly: true })
    await settle(); await openFiles(host)
    expect(tab(host, 'Files').textContent).toBe('Files2')
    expect(host.querySelectorAll('[data-testid^="file-row-"] a').length).toBe(2)
    expect(q(host, 'files-add')).toBeNull()
    expect(q(host, 'files-input')).toBeNull()
    expect(host.querySelectorAll('[data-testid^="file-remove-"]').length).toBe(0)
    expect(q(host, 'files-list')!.textContent).toContain('You can look at these files, but not add or remove them.')
    await unmount()
  })

  it('with none: says there are none, and still offers nothing', async () => {
    installFiles([])
    const { host, unmount } = await panel({ readOnly: true })
    await settle(); await openFiles(host)
    expect(q(host, 'files-empty')!.textContent).toContain('No files yet on this job.')
    expect(q(host, 'files-add')).toBeNull()
    expect(q(host, 'files-input')).toBeNull()
    await unmount()
  })

  it('a manager sees Remove only on the files the server says are theirs', async () => {
    installFiles([file(1, { can_remove: true }), file(2, { can_remove: false })])
    const { host, unmount } = await profile()
    await settle(); await openFiles(host)
    expect(q(host, 'file-remove-f1')).toBeTruthy()
    expect(q(host, 'file-remove-f2')).toBeNull()
    await unmount()
  })
})

describe('nothing outside the Files tab changed, by fingerprint', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FP_NOW) })

  const shoot = async (files: any[], readOnly: boolean) => {
    installCardFetch(files)
    return cardFingerprints(readOnly)
  }
  const three = [file(1, { engagement_id: 'eng-1' }), file(2), file(3)]

  it.each([
    ['no files, can edit', [] as any[], false],
    ['three files, can edit', three, false],
    ['no files, read-only', [] as any[], true],
    ['three files, read-only', three, true],
  ])('rendered — %s: both cards, Overview and Timeline, are what 57331f8 rendered', async (_label, files, readOnly) => {
    const now = await shoot(files, readOnly)
    const before = (BEFORE as any).rendered[readOnly ? 'readOnly' : 'writable']
    expect(now).toEqual(before)
    // and "the same" is not "both empty"
    expect(Math.min(...now.sizes)).toBeGreaterThan(10000)
  })

  // Take THESE lines back out, put the old ones back, and the file must be,
  // byte for byte, the file at 57331f8. Anything else I touched fails this.
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const undo = (src: string, steps: [string, string][]) => steps.reduce((s, [now, was]) => {
    expect(s.split(now).length - 1, `expected exactly once: ${now.slice(0, 60)}…`).toBe(1)
    return s.replace(now, was)
  }, src)
  const OLD_BOX = (radius: string) => `  const filesTab = (
    <div style={{ padding: '18px 12px', border: T.border.dashed, borderRadius: T.radius.${radius}, textAlign: 'center' }}>
      <p style={{ fontSize: '12px', color: T.ink.quiet, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
        <IconPaperclip size={14} /> No files yet — quotes, photos, and attachments will land here
      </p>
    </div>
  )
`

  it('source — the client card: five named changes, nothing else', () => {
    const p = 'components/hive/ClientProfile.jsx'
    const back = undo(readFileSync(p, 'utf8'), [
      ["import FilesTab, { useClientFiles } from './shared/FilesTab'\n", ''],
      ['IconCheck, IconX, IconMapPin,', 'IconCheck, IconX, IconPaperclip, IconMapPin,'],
      ['  const clientFiles = useClientFiles({ leadId: c?.id || null })\n', ''],
      [`  // The real Files tab (shared/FilesTab.jsx). The list is held up here so the
  // number on the tab is the length of the very list the tab shows.
  const filesTab = <FilesTab state={clientFiles} readOnly={readOnly} jobTitles={engTitleById} />
`, OLD_BOX('control')],
      ["{ key: 'files', label: 'Files', count: clientFiles.count },", "{ key: 'files', label: 'Files', count: 0 },"],
    ])
    expect(sha(back)).toBe((BEFORE as any).source[p])
  })

  it('source — the job panel: five named changes, nothing else', () => {
    const p = 'components/hive/EngagementPanel.jsx'
    const back = undo(readFileSync(p, 'utf8'), [
      ["import FilesTab, { useClientFiles } from './shared/FilesTab'\n", ''],
      ['IconCalendar, IconSend, IconMessage,', 'IconCalendar, IconSend, IconPaperclip, IconMessage,'],
      ['  const jobFiles = useClientFiles({ leadId: client?.id || null, engagementId })\n', ''],
      [`  // The real Files tab (shared/FilesTab.jsx): this job's files. Anything added
  // here is pinned to this job and also shows on the client's own Files tab.
  const filesTab = <FilesTab state={jobFiles} readOnly={readOnly} onJob />
`, OLD_BOX('inset')],
      ["{ key: 'files', label: 'Files', count: jobFiles.count },", "{ key: 'files', label: 'Files' },"],
    ])
    expect(sha(back)).toBe((BEFORE as any).source[p])
  })

  it('source — permanent client delete: the file clean-up, nothing else', () => {
    const p = 'app/api/leads/[id]/route.ts'
    const back = undo(readFileSync(p, 'utf8'), [
      ["import { clientFileObjectPaths, removeClientFileObjects } from '@/lib/client-files-server'\n", ''],
      [`  //
  // Their files (photos and PDFs, lib/client-files.ts) are the one child that
  // also lives OUTSIDE the database, in Storage. The paths are read first,
  // because the delete takes the rows that name them; the objects are removed
  // only AFTER the client is really gone, so a delete that is refused never
  // costs a surviving client their files.
  const filePaths = await clientFileObjectPaths(id)

`, ''],
      ["\n  await removeClientFileObjects(filePaths, `client ${id} permanently deleted`)\n", ''],
    ])
    expect(sha(back)).toBe((BEFORE as any).source[p])
  })
})
