// @vitest-environment happy-dom
//
// THE BUTTON SECTION (2026-10-30, slice 1 of Lovable's handoff).
//
// The link is a row of pills — None, Discovery, In-home, Video, Custom — not a
// box an owner types a code into. The words keep their own box, pre-filled
// from the pill. Left / centre / right once migrations/button_align.sql runs.
// Preview swaps the form for the real email. Pinned:
//
//   • None is the default, and an email with no button renders byte-identically
//     to main (9449681) — fingerprinted below, every look, HTML and text
//   • choosing a pill stores the matching tag in button_link
//   • an email carrying a hand-typed tag shows the right pill as chosen
//   • a pill for an unsaved link shows the amber held warning
//   • a custom address that isn't http(s) is refused with a plain message
//   • the no-links state offers only None and Custom
//   • alignment renders left, centre and right; null renders centre
//   • the screen works before the button_align migration is run
//   • the preview uses the production renderer, not a second one
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[], updates: [] as any[] }
  const enqueue = (table: string, data: any, error: any = null) => state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'limit', 'order']) b[m] = () => b
    b.update = (patch: any) => { state.updates.push({ table, patch: { ...patch } }); return b }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, enqueue, makeBuilder, reset: () => { state.queue = []; state.updates = [] } }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'u1', role: 'owner', location_id: 'loc-1' }, error: null }) }) }) }),
  }),
}))

import { buildBrandedDripHtml, buildBrandedDripText, buildButtonHtml, EMAIL_STYLES } from './drip-email-layout'
import { SIGNATURE_MARKER } from './email-signature'
import { extrasFromRow } from './email-send-options'
import { extrasNeedingMissingColumns, stepExtrasForInsert, parseStepExtras, STEP_EXTRA_COLUMNS } from './drip-step-extras'
import { PATCH as stepPATCH } from '@/app/api/drip-path-steps/[stepId]/route'
import { CUSTOM_LINK_PROBLEM, previewEmailHtml } from '@/components/settings/EmailsScreen'
import * as BeeHub from '@/components/BeeHub'
const { DripPathStepEditor, EmailTemplateEditor } = BeeHub as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ─── 1 · byte-identical to main ─────────────────────────────────────────
// Computed on 9449681 (current main) from exactly these inputs, before any
// change in this slice. A no-button email, a null button, a half-filled one,
// and a centred one — every look plus the default — HTML and plain text.
const MAIN: Record<string, string> = {
  'none:soft': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'none-text:soft': 'fff30a3da3e752d69694ad1e2f48e983f55d47513c54743a518faa807653e7be',
  'nullbutton:soft': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'halfbutton:soft': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'centre:soft': '51939593e46ff256ec1fec00ec8e0342c7a779f7197bcadd88454ed980785cb4',
  'centre-text:soft': 'c77e463f4eed3904d7ad7f03c0a889ef390c4567c055b6fb606b625942615424',
  'none:outline': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'none-text:outline': 'fff30a3da3e752d69694ad1e2f48e983f55d47513c54743a518faa807653e7be',
  'nullbutton:outline': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'halfbutton:outline': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'centre:outline': 'ab9cd750a5f2da1f3570eda66a5081405cfb03fff69513574e36862241af3c53',
  'centre-text:outline': 'c77e463f4eed3904d7ad7f03c0a889ef390c4567c055b6fb606b625942615424',
  'none:bold': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'none-text:bold': 'fff30a3da3e752d69694ad1e2f48e983f55d47513c54743a518faa807653e7be',
  'nullbutton:bold': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'halfbutton:bold': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'centre:bold': '1baf4823fb71c846c0a9bf15a294808f7326cd8e5c0733cbe2a4780662764608',
  'centre-text:bold': 'c77e463f4eed3904d7ad7f03c0a889ef390c4567c055b6fb606b625942615424',
  'none:rounded': 'db6c2cb7d38d643caeb48672c468430e3ed8f9415f829488f36128649007efbd',
  'none-text:rounded': 'fff30a3da3e752d69694ad1e2f48e983f55d47513c54743a518faa807653e7be',
  'nullbutton:rounded': 'db6c2cb7d38d643caeb48672c468430e3ed8f9415f829488f36128649007efbd',
  'halfbutton:rounded': 'db6c2cb7d38d643caeb48672c468430e3ed8f9415f829488f36128649007efbd',
  'centre:rounded': '68f8c5a136e6fee88be4e0ceeee5f6e87a82a66242a9da0c1d2eb42e94d04ff8',
  'centre-text:rounded': 'c77e463f4eed3904d7ad7f03c0a889ef390c4567c055b6fb606b625942615424',
  'none:classic': 'ffb49f649f6a7ac3e53053ec64911d26b4aa9fc7d1d260b9a5b0955c48acb372',
  'none-text:classic': 'fff30a3da3e752d69694ad1e2f48e983f55d47513c54743a518faa807653e7be',
  'nullbutton:classic': 'ffb49f649f6a7ac3e53053ec64911d26b4aa9fc7d1d260b9a5b0955c48acb372',
  'halfbutton:classic': 'ffb49f649f6a7ac3e53053ec64911d26b4aa9fc7d1d260b9a5b0955c48acb372',
  'centre:classic': '8b6e60ba1158cc4b2d68f51d289d8cd8c335c318c0135fa2b6bb0d5b7160d67c',
  'centre-text:classic': 'c77e463f4eed3904d7ad7f03c0a889ef390c4567c055b6fb606b625942615424',
  'none:null': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'none-text:null': 'fff30a3da3e752d69694ad1e2f48e983f55d47513c54743a518faa807653e7be',
  'nullbutton:null': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'halfbutton:null': '8b5a11f00314e1c4520b86ebebd9d1a13e3fbc75c4bd98cb10bffcb47c34626d',
  'centre:null': '51939593e46ff256ec1fec00ec8e0342c7a779f7197bcadd88454ed980785cb4',
  'centre-text:null': 'c77e463f4eed3904d7ad7f03c0a889ef390c4567c055b6fb606b625942615424',
}

