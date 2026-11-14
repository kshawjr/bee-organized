// @vitest-environment happy-dom
//
// THE EMAIL BUTTON CARD (2026-11-13, slice 1 of the Lovable email editor).
//
// The button picker is redrawn as five cards: None, Discovery, In-home, Video,
// Custom. What is stored did not change. Pinned:
//
//   • None is the default choice on a fresh edit, and says so
//   • a booking card stores its merge tag, never the address it shows
//   • the "Your button links to…" note names the link and shows the real
//     saved address (or, with no location, says each location's is filled in)
//   • only Custom shows a Button link box; the words stay the owner's to
//     change on every card
//   • a card for a link that is not saved says "Not set up" and warns the
//     email will be held; it is not hidden
//   • the position control is still there
//   • arrow keys move the choice
//   • the suggested words (changed in this slice — flagged to Kevin)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { BUTTON_DEFAULT_TEXT, BUTTON_LINKS, buttonCaption } from '@/components/settings/EmailsScreen'
import * as BeeHub from '@/components/BeeHub'
const { DripPathStepEditor, EmailTemplateEditor } = BeeHub as any

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const SAVED = { discovery: 'https://cal.example.com/discovery', inHome: 'https://cal.example.com/home', video: 'https://cal.example.com/video' }
const STEP = (over: any = {}) => ({ step_order: 2, subject: 'Hi', body: 'Hello there', delay_days: 5, ...over })
const mountStep = async (step: any = STEP(), props: any = {}) => {
  const onSave = vi.fn(async () => undefined)
  await act(async () => { root.render(<DripPathStepEditor step={step} onSave={onSave} onClose={() => {}} links={SAVED} alignReady {...props} />) })
  return onSave
}
const fields = () => container.querySelector('[data-button-fields]') as HTMLElement
const card = (id: string) => container.querySelector(`[data-button-pill="${id}"]`) as HTMLElement
const cards = () => Array.from(container.querySelectorAll('[data-button-pill]')).map(p => p.getAttribute('data-button-pill'))
const chosen = () => Array.from(container.querySelectorAll('[data-button-pill][aria-checked="true"]')).map(p => p.getAttribute('data-button-pill'))
const caption = () => container.querySelector('[data-button-caption]')!.textContent
const note = () => container.querySelector('[data-button-note]') as HTMLElement | null
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }) }
const save = () => click(Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Save')!)
const boxes = () => Array.from(fields().querySelectorAll('label')).map(l => l.querySelector('span')!.textContent)
const box = (label: string) => Array.from(fields().querySelectorAll('label')).find(l => l.querySelector('span')?.textContent === label)?.querySelector('input') as HTMLInputElement
const type = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const key = async (k: string) => { await act(async () => { container.querySelector('[role="radiogroup"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }) }
const saved = (onSave: any) => (onSave.mock.calls[0] as any[])[0]

describe('a fresh edit', () => {
  it('shows five cards, None chosen, and says no button will be added', async () => {
    await mountStep()
    expect(fields().textContent).toContain('Email button · Choose one')
    expect(cards()).toEqual(['none', 'discovery', 'inHome', 'video', 'custom'])
    expect(chosen()).toEqual(['none'])
    expect(caption()).toBe('No button will be added to this email.')
    expect(note()).toBeNull()
    expect(boxes()).toEqual([])
    expect(container.querySelector('[data-button-align]')).toBeNull()
  })
  it('the same in the template editor', async () => {
    await act(async () => { root.render(<EmailTemplateEditor row={{ when: 'Next day', subject: 'Welcome', body: 'B' }} onCancel={() => {}} onSave={async () => undefined} links={SAVED} />) })
    expect(chosen()).toEqual(['none'])
    expect(caption()).toBe('No button will be added to this email.')
  })
  it('every card has an icon, and only the chosen one a tick', async () => {
    await mountStep()
    for (const id of cards()) expect(card(id!).querySelector('svg')).toBeTruthy()
    expect(container.querySelectorAll('[data-chosen-tick]').length).toBe(1)
    expect(card('none').querySelector('[data-chosen-tick]')).toBeTruthy()
    await click(card('video'))
    expect(container.querySelectorAll('[data-chosen-tick]').length).toBe(1)
    expect(card('video').querySelector('[data-chosen-tick]')).toBeTruthy()
  })
})

describe('a booking card', () => {
  for (const [id, what, tag] of [
    ['discovery', 'discovery call', '{{discovery_booking_link}}'],
    ['inHome', 'in-home assessment', '{{book_assessment_link}}'],
    ['video', 'video assessment', '{{virtual_booking_link}}'],
  ] as const) {
    it(`${id}: names the link, shows the saved address, and stores the tag — never the address`, async () => {
      const onSave = await mountStep()
      await click(card(id))
      expect(caption()).toBe(`A button to book your ${what} will be added to this email.`)
      expect(note()!.textContent).toContain(`Your button links to your ${what}.`)
      expect(container.querySelector('[data-button-address]')!.textContent).toBe(SAVED[id])
      expect(boxes()).toEqual(['Button text'])
      await save()
      expect(saved(onSave).button_link).toBe(tag)
      expect(JSON.stringify(onSave.mock.calls)).not.toContain('cal.example.com')
    })
  }
  it('with no location (the master editor) the note says each location’s link is filled in', async () => {
    await mountStep(STEP(), { links: null })
    await click(card('discovery'))
    expect(container.querySelector('[data-button-address]')!.textContent).toBe('Each location’s own link is filled in when the email is sent.')
  })
  it('the words are still the owner’s to change', async () => {
    const onSave = await mountStep()
    await click(card('inHome'))
    expect(box('Button text').value).toBe('Book an in-home assessment')
    await type(box('Button text'), 'Come and see us')
    await save()
    expect(saved(onSave)).toMatchObject({ button_text: 'Come and see us', button_link: '{{book_assessment_link}}' })
  })
  it('None throws the typed words away, so the next card starts from its own suggestion', async () => {
    await mountStep()
    await click(card('discovery'))
    await type(box('Button text'), 'My old words')
    await click(card('none'))
    await click(card('video'))
    expect(box('Button text').value).toBe('Book a video assessment')
  })
  it('the position control is still offered', async () => {
    const onSave = await mountStep()
    await click(card('discovery'))
    await click(container.querySelector('[data-button-align="right"]')!)
    await save()
    expect(saved(onSave).button_align).toBe('right')
  })
})

describe('Custom, and only Custom, asks for a link', () => {
  it('shows Button text then Button link, and no note', async () => {
    await mountStep()
    await click(card('custom'))
    expect(caption()).toBe('Your button will use the words and link you enter below.')
    expect(boxes()).toEqual(['Button text', 'Button link'])
    expect(container.querySelector('[data-custom-fields]')!.querySelectorAll('input').length).toBe(2)
    expect(note()).toBeNull()
  })
  it('going back to a booking card takes the link box away again', async () => {
    await mountStep()
    await click(card('custom'))
    await click(card('discovery'))
    expect(boxes()).toEqual(['Button text'])
    expect(container.querySelector('[data-custom-fields]')).toBeNull()
  })
})

describe('a link that is not saved', () => {
  it('is shown, marked "Not set up", and chosen it warns instead of showing an address', async () => {
    await mountStep(STEP(), { links: { ...SAVED, video: '' } })
    expect(cards()).toContain('video')
    expect(card('video').querySelector('[data-not-set-up]')!.textContent).toBe('Not set up')
    expect(card('discovery').querySelector('[data-not-set-up]')).toBeNull()
    await click(card('video'))
    expect(container.querySelector('[data-held-warning]')!.textContent).toContain('You haven’t saved a video assessment link yet')
    expect(note()).toBeNull()
    expect(container.querySelector('[data-button-address]')).toBeNull()
  })
})

describe('arrow keys', () => {
  it('move the choice along the cards and wrap round', async () => {
    const onSave = await mountStep()
    await key('ArrowRight')
    expect(chosen()).toEqual(['discovery'])
    await key('ArrowDown')
    expect(chosen()).toEqual(['inHome'])
    await key('ArrowLeft'); await key('ArrowLeft'); await key('ArrowUp')
    expect(chosen()).toEqual(['custom'])
    await key('ArrowRight')
    expect(chosen()).toEqual(['none'])
    await key('Enter')
    expect(chosen()).toEqual(['none'])
    await save()
    // back where it started, so no button is saved (an untouched button sends no fields at all)
    expect(saved(onSave).button_link ?? null).toBeNull()
  })
  it('only the chosen card is in the tab order', async () => {
    await mountStep()
    await click(card('video'))
    expect(cards().filter(id => card(id!).tabIndex === 0)).toEqual(['video'])
  })
})

describe('the words', () => {
  it('captions', () => {
    expect(buttonCaption('none')).toBe('No button will be added to this email.')
    expect(buttonCaption('custom')).toBe('Your button will use the words and link you enter below.')
    expect(buttonCaption('video')).toBe('A button to book your video assessment will be added to this email.')
  })
  // Changed in this slice from Title Case. Flagged to Kevin, not settled: if he
  // rules the other way this is the one place to change.
  it('suggested button words', () => {
    expect(BUTTON_DEFAULT_TEXT).toEqual({ discovery: 'Book a discovery call', inHome: 'Book an in-home assessment', video: 'Book a video assessment' })
  })
  it('every booking card still maps to a merge tag', () => {
    expect(BUTTON_LINKS.map((l: any) => [l.id, l.tag])).toEqual([
      ['discovery', '{{discovery_booking_link}}'], ['inHome', '{{book_assessment_link}}'], ['video', '{{virtual_booking_link}}'],
    ])
  })
})
