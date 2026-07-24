// @vitest-environment node
//
// Preview parity — lib/preview-vars must mirror the FULL send-time
// RenderContext that lib/drip-send.ts assembles (the ctx literal handed to
// renderTemplate): 14 variables. The best pre-Stage-2 preview implemented 7,
// so Gen 2 master content previewed with holes where {{rate_per_hour}},
// {{owner_name}} and {{book_assessment_link}} render at send time.
//
// If a variable is ever ADDED to drip-send's ctx, the SEND_TIME_KEYS list
// below must be updated in the same commit — that is this suite's job.
import { describe, it, expect } from 'vitest'
import { PREVIEW_VAR_KEYS, buildPreviewVars, applyPreviewVars } from '@/lib/preview-vars'

// Transcribed from the ctx literal in lib/drip-send.ts (sendDripStepForRow).
// partner_name is RenderContext's 15th, optional key — Partner Drip Phase 2,
// a no-op at send time today, deliberately not previewed as filled.
const SEND_TIME_KEYS = [
  'first_name',
  'organizer_name',
  'location_name',
  'phone',
  'booking_link',
  'service_area',
  'owner_name',
  'owner_first_name',
  'owner_booking_link',
  'location_owner_name',
  'rate_per_hour',
  'location_phone',
  'book_assessment_link',
  'reviews_link',
]

const ALL_TAGS_TEMPLATE = SEND_TIME_KEYS.map(k => `${k}=[{{${k}}}]`).join('\n')

describe('buildPreviewVars mirrors the 14-variable send-time context', () => {
  it('PREVIEW_VAR_KEYS is exactly the send-time set — none silently omitted', () => {
    expect([...PREVIEW_VAR_KEYS].sort()).toEqual([...SEND_TIME_KEYS].sort())
    expect(PREVIEW_VAR_KEYS).toHaveLength(14)
  })

  it('every key resolves to a non-empty string even with NO settings', () => {
    const vars = buildPreviewVars()
    for (const key of SEND_TIME_KEYS) {
      expect(typeof vars[key], key).toBe('string')
      expect((vars[key] as string).trim().length, `${key} must not preview as an empty hole`).toBeGreaterThan(0)
    }
  })

  it('real location values win over samples', () => {
    const vars = buildPreviewVars({
      profile: { firstName: 'Pat', lastName: 'Owner', bookingLink: 'https://cal.example/pat' },
      location: {
        name: 'Testville', phone: '(111) 222-3333', bookingLink: 'https://cal.example/loc',
        reviewsLink: 'https://g.page/testville', ratePerHour: '$88/hr', sendFromName: 'Bee Testville',
      },
    })
    expect(vars.rate_per_hour).toBe('$88/hr')
    expect(vars.owner_name).toBe('Pat Owner')
    expect(vars.owner_first_name).toBe('Pat')
    expect(vars.owner_booking_link).toBe('https://cal.example/pat')
    expect(vars.book_assessment_link).toBe('https://cal.example/loc')
    expect(vars.booking_link).toBe('https://cal.example/loc')
    expect(vars.reviews_link).toBe('https://g.page/testville')
    expect(vars.location_phone).toBe('(111) 222-3333')
    expect(vars.organizer_name).toBe('Bee Testville')
  })

  it('a template using every tag renders with zero holes and zero literal {{…}}', () => {
    const rendered = applyPreviewVars(ALL_TAGS_TEMPLATE, buildPreviewVars())
    expect(rendered).not.toMatch(/\{\{/)
    // Each line rendered as key=[value] — an empty hole would read key=[].
    for (const key of SEND_TIME_KEYS) {
      expect(rendered, `hole for {{${key}}}`).not.toContain(`${key}=[]`)
    }
  })

  it('unknown tags render as empty string — same as the send path (resend.ts applyVars)', () => {
    const rendered = applyPreviewVars('hi {{partner_name}}{{not_a_var}} there', buildPreviewVars())
    expect(rendered).toBe('hi  there')
  })
})