const SIG = { name: 'Lynette Ewy', title: 'Owner', email: 'l@x.com', mobile: '(816) 555-0100', photoPath: null, websiteUrl: 'https://beeorganized.com/kc', facebookUrl: null, instagramUrl: null, linkedinUrl: null }
const BODY = `Hi Jordan,\n\nThanks for reaching out.\n\nThank you,\n${SIGNATURE_MARKER}`
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const base = (st: string | null) => ({ location_name: 'Kansas City', location_phone: '(816) 555-0100', reviews_link: 'https://g.page/r/kc', signature: SIG, style: st, heading: 'Welcome' })
const CENTRE = { label: 'Book Your Assessment', href: 'https://cal.example.com/kc' }

describe('an email with no button renders byte-identically to main', () => {
  for (const st of [...EMAIL_STYLES.map(e => e.id), null]) {
    it(`look ${st ?? '(default)'}`, () => {
      expect(sha(buildBrandedDripHtml(BODY, base(st)))).toBe(MAIN[`none:${st}`])
      expect(sha(buildBrandedDripText(BODY, base(st)))).toBe(MAIN[`none-text:${st}`])
      expect(sha(buildBrandedDripHtml(BODY, { ...base(st), button: null }))).toBe(MAIN[`nullbutton:${st}`])
      expect(sha(buildBrandedDripHtml(BODY, { ...base(st), button: { label: 'Book', href: '' } }))).toBe(MAIN[`halfbutton:${st}`])
      // …and a button with no alignment is main's centred button, byte for byte.
      expect(sha(buildBrandedDripHtml(BODY, { ...base(st), button: CENTRE }))).toBe(MAIN[`centre:${st}`])
      expect(sha(buildBrandedDripHtml(BODY, { ...base(st), button: { ...CENTRE, align: null } }))).toBe(MAIN[`centre:${st}`])
      expect(sha(buildBrandedDripText(BODY, { ...base(st), button: CENTRE }))).toBe(MAIN[`centre-text:${st}`])
    })
  }
})

