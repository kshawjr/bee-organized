// @vitest-environment happy-dom
//
// THE MERGE TAGS OWNERS CAN SEE AND USE (2026-10-30). lib/merge-tags.ts.
//
//   • every tag offered to an owner renders a non-empty value when its source
//     is set — through the REAL renderTemplate
//   • no tag offered is one the senders don't fill: each is in the context
//     of all three client senders and the test send
//   • the two new booking tags are offered and insert correctly
//   • the owner's email editors show the list (the full Emails → Edit flow is
//     pinned in lib/drip-step-edit-in-place.test.tsx)
//   • a tag goes in at the cursor, not at the end
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('no db') } } }))

import { OWNER_MERGE_TAGS, LEGACY_MERGE_TAGS, insertAtCursor } from './merge-tags'
import { renderTemplate } from './resend'
import { SIGNATURE_MARKER } from './email-signature'
import { buildBrandedDripHtml } from './drip-email-layout'
// BeeHub.jsx is untyped; a namespace import keeps that out of the type count.
import * as BeeHub from '@/components/BeeHub'
const { DripPathStepEditor, EmailTemplateEditor } = BeeHub as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const offered = OWNER_MERGE_TAGS.map(t => t.key)
const VALUES: Record<string, string> = {
  first_name: 'Jordan', owner_name: 'Lynette Ewy', owner_first_name: 'Lynette', location_owner_name: 'Lynette Ewy',
  location_name: 'Kansas City', location_phone: '(816) 555-0100', service_area: 'Kansas City, MO',
  rate_per_hour: '$95', reviews_link: 'https://g.page/r/kc',
  book_assessment_link: 'https://cal.example.com/kc', booking_link: 'https://cal.example.com/kc',
  owner_booking_link: 'https://cal.example.com/lynette',
  discovery_booking_link: 'https://cal.example.com/discovery', virtual_booking_link: 'https://cal.example.com/virtual',
}

describe('every tag offered to an owner renders something', () => {
  it('each value tag renders its source value through the real renderTemplate', () => {
    for (const key of offered.filter(k => k !== 'signature')) {
      expect(VALUES[key], `a value for ${key}`).toBeTruthy()
      const r = renderTemplate({ subject: `{{${key}}}`, body: `x {{${key}}} y` }, VALUES as any)
      expect(r.subject, key).toBe(VALUES[key])
      expect(r.body, key).toBe(`x ${VALUES[key]} y`)
    }
  })

  it('{{signature}} becomes the real signature in the email', () => {
    const r = renderTemplate({ subject: 's', body: 'Thank you,\n{{signature}}' }, {}, { signatureMarker: true })
    expect(r.body).toContain(SIGNATURE_MARKER)
    const html = buildBrandedDripHtml(r.body, { location_name: 'KC', signature: {
      name: 'Lynette Ewy', title: null, email: 'l@x.com', mobile: null, photoPath: null,
      websiteUrl: null, facebookUrl: null, instagramUrl: null, linkedinUrl: null,
    } })
    expect(html).toContain('Lynette Ewy</strong>')
  })
})

describe('nothing offered that the senders do not fill', () => {
  // The context literal each sender builds — `const ctx: RenderContext = { … }`.
  const ctxKeys = (file: string) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8')
    const at = src.indexOf('const ctx: RenderContext = {')
    expect(at, `${file} context`).toBeGreaterThan(-1)
    const block = src.slice(at, src.indexOf('\n  }', at))
    return new Set(Array.from(block.matchAll(/^\s+(\w+):/gm)).map(m => m[1]))
  }
  for (const file of ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts', 'app/api/emails/test-send/route.ts']) {
    it(`${file} fills every offered tag`, () => {
      const keys = ctxKeys(file)
      for (const k of offered.filter(k => k !== 'signature')) expect(keys.has(k), `${file} fills {{${k}}}`).toBe(true)
    })
  }
  it('{{last_name}} — filled by nothing — is not offered, and neither is the unfilled {{partner_name}}', () => {
    expect(offered).not.toContain('last_name')
    expect(offered).not.toContain('partner_name')
  })
  it('a legacy tag is never also offered', () => {
    for (const l of LEGACY_MERGE_TAGS) expect(offered).not.toContain(l.key)
  })
  it('every offered tag has a label and a one-sentence description', () => {
    for (const t of OWNER_MERGE_TAGS) {
      expect(t.label.trim(), t.key).toBeTruthy()
      expect(t.description.trim().endsWith('.'), t.key).toBe(true)
    }
  })
  it('the two names for the location booking link say they are the same link', () => {
    const older = OWNER_MERGE_TAGS.find(t => t.key === 'booking_link')!
    expect(older.description).toContain('Exactly the same link')
  })
})

