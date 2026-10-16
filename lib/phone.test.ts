// lib/phone.test.ts — the universal phone shape, pinned on REAL stored
// values (every odd one below was in production on 16 Oct 2026).
import { describe, it, expect } from 'vitest'
import { parsePhone, phoneKey, phoneForWrite, formatPhone, displayPhone, telHref } from '@/lib/phone'

describe('one US number → (123) 456-7890', () => {
  it.each([
    ['336-324-0862', '(336) 324-0862'],
    ['(336)987-5272', '(336) 987-5272'],
    ['+13362077477', '(336) 207-7477'],
    ['3363027940', '(336) 302-7940'],
    ['301.512.7400', '(301) 512-7400'],
    ['17049981945', '(704) 998-1945'],
    ['+1 (303) 210-4579', '(303) 210-4579'],
    ['+1(917)703-2800', '(917) 703-2800'],
    ['303-2104579', '(303) 210-4579'],
    ['\t 2068511585', '(206) 851-1585'],
    [' 1-877 243-5732', '(877) 243-5732'],
    ['Phone: (512) 787-5175', '(512) 787-5175'],
    [' Phone: (202) 841-2107', '(202) 841-2107'],
    ['p:+19179754466', '(917) 975-4466'],
    ['917.749.9214, ', '(917) 749-9214'],
    [',(484) 213-1519', '(484) 213-1519'],
    ['(555) 555-0199', '(555) 555-0199'],
    // invisible direction marks from a pasted contact are not "words"
    ['\u202A(571) 292-4046\u202C', '(571) 292-4046'],
    ['\u202A+1 (303) 250-7320\u202C', '(303) 250-7320'],
    ['(352) 359-2620\u202C', '(352) 359-2620'],
    // look-alike dashes and a mis-decoded no-break space
    ['(800) 429\u20119030', '(800) 429-9030'],
    ['602\u2013 639\u20131805', '(602) 639-1805'],
    ['(504)\u00C2\u00A0236-4072', '(504) 236-4072'],
  ])('%j → %s with no note', (raw, want) => {
    expect(phoneForWrite(raw)).toEqual({ value: want, note: null, kind: 'us' })
    expect(displayPhone(raw)).toBe(want)
  })
})

describe('extensions are kept', () => {
  it.each([
    [' (401)247-1926 ext. 202', '(401) 247-1926 ext. 202'],
    ['206-405-4100 x. 5790', '(206) 405-4100 ext. 5790'],
    ['609 693-5002 X6017', '(609) 693-5002 ext. 6017'],
    ['2063505237 x 1035', '(206) 350-5237 ext. 1035'],
    ['480-874-2326;EXT=881', '(480) 874-2326 ext. 881'],
    ['908-766-6500 (ext.547) ', '(908) 766-6500 ext. 547'],
    ['(206) 405-4100  (EXT: 5790)', '(206) 405-4100 ext. 5790'],
    ['206.937.4809 Ext. 4 ', '(206) 937-4809 ext. 4'],
    ['1-888-8373363 ext 70', '(888) 837-3363 ext. 70'],
  ])('%j → %s', (raw, want) => {
    expect(phoneForWrite(raw)).toEqual({ value: want, note: null, kind: 'us' })
  })
})

describe('a number that came with words: formatted, original kept as a note', () => {
  it.each([
    ['(512) 964-5988 (cell)', '(512) 964-5988'],
    ['3039949176 (stuart)', '(303) 994-9176'],
    ['816-935-9869 (daughter Jan) ', '(816) 935-9869'],
    ['Office: 407-330-2181', '(407) 330-2181'],
  ])('%j → %s + note', (raw, want) => {
    expect(phoneForWrite(raw)).toEqual({ value: want, note: raw.trim(), kind: 'us' })
    // Paths with nowhere to keep a note never reduce it.
    expect(formatPhone(raw)).toBe(raw.trim())
    expect(displayPhone(raw)).toBe(raw.trim())
  })
})

describe('two numbers in one field: first becomes the phone, original into a note', () => {
  it.each([
    ['321-299-5544, 407-393-5901', '(321) 299-5544'],
    ['407-393-5901 & 407-392-1931', '(407) 393-5901'],
    ['Office 321-348-8720 & cell 407-406-3577', '(321) 348-8720'],
    ['407-676-4529 cell & 407-676-5155 ext. 320', '(407) 676-4529'],
    ['689-240-1690 direct & 407-676-5155 ext. 340 ', '(689) 240-1690'],
  ])('%j → %s + note', (raw, want) => {
    expect(phoneForWrite(raw)).toEqual({ value: want, note: raw.trim(), kind: 'multi' })
    expect(formatPhone(raw)).toBe(raw.trim())
  })
})