// ─── 7 · alignment ──────────────────────────────────────────────────────
describe('alignment renders left, centre and right; null renders centre', () => {
  const cellAlign = (html: string) => (html.match(/<td align="(left|center|right)">/) || [])[1]
  it('left and right sit the button in a full-width row aligned that way', () => {
    for (const a of ['left', 'right'] as const) {
      const html = buildButtonHtml('soft', { ...CENTRE, align: a })
      expect(cellAlign(html), a).toBe(a)
      expect(html).toContain('width="100%"')
      expect(html).toContain('Book Your Assessment')
    }
  })
  it('centre, null, missing and nonsense are all main’s centred markup', () => {
    const centre = buildButtonHtml('soft', CENTRE)
    expect(centre.startsWith('<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 20px auto;">')).toBe(true)
    for (const a of ['center', null, undefined, 'middle']) expect(buildButtonHtml('soft', { ...CENTRE, align: a as any })).toBe(centre)
  })
  it('the whole email carries it, and the senders read it from the row', () => {
    const html = buildBrandedDripHtml(BODY, { ...base('soft'), button: { ...CENTRE, align: 'right' } })
    expect(cellAlign(html)).toBe('right')
    expect(extrasFromRow({ button_text: 'x', button_link: 'y', button_align: 'left' }).buttonAlign).toBe('left')
    expect(extrasFromRow({ button_text: 'x', button_link: 'y' }).buttonAlign).toBeNull()        // column absent
    for (const f of ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts', 'app/api/emails/test-send/route.ts']) {
      expect(readFileSync(join(process.cwd(), f), 'utf8'), f).toMatch(/href: renderedButton\.body, align: \w+\.buttonAlign \}/)
    }
  })
})

// ─── the editors ────────────────────────────────────────────────────────
let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); h.reset() })
afterEach(() => { act(() => root.unmount()); container.remove() })

const SAVED = { discovery: 'https://cal.example.com/discovery', inHome: 'https://cal.example.com/home', video: 'https://cal.example.com/video' }
const STEP = (over: any = {}) => ({ step_order: 2, subject: 'Hi', body: 'Hello there', delay_days: 5, ...over })
const mountStep = async (step: any = STEP(), props: any = {}) => {
  const onSave = vi.fn(async () => undefined)
  await act(async () => { root.render(<DripPathStepEditor step={step} onSave={onSave} onClose={() => {}} links={SAVED} {...props} />) })
  return onSave
}
const pill = (id: string) => container.querySelector(`[data-button-pill="${id}"]`) as HTMLElement
const pills = () => Array.from(container.querySelectorAll('[data-button-pill]')).map(p => p.getAttribute('data-button-pill'))
const chosen = () => container.querySelector('[data-button-pill][aria-checked="true"]')?.getAttribute('data-button-pill')
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === label) as HTMLElement
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }) }
const save = () => click(button('Save'))
const inputLabelled = (label: string) => Array.from(container.querySelectorAll('label')).find(l => l.querySelector('span')?.textContent === label)?.querySelector('input') as HTMLInputElement
const type = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('None is the default', () => {
  it('an email with no button opens on None, with no words box', async () => {
    await mountStep()
    expect(pills()).toEqual(['none', 'discovery', 'inHome', 'video', 'custom'])
    expect(chosen()).toBe('none')
    expect(inputLabelled('Button text')).toBeUndefined()
  })
  it('saving only the wording sends no button fields at all', async () => {
    const onSave = await mountStep()
    await save()
    const patch = (onSave.mock.calls[0] as any[])[0]
    expect(patch).not.toHaveProperty('button_text')
    expect(patch).not.toHaveProperty('button_link')
    expect(patch).not.toHaveProperty('button_align')
  })
  it('None clears the words too', async () => {
    const onSave = await mountStep(STEP({ button_text: 'My words', button_link: '{{discovery_booking_link}}' }))
    await click(pill('none'))
    await save()
    expect((onSave.mock.calls[0] as any[])[0]).toMatchObject({ button_text: null, button_link: null, button_align: null })
  })
})

describe('None saves no words', () => {
  it('words stored without a link (half a button, which never shows) are cleared on the next save', async () => {
    const onSave = await mountStep(STEP({ button_text: 'Orphan words', button_link: '' }))
    expect(chosen()).toBe('none')
    await save()
    expect((onSave.mock.calls[0] as any[])[0]).toMatchObject({ button_text: null, button_link: null })
  })
})

