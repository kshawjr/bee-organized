// @vitest-environment happy-dom
//
// EDIT AND DELETE, ON THE CARD — the two surfaces a note renders on, which
// are shaped differently and had to be handled differently.
//
//   · NotesStream lists every note, so its controls sit on each row.
//   · PinnedBuzz shows ONLY the latest, with history folded behind the pencil
//     (PinnedBuzz.jsx). Its controls live in the EXPANDED history, never on
//     the collapsed band: that band exists to put one standing note in front
//     of someone before they act, and hanging verbs off it would crowd the
//     single thing it is for, on every card, for everyone.
//
// The route is the guard and beta-lead-note-edit-delete proves the refusals
// there with forged requests. THIS file is about what the card draws, and the
// one rule it must not get wrong: a hidden control is a courtesy, so the card
// must not offer a verb the server would refuse.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NotesStream from '@/components/hive/NotesStream'
import PinnedBuzz from '@/components/hive/shared/PinnedBuzz'
import NoteActions, { EditedMark, deleteNoteConfirmSentence } from '@/components/hive/shared/NoteActions'
import { replaceNote, removeNote, upsertNote } from '@/components/hive/shared/noteStream'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

const note = (over: any = {}) => ({
  id: 'n1', kind: 'job', text: 'The original text', user_id: 'u-author',
  user_label: 'Dana Reed', created_at: iso(60000), edited_at: null, ...over,
})
const streamItem = (over: any = {}) => ({ t: 'note', ts: iso(60000), ...note(over) })

let container: HTMLDivElement
let root: Root
const flush = async () => { await act(async () => { await Promise.resolve() }) }
const mount = async (el: React.ReactElement) => {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { root = createRoot(container); root.render(el) })
  await flush()
}
const text = () => container.textContent || ''
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
// PinnedBuzz's history toggle is the banded row itself, labelled for screen
// readers rather than tagged with a test id.
const buzzToggle = () => q('[aria-label="Expand buzz"]') || q('[aria-label="Collapse buzz"]')

