'use client'
// components/settings/EmailBodyEditor.jsx
//
// THE MESSAGE EDITOR (2026-11-13, slice 2b of the Lovable email editor).
// The "Message" card: a real editor in place of the text box an owner used to
// type {{first_name}} and "word (https://…)" into.
//
//   toolbar      bold, italic, underline · Normal / Large · left, centre,
//                right · bullets, numbers · link. Headings are off, as the
//                design has them. Sizes are Kevin's ruling: Normal is the
//                email's own 17px, Large is 20px, there is no Small.
//   merge tags   picked from "Merge tags" (top right). In the message a tag is
//                ONE THING: one backspace takes all of it or none — never
//                {{first_nam}}. Typing or pasting {{first_name}} makes one too.
//   link panel   select words, press the link button: the three saved booking
//                links by name with their real addresses ("Not set up" when
//                one is blank — dimmed, not hidden), or paste an address. A
//                booking link is stored as its MERGE TAG, never the address,
//                so it follows the location (Kevin, 2026-11-13).
//
// TWO FAULTS IN THE DESIGN, FIXED HERE:
//   1. on a phone the link panel floated flush to the right edge over the
//      next card. Here it is a sheet from the bottom under 640px.
//   2. the phone toolbar's second row began with a stray divider. Dividers
//      are each group's own left edge, and the row clips the one at its start.
//
// WHAT COMES OUT is always sanitizeEmailHtml(editor html) — the same whitelist
// the server rebuilds from (lib/email-body-html.ts). The editor is loaded on
// its own (React.lazy in the editors), so nobody who never opens an email
// downloads it.
//
// It LOOKS like the email: the sent body's font, size and colour, not the
// design's serif, so what an owner types is what a client reads.

import React from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, useEditor, useEditorState, Node, Extension, nodeInputRule, nodePasteRule, mergeAttributes } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle, FontSize } from '@tiptap/extension-text-style'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ET, ER, EF, ESHADOW, alpha, eLabelStyle, eInputStyle, eHintStyle } from './EmailsScreen'
import { OWNER_MERGE_TAGS, MERGE_TAG_GROUPS } from '@/lib/merge-tags'
import { bodyForEditor, sanitizeEmailHtml, allowedHref, LARGE_PX } from '@/lib/email-body-html'
import { safeHttpUrl } from '@/lib/email-signature'
import { EMAIL_SANS, EMAIL_TEXT } from '@/lib/drip-email-layout'

// The three booking links, in the order the panel lists them: the one the
// emails we write use first.
export const EDITOR_LINKS = [
  { id: 'inHome', name: 'In-home assessment', tag: '{{book_assessment_link}}' },
  { id: 'discovery', name: 'Discovery call', tag: '{{discovery_booking_link}}' },
  { id: 'video', name: 'Video assessment', tag: '{{virtual_booking_link}}' },
]
export const LINK_PROBLEM = 'Enter a full website address, starting with https://.'
const LARGE = `${LARGE_PX}px`
const MERGE_HREF = /^\{\{\w+\}\}$/

// ── a merge tag is one thing ───────────────────────────────────────────
export const MergeTag = Node.create({
  name: 'mergeTag',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  priority: 1000,   // before TextStyle, which also reads spans
  addAttributes() {
    return { name: { default: '', parseHTML: el => el.getAttribute('data-merge-tag') || '', renderHTML: a => ({ 'data-merge-tag': a.name }) } }
  },
  parseHTML() { return [{ tag: 'span[data-merge-tag]' }] },
  renderHTML({ node, HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { class: 'bo-merge-tag' }), `{{${node.attrs.name}}}`] },
  renderText({ node }) { return `{{${node.attrs.name}}}` },
  // No capture group: the rule swaps the WHOLE match for the tag. With one
  // it keeps what is outside the group, and typing a tag left "{{" and "}"
  // behind around it.
  addInputRules() { return [nodeInputRule({ find: /\{\{\w+\}\}$/, type: this.type, getAttributes: m => ({ name: m[0].slice(2, -2) }) })] },
  addPasteRules() { return [nodePasteRule({ find: /\{\{\w+\}\}/g, type: this.type, getAttributes: m => ({ name: m[0].slice(2, -2) }) })] },
})