describe('foreign numbers are left exactly as typed', () => {
  it.each(['+82-10-2890-8574', '+61478719018', '+917032636025', '+0774682953', '+305 767-6242'])('%j', raw => {
    expect(parsePhone(raw).kind).toBe('foreign')
    expect(phoneForWrite(raw).value).toBe(raw)
    expect(displayPhone(raw)).toBe(raw)
  })
})

describe('unreadable values are left exactly as typed', () => {
  it.each([
    '7126', '4', '19335', '555-0100', 'Shobha.Russell@foxroach.com', '907 I 2423615', '917 913-73I4',
    '913-816-536-9644', '7065296700106', '(602) 881-810', '-484356733', '—', 'Dean Lanier', '76ers 05008227',
    '017636360563', '61-4866653', '936-672-5400t',
  ])('%j', raw => {
    const p = parsePhone(raw)
    // 936-672-5400t is one number with a stray letter: formatted, original noted.
    if (raw === '936-672-5400t') {
      expect(phoneForWrite(raw)).toEqual({ value: '(936) 672-5400', note: raw, kind: 'us' })
      return
    }
    expect(p.kind).toBe('unreadable')
    expect(phoneForWrite(raw).value).toBe(raw.trim())
    expect(phoneForWrite(raw).note).toBeNull()
  })
})

describe('empty', () => {
  it.each([null, undefined, '', '   '])('%j saves null', raw => {
    expect(phoneForWrite(raw)).toEqual({ value: null, note: null, kind: 'empty' })
    expect(displayPhone(raw)).toBe('')
    expect(telHref(raw)).toBeNull()
  })
})

describe('phoneKey — the duplicate-check key, same as leads.phone_normalized', () => {
  it('drops a leading US 1 so +1 and 10-digit forms match', () => {
    expect(phoneKey('+16467082407')).toBe('6467082407')
    expect(phoneKey('646.708.2407')).toBe('6467082407')
    expect(phoneKey('15085070519')).toBe('5085070519')
    expect(phoneKey('1-800-775-8387')).toBe('8007758387')
  })
  it('keeps the extension, however it was written — a shared office line is not one person', () => {
    expect(phoneKey('(401) 247-1926 ext. 202')).toBe('4012471926202')
    expect(phoneKey(' (401)247-1926 ext. 202')).toBe(phoneKey('401-247-1926 x202'))
    expect(phoneKey('609 978-4046 x1216')).not.toBe(phoneKey('609 978-4046'))
    expect(phoneKey('480-874-2326;EXT=881')).toBe('4808742326881')
    expect(phoneKey('1-888-8373363 ext 70')).toBe(phoneKey('(888) 837-3363 ext. 70'))
    expect(phoneKey('(206) 405-4100  (EXT: 5790)')).toBe('20640541005790')
  })
  it('leaves foreign and odd lengths as their digits', () => {
    expect(phoneKey('+82-10-2890-8574')).toBe('821028908574')
    expect(phoneKey('7126')).toBe('7126')
    expect(phoneKey(null)).toBe('')
  })
})

describe('telHref — ONE call-link shape', () => {
  it('US numbers always dial +1 and ten digits, whatever was stored', () => {
    for (const raw of ['5085070519', '15085070519', '+15085070519', '(508) 507-0519', '508-507-0519 (cell)']) {
      expect(telHref(raw)).toBe('tel:+15085070519')
    }
  })
  it('the 11-digit case that used to dial tel:+115085070519 now dials correctly', () => {
    expect(telHref('15085070519')).not.toContain('+11')
  })
  it('an extension dials after a pause', () => {
    expect(telHref('(401) 247-1926 ext. 202')).toBe('tel:+14012471926,202')
  })
  it('a two-number field dials the first', () => {
    expect(telHref('407-393-5901 & 407-392-1931')).toBe('tel:+14073935901')
  })
  it('foreign keeps its own country code; stubs get no link', () => {
    expect(telHref('+82-10-2890-8574')).toBe('tel:+821028908574')
    expect(telHref('7126')).toBeNull()
    expect(telHref('Dean Lanier')).toBeNull()
  })
})