const click = async (el: Element | null) => {
  await act(async () => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush(); await flush()
}

const manageable = (over: any = {}) => ({
  canManage: true, isOwn: true, onSave: vi.fn(async () => {}), onDelete: vi.fn(async () => {}), ...over,
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  ;(root as any) = null
  container?.remove()
  vi.restoreAllMocks()
})

describe('the edited marker — quietly, not loudly', () => {
  it('an edited note says so', async () => {
    await mount(<EditedMark note={note({ edited_at: iso(1000) })} />)
    expect(text()).toContain('edited')
  })

  it('an UNTOUCHED note says nothing — it reads exactly as it always has', async () => {
    await mount(<EditedMark note={note({ edited_at: null })} />)
    expect(text()).toBe('')
  })

  it('shows on a note row in the activity stream', async () => {
    await mount(<NotesStream label="Recent activity" items={[streamItem({ edited_at: iso(500) })]} nowMs={now} />)
    expect(container.querySelector('[data-testid="note-edited-n1"]')).toBeTruthy()
  })

  it('shows in the buzz history', async () => {
    await mount(<PinnedBuzz notes={[note({ kind: 'buzz', edited_at: iso(500) })]} nowMs={now} />)
    // The band is collapsed; open the history where every buzz note renders.
    await click(buzzToggle())
    expect(text()).toContain('edited')
  })
})

describe('the delete confirmation leads with what is lost', () => {
  it('your own note — the exact sentence', () => {
    expect(deleteNoteConfirmSentence(note(), true))
      .toBe('This deletes your note for good — we can’t get it back.')
  })

  it('someone else’s, for an admin — it names whose', () => {
    expect(deleteNoteConfirmSentence(note({ user_label: 'Dana Reed' }), false))
      .toBe('This deletes Dana Reed’s note for good — we can’t get it back.')
  })

  it('an unattributed note still reads', () => {
    expect(deleteNoteConfirmSentence(note({ user_label: null }), false))
      .toBe('This deletes this note for good — we can’t get it back.')
  })

  it('it is never a bare "are you sure?"', () => {
    const s = deleteNoteConfirmSentence(note(), true).toLowerCase()
    expect(s).not.toContain('are you sure')
    expect(s).toContain('for good')
  })
})

describe('the controls themselves', () => {
  it('are absent when the viewer may not act', async () => {
    await mount(<NoteActions note={note()} canManage={false} />)
    expect(container.querySelector('[data-testid="note-edit-n1"]')).toBeNull()
    expect(container.querySelector('[data-testid="note-delete-n1"]')).toBeNull()
  })

  it('editing saves the new text', async () => {
    const act_ = manageable()
    await mount(<NoteActions note={note()} {...act_} />)

    await click(q('[data-testid="note-edit-n1"]'))
    const input = q('[data-testid="note-edit-input-n1"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'A better sentence')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(q('[data-testid="note-edit-save-n1"]'))

    expect(act_.onSave).toHaveBeenCalledWith('A better sentence')
  })

  it('an unchanged edit writes nothing', async () => {
    const act_ = manageable()
    await mount(<NoteActions note={note()} {...act_} />)
    await click(q('[data-testid="note-edit-n1"]'))
    await click(q('[data-testid="note-edit-save-n1"]'))
    expect(act_.onSave).not.toHaveBeenCalled()
  })

  it('an emptied edit is refused, and points at delete instead', async () => {
    // Emptying a note is a deletion in disguise, and deletion has a
    // confirmation for a reason.
    const act_ = manageable()
    await mount(<NoteActions note={note()} {...act_} />)
    await click(q('[data-testid="note-edit-n1"]'))
    const input = q('[data-testid="note-edit-input-n1"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, '   '); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(q('[data-testid="note-edit-save-n1"]'))

    expect(act_.onSave).not.toHaveBeenCalled()
    expect(text()).toContain('Delete it instead')
  })

  it('delete asks first, and "Keep it" backs out without deleting', async () => {
    const act_ = manageable()
    await mount(<NoteActions note={note()} {...act_} />)

    await click(q('[data-testid="note-delete-n1"]'))
    expect(text()).toContain('for good')
    await click(q('[data-testid="note-delete-cancel-n1"]'))

    expect(act_.onDelete).not.toHaveBeenCalled()
    expect(text()).not.toContain('for good')
  })

  it('confirming deletes', async () => {
    const act_ = manageable()
    await mount(<NoteActions note={note()} {...act_} />)
    await click(q('[data-testid="note-delete-n1"]'))
    await click(q('[data-testid="note-delete-confirm-n1"]'))
    expect(act_.onDelete).toHaveBeenCalled()
  })

  it('a failed save keeps the draft on screen instead of losing it', async () => {
    const act_ = manageable({ onSave: vi.fn(async () => { throw new Error('nope') }) })
    await mount(<NoteActions note={note()} {...act_} />)
    await click(q('[data-testid="note-edit-n1"]'))
    const input = q('[data-testid="note-edit-input-n1"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'Worth keeping'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(q('[data-testid="note-edit-save-n1"]'))

    expect((q('[data-testid="note-edit-input-n1"]') as HTMLTextAreaElement).value).toBe('Worth keeping')
    expect(text()).toContain('Couldn’t save it')
  })
})

describe('the two surfaces', () => {
  it('NotesStream offers controls per note row', async () => {
    await mount(<NotesStream label="Recent activity" items={[streamItem()]} nowMs={now}
      noteActionsFor={() => manageable()} />)
    expect(container.querySelector('[data-testid="note-edit-n1"]')).toBeTruthy()
  })

  it('NotesStream offers NONE on a touchpoint — it is not a note', async () => {
    const touch = { t: 'touch', id: 'tp1', ts: iso(500), method: 'call', label: 'Reach-out' }
    const forItem = vi.fn(() => manageable())
    await mount(<NotesStream label="Recent activity" items={[touch as any]} nowMs={now} noteActionsFor={forItem} />)
    expect(forItem).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="note-edit-tp1"]')).toBeNull()
  })

  it('NotesStream offers none when the card is read-only', async () => {
    await mount(<NotesStream label="Recent activity" items={[streamItem()]} nowMs={now}
      readOnly noteActionsFor={() => manageable()} />)
    expect(container.querySelector('[data-testid="note-edit-n1"]')).toBeNull()
  })

  it('PinnedBuzz keeps the COLLAPSED band clear of verbs', async () => {
    // The band's whole job is one standing note, seen before acting.
    await mount(<PinnedBuzz notes={[note({ kind: 'buzz' })]} nowMs={now}
      noteActionsFor={() => manageable()} />)
    expect(container.querySelector('[data-testid="note-edit-n1"]')).toBeNull()
  })

  it('PinnedBuzz offers them in the EXPANDED history', async () => {
    await mount(<PinnedBuzz notes={[note({ kind: 'buzz' })]} nowMs={now}
      noteActionsFor={() => manageable()} />)
    await click(buzzToggle())
    expect(container.querySelector('[data-testid="note-edit-n1"]')).toBeTruthy()
  })

  it('PinnedBuzz offers none when read-only', async () => {
    await mount(<PinnedBuzz notes={[note({ kind: 'buzz' })]} nowMs={now} readOnly
      noteActionsFor={() => manageable()} />)
    await click(buzzToggle())
    expect(container.querySelector('[data-testid="note-edit-n1"]')).toBeNull()
  })
})

describe('the card’s own state, after a confirmed write', () => {
  const data = (over: any = {}) => ({
    client: { id: 'c1' },
    buzz_notes: [note({ id: 'b1', kind: 'buzz', text: 'buzz one' })],
    job_notes: [note({ id: 'j1', kind: 'job', text: 'job one' })],
    ...over,
  })

  it('replaceNote swaps the row in place, in whichever bucket holds it', () => {
    const d = data()
    const next: any = replaceNote(d, { ...note({ id: 'j1' }), text: 'edited job', edited_at: iso(1) })
    expect(next.job_notes[0].text).toBe('edited job')
    expect(next.job_notes[0].edited_at).toBeTruthy()
    expect(next.buzz_notes).toBe(d.buzz_notes) // untouched bucket keeps its reference
  })

  it('replaceNote no-ops on an id the card does not hold', () => {
    const d = data()
    expect(replaceNote(d, note({ id: 'unknown' }))).toBe(d)
    expect(replaceNote(d, null)).toBe(d)
  })

  it('removeNote drops the row and leaves the other bucket alone', () => {
    const d = data()
    const next: any = removeNote(d, 'b1')
    expect(next.buzz_notes).toHaveLength(0)
    expect(next.job_notes).toBe(d.job_notes)
  })

  it('removeNote no-ops on an unknown id — no re-render', () => {
    const d = data()
    expect(removeNote(d, 'unknown')).toBe(d)
  })

  it('a deleted note does not come back via the arrival path', () => {
    // upsertNote is additive-by-id; once removed, a stale INSERT for the same
    // id WOULD re-add it. Pinned so the interaction is understood: realtime
    // is INSERT-only and a delete is not broadcast, so this cannot happen
    // from a delete — but if UPDATE/DELETE are ever added, this is the seam
    // that needs re-reading.
    const d = data()
    const gone: any = removeNote(d, 'j1')
    expect(gone.job_notes).toHaveLength(0)
    const back: any = upsertNote(gone, note({ id: 'j1' }))
    expect(back.job_notes).toHaveLength(1)
  })
})

describe('the realtime decision is recorded, not forgotten', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const hook = fs.readFileSync(path.join(process.cwd(), 'lib/use-lead-notes-realtime.ts'), 'utf8')

  it('the hook is still INSERT-only', () => {
    expect(hook).toContain("event: 'INSERT'")
    expect(hook).not.toContain("event: '*'")
    expect(hook).not.toContain("event: 'UPDATE'")
    expect(hook).not.toContain("event: 'DELETE'")
  })

  it('and says WHY, now that notes really are edited and deleted', () => {
    // The original reason ("not edited today") expired with this build. The
    // header must carry the reason that replaced it, or the next person will
    // read a stale justification as a current one.
    //
    // Prose wraps across comment lines, so strip the markers and collapse
    // whitespace before matching — asserting on a raw file means asserting on
    // where the line breaks happen to fall.
    const prose = hook.replace(/^\s*\/\//gm, ' ').replace(/\s+/g, ' ')
    expect(prose).toContain('RE-DECIDED')
    expect(prose).toContain('REPLICA IDENTITY DEFAULT')
    expect(prose).toContain('delete events are not filterable')
  })

  it('noteStream keeps arrival and change as separate functions', () => {
    const merge = fs.readFileSync(path.join(process.cwd(), 'components/hive/shared/noteStream.js'), 'utf8')
    expect(merge).toContain('export function upsertNote')
    expect(merge).toContain('export function replaceNote')
    expect(merge).toContain('export function removeNote')
  })
})
