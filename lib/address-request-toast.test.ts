// The address toast tells the whole truth about the Jobber request step
// (2026-10-19): a created property counts as synced, and a request that did
// not get the address is said out loud.
import { describe, it, expect } from 'vitest'
import { syncSuffix } from '@/components/hive/shared/AddressField'

describe('syncSuffix — the Jobber request step', () => {
  it('property created + request attached → synced to Jobber', () => {
    expect(syncSuffix({ billing: 'unchanged', property: 'added', request: 'attached' })).toBe(' · synced to Jobber')
  })
  it('request failed → says the address did not reach the request', () => {
    expect(syncSuffix({ billing: 'added', property: 'added', request: 'failed' }))
      .toBe(' · synced to Jobber, but the address did not reach the Jobber request')
  })
  it('no request on the lead → unchanged wording', () => {
    expect(syncSuffix({ billing: 'added', property: 'none', request: null })).toBe(' · synced to Jobber')
  })
})
