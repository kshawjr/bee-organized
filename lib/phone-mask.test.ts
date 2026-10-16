// lib/phone-mask.test.ts — the as-you-type phone mask, driven keystroke by
// keystroke. The cursor and backspace cases are the point: they are what
// make masked fields infuriating.
import { describe, it, expect } from 'vitest'
import { maskPhoneInput, formatPartial } from '@/lib/phone-mask'

// A tiny field: value + cursor, and the browser's edit before the mask runs.
type Field = { value: string; caret: number }
const apply = (f: Field, raw: string, caret: number, inputType: string): Field =>
  maskPhoneInput(f.value, raw, caret, inputType)
const type = (f: Field, ch: string): Field =>
  apply(f, f.value.slice(0, f.caret) + ch + f.value.slice(f.caret), f.caret + ch.length, 'insertText')
const typeAll = (f: Field, s: string): Field => [...s].reduce(type, f)
const backspace = (f: Field): Field =>
  f.caret === 0 ? f : apply(f, f.value.slice(0, f.caret - 1) + f.value.slice(f.caret), f.caret - 1, 'deleteContentBackward')
const del = (f: Field): Field =>
  apply(f, f.value.slice(0, f.caret) + f.value.slice(f.caret + 1), f.caret, 'deleteContentForward')
const paste = (f: Field, s: string): Field =>
  apply(f, f.value.slice(0, f.caret) + s + f.value.slice(f.caret), f.caret + s.length, 'insertFromPaste')
const at = (value: string, caret: number): Field => ({ value, caret })
const empty = at('', 0)
// Render the cursor as "|" so a failure reads like the field looks.
const show = (f: Field) => f.value.slice(0, f.caret) + '|' + f.value.slice(f.caret)

describe('builds as they type', () => {
  it('(336) after three digits, (336) 555- after six, (336) 555-1234 at ten', () => {
    const steps: string[] = []
    let f = empty
    for (const ch of '3365551234') { f = type(f, ch); steps.push(show(f)) }
    expect(steps).toEqual([
      '(3|', '(33|', '(336) |', '(336) 5|', '(336) 55|', '(336) 555-|',
      '(336) 555-1|', '(336) 555-12|', '(336) 555-123|', '(336) 555-1234|',
    ])
  })
  it('a typed letter or space is ignored, the cursor does not move', () => {
    expect(show(type(at('(336) 5', 7), 'a'))).toBe('(336) 5|')
    expect(show(type(at('(336) ', 6), ' '))).toBe('(336) |')
  })
  it('a leading 1 is the country code and is dropped', () => {
    expect(show(typeAll(empty, '13365551234'))).toBe('(336) 555-1234|')
  })
})

describe('backspace deletes what they expect — the mask never puts it back', () => {
  it('from the end, one digit at a time, separators never reappear', () => {
    let f = typeAll(empty, '3365551')
    const steps: string[] = [show(f)]
    while (f.value) { f = backspace(f); steps.push(show(f)) }
    expect(steps).toEqual([
      '(336) 555-1|', '(336) 555|', '(336) 55|', '(336) 5|', '(336|', '(33|', '(3|', '|',
    ])
  })
  it('backspace right after a "-" deletes the digit before it, not nothing', () => {
    // "(336) 555-|1234": cursor just after the dash
    expect(show(backspace(at('(336) 555-1234', 10)))).toBe('(336) 55|1-234')
  })
  it('backspace right after ") " deletes the last area-code digit', () => {
    // "(336) |5551234" → "(33|5) 551-234"
    expect(show(backspace(at('(336) 555-1234', 6)))).toBe('(33|5) 551-234')
  })
  it('backspace on a separator typed-in at three digits does not get stuck', () => {
    let f = typeAll(empty, '336')            // "(336) |"
    f = backspace(f)                          // removes the space → deletes the 6
    expect(show(f)).toBe('(33|')
    f = backspace(f)
    expect(show(f)).toBe('(3|')
  })
  it('backspace mid-number deletes that digit and keeps the cursor there', () => {
    // "(336) 55|5-1234" → "(336) 5|51-234"
    expect(show(backspace(at('(336) 555-1234', 8)))).toBe('(336) 5|51-234')
  })
  it('delete-forward on a "-" deletes the digit after it', () => {
    // "(336) 555|-1234" → "(336) 555|-234"
    expect(show(del(at('(336) 555-1234', 9)))).toBe('(336) 555|-234')
  })
})

