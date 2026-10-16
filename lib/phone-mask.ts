// lib/phone-mask.ts — the as-you-type phone mask. Pure: given what the box
// held, what it holds now and where the cursor is, return what it should
// hold and where the cursor goes. components/hive/shared/PhoneInput.jsx is
// the only caller; it is a function so every cursor/backspace case can be
// tested without a browser.
//
// THE RULES (Kevin, 16 Oct 2026):
//   · builds as they type: "(336) " at three digits, "(336) 555-" at six,
//     "(336) 555-1234" at ten
//   · backspace deletes what they expect: deleting a mask character ("-",
//     ") ") deletes the digit before it, and while deleting the trailing
//     separator is not put back — "(336) 555-1" ← backspace → "(336) 555",
//     not "(336) 555-"
//   · the cursor stays on the digit they were editing; it never jumps to
//     the end mid-edit
//   · after ten digits they keep typing an extension: "(336) 555-1234 ext. 9"
//   · a leading "+" switches the mask off — a foreign number goes in as typed
//   · a paste comes out clean ("Phone: (512) 787-5175", "512.787.5175",
//     "+1 512 787 5175" all → "(512) 787-5175"); a paste the mask cannot
//     honestly reduce — two numbers, a name in it — is left exactly as
//     pasted for the save path (lib/phone.ts) to format and note
//
// Saving still formats (lib/phone.ts phoneForWrite): the mask is a
// convenience for people at a keyboard; the web form, the Jobber import and
// webhooks never touch one.

import { parsePhone } from './phone'

const MAX_EXT = 6

export type MaskResult = { value: string; caret: number }

// Digits only, with a leading US "1" (or a stray "0") dropped — no area code
// starts with either, so it can only be the country code.
function digitsOf(s: string): string {
  return s.replace(/\D/g, '')
}

// The display for `d` digits. `trailing` adds the separator that the NEXT
// digit will sit after ("(336) ", "(336) 555-") — on while typing, off
// while deleting so a backspace never sees its separator come back.
export function formatPartial(d: string, trailing: boolean): string {
  const n = d.length
  if (n === 0) return ''
  if (n < 3) return `(${d}`
  if (n === 3) return trailing ? `(${d}) ` : `(${d}`
  if (n < 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  if (n === 6) return trailing ? `(${d.slice(0, 3)}) ${d.slice(3)}-` : `(${d.slice(0, 3)}) ${d.slice(3)}`
  const base = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`
  if (n <= 10) return base
  return `${base} ext. ${d.slice(10)}`
}

// Index in `value` just after its `k`-th digit (k = 0 → just before the
// first digit).
function caretAfterDigit(value: string, k: number): number {
  if (k <= 0) {
    const first = value.search(/\d/)
    return first === -1 ? value.length : first
  }
  let seen = 0
  for (let i = 0; i < value.length; i++) {
    if (/\d/.test(value[i])) {
      seen++
      if (seen === k) return i + 1
    }
  }
  return value.length
}

export function maskPhoneInput(
  prev: string,
  raw: string,
  caret: number | null | undefined,
  inputType?: string | null,
): MaskResult {
  const at = typeof caret === 'number' ? caret : raw.length

  const deleting = raw.length < prev.length || (inputType ?? '').startsWith('delete')
  const pasted = (inputType ?? '') === 'insertFromPaste' || raw.length - prev.length > 1

  // A paste is judged whole first, so "+1 512 787 5175" pasted comes out
  // clean while a "+" typed by hand still switches the mask off.
  if (pasted) {
    const p = parsePhone(raw)
    // Two numbers, or a number with words: the mask would throw something
    // away. Leave it whole; saving formats it and keeps the original as a
    // note.
    if (p.kind === 'multi' || (p.kind === 'us' && p.extraText) || p.kind === 'foreign') {
      return { value: raw, caret: at }
    }
    if (p.kind === 'us') return { value: p.formatted, caret: p.formatted.length }
  }

  // A leading "+" typed by hand: a foreign number — hands off entirely.
  if (/^\s*\+/.test(raw)) return { value: raw, caret: at }

  let digits = digitsOf(raw)
  let before = digitsOf(raw.slice(0, at)).length

  // Deleted only a mask character — exactly ONE non-digit gone, at the
  // cursor (backspace and delete both leave the cursor where it was): delete
  // the digit beside it, in the direction they were deleting, so the keypress
  // does something instead of the mask putting the character straight back.
  // A whole-value replacement (autofill, select-all + paste) is not this,
  // even when it is shorter with the same digits.
  const removedOneSeparator =
    raw.length === prev.length - 1 &&
    prev.slice(0, at) + prev.slice(at + 1) === raw &&
    /\D/.test(prev[at] ?? '')
  if (removedOneSeparator && digits.length > 0) {
    if (inputType === 'deleteContentForward') {
      digits = digits.slice(0, before) + digits.slice(before + 1)
    } else if (before > 0) {
      digits = digits.slice(0, before - 1) + digits.slice(before)
      before -= 1
    }
  }

  // A leading 1 or 0 can only be a country code / slip — drop it.
  while (digits.length > 0 && (digits[0] === '1' || digits[0] === '0')) {
    digits = digits.slice(1)
    if (before > 0) before -= 1
  }

  digits = digits.slice(0, 10 + MAX_EXT)
  if (before > digits.length) before = digits.length

  const value = formatPartial(digits, !deleting)
  // Typing at the very end: the cursor follows the end (past any separator
  // that was just added). Anywhere else: right after the same digit it was
  // after, so a mid-number edit keeps its place.
  const atEnd = before >= digits.length
  return { value, caret: atEnd ? value.length : caretAfterDigit(value, before) }
}
