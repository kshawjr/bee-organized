// lib/email-body-html.ts
//
// THE TWO SHAPES OF AN EMAIL BODY (2026-11-13, groundwork for the rich-text
// editor — slice 2a; no screen uses it yet).
//
// A body in drip_path_steps.body / templates.body is one of:
//
//   plain   what every body is today: text, blank line = new paragraph,
//           "word (https://…)" = a link on the word.
//   html    what the rich editor will save: a SMALL, FIXED set of tags.
//
// Which one a row holds is its body_format column (migrations/
// email_body_format.sql), never a guess from the text: an owner who types
// "a < b" into a plain body must not turn it into HTML.
//
// WHAT HTML IS ALLOWED. A whitelist, rebuilt from scratch on every pass:
//
//   blocks   p, h2, h3 (optional text-align: center | right), ul, ol > li
//   inline   strong, em, u, br, a[href]
//
// Nothing is "stripped out" of the input. The input is read into the small
// tree below and the output is written from that tree, so a tag, attribute,
// style, class or comment that the tree has no slot for cannot survive — a
// paste from Word included. Text is escaped on the way out.
//
// A LINK's href must be a full http(s) address, or exactly one merge tag
// ({{book_assessment_link}}): a booking link is stored as its tag so it
// follows the location (Kevin, 2026-11-13). Anything else — javascript:,
// mailto:, a bare word — and the link is dropped; the words stay.
//
// MERGE TAGS are plain text in both shapes: {{first_name}} is the same
// sixteen characters in a plain body and an html one. Nothing here rewrites,
// wraps or moves them (lib/beta-email-body-format.test.ts round-trips every
// seeded body; scripts/email-body-roundtrip.mjs does the live ones).
//
// Pure: no imports beyond the shared escaper, safe on the server and in the
// browser.

import { escHtml, escAttr } from './email-escape'

export type BodyFormat = 'plain' | 'html'
export const BODY_FORMATS: BodyFormat[] = ['plain', 'html']

// A row's format. A missing column (the migration has not run), null, or any
// unknown value is plain — today's behaviour.
export function bodyFormatOf(row: Record<string, unknown> | null | undefined): BodyFormat {
  return row && row.body_format === 'html' ? 'html' : 'plain'
}

export type Align = 'center' | 'right' | null
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'mark'; tag: 'strong' | 'em' | 'u'; kids: Inline[] }
  | { t: 'a'; href: string; kids: Inline[] }
export type Block =
  | { type: 'p' | 'h2' | 'h3'; align: Align; kids: Inline[] }
  | { type: 'ul' | 'ol'; items: Inline[][] }

const MERGE_TAG_HREF = /^\{\{\w+\}\}$/
const HTTP_HREF = /^https?:\/\/[^\s"'<>]+$/i

// What an href may be when a body is SAVED.
export function allowedHref(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim()
  if (!v) return null
  return MERGE_TAG_HREF.test(v) || HTTP_HREF.test(v) ? v : null
}
// What an href must be when an email is SENT (tags are filled in by then).
export function sendableHref(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim()
  return HTTP_HREF.test(v) ? v : null
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    const hit = NAMED[e.toLowerCase()]
    return hit === undefined ? m : hit
  })
}

const MARK_OF: Record<string, 'strong' | 'em' | 'u'> = { strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'u' }
const BLOCK_OF: Record<string, 'p' | 'h2' | 'h3'> = { p: 'p', div: 'p', h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' }
// Their CONTENT is dropped too, not just the tag.
const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'iframe', 'object', 'svg', 'math', 'xml', 'o:p'])
const TOKEN = /<!--[\s\S]*?-->|<!\[[\s\S]*?\]>|<(\/?)([a-zA-Z][a-zA-Z0-9:]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</g

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs)
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null
}
function alignOf(attrs: string): Align {
  const style = attr(attrs, 'style') || ''
  const m = /(?:^|;)\s*text-align\s*:\s*(center|right)\s*(?:;|$)/i.exec(style)
  const v = (m ? m[1] : attr(attrs, 'align') || '').toLowerCase()
  return v === 'center' || v === 'right' ? v : null
}