describe('choosing a pill stores the matching tag', () => {
  for (const [id, tag, words] of [
    ['discovery', '{{discovery_booking_link}}', 'Book a Discovery Call'],
    ['inHome', '{{book_assessment_link}}', 'Book Your Assessment'],
    ['video', '{{virtual_booking_link}}', 'Book a Video Assessment'],
  ]) {
    it(`${id} → ${tag}, words pre-filled`, async () => {
      const onSave = await mountStep()
      await click(pill(id))
      expect(inputLabelled('Button text').value).toBe(words)
      await save()
      expect((onSave.mock.calls[0] as any[])[0]).toMatchObject({ button_link: tag, button_text: words })
    })
  }
  it('a suggestion follows the pill; words the owner typed never change', async () => {
    await mountStep()
    await click(pill('discovery'))
    await click(pill('video'))
    expect(inputLabelled('Button text').value).toBe('Book a Video Assessment')
    await type(inputLabelled('Button text'), 'Pick a time that suits you')
    await click(pill('inHome'))
    expect(inputLabelled('Button text').value).toBe('Pick a time that suits you')
  })
  it('the template editor stores the same way', async () => {
    const onSave = vi.fn(async () => undefined)
    await act(async () => { root.render(<EmailTemplateEditor row={{ when: 'Next day', subject: 'Welcome', body: 'B' }} onCancel={() => {}} onSave={onSave} links={SAVED} />) })
    await click(pill('video'))
    await save()
    expect((onSave.mock.calls[0] as any[])[2]).toEqual({ button_text: 'Book a Video Assessment', button_link: '{{virtual_booking_link}}', button_align: null })
  })
})

describe('an email carrying a hand-typed tag shows the right pill', () => {
  for (const [link, id] of [
    ['{{discovery_booking_link}}', 'discovery'], ['{{book_assessment_link}}', 'inHome'], ['{{booking_link}}', 'inHome'],
    ['{{virtual_booking_link}}', 'video'], ['https://calendly.com/kc', 'custom'], ['', 'none'],
  ]) {
    it(`${link || '(blank)'} → ${id}`, async () => {
      await mountStep(STEP({ button_text: 'Go', button_link: link }))
      expect(chosen()).toBe(id)
    })
  }
  it('the older {{booking_link}} is kept as typed when the owner only changes the words', async () => {
    const onSave = await mountStep(STEP({ button_text: 'Go', button_link: '{{booking_link}}' }))
    await type(inputLabelled('Button text'), 'Book now')
    await save()
    expect((onSave.mock.calls[0] as any[])[0]).toMatchObject({ button_link: '{{booking_link}}', button_text: 'Book now' })
  })
})

describe('a pill for an unsaved link', () => {
  it('is amber, and chosen it says the email will be held', async () => {
    await mountStep(STEP(), { links: { ...SAVED, discovery: '' } })
    expect(pill('discovery').getAttribute('data-unsaved')).toBe('true')
    expect(pill('video').getAttribute('data-unsaved')).toBeNull()
    expect(container.querySelector('[data-held-warning]')).toBeNull()
    await click(pill('discovery'))
    const warn = container.querySelector('[data-held-warning]') as HTMLElement
    expect(warn.textContent).toContain('You haven’t saved a discovery call link yet, so this email will be held')
    await click(pill('video'))
    expect(container.querySelector('[data-held-warning]')).toBeNull()
  })
})