// ── the words being linked stay marked while the panel is open ─────────
const hlKey = new PluginKey('boLinkHighlight')
export const SelectionHighlight = Extension.create({
  name: 'boLinkHighlight',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: hlKey,
      state: {
        init: () => null,
        apply(tr, old) {
          const meta = tr.getMeta(hlKey)
          if (meta !== undefined) return meta
          return old && tr.docChanged ? { from: tr.mapping.map(old.from), to: tr.mapping.map(old.to) } : old
        },
      },
      props: {
        decorations(state) {
          const r = hlKey.getState(state)
          return r && r.to > r.from ? DecorationSet.create(state.doc, [Decoration.inline(r.from, r.to, { class: 'bo-link-target' })]) : null
        },
      },
    })]
  },
})

export const editorExtensions = () => [
  StarterKit.configure({
    heading: false, codeBlock: false, code: false, blockquote: false, horizontalRule: false, strike: false,
    link: {
      openOnClick: false,
      // A booking link is its merge tag.
      isAllowedUri: (url, ctx) => MERGE_HREF.test(String(url || '').trim()) || ctx.defaultValidate(url),
    },
  }),
  TextAlign.configure({ types: ['paragraph'], alignments: ['left', 'center', 'right'] }),
  TextStyle, FontSize, MergeTag, SelectionHighlight,
]
// Spaces are kept as typed: an owner's double space is theirs.
export const PARSE = { preserveWhitespace: 'full' }

const CSS = `
.bo-editor .ProseMirror{outline:none;min-height:200px;padding:16px 18px;font-family:${EMAIL_SANS};font-size:17px;line-height:28px;font-weight:300;color:${EMAIL_TEXT};white-space:pre-wrap;word-break:break-word}
.bo-editor .ProseMirror p{margin:0 0 20px}
.bo-editor .ProseMirror p:last-child{margin-bottom:0}
.bo-editor .ProseMirror ul,.bo-editor .ProseMirror ol{margin:0 0 20px;padding:0 0 0 24px}
.bo-editor .ProseMirror li{margin:0 0 6px}
.bo-editor .ProseMirror li p{margin:0}
.bo-editor .ProseMirror strong{font-weight:700}
.bo-editor .ProseMirror a{color:${EMAIL_TEXT};text-decoration:underline;cursor:text}
.bo-editor .bo-merge-tag{display:inline-block;padding:0 6px;border-radius:6px;background:${ET.sageSoft};color:${ET.primary};font-size:.82em;font-weight:500;line-height:1.5;white-space:nowrap;font-family:${EF.ui}}
.bo-editor .bo-merge-tag.ProseMirror-selectednode{outline:2px solid ${ET.gold}}
.bo-editor .bo-link-target{background:${ET.goldSoft}}
.bo-toolbar-row{display:flex;flex-wrap:wrap;margin-left:-9px;row-gap:4px}
.bo-toolbar-group{display:flex;align-items:center;gap:2px;padding:0 8px;border-left:1px solid ${ET.border}}
.bo-tool{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:${ER.md};border:none;background:transparent;color:${ET.ink};cursor:pointer;padding:0}
.bo-tool[aria-pressed="true"]{background:${ET.goldSoft};color:${ET.foreground}}
.bo-tool:hover{background:${ET.muted}}
.bo-tool[aria-pressed="true"]:hover{background:${ET.goldSoft}}
@media (max-width:639px){.bo-tool{width:44px;height:44px}}
[data-emails-ui] .bo-editor .ProseMirror:focus-visible{box-shadow:none!important}
.bo-editor [data-writing-area]:focus-within{box-shadow:0 0 0 2px ${ET.gold}}
.bo-size{height:36px;border:none;border-radius:${ER.md};background:transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23595C57' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 6px center;color:${ET.foreground};font-family:${EF.ui};cursor:pointer;padding:0 24px 0 6px}
@media (max-width:639px){.bo-size{height:44px}}
`

