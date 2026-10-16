// lib/phone.ts — the ONE place a phone number is read, formatted, matched
// and dialled.
//
// THE UNIVERSAL SHAPE (Kevin, 16 Oct 2026): (123) 456-7890 everywhere.
// Before this file there was no formatter at all: every screen, email, Slack
// line and Jobber push showed whatever was typed, and there were five
// different tel: shapes, one of which (tel:+1 + 11 digits) dialled nothing.
//
// What a stored phone can be, and what each kind gets:
//   us         — one readable US/Canada number (10 digits, or 11 starting
//                with 1), optionally with an extension. Formatted:
//                "(401) 247-1926" or "(401) 247-1926 ext. 202".
//                If the field also carried words ("(cell)", "(daughter
//                Jan)", "Office:"), the number is formatted and the ORIGINAL
//                string is kept as a note, so nothing is lost. A bare
//                "Phone:" / "Tel:" / "p:" prefix says nothing and is dropped
//                without a note.
//   multi      — two or more numbers in one field ("407-393-5901 &
//                407-392-1931"). The FIRST becomes the phone, formatted; the
//                whole original goes into a note for the owner to sort.
//   foreign    — starts with "+" and not "+1" (+82…, +61…). Left exactly
//                as typed — US rules would corrupt them.
//   unreadable — anything else: stubs ("7126", "4"), an email address, a
//                capital I for a 1, 13-digit runs, digit-only junk. Left
//                exactly as typed.
//
// MATCHING KEY. phoneKey() is the digits-only key duplicate checks compare:
// a leading US "1" on an 11-digit number is dropped, so "+1 (336) 207-7477"
// and "336-207-7477" are the same person. An extension's digits are kept on
// the end, however it was written ("x 4", "ext. 4", ";EXT=4"). leads.phone_normalized (a
// generated column) computes the SAME key in SQL — see
// migrations/phone_normalized_drop_leading_one.sql. Change one, change both.

export type ParsedPhone =
  | { kind: 'empty' }
  | { kind: 'us'; formatted: string; key: string; ext: string | null; extraText: boolean }
  | { kind: 'multi'; formatted: string; key: string; ext: string | null; count: number }
  | { kind: 'foreign' }
  | { kind: 'unreadable' }

// Extension tail: "ext. 202", "x 1035", "X6017", ";EXT=881", "(ext.547)",
// "(EXT: 5790)", "Extension 4". Digits must follow, so a stray "x" in a
// name never counts.
const EXT_RE = /[\s(;,]*\b(?:extension|ext|x)\.?\s*[:=.]?\s*(\d{1,6})\s*\)?/i
// The same tail, anchored to the end, for the matching key; EXT_DIGITS_RE
// captures the extension's own digits.
const EXT_TAIL_RE = /\b(?:extension|ext|x)\.?\s*[:=.]?\s*\d+.*$/i
const EXT_DIGITS_RE = /\b(?:extension|ext|x)\.?\s*[:=.]?\s*(\d+)/i

// One NANP number: optional leading 1 (with or without "+"), area code
// 2-9xx, then 3 + 4 digits with spaces / dots / dashes / parens between.
// Not preceded by a digit or "+" and not followed by a digit, so it never
// matches a slice out of a longer digit run.
const US_NUMBER_RE = /(?<![\d+])(?:\+\s*)?(?:1[\s.\-]*)?\(?([2-9]\d{2})\)?[\s.\-]*(\d{3})[\s.\-]*(\d{4})(?!\d)/g

// Prefixes that carry no information.
const BARE_PREFIX_RE = /^\s*(?:phone|ph|tel|telephone|p)\s*[:.]?\s*/i

// Invisible characters copy-paste carries in (phone contacts wrap numbers in
// direction marks: U+202A … U+202C), zero-width spaces, a BOM. They are not
// words and never make a note; a no-break space is just a space.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g
// Look-alike dashes (non-breaking hyphen, en/em dash, minus) are dashes; "Â"
// before a space is a no-break space mis-decoded somewhere upstream.
const DASHES_RE = /[\u2010-\u2015\u2212]/g
const MOJIBAKE_NBSP_RE = /\u00C2(?=[\s\u00A0])/g

// Punctuation that may surround a number without meaning anything.
const NOISE_RE = /^[\s,;:.\-–—(){}[\]|]*$/

function fmt(area: string, mid: string, last: string, ext: string | null): string {
  return `(${area}) ${mid}-${last}` + (ext ? ` ext. ${ext}` : '')
}