describe('Custom', () => {
  for (const bad of ['javascript:alert(1)', 'https://', 'ftp://files.example.com', 'book with me']) {
    it(`"${bad}" is refused, plainly, and nothing saves`, async () => {
      const onSave = await mountStep()
      await click(pill('custom'))
      await type(inputLabelled('Web address'), bad)
      await save()
      expect(onSave).not.toHaveBeenCalled()
      expect(container.textContent).toContain(CUSTOM_LINK_PROBLEM)
    })
  }
  it('a bare address is saved the way the send reads it — with https://', async () => {
    const onSave = await mountStep()
    await click(pill('custom'))
    await type(inputLabelled('Web address'), 'calendly.com/kc')
    await type(inputLabelled('Button text'), 'Book with me')
    await save()
    expect((onSave.mock.calls[0] as any[])[0]).toMatchObject({ button_link: 'https://calendly.com/kc' })
  })
  it('a real https address saves', async () => {
    const onSave = await mountStep()
    await click(pill('custom'))
    await type(inputLabelled('Web address'), 'https://calendly.com/kc')
    await type(inputLabelled('Button text'), 'Book with me')
    await save()
    expect((onSave.mock.calls[0] as any[])[0]).toMatchObject({ button_link: 'https://calendly.com/kc', button_text: 'Book with me' })
  })
})

describe('the no-links state', () => {
  it('offers only None and Custom, with a note', async () => {
    await mountStep(STEP(), { links: { discovery: '', inHome: null, video: '  ' } })
    expect(pills()).toEqual(['none', 'custom'])
    expect(container.querySelector('[data-no-links]')!.textContent).toContain('You haven’t saved any booking links yet')
  })
  it('…but an email that already carries a link tag still shows its pill, amber', async () => {
    await mountStep(STEP({ button_text: 'Go', button_link: '{{book_assessment_link}}' }), { links: { discovery: '', inHome: '', video: '' } })
    expect(pills()).toEqual(['none', 'inHome', 'custom'])
    expect(pill('inHome').getAttribute('data-unsaved')).toBe('true')
    expect(container.querySelector('[data-held-warning]')).toBeTruthy()
  })
})