const I = (d) => <svg aria-hidden width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
const ICON = {
  bold: I(<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />),
  italic: I(<><line x1="19" y1="5" x2="10" y2="5" /><line x1="14" y1="19" x2="5" y2="19" /><line x1="15" y1="5" x2="9" y2="19" /></>),
  underline: I(<><path d="M6 4v6a6 6 0 0 0 12 0V4" /><line x1="4" y1="20" x2="20" y2="20" /></>),
  left: I(<><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="14" y2="12" /><line x1="4" y1="18" x2="18" y2="18" /></>),
  center: I(<><line x1="4" y1="6" x2="20" y2="6" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="5" y1="18" x2="19" y2="18" /></>),
  right: I(<><line x1="4" y1="6" x2="20" y2="6" /><line x1="10" y1="12" x2="20" y2="12" /><line x1="6" y1="18" x2="20" y2="18" /></>),
  bullets: I(<><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><line x1="4.5" y1="6" x2="4.51" y2="6" /><line x1="4.5" y1="12" x2="4.51" y2="12" /><line x1="4.5" y1="18" x2="4.51" y2="18" /></>),
  numbers: I(<><line x1="10" y1="6" x2="20" y2="6" /><line x1="10" y1="12" x2="20" y2="12" /><line x1="10" y1="18" x2="20" y2="18" /><path d="M4 4.5 5.5 4v4.5" /><path d="M4 14.5c0-1 2.5-1 2.5.2 0 .9-2.5 1.6-2.5 3.3h2.7" /></>),
  link: I(<><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" /></>),
  braces: I(<><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" /><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></>),
  x: I(<path d="M18 6 6 18M6 6l12 12" />),
  arrow: I(<><path d="M7 17 17 7" /><path d="M8 7h9v9" /></>),
  inHome: I(<><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" /><path d="M9.5 20.5v-6h5v6" /></>),
  discovery: I(<><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><line x1="8" y1="3" x2="8" y2="7" /><line x1="16" y1="3" x2="16" y2="7" /><line x1="3.5" y1="10" x2="20.5" y2="10" /></>),
  video: I(<><rect x="3" y="7" width="12.5" height="10" rx="2" /><path d="m15.5 11 5.5-3v8l-5.5-3" /></>),
}

function usePhone() {
  const q = '(max-width: 639px)'
  const [phone, setPhone] = React.useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(q).matches)
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const m = window.matchMedia(q)
    const on = () => setPhone(m.matches)
    on()
    m.addEventListener?.('change', on)
    return () => m.removeEventListener?.('change', on)
  }, [])
  return phone
}

// A panel over everything: a sheet from the bottom on a phone, a box under
// the toolbar otherwise. Portaled to <body> — the email dialog it opens from
// is transformed, which would otherwise trap a fixed box inside it.
function Panel({ label, title, anchor, under = null, phone, onClose, children, name }) {
  const [box, setBox] = React.useState(null)
  // Focus comes into the panel, so Escape reaches it wherever the cursor was.
  const boxRef = React.useRef(null)
  React.useEffect(() => { try { boxRef.current?.focus({ preventScroll: true }) } catch { /* not focusable yet */ } }, [])
  React.useLayoutEffect(() => {
    if (phone || !anchor?.current) { setBox(null); return }
    // Right edge on the writing area's, top just under the toolbar.
    const r = anchor.current.getBoundingClientRect()
    const bar = (under?.current || anchor.current).getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 32)
    const left = Math.max(16, Math.min(r.right - width, window.innerWidth - width - 16))
    const top = Math.max(16, Math.min(bar.bottom + 8, window.innerHeight - 200))
    setBox({ left, top, width, maxHeight: window.innerHeight - top - 16 })
  }, [phone, anchor, under])
  const body = (
    <div data-emails-ui data-editor-panel={name} data-sheet={phone ? 'true' : undefined} style={{ fontFamily: EF.ui, color: ET.foreground }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); onClose() } }}>
      {/* The overlay closes nothing (Kevin, 2026-09-30): ✕ or Escape. It only
          keeps a stray tap off the email underneath. */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 90, background: phone ? alpha(ET.foreground, 0.4) : 'transparent' }} />
      <div ref={boxRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label}
        style={phone
          ? { outline: 'none', position: 'fixed', zIndex: 91, left: 0, right: 0, bottom: 0, maxHeight: '85vh', overflowY: 'auto', boxSizing: 'border-box', background: ET.card, borderRadius: `${ER.xxl} ${ER.xxl} 0 0`, padding: '18px 16px calc(18px + env(safe-area-inset-bottom))', boxShadow: ESHADOW.dialog }
          : { outline: 'none', position: 'fixed', zIndex: 91, boxSizing: 'border-box', overflowY: 'auto', background: ET.card, border: `1px solid ${ET.border}`, borderRadius: ER.xl, padding: '18px', boxShadow: ESHADOW.dialog, ...(box || { left: -9999, top: 0, width: 360 }) }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, fontFamily: EF.heading }}>{title}</h3>
          <button type="button" aria-label={`Close ${label.toLowerCase()}`} onClick={onClose} data-ehover="muted"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', flex: 'none', borderRadius: ER.md, border: `1px solid ${ET.border}`, background: ET.card, color: ET.foreground, cursor: 'pointer', padding: 0 }}>{ICON.x}</button>
        </div>
        {children}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? null : createPortal(body, document.body)
}