// ─── the editors ────────────────────────────────────────────────────────
let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const chip = (key: string) => container.querySelector(`[data-merge-tag="${key}"]`) as HTMLElement
const at = async (el: HTMLInputElement | HTMLTextAreaElement, pos: number) => {
  await act(async () => { el.focus(); el.setSelectionRange(pos, pos); el.dispatchEvent(new Event('select', { bubbles: true })) })
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('the owner’s drip email editor', () => {
  const mount = async (body = 'Hello there') => {
    const onSave = vi.fn(async () => undefined)
    await act(async () => { root.render(<DripPathStepEditor step={{ step_order: 2, subject: 'Hi', body, delay_days: 5 }} onSave={onSave} onClose={() => {}} />) })
    return onSave
  }

  it('shows the list, the two new booking links included', async () => {
    await mount()
    expect(container.querySelector('[data-merge-tag-picker]')).toBeTruthy()
    expect(chip('discovery_booking_link').textContent).toBe('Discovery call link')
    expect(chip('virtual_booking_link').textContent).toBe('Video assessment link')
    expect(chip('last_name')).toBeNull()
  })

  it('a tag goes in at the cursor, not at the end', async () => {
    await mount('Hello there')
    const body = container.querySelector('textarea') as HTMLTextAreaElement
    await at(body, 5)
    await act(async () => { chip('discovery_booking_link').click() })
    await flush()
    expect(body.value).toBe('Hello{{discovery_booking_link}} there')
  })

  it('…in the subject too, when that is where the cursor was', async () => {
    await mount()
    const subject = container.querySelector('input[type="text"]') as HTMLInputElement
    await at(subject, 0)
    await act(async () => { chip('first_name').click() })
    await flush()
    expect(subject.value).toBe('{{first_name}}Hi')
  })

  it('the inserted tag is saved', async () => {
    const onSave = await mount('Book here: ')
    const body = container.querySelector('textarea') as HTMLTextAreaElement
    await at(body, 11)
    await act(async () => { chip('virtual_booking_link').click() })
    await flush()
    await act(async () => { (Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLElement).click() })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ body: 'Book here: {{virtual_booking_link}}' }))
  })

  it('hovering a tag says what it is', async () => {
    await mount()
    await act(async () => { chip('booking_link').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(container.querySelector('[data-merge-tag-picker]')!.textContent).toContain('Exactly the same link as “In-home assessment link”')
  })
})

describe('the welcome / job follow-up editor', () => {
  it('shows the list and inserts at the cursor', async () => {
    await act(async () => { root.render(<EmailTemplateEditor row={{ when: 'Next day', subject: 'Welcome', body: 'AB' }} onCancel={() => {}} onSave={vi.fn()} />) })
    const body = container.querySelector('textarea') as HTMLTextAreaElement
    await at(body, 1)
    await act(async () => { chip('reviews_link').click() })
    await flush()
    expect(body.value).toBe('A{{reviews_link}}B')
  })
})

describe('insertAtCursor', () => {
  it('replaces a selection and puts the caret after the tag', () => {
    expect(insertAtCursor('Hello world', '{{x}}', 6, 11)).toEqual({ next: 'Hello {{x}}', caret: 11 })
  })
})
