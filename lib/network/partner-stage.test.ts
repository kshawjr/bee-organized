import { describe, expect, it } from 'vitest'
import { contactHistory } from './history'
import { confirmPartnerStage } from './partner-stage'
import { sampleContact } from './testing'

const p = sampleContact({ types: ['partner'], stage: 'New Contact', notes: [], history: [] })

describe('Partner stage confirmation', () => {
  it('does not move or save a note before confirmation', () => {
    expect(confirmPartnerStage(p, 'Active Partner', 'Met today', false)).toBe(p)
  })
  it('allows confirmation without a note', () => {
    const next = confirmPartnerStage(p, 'Active Partner', '  ', true, '2026-11-14T18:56:00Z')
    expect(next.stage).toBe('Active Partner')
    expect(next.notes).toEqual([])
    expect(next.history).toContainEqual({ kind: 'partner', text: 'Moved to Active Partner', when: '2026-11-14T18:56:00Z' })
  })
  it('saves the optional note in notes and History with a timestamp', () => {
    const next = confirmPartnerStage(p, 'Active Partner', '  Referred a new client  ', true, '2026-11-14T18:56:00Z')
    expect(next.notes).toEqual([{ text: 'Referred a new client', title: 'Moved to Active Partner', author: 'You', at: '2026-11-14T18:56:00Z' }])
    expect(contactHistory(next)).toContainEqual({ kind: 'note', when: '2026-11-14T18:56:00Z', text: 'Moved to Active Partner: Referred a new client' })
  })
  it('can move a partner to Gone quiet', () => {
    expect(confirmPartnerStage(p, 'Gone quiet', '', true).stage).toBe('Gone quiet')
  })
  it('does not repeat the stage they are already in', () => {
    expect(confirmPartnerStage(p, 'New Contact', 'again', true)).toBe(p)
  })
  it.each(['vendor', 'nurture', 'organization', 'unsure'] as const)('never gives a %s a stage', (t) => {
    const other = sampleContact({ types: [t], stage: undefined })
    expect(confirmPartnerStage(other, 'Active Partner', '', true)).toBe(other)
  })
})