// onInsertTag: the dialog's chance to put a picked tag somewhere else first
// (the Subject box, when the cursor was last there). True = it did.
export default function EmailBodyEditor({ initialBody = '', initialFormat = 'plain', onChange, onReady = null, onFocus = null, onInsertTag = null, links = null, tags = OWNER_MERGE_TAGS }) {
  const phone = usePhone()
  const areaRef = React.useRef(null)
  const barRef = React.useRef(null)
  const [linkOpen, setLinkOpen] = React.useState(false)
  const [tagsOpen, setTagsOpen] = React.useState(false)
  const [range, setRange] = React.useState({ from: 0, to: 0 })
  const [linkText, setLinkText] = React.useState('')
  const [hadWords, setHadWords] = React.useState(false)
  const [linkUrl, setLinkUrl] = React.useState('')
  const [linkErr, setLinkErr] = React.useState('')
  const [inLink, setInLink] = React.useState(false)
  const out = (ed) => sanitizeEmailHtml(ed.getHTML())

  const editor = useEditor({
    extensions: editorExtensions(),
    content: bodyForEditor(initialBody, initialFormat),
    parseOptions: PARSE,
    immediatelyRender: false,
    editorProps: { attributes: { 'aria-label': 'Email message', role: 'textbox', 'aria-multiline': 'true' } },
    onCreate: ({ editor: ed }) => { onReady?.(out(ed)) },
    onUpdate: ({ editor: ed }) => { onChange?.(out(ed)) },
    onFocus: () => { onFocus?.() },
  })
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => !e ? {} : ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'),
      center: e.isActive({ textAlign: 'center' }), right: e.isActive({ textAlign: 'right' }),
      bullets: e.isActive('bulletList'), numbers: e.isActive('orderedList'), link: e.isActive('link'),
      large: e.getAttributes('textStyle').fontSize === LARGE,
    }),
  }) || {}

  const closeLink = () => {
    setLinkOpen(false)
    editor?.view.dispatch(editor.state.tr.setMeta(hlKey, null))
  }
  const openLink = () => {
    if (!editor) return
    setTagsOpen(false)
    // Inside a link: the whole link is what is being changed.
    if (editor.isActive('link')) editor.chain().extendMarkRange('link').run()
    const { from, to } = editor.state.selection
    const words = editor.state.doc.textBetween(from, to, ' ')
    const href = editor.getAttributes('link').href || ''
    setRange({ from, to })
    setLinkText(words)
    setHadWords(!!words.trim())
    setInLink(editor.isActive('link'))
    setLinkUrl(MERGE_HREF.test(href) ? '' : href)
    setLinkErr('')
    editor.view.dispatch(editor.state.tr.setMeta(hlKey, to > from ? { from, to } : null))
    setLinkOpen(true)
  }
  // href is a merge tag (a booking link) or a full http(s) address.
  const applyLink = (href, fallbackWords) => {
    if (!editor) return
    const ok = allowedHref(href)
    if (!ok) { setLinkErr(LINK_PROBLEM); return }
    const chain = editor.chain().focus().setTextSelection(range)
    if (range.from === range.to) {
      const words = linkText.trim() || fallbackWords || ok
      chain.insertContent({ type: 'text', text: words, marks: [{ type: 'link', attrs: { href: ok } }] }).run()
    } else chain.setLink({ href: ok }).run()
    closeLink()
  }
  const pasteLink = () => {
    const typed = linkUrl.trim()
    // "calendly.com/you" is saved the way the send reads it, with https://.
    const full = /^https?:\/\//i.test(typed) ? typed : (typed && !/^[a-z][a-z0-9+.-]*:/i.test(typed) ? safeHttpUrl(typed) : null)
    applyLink(full || '', null)
  }
  const removeLink = () => {
    editor?.chain().focus().setTextSelection(range).extendMarkRange('link').unsetLink().run()
    closeLink()
  }
  const insertTag = (key) => {
    if (onInsertTag?.(`{{${key}}}`)) { setTagsOpen(false); return }
    editor?.chain().focus().insertContent({ type: 'mergeTag', attrs: { name: key } }).run()
    setTagsOpen(false)
  }

  const run = (fn) => () => { if (editor) fn(editor.chain().focus()).run() }
  const tool = (key, label, pressed, onClick, extra = {}) => (
    <button key={key} type="button" className="bo-tool" data-tool={key} title={label} aria-label={label} aria-pressed={pressed ? 'true' : 'false'}
      onMouseDown={e => e.preventDefault()} onClick={onClick} {...extra}>{ICON[key]}</button>
  )
  const savedUrl = (id) => (links ? String(links[id] || '').trim() : '')

  return (
    <div data-email-body-editor className="bo-editor" style={{ fontFamily: EF.ui }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '6px' }}>
        <span style={{ ...eLabelStyle, marginBottom: 0 }}>Message</span>
        <button type="button" data-merge-tags-open aria-label="Insert merge tag" aria-expanded={tagsOpen ? 'true' : 'false'} data-ehover="muted"
          onMouseDown={e => e.preventDefault()} onClick={() => { closeLink(); setTagsOpen(o => !o) }}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', minHeight: '36px', padding: '0 10px', borderRadius: ER.md, border: 'none', background: 'transparent', color: ET.ink, fontSize: '14px', fontFamily: EF.ui, cursor: 'pointer' }}>
          {ICON.braces} Merge tags
        </button>
      </div>
      <div ref={areaRef} data-writing-area style={{ border: `1px solid ${ET.input}`, borderRadius: ER.lg, background: ET.card, overflow: 'hidden' }}>
        <div ref={barRef} role="toolbar" aria-label="Message formatting" style={{ overflow: 'hidden', background: ET.background, borderBottom: `1px solid ${ET.border}`, padding: '6px 8px' }}>
          <div className="bo-toolbar-row">
            <div className="bo-toolbar-group">
              {tool('bold', 'Bold', active.bold, run(c => c.toggleBold()))}
              {tool('italic', 'Italic', active.italic, run(c => c.toggleItalic()))}
              {tool('underline', 'Underline', active.underline, run(c => c.toggleUnderline()))}
            </div>
            <div className="bo-toolbar-group">
              <select aria-label="Text size" data-tool="size" value={active.large ? 'large' : 'normal'}
                onChange={e => { if (!editor) return; e.target.value === 'large' ? editor.chain().focus().setFontSize(LARGE).run() : editor.chain().focus().unsetFontSize().run() }}
                className="bo-size">
                <option value="normal">Normal</option>
                <option value="large">Large</option>
              </select>
            </div>
            <div className="bo-toolbar-group">
              {tool('left', 'Align left', !active.center && !active.right, run(c => c.setTextAlign('left')))}
              {tool('center', 'Align centre', active.center, run(c => c.setTextAlign('center')))}
              {tool('right', 'Align right', active.right, run(c => c.setTextAlign('right')))}
            </div>
            <div className="bo-toolbar-group">
              {tool('bullets', 'Bulleted list', active.bullets, run(c => c.toggleBulletList()))}
              {tool('numbers', 'Numbered list', active.numbers, run(c => c.toggleOrderedList()))}
            </div>
            <div className="bo-toolbar-group">
              {tool('link', 'Insert link', active.link || linkOpen, openLink)}
            </div>
          </div>
        </div>
        <EditorContent editor={editor} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', borderTop: `1px solid ${ET.border}`, padding: '8px 12px', fontSize: '12px', color: ET.mutedFg }}>
          <span style={{ display: 'flex', flex: 'none', transform: 'scale(.7)' }}>{ICON.braces}</span> Client details are filled in automatically when the email is sent.
        </div>
      </div>

      {tagsOpen && (
        <Panel name="tags" label="Merge tags" title="Merge tags" anchor={areaRef} under={barRef} phone={phone} onClose={() => setTagsOpen(false)}>
          <p style={{ ...eHintStyle, margin: '0 0 10px' }}>Pick a detail. It goes in where your cursor is and is filled in for each client.</p>
          {MERGE_TAG_GROUPS.map(g => {
            const inGroup = tags.filter(t => t.group === g.id)
            if (!inGroup.length) return null
            return (
              <div key={g.id} style={{ marginBottom: '10px' }}>
                <p style={{ margin: '0 0 4px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: ET.mutedFg }}>{g.title}</p>
                <div style={{ display: 'grid', gap: '4px' }}>
                  {inGroup.map(t => (
                    <button key={t.key} type="button" data-merge-tag-option={t.key} title={t.description} data-ehover="muted" onClick={() => insertTag(t.key)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', minHeight: '44px', padding: '6px 10px', borderRadius: ER.md, border: `1px solid ${ET.border}`, background: ET.card, color: ET.foreground, fontSize: '14px', fontFamily: EF.ui, cursor: 'pointer', textAlign: 'left' }}>
                      <span>{t.label}</span>
                      <span style={{ flex: 'none', fontSize: '11px', color: ET.mutedFg, fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>{`{{${t.key}}}`}</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </Panel>
      )}

      {linkOpen && (
        <Panel name="link" label="Add a link" title="Add a link" anchor={areaRef} under={barRef} phone={phone} onClose={closeLink}>
          <p data-link-about style={{ margin: '0 0 12px', fontSize: '14px', lineHeight: 1.5 }}>
            {hadWords ? <>Link “{linkText.trim()}” to a booking page or website.</> : 'Choose a booking link or add a website address.'}
          </p>
          {!hadWords && (
            <label style={{ display: 'block', marginBottom: '12px' }}>
              <span style={eLabelStyle}>Link text</span>
              <input data-link-text value={linkText} placeholder="Words to link" onChange={e => setLinkText(e.target.value)} style={eInputStyle} />
            </label>
          )}
          <p style={{ margin: '0 0 6px', fontSize: '13px', fontWeight: 600, color: ET.mutedFg }}>Saved booking links</p>
          <div style={{ display: 'grid', gap: '8px' }}>
            {EDITOR_LINKS.map(l => {
              const url = savedUrl(l.id)
              const available = !links || !!url
              return (
                <button key={l.id} type="button" data-link-option={l.id} data-available={available ? 'true' : 'false'} disabled={!available}
                  data-ehover={available ? 'muted' : undefined} onClick={() => applyLink(l.tag, l.name)}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', minHeight: '56px', padding: '8px 12px', borderRadius: ER.lg, textAlign: 'left', fontFamily: EF.ui,
                    border: `1px ${available ? 'solid' : 'dashed'} ${ET.border}`, background: available ? ET.card : ET.muted, color: available ? ET.foreground : ET.mutedFg, cursor: available ? 'pointer' : 'default', opacity: available ? 1 : 0.75 }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', flex: 'none', borderRadius: ER.md, background: ET.goldSoft, color: ET.warning }}>{ICON[l.id]}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '14px', fontWeight: 600 }}>{l.name}</span>
                    <span data-link-url style={{ display: 'block', fontSize: '12px', color: ET.mutedFg, overflowWrap: 'anywhere' }}>{!available ? 'Not set up' : url || 'Each location’s own link'}</span>
                  </span>
                  {available && <span style={{ display: 'flex', flex: 'none' }}>{ICON.arrow}</span>}
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '14px 0 10px', fontSize: '12px', color: ET.mutedFg }}>
            <span style={{ flex: 1, height: '1px', background: ET.border }} />or paste a link<span style={{ flex: 1, height: '1px', background: ET.border }} />
          </div>
          <label style={{ display: 'block' }}>
            <span style={eLabelStyle}>Website address</span>
            <input data-link-url-input type="url" value={linkUrl} placeholder="https://example.com" aria-invalid={linkErr ? 'true' : undefined}
              onChange={e => { setLinkUrl(e.target.value); setLinkErr('') }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); pasteLink() } }}
              style={{ ...eInputStyle, ...(linkErr ? { border: `1px solid ${ET.destructive}` } : null) }} />
            {linkErr && <span role="alert" data-link-error style={{ display: 'block', marginTop: '4px', fontSize: '12px', color: ET.destructive }}>⚠ {linkErr}</span>}
          </label>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '14px' }}>
            {inLink
              ? <button type="button" data-link-remove onClick={removeLink} data-ehover="muted" style={{ minHeight: '40px', padding: '0 12px', borderRadius: ER.md, border: `1px solid ${ET.border}`, background: ET.card, color: ET.foreground, fontSize: '14px', fontFamily: EF.ui, cursor: 'pointer' }}>Remove link</button>
              : <span />}
            <button type="button" data-link-insert onClick={pasteLink}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '40px', padding: '0 16px', borderRadius: ER.md, border: 'none', background: ET.primary, color: ET.primaryFg, fontSize: '14px', fontWeight: 600, fontFamily: EF.ui, cursor: 'pointer', boxShadow: ESHADOW.btn }}>
              {ICON.link} Insert link
            </button>
          </div>
        </Panel>
      )}
    </div>
  )
}
