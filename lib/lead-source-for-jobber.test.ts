// leadSourceForJobber — the lead source as it is SENT to Jobber (2026-10-19).
// Jobber stores what we send as loose text, so this is exactly what an owner
// sees. leads.source itself is never changed by it.
import { describe, it, expect } from 'vitest'
import { leadSourceForJobber, normalizeLeadSource } from '@/lib/lead-source'

describe('leadSourceForJobber', () => {
  it('real sources go as they are', () => {
    for (const s of ['Website', 'Google', 'Facebook', 'Instagram', 'Referral', 'Search', 'Print Material', 'Word of Mouth']) {
      expect(leadSourceForJobber(s)).toBe(s)
    }
  })

  it('variants become one name', () => {
    expect(leadSourceForJobber('GGLE')).toBe('Google')
    expect(leadSourceForJobber('ggle')).toBe('Google')
    expect(leadSourceForJobber('google')).toBe('Google')
    expect(leadSourceForJobber('chatgpt.com')).toBe('AI')
    expect(leadSourceForJobber('ChatGPT.com')).toBe('AI')
    expect(leadSourceForJobber('ig')).toBe('Instagram')
    expect(leadSourceForJobber('fb')).toBe('Facebook')
    expect(leadSourceForJobber('Next Door')).toBe('NextDoor')
    expect(leadSourceForJobber('Angi Leads Integration')).toBe('Angi')
    expect(leadSourceForJobber('Angi Integration')).toBe('Angi')
    expect(leadSourceForJobber('Friend Referred')).toBe('Referral')
    expect(leadSourceForJobber('Client Referral')).toBe('Referral')
    expect(leadSourceForJobber('Referral From Other Hive')).toBe('Referral')
    expect(leadSourceForJobber('Friend')).toBe('Word of Mouth')
    expect(leadSourceForJobber('Personal Friend')).toBe('Word of Mouth')
    expect(leadSourceForJobber('seattle_assessment')).toBe('Website')
  })

  it('extra spaces and capitals do not stop a match', () => {
    expect(leadSourceForJobber('  Angi   Leads  Integration ')).toBe('Angi')
    expect(leadSourceForJobber('MANUAL')).toBeNull()
  })

  it('our own words send nothing', () => {
    for (const s of ['Manual', 'Returning Client', 'Existing Client', 'beeorganized', 'Bee Organized Interface', 'Bee Applicant', 'smoke_test', 'scout_test']) {
      expect(leadSourceForJobber(s)).toBeNull()
    }
  })

  it('"Other" and "Google Voice" are owners\' own choices — kept', () => {
    expect(leadSourceForJobber('Other')).toBe('Other')
    expect(leadSourceForJobber('Google Voice')).toBe('Google Voice')
  })

  it('a real source with no rule goes as typed', () => {
    for (const s of ['Thumbtack', 'Angi', 'Yelp', 'TikTok', 'Social Media', 'Flyer', 'AI', 'Senior Expo   Glen Mills']) {
      expect(leadSourceForJobber(s)).toBe(s)
    }
  })

  it('blank stays blank', () => {
    for (const s of [null, undefined, '', '   ', 42]) expect(leadSourceForJobber(s)).toBeNull()
  })

  it('does NOT change the Bee Hub tidy-up: normalizeLeadSource still keeps these as typed', () => {
    expect(normalizeLeadSource('Manual')).toBe('Manual')
    expect(normalizeLeadSource('GGLE')).toBe('GGLE')
    expect(normalizeLeadSource('chatgpt.com')).toBe('chatgpt.com')
  })
})