// Read ANY html into the small tree. Never throws; unknown input degrades to
// its text.
//
// anyHref: the SEND reads a body whose tags are already filled in, and a
// filled-in address that is not a usable one ("calendly.com/you", saved
// without https://) must still be shown to the reader as words, not vanish.
// So the send keeps every non-empty href and decides at the link
// (sendableHref). A SAVE never passes it.
export function parseEmailHtml(html: string | null | undefined, opts: { anyHref?: boolean } = {}): Block[] {
  const blocks: Block[] = []
  // `as`, so the checker keeps the full type: these are reassigned inside the
  // helpers below, which it cannot see from the loop.
  let block = null as Extract<Block, { kids: Inline[] }> | null
  let list = null as Extract<Block, { items: Inline[][] }> | null
  let item = null as Inline[] | null
  // The open inline containers, innermost last. [0] is the block's (or the
  // list item's) own kids. `kind` null = a link we refused: transparent.
  let stack: { kind: string | null; kids: Inline[] }[] = []
  let skip = 0

  const closeBlock = () => { block = null; if (!item) stack = [] }
  const closeItem = () => { item = null; stack = [] }
  const closeList = () => { closeItem(); list = null }
  const openBlock = (type: 'p' | 'h2' | 'h3', align: Align) => {
    closeList()
    block = { type, align, kids: [] }
    blocks.push(block)
    stack = [{ kind: 'root', kids: block.kids }]
  }
  const openItem = () => {
    if (!list) { list = { type: 'ul', items: [] }; blocks.push(list); block = null }
    item = []
    list.items.push(item)
    stack = [{ kind: 'root', kids: item }]
  }
  const target = (): Inline[] => {
    if (!stack.length) openBlock('p', null)
    return stack[stack.length - 1].kids
  }

  let m: RegExpExecArray | null
  TOKEN.lastIndex = 0
  const src = String(html ?? '')
  while ((m = TOKEN.exec(src)) !== null) {
    const tok = m[0]
    const name = m[2] ? m[2].toLowerCase() : null
    if (!name) {
      if (tok.startsWith('<!')) continue // a comment / conditional: gone
      if (skip) continue
      const text = decodeEntities(tok)
      // Whitespace between blocks (pretty-printed html) is not a paragraph.
      if (!stack.length && !text.trim()) continue
      target().push({ t: 'text', v: text })
      continue
    }
    const closing = m[1] === '/'
    const attrs = m[3] || ''
    if (SKIP.has(name)) { if (closing) skip = Math.max(0, skip - 1); else if (!/\/\s*$/.test(attrs)) skip++; continue }
    if (skip) continue

    if (name in BLOCK_OF) {
      if (item) {
        // TipTap writes <li><p>…</p></li>. A second paragraph in one item is a
        // line break, not a new bullet.
        if (!closing && item.length) { stack = [{ kind: 'root', kids: item }]; item.push({ t: 'br' }) }
        continue
      }
      if (closing) closeBlock()
      else openBlock(BLOCK_OF[name], alignOf(attrs))
      continue
    }
    if (name === 'ul' || name === 'ol') {
      if (closing) { closeList(); continue }
      if (list) continue // a nested list joins its parent: one level only
      block = null; stack = []
      list = { type: name, items: [] }
      blocks.push(list)
      continue
    }
    if (name === 'li') { if (closing) closeItem(); else openItem(); continue }
    if (name === 'br') { if (!closing) target().push({ t: 'br' }); continue }

    const mark = MARK_OF[name] as 'strong' | 'em' | 'u' | undefined
    if (mark || name === 'a') {
      const kind: string = mark || 'a'
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].kind === kind || (kind === 'a' && stack[i].kind === null)) { stack.length = i; break }
        }
        continue
      }
      const into = target()
      if (mark) {
        const node: Inline = { t: 'mark', tag: mark, kids: [] }
        into.push(node)
        stack.push({ kind, kids: node.kids })
      } else {
        const rawHref = (attr(attrs, 'href') || '').trim()
        const href = opts.anyHref ? rawHref || null : allowedHref(rawHref)
        if (href) {
          const node: Inline = { t: 'a', href, kids: [] }
          into.push(node)
          stack.push({ kind, kids: node.kids })
        } else {
          stack.push({ kind: null, kids: into }) // the words stay, the link goes
        }
      }
      continue
    }
    // any other tag: ignored, its text falls through to where we are
  }
  return blocks.map(tidyBlock)
}

