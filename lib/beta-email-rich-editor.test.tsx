// @vitest-environment happy-dom
//
// THE RICH-TEXT MESSAGE EDITOR (2026-11-13, slice 2b of the Lovable email
// editor). The two email dialogs get a real editor (TipTap) in place of the
// text box, once migrations/email_body_format.sql has run. Pinned:
//
//   • every existing body goes through the REAL editor, load → save, with no
//     merge tag altered and the same html slice 2a proved sends byte for
//     byte (the seeded bodies always; every LIVE body with LIVE_BODIES_JSON)
//   • a body nobody touched is saved as it was — opening a plain email and
//     changing its subject does not turn its body into html
//   • a merge tag is one thing in the editor, and the same characters saved
//   • a booking link picked in the link panel is stored as its merge tag
//   • Large is exactly 20px, Normal is no size at all; headings are off
//   • before the migration, and for every existing caller, the dialogs are
//     the plain text box they were
//   • the editor is loaded on its own, and the only new packages are TipTap's
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Editor } from '@tiptap/react'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => ({ select: () => ({ limit: async () => ({ data: [{ id: 'x', body_format: 'plain', button_align: null }], error: null }) }) }) } }))

import EmailBodyEditor, { editorExtensions, PARSE, EDITOR_LINKS, LINK_PROBLEM } from '@/components/settings/EmailBodyEditor'
import { previewEmailHtml, useBodyDraft } from '@/components/settings/EmailsScreen'
import {
  bodyForEditor, sanitizeEmailHtml, plainBodyToHtml, mergeTagsIn, htmlBodyToText, bodyAsPlainText, mergeTagSpan, LARGE_PX,
} from './email-body-html'
import { bodyForSave } from './email-body-save'
import { buildBrandedDripHtml } from './drip-email-layout'
import * as BeeHub from '@/components/BeeHub'
const { DripPathStepEditor, EmailTemplateEditor, stepEditorContent, stepEditorFormat, applyStepContentEdit, buildEmailList } = BeeHub as any

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const HUB = read('components/BeeHub.jsx')
const EDITOR_SRC = read('components/settings/EmailBodyEditor.jsx')

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); document.querySelectorAll('[data-editor-panel]').forEach(n => n.remove()) })
const tick = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const until = async (test: () => unknown) => { for (let i = 0; i < 60 && !test(); i++) await tick() ; return test() }
const click = async (el: Element | null | undefined) => { expect(el, 'element to click').toBeTruthy(); await act(async () => { (el as HTMLElement).click() }) }
const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === label) as HTMLElement
const type = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

// The editor without a screen: what TipTap makes of a body, cleaned as a save
// cleans it.
const through = (body: string, format: 'plain' | 'html' = 'plain') => {
  const e = new Editor({ extensions: editorExtensions(), content: bodyForEditor(body, format), parseOptions: PARSE as any })
  const out = sanitizeEmailHtml(e.getHTML())
  e.destroy()
  return out
}

