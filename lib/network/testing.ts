// lib/network/testing.ts
// One made-up contact for the tests in this folder to start from. Not sample
// data for a screen: nothing outside a *.test.ts file should import it.

import type { NetContact } from './types'

export function sampleContact(overrides: Partial<NetContact> = {}): NetContact {
  return {
    id: 'c1',
    name: 'Lisa Snyder',
    types: ['partner'],
    level: 'referral',
    stage: 'Active Partner',
    tags: [],
    role: 'Real Estate Agent',
    company: 'Compass Greenwood Village',
    phone: '(303) 555-0142',
    email: 'lisa@example.com',
    howMet: 'Chamber breakfast',
    referred: 0,
    converted: 0,
    revenue: 0,
    lastTalkedDays: 5,
    mailchimp: { on: false },
    notes: [],
    history: [],
    ...overrides,
  }
}