// Empty marks and links hold nothing to show.
function tidyInlines(kids: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const k of kids) {
    if (k.t === 'mark' || k.t === 'a') {
      const inner = tidyInlines(k.kids)
      if (inner.length) out.push({ ...k, kids: inner })
    } else if (k.t === 'text') {
      const last = out[out.length - 1]
      if (last && last.t === 'text') last.v += k.v
      else if (k.v) out.push({ t: 'text', v: k.v })
    } else out.push(k)
  }
  return out
}
function tidyBlock(b: Block): Block {
  return 'items' in b ? { ...b, items: b.items.map(tidyInlines) } : { ...b, kids: tidyInlines(b.kids) }
}

function inlinesToHtml(kids: Inline[]): string {
  return kids.map((k) => {
    if (k.t === 'text') return escHtml(k.v)
    if (k.t === 'br') return '<br>'
    if (k.t === 'mark') return `<${k.tag}>${inlinesToHtml(k.kids)}</${k.tag}>`
    return `<a href="${escAttr(k.href)}">${inlinesToHtml(k.kids)}</a>`
  }).join('')
}

// The tree, written the one way a body is stored.
export function blocksToHtml(blocks: Block[]): string {
  return blocks.map((b) => {
    if ('items' in b) return `<${b.type}>${b.items.map((it) => `<li>${inlinesToHtml(it)}</li>`).join('')}</${b.type}>`
    const style = b.align ? ` style="text-align:${b.align}"` : ''
    return `<${b.type}${style}>${inlinesToHtml(b.kids)}</${b.type}>`
  }).join('')
}

// WHAT A SAVE STORES. Whatever came in, only the whitelist comes out.
// Running it twice changes nothing.
export function sanitizeEmailHtml(html: string | null | undefined): string {
  return blocksToHtml(parseEmailHtml(html))
}

// ── plain → html (what the editor will open a plain body as) ─────────────
// The same reading the send gives a plain body (lib/drip-email-layout.ts):
// blank line = paragraph, single newline = line break, "word (link)" = a link
// on the word, a bare address = a link on itself. One addition: the link in
// the brackets may be a merge tag — "HERE ({{book_assessment_link}})" is how
// 126 of the live bodies write their booking link — and it becomes a link
// whose address is that tag.
const PLAIN_LINK = /([^\s()]+)[ \t]*\((https?:\/\/[^)\s]+|\{\{\w+\}\})\)|(https?:\/\/[^\s)]+)/g
function plainLineToInlines(line: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  let m: RegExpExecArray | null
  PLAIN_LINK.lastIndex = 0
  const text = (v: string) => { if (v) out.push({ t: 'text', v }) }
  while ((m = PLAIN_LINK.exec(line)) !== null) {
    const href = allowedHref(m[2] || m[3])
    if (!href) continue
    text(line.slice(last, m.index))
    out.push({ t: 'a', href, kids: [{ t: 'text', v: m[2] ? m[1] : m[3] }] })
    last = PLAIN_LINK.lastIndex
  }
  text(line.slice(last))
  return out
}
export function plainBodyToBlocks(body: string | null | undefined): Block[] {
  return String(body ?? '').split(/\n{2,}/).map((para) => {
    const kids: Inline[] = []
    para.split('\n').forEach((line, i) => {
      if (i) kids.push({ t: 'br' })
      kids.push(...plainLineToInlines(line))
    })
    return { type: 'p' as const, align: null, kids }
  })
}
export function plainBodyToHtml(body: string | null | undefined): string {
  return blocksToHtml(plainBodyToBlocks(body))
}

// ── html → text (the text/plain half of an email, and the round trip) ────
// A link reads "words (address)", the plain shape, so a plain body that went
// plain → html → text comes back as it started.
function inlinesToText(kids: Inline[]): string {
  return kids.map((k) => {
    if (k.t === 'text') return k.v
    if (k.t === 'br') return '\n'
    if (k.t === 'mark') return inlinesToText(k.kids)
    const words = inlinesToText(k.kids)
    return words === k.href ? k.href : `${words} (${k.href})`
  }).join('')
}
export function blocksToText(blocks: Block[]): string {
  return blocks.map((b) => {
    if ('items' in b) return b.items.map((it, i) => `${b.type === 'ol' ? `${i + 1}.` : '-'} ${inlinesToText(it)}`).join('\n')
    return inlinesToText(b.kids)
  }).join('\n\n')
}
export function htmlBodyToText(html: string | null | undefined): string {
  return blocksToText(parseEmailHtml(html))
}

// Every {{tag}} in a body, in order — what the round trip compares.
export function mergeTagsIn(body: string | null | undefined): string[] {
  return String(body ?? '').match(/\{\{\w+\}\}/g) || []
}