export function parsePhone(raw: unknown): ParsedPhone {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  const original = String(raw)
  if (!original.replace(INVISIBLE_RE, '').trim()) return { kind: 'empty' }
  if (original.includes('@')) return { kind: 'unreadable' }

  const s = original
    .replace(INVISIBLE_RE, '')
    .replace(MOJIBAKE_NBSP_RE, '')
    .replace(/\u00A0/g, ' ')
    .replace(DASHES_RE, '-')
    .replace(BARE_PREFIX_RE, '')
  if (/^\s*\+\s*[02-9]/.test(s)) return { kind: 'foreign' }

  const matches = Array.from(s.matchAll(US_NUMBER_RE))
  if (matches.length === 0) return { kind: 'unreadable' }

  if (matches.length > 1) {
    const [m] = matches
    // An extension straight after the FIRST number belongs to it.
    const after = s.slice((m.index ?? 0) + m[0].length)
    const extM = after.match(new RegExp('^' + EXT_RE.source, 'i'))
    const ext = extM ? extM[1] : null
    return { kind: 'multi', formatted: fmt(m[1], m[2], m[3], ext), key: m[1] + m[2] + m[3], ext, count: matches.length }
  }

  const [m] = matches
  const start = m.index ?? 0
  let rest = s.slice(0, start) + ' ' + s.slice(start + m[0].length)
  let ext: string | null = null
  const extM = rest.match(EXT_RE)
  if (extM) {
    ext = extM[1]
    rest = rest.replace(EXT_RE, ' ')
  }
  // Leftover digits mean the number was not cleanly one number
  // ("913-816-536-9644", "61-4866653") — not ours to guess.
  if (/\d/.test(rest)) return { kind: 'unreadable' }
  const extraText = !NOISE_RE.test(rest)
  return { kind: 'us', formatted: fmt(m[1], m[2], m[3], ext), key: m[1] + m[2] + m[3], ext, extraText }
}

// Digits-only matching key. Mirrors leads.phone_normalized exactly.
// The number's digits (leading US 1 dropped) THEN the extension's digits.
// The extension stays in the key on purpose: two people at one office line
// ("609 978-4046" and "609 978-4046 x1216") are not the same person — but
// "x1216" and "ext. 1216" are the same extension.
export function phoneKey(raw: unknown): string {
  const s = String(raw ?? '')
  let d = s.replace(EXT_TAIL_RE, '').replace(/\D/g, '')
  if (/^1\d{10}$/.test(d)) d = d.slice(1)
  const ext = s.match(EXT_DIGITS_RE)
  return d + (ext ? ext[1] : '')
}

// What to SAVE. `value` goes in the phone column; `note`, when set, is the
// original string to keep as a note on the record (multi, or a number that
// came with words). Foreign / unreadable are saved as typed (trimmed, as
// every write path already did); empty saves null.
export function phoneForWrite(raw: unknown): { value: string | null; note: string | null; kind: ParsedPhone['kind'] } {
  const p = parsePhone(raw)
  const original = raw === null || raw === undefined ? '' : String(raw).trim()
  switch (p.kind) {
    case 'empty':
      return { value: null, note: null, kind: p.kind }
    case 'us':
      return { value: p.formatted, note: p.extraText ? original : null, kind: p.kind }
    case 'multi':
      return { value: p.formatted, note: original, kind: p.kind }
    default:
      return { value: original, note: null, kind: p.kind }
  }
}

// The formatted value alone, for callers with nowhere to put a note. A
// number that came with words, or a second number, is NOT reduced here —
// the original is returned trimmed, so nothing is ever lost on a path that
// cannot keep the note.
export function formatPhone(raw: unknown): string | null {
  const w = phoneForWrite(raw)
  return w.note ? (raw === null || raw === undefined ? null : String(raw).trim()) : w.value
}

// What to SHOW. A clean single number shows formatted (even before the
// backfill has reached it); anything else shows as stored.
export function displayPhone(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  const p = parsePhone(raw)
  if (p.kind === 'us') {
    return p.extraText ? String(raw).trim() : p.formatted
  }
  return String(raw).trim()
}

// The ONE tel: shape. US numbers dial as +1 and ten digits, an extension
// after a pause (","), which every phone dialler honours. A multi field
// dials its first number. A foreign number dials its own +digits.
// Unreadable dials its digits if there are at least seven, else no link.
export function telHref(raw: unknown): string | null {
  const p = parsePhone(raw)
  if (p.kind === 'us' || p.kind === 'multi') return `tel:+1${p.key}` + (p.ext ? `,${p.ext}` : '')
  if (p.kind === 'empty') return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length < 7) return null
  return p.kind === 'foreign' ? `tel:+${digits}` : `tel:${digits}`
}