const SEED_FILES = ['seed_master_drip_paths.sql', 'seed_returning_drip_path.sql', 'returning_drip_path_variants.sql', 'drips_infrastructure.sql']
const SEEDED: string[] = Array.from(new Set(SEED_FILES.flatMap(f =>
  Array.from(read(`migrations/${f}`).matchAll(/'((?:[^']|'')*)'/g)).map(m => m[1].replace(/''/g, "'")).filter(b => b.includes('{{') && b.includes('\n') && b.length > 80))))

function editorRoundTrip(bodies: string[]) {
  const tagsChanged: number[] = [], wordsChanged: number[] = [], notTheProvenHtml: number[] = [], notStable: number[] = []
  bodies.forEach((body, i) => {
    const out = through(body)
    const proven = bodyForSave(plainBodyToHtml(body), 'html').body   // what slice 2a held against the plain send, byte for byte
    if (JSON.stringify(mergeTagsIn(out)) !== JSON.stringify(mergeTagsIn(body))) tagsChanged.push(i)
    if (htmlBodyToText(out) !== htmlBodyToText(proven)) wordsChanged.push(i)
    if (out !== proven) notTheProvenHtml.push(i)
    if (through(out, 'html') !== out) notStable.push(i)   // saved, reopened, saved again
  })
  return { tagsChanged, wordsChanged, notTheProvenHtml, notStable }
}

describe('every existing body through the real editor, load → save', () => {
  it('seeded bodies: no merge tag altered, no word altered, and exactly the html slice 2a proved is sent byte for byte', () => {
    expect(SEEDED.length).toBeGreaterThanOrEqual(30)
    expect(editorRoundTrip(SEEDED)).toEqual({ tagsChanged: [], wordsChanged: [], notTheProvenHtml: [], notStable: [] })
  })
  // The live bodies are owners' own wording and are not kept in the repo:
  //   LIVE_BODIES_JSON=/path/bodies.json npx vitest run lib/beta-email-rich-editor.test.tsx
  it.skipIf(!process.env.LIVE_BODIES_JSON)('LIVE bodies: the same, for every one of them', () => {
    const bodies: string[] = JSON.parse(readFileSync(process.env.LIVE_BODIES_JSON!, 'utf8'))
    const r = editorRoundTrip(bodies)
    process.stdout.write(`\n[live, through the real editor] ${bodies.length} bodies, ${bodies.reduce((n, b) => n + mergeTagsIn(b).length, 0)} merge tags; tags changed ${r.tagsChanged.length}, words changed ${r.wordsChanged.length}, not the proven html ${r.notTheProvenHtml.length}, not stable on a second save ${r.notStable.length}\n`)
    expect(r).toEqual({ tagsChanged: [], wordsChanged: [], notTheProvenHtml: [], notStable: [] })
  })
  it('spaces are kept as typed: a doubled space, a trailing space, a blank paragraph', () => {
    expect(through('<p>one  two </p><p></p><p> three</p>', 'html')).toBe('<p>one  two </p><p></p><p> three</p>')
  })
  it('a body saved by the editor reopens as itself: lists, bold, italic, underline, a link, centre, right, Large', () => {
    const saved = `<p>Hi {{first_name}},</p><ul><li>One <strong>bold</strong> <em>it</em> <u>un</u></li><li>Two</li></ul><ol><li>First <a href="{{book_assessment_link}}">here</a></li></ol><p style="text-align:center"><span style="font-size:${LARGE_PX}px">Big</span> and small</p><p style="text-align:right">Right</p><p><a href="https://example.com/x?a=1&amp;b=2">out</a></p>`
    expect(through(saved, 'html')).toBe(saved)
  })
})

describe('a merge tag is one thing', () => {
  it('the editor is handed every tag in the text wrapped as one unit — but not a tag that is a link’s address', () => {
    expect(mergeTagSpan('first_name')).toBe('<span data-merge-tag="first_name">{{first_name}}</span>')
    expect(bodyForEditor('Hi {{first_name}}, see HERE ({{book_assessment_link}})', 'plain'))
      .toBe('<p>Hi <span data-merge-tag="first_name">{{first_name}}</span>, see <a href="{{book_assessment_link}}">HERE</a></p>')
    expect(bodyForEditor('<p><strong>{{owner_name}}</strong></p>', 'html')).toBe('<p><strong><span data-merge-tag="owner_name">{{owner_name}}</span></strong></p>')
  })
  it('in the document it is a single node that cannot be split, and it saves as the same characters', () => {
    const e = new Editor({ extensions: editorExtensions(), content: bodyForEditor('Hi {{first_name}}!', 'plain'), parseOptions: PARSE as any })
    const kinds: string[] = []
    e.state.doc.descendants(n => { kinds.push(n.type.name + (n.isText ? `:${n.text}` : '')) })
    expect(kinds).toEqual(['paragraph', 'text:Hi ', 'mergeTag', 'text:!'])
    const tag = e.schema.nodes.mergeTag
    expect([tag.isAtom, tag.isInline, tag.isLeaf]).toEqual([true, true, true])
    expect(sanitizeEmailHtml(e.getHTML())).toBe('<p>Hi {{first_name}}!</p>')
    // one backspace with the cursor just after it: the whole tag goes
    e.commands.setTextSelection(5)
    e.commands.deleteRange({ from: 4, to: 5 })
    expect(sanitizeEmailHtml(e.getHTML())).toBe('<p>Hi !</p>')
    e.destroy()
  })
  it('a tag typed or pasted by hand becomes one too, with nothing left around it', () => {
    const src = EDITOR_SRC
    expect(src).toMatch(/nodeInputRule\(\{ find: \/\\\{\\\{\\w\+\\\}\\\}\$\//)
    expect(src).toMatch(/nodePasteRule\(\{ find: \/\\\{\\\{\\w\+\\\}\\\}\/g/)
    const e = new Editor({ extensions: editorExtensions(), content: '<p>Hi </p>', parseOptions: PARSE as any })
    e.chain().focus('end').insertContent({ type: 'mergeTag', attrs: { name: 'location_name' } }).run()
    expect(sanitizeEmailHtml(e.getHTML())).toBe('<p>Hi {{location_name}}</p>')
    e.destroy()
  })
})

describe('what the editor can make', () => {
  const ed = (content = '<p>hello world</p>') => new Editor({ extensions: editorExtensions(), content, parseOptions: PARSE as any })
  it('headings are off, and so are code, quotes, rules and strike-through', () => {
    const e = ed()
    for (const off of ['heading', 'codeBlock', 'code', 'blockquote', 'horizontalRule', 'strike']) expect(e.schema.nodes[off] || e.schema.marks[off], off).toBeUndefined()
    for (const on of ['paragraph', 'bulletList', 'orderedList', 'listItem', 'hardBreak', 'mergeTag']) expect(e.schema.nodes[on], on).toBeTruthy()
    for (const on of ['bold', 'italic', 'underline', 'link', 'textStyle']) expect(e.schema.marks[on], on).toBeTruthy()
    e.destroy()
  })
  it('Large is exactly 20px; Normal takes the size away (the email’s own 17px), there is no Small', () => {
    const e = ed()
    e.chain().selectAll().setFontSize(`${LARGE_PX}px`).run()
    expect(sanitizeEmailHtml(e.getHTML())).toBe('<p><span style="font-size:20px">hello world</span></p>')
    e.chain().selectAll().unsetFontSize().run()
    expect(sanitizeEmailHtml(e.getHTML())).toBe('<p>hello world</p>')
    e.destroy()
    expect(LARGE_PX).toBe(20)
    const select = EDITOR_SRC.slice(EDITOR_SRC.indexOf('aria-label="Text size"'), EDITOR_SRC.indexOf('</select>'))
    expect(Array.from(select.matchAll(/<option value="(\w+)">(\w+)<\/option>/g)).map(m => [m[1], m[2]])).toEqual([['normal', 'Normal'], ['large', 'Large']])
  })
  it('any other size, colour or font does not survive a save', () => {
    expect(sanitizeEmailHtml('<p><span style="font-size:10px">s</span><span style="font-size:20px;color:red">c</span><span style="font-size:200px">h</span><span style="font-family:Comic Sans MS">f</span><span style="font-size: 20px;">ok</span></p>'))
      .toBe('<p>schf<span style="font-size:20px">ok</span></p>')
  })
  it('Large is sent at 20px with its own line height, inline', () => {
    const out = buildBrandedDripHtml('<p>Hi <span style="font-size:20px">there</span></p>', { location_name: 'Denver', bodyFormat: 'html' })
    expect(out).toContain('Hi <span style="font-size:20px;line-height:30px;">there</span></p>')
  })
  it('a link may be a full web address or one merge tag, and nothing else', () => {
    const e = ed('<p><a href="{{book_assessment_link}}">a</a> <a href="https://x.example/y">b</a> <a href="javascript:alert(1)">c</a></p>')
    expect(sanitizeEmailHtml(e.getHTML())).toBe('<p><a href="{{book_assessment_link}}">a</a> <a href="https://x.example/y">b</a> c</p>')
    e.destroy()
  })
})

describe('the Message card', () => {
  const mount = async (props: any = {}) => {
    const got: any = { ready: null, changes: [] as string[] }
    await act(async () => { root.render(<EmailBodyEditor initialBody={'Hi {{first_name}},\n\nCome and see our home today.'} initialFormat="plain" onReady={(h: string) => { got.ready = h }} onChange={(h: string) => got.changes.push(h)} links={{ discovery: 'https://cal.example.com/d', inHome: 'https://cal.example.com/h', video: '' }} {...props} />) })
    await until(() => container.querySelector('.ProseMirror') && got.ready)
    return got
  }
  const panel = () => document.querySelector('[data-editor-panel="link"]') as HTMLElement | null
  it('opens on the body as whitelisted html, with the toolbar, the Merge tags control and the footnote', async () => {
    const got = await mount()
    expect(got.ready).toBe('<p>Hi {{first_name}},</p><p>Come and see our home today.</p>')
    expect(container.querySelector('.bo-merge-tag')!.textContent).toBe('{{first_name}}')
    expect(Array.from(container.querySelectorAll('[data-tool]')).map(b => b.getAttribute('data-tool'))).toEqual(['bold', 'italic', 'underline', 'size', 'left', 'center', 'right', 'bullets', 'numbers', 'link'])
    expect(container.querySelector('[data-merge-tags-open]')!.textContent).toContain('Merge tags')
    expect(container.textContent).toContain('Client details are filled in automatically when the email is sent.')
  })
  it('the toolbar has no divider elements: each group’s own edge is the divider, so a wrapped row cannot start with a stray one', async () => {
    await mount()
    expect(container.querySelectorAll('.bo-toolbar-group').length).toBe(5)
    expect(container.querySelector('.toolbar-divider, [data-divider]')).toBeNull()
    expect(EDITOR_SRC).toContain('.bo-toolbar-row{display:flex;flex-wrap:wrap;margin-left:-9px')
    expect(EDITOR_SRC).toMatch(/role="toolbar"[^>]*overflow: 'hidden'/)
  })
  it('the link panel lists the three booking links by name with their real addresses, in-home first; one that is not saved says "Not set up" and cannot be picked', async () => {
    await mount()
    await click(container.querySelector('[data-tool="link"]'))
    const options = Array.from(panel()!.querySelectorAll('[data-link-option]')) as HTMLButtonElement[]
    expect(options.map(o => [o.getAttribute('data-link-option'), o.querySelector('[data-link-url]')!.textContent, o.disabled])).toEqual([
      ['inHome', 'https://cal.example.com/h', false], ['discovery', 'https://cal.example.com/d', false], ['video', 'Not set up', true],
    ])
    expect(panel()!.textContent).toContain('or paste a link')
    expect(EDITOR_LINKS.map(l => [l.id, l.tag])).toEqual([['inHome', '{{book_assessment_link}}'], ['discovery', '{{discovery_booking_link}}'], ['video', '{{virtual_booking_link}}']])
  })
  it('picking a booking link stores its merge tag — the address shown is never saved', async () => {
    const got = await mount()
    await click(container.querySelector('[data-tool="link"]'))
    await type(panel()!.querySelector('[data-link-text]') as HTMLInputElement, 'Book a visit')
    await click(panel()!.querySelector('[data-link-option="inHome"]'))
    const last = got.changes[got.changes.length - 1]
    expect(last).toContain('<a href="{{book_assessment_link}}">Book a visit</a>')
    expect(JSON.stringify(got.changes)).not.toContain('cal.example.com')
    expect(panel()).toBeNull()
  })
  it('with no location (the master editor) all three can be picked', async () => {
    await mount({ links: null })
    await click(container.querySelector('[data-tool="link"]'))
    expect(Array.from(panel()!.querySelectorAll('[data-link-option]')).map(o => [(o as HTMLButtonElement).disabled, o.querySelector('[data-link-url]')!.textContent])).toEqual([[false, 'Each location’s own link'], [false, 'Each location’s own link'], [false, 'Each location’s own link']])
  })
  for (const bad of ['javascript:alert(1)', 'mailto:a@b.com', 'not a link', '']) {
    it(`a pasted "${bad}" is refused, plainly, and nothing is inserted`, async () => {
      const got = await mount()
      await click(container.querySelector('[data-tool="link"]'))
      await type(panel()!.querySelector('[data-link-url-input]') as HTMLInputElement, bad)
      await click(panel()!.querySelector('[data-link-insert]'))
      expect(panel()!.querySelector('[data-link-error]')!.textContent).toContain(LINK_PROBLEM)
      expect(got.changes.join('')).not.toContain('<a ')
    })
  }
  it('a pasted address without https:// is saved with it', async () => {
    const got = await mount()
    await click(container.querySelector('[data-tool="link"]'))
    await type(panel()!.querySelector('[data-link-text]') as HTMLInputElement, 'my page')
    await type(panel()!.querySelector('[data-link-url-input]') as HTMLInputElement, 'calendly.com/kc')
    await click(panel()!.querySelector('[data-link-insert]'))
    expect(got.changes[got.changes.length - 1]).toContain('<a href="https://calendly.com/kc">my page</a>')
  })
  it('the panels are put on the page itself, not inside the dialog (which is transformed and would trap them); under 640px they are a bottom sheet', async () => {
    await mount()
    await click(container.querySelector('[data-tool="link"]'))
    expect(panel()!.parentElement).toBe(document.body)
    expect(container.querySelector('[data-editor-panel]')).toBeNull()
    expect(EDITOR_SRC).toContain("const q = '(max-width: 639px)'")
    expect(EDITOR_SRC).toMatch(/phone\s*\n?\s*\? \{ outline: 'none', position: 'fixed', zIndex: 91, left: 0, right: 0, bottom: 0/)
    expect(EDITOR_SRC).toContain('createPortal(body, document.body)')
  })
  it('the overlay behind a panel closes nothing: only ✕ or Escape does', async () => {
    await mount()
    await click(container.querySelector('[data-tool="link"]'))
    const overlay = panel()!.querySelector('[aria-hidden]') as HTMLElement
    await act(async () => { overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); overlay.click() })
    expect(panel()).toBeTruthy()
    await act(async () => { panel()!.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(panel()).toBeNull()
    await click(container.querySelector('[data-tool="link"]'))
    await click(panel()!.querySelector('button[aria-label="Close add a link"]'))
    expect(panel()).toBeNull()
  })
  it('Merge tags lists every tag an owner is offered and puts the picked one in the message', async () => {
    const got = await mount()
    await click(container.querySelector('[data-merge-tags-open]'))
    const options = Array.from(document.querySelectorAll('[data-merge-tag-option]'))
    expect(options.length).toBeGreaterThanOrEqual(10)
    await click(document.querySelector('[data-merge-tag-option="location_name"]'))
    expect(got.changes[got.changes.length - 1]).toContain('{{location_name}}')
    expect(document.querySelector('[data-editor-panel="tags"]')).toBeNull()
  })
  it('…unless the dialog takes it for the Subject box', async () => {
    const taken: string[] = []
    const got = await mount({ onInsertTag: (t: string) => { taken.push(t); return true } })
    await click(container.querySelector('[data-merge-tags-open]'))
    await click(document.querySelector('[data-merge-tag-option="location_name"]'))
    expect(taken).toEqual(['{{location_name}}'])
    expect(got.changes.join('')).not.toContain('location_name')
  })
})

describe('the two email dialogs', () => {
  const STEP = (over: any = {}) => ({ step_order: 2, subject: 'Hi', body: 'Hello {{first_name}}\n\nSee HERE (https://x.example/y)', delay_days: 5, ...over })
  const mountStep = async (step: any, props: any = {}) => {
    const onSave = vi.fn(async () => undefined)
    await act(async () => { root.render(<DripPathStepEditor step={step} onSave={onSave} onClose={() => {}} {...props} />) })
    return onSave
  }
  const editorUp = () => until(() => container.querySelector('.ProseMirror'))
  const patch = (onSave: any) => (onSave.mock.calls[0] as any[])[0]

  it('before the migration the dialog is the plain text box it was, and saves what it always saved', async () => {
    const onSave = await mountStep(STEP())
    await tick(80)
    expect(container.querySelector('textarea')).toBeTruthy()
    expect(container.querySelector('[data-email-body-editor]')).toBeNull()
    expect(container.querySelector('[data-merge-tag-picker]')).toBeTruthy()
    await click(button('Save'))
    expect(patch(onSave)).toEqual({ subject: 'Hi', body: STEP().body, delay_days: 5 })
  })
  it('after it, the Message editor replaces the box and the chips under it', async () => {
    await mountStep(STEP(), { bodyReady: true })
    await editorUp()
    expect(container.querySelector('[data-email-body-editor]')).toBeTruthy()
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.querySelector('[data-merge-tag-picker]')).toBeNull()
    expect(container.textContent).toContain('Pick one from Merge tags, above the message.')
  })
  it('A BODY NOBODY TOUCHED IS SAVED AS IT WAS: a plain body stays plain when only the subject changes', async () => {
    const onSave = await mountStep(STEP(), { bodyReady: true })
    await editorUp()
    await type(container.querySelector('input[type="text"]') as HTMLInputElement, 'A new subject')
    await click(button('Save'))
    expect(patch(onSave)).toMatchObject({ subject: 'A new subject', body: STEP().body, body_format: 'plain' })
  })
  it('an html body nobody touched is saved as the same html', async () => {
    const html = '<p>Hello <strong>there</strong> {{first_name}}</p>'
    const onSave = await mountStep(STEP({ body: html, body_format: 'html' }), { bodyReady: true })
    await editorUp()
    await click(button('Save'))
    expect(patch(onSave)).toMatchObject({ body: html, body_format: 'html' })
  })
  it('a body that is already html opens in the editor even if the ready flag never arrived — never as raw tags in a text box', async () => {
    await mountStep(STEP({ body: '<p>Hi</p>', body_format: 'html' }))
    await editorUp()
    expect(container.querySelector('textarea')).toBeNull()
  })
  it('a touched body is saved as the editor’s html, marked html', async () => {
    const onSave = await mountStep(STEP(), { bodyReady: true })
    await editorUp()
    await click(container.querySelector('[data-merge-tags-open]'))
    await click(document.querySelector('[data-merge-tag-option="location_name"]'))
    await click(button('Save'))
    const p = patch(onSave)
    expect(p.body_format).toBe('html')
    expect(p.body).toContain('{{location_name}}')
    expect(p.body).toContain('<a href="https://x.example/y">HERE</a>')
    expect(sanitizeEmailHtml(p.body)).toBe(p.body)
  })
  it('an empty message is refused', async () => {
    const onSave = await mountStep(STEP({ body: '<p></p><p> </p>', body_format: 'html' }), { bodyReady: true })
    await editorUp()
    await click(button('Save'))
    expect(onSave).not.toHaveBeenCalled()
    expect(container.textContent).toContain('The email body can’t be empty.')
  })
  it('Preview shows the draft and coming back keeps it', async () => {
    await mountStep(STEP(), { bodyReady: true })
    await editorUp()
    await click(container.querySelector('[data-merge-tags-open]'))
    await click(document.querySelector('[data-merge-tag-option="location_name"]'))
    await click(button('Preview'))
    expect(container.querySelector('[data-editor-preview]')).toBeTruthy()
    await click(button('Back to editing'))
    await editorUp()
    expect(Array.from(container.querySelectorAll('.bo-merge-tag')).map(t => t.textContent)).toContain('{{location_name}}')
  })
  it('the template dialog: untouched keeps the plain body, touched hands the format on; the plain box calls onSave as it always did', async () => {
    const row = { when: 'Next day', subject: 'Welcome', body: 'Hello {{first_name}}', bodyFormat: 'plain' }
    let onSave = vi.fn(async () => undefined)
    await act(async () => { root.render(<EmailTemplateEditor row={row} onCancel={() => {}} onSave={onSave} />) })
    await type(container.querySelector('input') as HTMLInputElement, 'Welcome!')
    await click(button('Save'))
    expect(onSave.mock.calls[0]).toEqual(['Welcome!', 'Hello {{first_name}}', { button_text: null, button_link: null, button_align: null }])
    act(() => root.unmount()); root = createRoot(container)
    onSave = vi.fn(async () => undefined)
    await act(async () => { root.render(<EmailTemplateEditor row={row} onCancel={() => {}} onSave={onSave} bodyReady />) })
    await editorUp()
    await type(container.querySelector('input') as HTMLInputElement, 'Welcome!')
    await click(button('Save'))
    expect((onSave.mock.calls[0] as any[])[1]).toBe('Hello {{first_name}}')
    expect((onSave.mock.calls[0] as any[])[3]).toBe('plain')
  })
})

describe('the format travels with the body through the screen', () => {
  it('a step’s body and its shape come from the same row: its own text, else its linked template', () => {
    const templates = [{ dbId: 't1', legacyId: 'x', subject: 'T', body: '<p>tpl</p>', bodyFormat: 'html' }]
    expect(stepEditorFormat({ body: 'own', bodyFormat: 'plain', masterTemplateId: 't1' }, templates)).toBe('plain')
    expect(stepEditorFormat({ body: null, masterTemplateId: 't1' }, templates)).toBe('html')
    expect(stepEditorFormat({ body: '<p>x</p>', bodyFormat: 'html' }, [])).toBe('html')
    expect(stepEditorFormat({ body: 'x' }, [])).toBe('plain')
    expect(stepEditorContent({ body: null, masterTemplateId: 't1' }, templates)).toEqual({ subject: 'T', body: '<p>tpl</p>' })
  })
  it('saving new wording onto a step records its shape; plain wording over html clears the mark', () => {
    expect(applyStepContentEdit({ order: 1, subject: 'S', body: 'old' }, { subject: 'S', body: '<p>new</p>', body_format: 'html', delay_days: 0 }, []).bodyFormat).toBe('html')
    expect(applyStepContentEdit({ order: 1, subject: 'S', body: '<p>old</p>', bodyFormat: 'html' }, { subject: 'S', body: 'new', delay_days: 0 }, []).bodyFormat).toBe('plain')
    expect(applyStepContentEdit({ order: 1, subject: 'S', body: 'old' }, { subject: 'S', body: 'new', delay_days: 0 }, [])).not.toHaveProperty('bodyFormat')
  })
  it('the list shows an html email’s words, not its tags, and hands the editor its format', () => {
    const rows = buildEmailList({ pathSteps: { p: [{ order: 1, type: 'email', subject: 'S', body: '<p>Hi {{first_name}},</p><p>We <strong>would</strong> love to help.</p>', bodyFormat: 'html', delay_days: 0, dbId: 'd1' }] }, templates: [], pathKey: 'p' })
    const row = rows.flat ? rows.flat().find((r: any) => r && r.rail === 'drip') : null
    const found = row || JSON.parse(JSON.stringify(rows)).groups?.[0]?.rows?.[0] || Object.values(rows as any).flat().find((r: any) => r && r.rail === 'drip')
    expect(found.bodyFormat).toBe('html')
    expect(found.firstLine).toBe('We would love to help.')
  })
  it('the whole-sequence save names the format only for an html body; the template save too', () => {
    expect(HUB).toContain("...(s.bodyFormat === 'html' && s.body != null ? { body_format: 'html' } : {}),")
    expect(HUB).toContain("body: JSON.stringify({ subject, body, ...(bodyFormat === 'html' ? { body_format: 'html' } : {}),")
    expect(HUB).toContain("bodyFormat: s.body_format === 'html' ? 'html' : 'plain',")
    expect(HUB).toContain("bodyFormat: r.body_format === 'html' ? 'html' : 'plain',")
    expect(HUB).toContain("bodyReady: emailSettings.ready.bodyFormat === true,")
    // Corporate's master editor (Admin › Content) is pinned to the code it was
    // at 722aaa0 (lib/guides-retired.test.tsx), so it keeps the plain text box.
    expect(HUB).not.toContain("bodyReady={'body_format' in editing.step}")
  })
  it('the server tells the screen when the editor may be offered, and every read that feeds it carries the format', () => {
    const settings = read('app/api/locations/[id]/email-settings/route.ts')
    expect(settings).toContain("'body_format' in (r.data[0] as Record<string, unknown>)")
    expect(settings).toContain('return has(steps) && has(templates)')
    expect(settings).toContain('ready: { ...readiness(row), align: await alignReady(), bodyFormat: await bodyFormatReady() },')
    const one = read('app/api/drip-paths/[id]/route.ts')
    expect(one).toContain("body_format: (s as any).body_format === 'html' ? 'html' : 'plain',")
    expect(one).not.toMatch(/select\('[^']*body_format/)
  })
  it('the older screens that only know text are given an html body’s words', () => {
    expect((HUB.match(/bodyAsPlainText\(template\.body, template\.bodyFormat\)/g) || []).length).toBe(3)
    expect(HUB).toContain('useState(bodyAsPlainText(template?.body, template?.bodyFormat))')
    expect(HUB).toContain('Saving here keeps the words and drops the formatting.')
    expect(bodyAsPlainText('<p>Hi <strong>you</strong></p><ul><li>a</li></ul>', 'html')).toBe('Hi you\n\n- a')
    expect(bodyAsPlainText('a <b> c', 'plain')).toBe('a <b> c')
    expect(bodyAsPlainText('a <b> c', undefined)).toBe('a <b> c')
  })
  it('the preview fills an html body’s values escaped and tells the layout its shape', () => {
    const values = { first_name: 'Tom <b>&</b>', location_name: 'Denver', book_assessment_link: 'https://cal.example.com/h?a=1&b=2' }
    const out = previewEmailHtml({ row: { subject: 'S {{first_name}}', body: '<p>Hi {{first_name}}, <a href="{{book_assessment_link}}">book</a> <strong>now</strong></p>', bodyFormat: 'html' }, style: 'soft', values })
    expect(out).toContain('Hi Tom &lt;b&gt;&amp;&lt;/b&gt;, <a href="https://cal.example.com/h?a=1&amp;b=2"')
    expect(out).toContain('<strong style="font-weight:700;">now</strong>')
    const plain = previewEmailHtml({ row: { subject: 'S', body: 'Hi {{first_name}} <strong>x</strong>' }, style: 'soft', values })
    expect(plain).toContain('Hi Tom &lt;b&gt;&amp;&lt;/b&gt; &lt;strong&gt;x&lt;/strong&gt;')
  })
})

describe('useBodyDraft', () => {
  const probe = (body: string, format: any, ready: any) => {
    let got: any = null
    const P = () => { got = useBodyDraft(body, format, ready); return null }
    act(() => { root.render(<P />) })
    return () => got
  }
  it('not ready and plain → the plain box: body is the text, format plain, no editor', () => {
    const d = probe('Hello', 'plain', false)()
    expect([d.rich, d.body, d.format, d.touched, d.editor]).toEqual([false, 'Hello', 'plain', false, null])
  })
  it('ready → rich; until the editor reports in, the body is the original in its own shape', () => {
    const d = probe('Hello', undefined, true)()
    expect([d.rich, d.body, d.format, d.touched, d.text]).toEqual([true, 'Hello', 'plain', false, 'Hello'])
    expect(d.editor.initialBody).toBe('Hello')
    expect(d.editor.initialFormat).toBe('plain')
  })
  it('touched only once the editor’s html differs from what it first reported', () => {
    const get = probe('Hello', 'plain', true)
    act(() => { get().editor.onReady('<p>Hello</p>') })
    expect([get().touched, get().body, get().format]).toEqual([false, 'Hello', 'plain'])
    act(() => { get().editor.onChange('<p>Hello</p>') })
    expect(get().touched).toBe(false)
    act(() => { get().editor.onChange('<p>Hello you</p>') })
    expect([get().touched, get().body, get().format, get().text]).toEqual([true, '<p>Hello you</p>', 'html', 'Hello you'])
    // the editor remounts after Preview: it is handed the draft, and the baseline does not move
    expect([get().editor.initialBody, get().editor.initialFormat]).toEqual(['<p>Hello you</p>', 'html'])
    act(() => { get().editor.onReady('<p>Hello you</p>') })
    expect(get().touched).toBe(true)
  })
})

describe('the editor is loaded on its own, and brought only TipTap', () => {
  it('nothing imports the editor file directly except the lazy loader', () => {
    expect(HUB).not.toMatch(/from ["'][^"']*EmailBodyEditor["']/)
    expect(HUB).not.toMatch(/from ["']@tiptap/)
    const screen = read('components/settings/EmailsScreen.jsx')
    expect(screen).toContain("const LazyBodyEditor = React.lazy(() => import('./EmailBodyEditor'))")
    expect(screen).not.toMatch(/^import .*EmailBodyEditor/m)
    expect(screen).not.toMatch(/from ["']@tiptap/)
  })
  it('package.json gained exactly the five TipTap packages, pinned, and nothing from the design’s scaffolding', () => {
    const pkg = JSON.parse(read('package.json'))
    const tiptap = Object.entries(pkg.dependencies).filter(([k]) => k.startsWith('@tiptap/'))
    expect(tiptap).toEqual([
      ['@tiptap/extension-text-align', '3.34.0'], ['@tiptap/extension-text-style', '3.34.0'], ['@tiptap/pm', '3.34.0'], ['@tiptap/react', '3.34.0'], ['@tiptap/starter-kit', '3.34.0'],
    ])
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@supabase/ssr', '@supabase/supabase-js', '@tiptap/extension-text-align', '@tiptap/extension-text-style', '@tiptap/pm', '@tiptap/react', '@tiptap/starter-kit', '@vercel/functions', 'date-fns', 'date-fns-tz', 'google-auth-library', 'next', 'react', 'react-dom', 'resend', 'stripe'])
    expect(JSON.stringify(pkg)).not.toMatch(/lucide|radix|tanstack|shadcn|tailwind/i)
    expect(EDITOR_SRC).not.toMatch(/lucide|radix|@\/components\/ui|className="(?!bo-)/)
  })
})