describe('a whole-value replacement is not a backspace', () => {
  it('autofill swapping "(561) 555-0100" for "561.555.0100" keeps every digit', () => {
    expect(maskPhoneInput('(561) 555-0100', '561.555.0100', 12, 'insertReplacementText').value).toBe('(561) 555-0100')
    expect(maskPhoneInput('(561) 555-0100', '561.555.0100', 12, undefined).value).toBe('(561) 555-0100')
  })
})

describe('the cursor stays where they are editing', () => {
  it('typing a digit in the middle keeps the cursor after it', () => {
    // fix a typo: "(336) 5|51-234" + "5" → "(336) 55|5-1234"
    expect(show(type(at('(336) 551-234', 7), '5'))).toBe('(336) 55|5-1234')
  })
  it('typing into the area code reflows the rest without jumping to the end', () => {
    expect(show(type(at('(36) ', 2), '3'))).toBe('(33|6) ')
  })
  it('replacing a selected digit (delete then type) lands after the new digit', () => {
    let f = backspace(at('(336) 555-1234', 2))  // "(|36) 555-1234" → digits 365551234
    expect(show(f)).toBe('(|365) 551-234')
    f = type(f, '9')
    expect(show(f)).toBe('(9|36) 555-1234')
  })
})

describe('extensions: after ten digits they keep typing', () => {
  it('the 11th digit opens "ext."', () => {
    expect(show(typeAll(empty, '3365551234202'))).toBe('(336) 555-1234 ext. 202|')
  })
  it('backspacing out of the extension returns to the plain number', () => {
    let f = typeAll(empty, '33655512342')
    expect(show(f)).toBe('(336) 555-1234 ext. 2|')
    f = backspace(f)
    expect(show(f)).toBe('(336) 555-1234|')
  })
  it('an extension is capped at six digits', () => {
    expect(typeAll(empty, '33655512341234567890').value).toBe('(336) 555-1234 ext. 123456')
  })
})

describe('a leading + switches the mask off', () => {
  it('a foreign number types exactly as typed', () => {
    expect(show(typeAll(empty, '+82-10-2890-8574'))).toBe('+82-10-2890-8574|')
  })
  it('a + typed by hand before a US number is left alone too (saving formats it)', () => {
    expect(typeAll(empty, '+1 336').value).toBe('+1 336')
  })
})

describe('pasting comes out clean', () => {
  it.each([
    ['Phone: (512) 787-5175', '(512) 787-5175'],
    ['512.787.5175', '(512) 787-5175'],
    ['+1 512 787 5175', '(512) 787-5175'],
    ['5127875175', '(512) 787-5175'],
    ['512-787-5175 x 22', '(512) 787-5175 ext. 22'],
  ])('%j → %s', (pasted, want) => {
    expect(show(paste(empty, pasted))).toBe(want + '|')
  })
  it('a paste the mask cannot reduce honestly is left whole for saving to note', () => {
    expect(paste(empty, '407-393-5901 & 407-392-1931').value).toBe('407-393-5901 & 407-392-1931')
    expect(paste(empty, '816-935-9869 (daughter Jan)').value).toBe('816-935-9869 (daughter Jan)')
    expect(paste(empty, '+82-10-2890-8574').value).toBe('+82-10-2890-8574')
  })
  it('pasting digits into the middle of a number keeps the cursor after them', () => {
    // "(336) |1234" + paste "555"
    expect(show(paste(at('(336) 123-4', 6), '555'))).toBe('(336) 555|-1234')
  })
})

describe('formatPartial', () => {
  it('trailing separators only while typing', () => {
    expect(formatPartial('336', true)).toBe('(336) ')
    expect(formatPartial('336', false)).toBe('(336')
    expect(formatPartial('336555', true)).toBe('(336) 555-')
    expect(formatPartial('336555', false)).toBe('(336) 555')
  })
})