// ─── 8 · before migrations/button_align.sql ─────────────────────────────
describe('the screen works before the button_align migration is run', () => {
  it('no position control is offered, and a button still saves, centred', async () => {
    const onSave = await mountStep(STEP(), { alignReady: false })
    await click(pill('inHome'))
    expect(container.querySelector('[data-button-align]')).toBeNull()
    await save()
    expect((onSave.mock.calls[0] as any[])[0]).toMatchObject({ button_link: '{{book_assessment_link}}', button_align: null })
  })
  it('once it has run: left / centre / right, centre stored as null', async () => {
    const onSave = await mountStep(STEP({ button_text: 'Go', button_link: '{{book_assessment_link}}' }), { alignReady: true })
    const radios = Array.from(container.querySelectorAll('[data-button-align]')) as HTMLElement[]
    expect(radios.map(r => r.getAttribute('aria-label'))).toEqual(['Left', 'Centre', 'Right'])
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    await click(radios[0])
    await save()
    expect((onSave.mock.calls[0] as any[])[0]).toMatchObject({ button_align: 'left' })
  })
  it('the bulk step save: a centred button needs no column; left needs it', () => {
    const none = new Set(STEP_EXTRA_COLUMNS.filter(c => c !== 'button_align'))
    expect(STEP_EXTRA_COLUMNS).toContain('button_align')
    expect(extrasNeedingMissingColumns([parseStepExtras({ button_text: 'Go', button_link: '{{booking_link}}', button_align: null })], none)).toEqual([])
    expect(extrasNeedingMissingColumns([parseStepExtras({ button_align: 'center' })], none)).toEqual([])
    expect(extrasNeedingMissingColumns([parseStepExtras({ button_align: 'left' })], none)).toEqual(['button_align'])
    expect(stepExtrasForInsert(parseStepExtras({ button_align: 'left' }), none)).not.toHaveProperty('button_align')
    expect(stepExtrasForInsert(parseStepExtras({ button_align: 'right' }), new Set(STEP_EXTRA_COLUMNS))).toMatchObject({ button_align: 'right' })
  })
  const STEP_ROW = { id: 'st-1', drip_path_id: 'p-1', channel: 'email', master_template_id: null, drip_paths: { id: 'p-1', is_master: false, location_uuid: 'loc-1' } }
  const MISSING = { message: 'column "button_align" of relation "drip_path_steps" does not exist' }
  const req = (body: any) => ({ json: async () => body }) as any
  it('the single-step save: a centred button retries without the column and saves', async () => {
    h.enqueue('drip_path_steps', STEP_ROW)
    h.enqueue('drip_path_steps', null, MISSING)
    h.enqueue('drip_path_steps', { id: 'st-1' })
    const res = await stepPATCH(req({ subject: 'Hi', button_text: 'Go', button_link: '{{booking_link}}', button_align: null }), { params: { stepId: 'st-1' } })
    expect(res.status).toBe(200)
    expect(h.state.updates.map(u => 'button_align' in u.patch)).toEqual([true, false])
    expect(h.state.updates[1].patch).toMatchObject({ button_text: 'Go', button_link: '{{booking_link}}' })
  })
  it('…and left is refused as "not set up yet", nothing written', async () => {
    h.enqueue('drip_path_steps', STEP_ROW)
    h.enqueue('drip_path_steps', null, MISSING)
    const res = await stepPATCH(req({ subject: 'Hi', button_text: 'Go', button_link: '{{booking_link}}', button_align: 'left' }), { params: { stepId: 'st-1' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_set_up_yet' })
    expect(h.state.updates).toHaveLength(1)
  })
})

// ─── 9 · the preview is the production renderer ─────────────────────────
describe('Preview', () => {
  const ctx = { style: 'bold', signature: SIG, values: { first_name: 'Jordan', location_name: 'Kansas City', virtual_booking_link: 'https://cal.example.com/video' } }
  it('swaps the form for the real email — the unsaved subject, wording, button and signature — through lib/drip-email-layout', async () => {
    await mountStep(STEP({ body: 'Hello {{first_name}}\n\nThank you,\n{{signature}}' }), { preview: ctx, alignReady: true })
    await type(container.querySelector('input[type="text"]') as HTMLInputElement, 'A new subject')
    await click(pill('video'))
    await click(container.querySelector('[data-button-align="right"]')!)
    await click(button('Preview'))
    expect(container.querySelector('textarea')).toBeNull()                          // the form is gone
    const html = (container.querySelector('[data-editor-preview] iframe') as HTMLIFrameElement).getAttribute('srcdoc')!
    const expected = buildBrandedDripHtml(`Hello Jordan\n\nThank you,\n${SIGNATURE_MARKER}`, {
      location_name: 'Kansas City', location_phone: undefined, reviews_link: undefined, signature: SIG, style: 'bold', heading: 'A new subject',
      button: { label: 'Book a Video Assessment', href: 'https://cal.example.com/video', align: 'right' },
    })
    expect(html).toBe(expected)
    expect(html).toContain('Lynette Ewy</strong>')
    // "Back to editing" loses nothing.
    await click(button('Back to editing'))
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('A new subject')
    expect(chosen()).toBe('video')
    expect(container.querySelector('[data-button-align="right"]')!.getAttribute('aria-checked')).toBe('true')
  })
  it('the footer is one row: Cancel · Preview · Save', async () => {
    await mountStep()
    const footer = button('Save').parentElement!
    expect(Array.from(footer.querySelectorAll('button')).map(b => b.textContent)).toEqual(['Cancel', 'Preview', 'Save'])
  })
  it('no second renderer: nothing in the app imports Lovable’s, or its rewriting helpers', () => {
    const files = ['components/BeeHub.jsx', 'components/settings/EmailsScreen.jsx']
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      for (const bad of ['renderEmail(', 'email-html', 'adaptedEmail', 'emailNeeds']) expect(src.includes(bad), `${f}: ${bad}`).toBe(false)
    }
    expect(readdirSync(join(process.cwd(), 'lib')).filter(n => /^email-html/.test(n))).toEqual([])
    // previewEmailHtml is the layout's own output, unchanged in between.
    const row = { subject: 'S', body: 'B', buttonText: 'Go', buttonLink: '{{x}}', buttonAlign: 'left' }
    expect(previewEmailHtml({ row, style: 'soft', values: { x: 'https://a.example' } })).toBe(
      buildBrandedDripHtml('B', { location_name: undefined, location_phone: undefined, reviews_link: undefined, signature: null, style: 'soft', heading: 'S', button: { label: 'Go', href: 'https://a.example', align: 'left' } }))
  })
})
