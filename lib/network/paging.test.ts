import { describe, expect, it } from 'vitest'
import { PAGE_SIZES, clampPage, contactPage, defaultPageSize, pageCount } from './paging'

describe('Contact pages', () => {
  const contacts = Array.from({ length: 5037 }, (_, i) => i)
  it('defaults to 10 contacts on mobile', () => {
    expect(defaultPageSize(true)).toBe(10)
    expect(contactPage(contacts, 0, defaultPageSize(true))).toEqual(contacts.slice(0, 10))
  })
  it('defaults to 25 contacts on desktop', () => {
    expect(defaultPageSize(false)).toBe(25)
    expect(contactPage(contacts, 0, defaultPageSize(false))).toEqual(contacts.slice(0, 25))
  })
  it('offers page sizes up to 100, including 15', () => {
    expect(PAGE_SIZES).toEqual([10, 15, 25, 50, 100])
    expect(contactPage(contacts, 1, 100)).toEqual(contacts.slice(100, 200))
  })
  it('replaces rather than appends rows on the next page', () => {
    expect(contactPage(contacts, 1, 10)).toEqual(contacts.slice(10, 20))
  })
  it('shows all 10 available contacts when 25 per page is selected', () => {
    const smallGroup = contacts.slice(0, 10)
    expect(contactPage(smallGroup, 0, 25)).toEqual(smallGroup)
    expect(pageCount(10, 25)).toBe(1)
  })
  it('clamps to the last available page after filtering or removal', () => {
    expect(clampPage(503, 12, 10)).toBe(1)
    expect(contactPage(contacts, 999, 25)).toEqual(contacts.slice(5025))
    expect(pageCount(5037, 25)).toBe(202)
    expect(contactPage([], 10, 25)).toEqual([])
  })
  it('never goes below the first page', () => {
    expect(clampPage(-3, 100, 10)).toBe(0)
    expect(contactPage(contacts, -3, 10)).toEqual(contacts.slice(0, 10))
  })
  it("pages today's 263 Network contacts into 11 desktop pages, the last one short", () => {
    const network = contacts.slice(0, 263)
    expect(pageCount(263, 25)).toBe(11)
    expect(contactPage(network, 10, 25)).toHaveLength(13)
  })
})
