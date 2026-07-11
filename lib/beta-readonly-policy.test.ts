// @vitest-environment node
//
// 868kawwmh — the read-only POLICY, both sides:
//   • client:  resolveBetaReadOnly (components/hive/shared/betaGate.js)
//              — the single point that decides whether the beta surface
//                renders read-only, from the mapRole vocabulary + crmStatus.
//   • server:  isLocationReadOnly (lib/read-only-access) — the paused-
//                location predicate the write routes enforce.
//
// The load-bearing distinctions:
//   - lite_user (viewer / light / readonly) is ALWAYS read-only.
//   - paused / inactive location is read-only (recoverable).
//   - past_due keeps FULL write access during its 14-day grace — it must
//     NOT resolve read-only (locking out a paying grace-period customer).
//   - elevated roles (super_admin, corporate/admin) ALWAYS write.
import { describe, it, expect } from 'vitest'
import { resolveBetaReadOnly } from '@/components/hive/shared/betaGate'
import { isLocationReadOnly } from '@/lib/read-only-access'

describe('resolveBetaReadOnly — client beta-surface policy', () => {
  it('elevated roles always write (never read-only), even on a paused location', () => {
    expect(resolveBetaReadOnly({ role: 'super_admin', franchiseRole: 'owner', crmStatus: 'inactive' })).toBe(false)
    expect(resolveBetaReadOnly({ role: 'corporate', franchiseRole: 'owner', crmStatus: 'inactive' })).toBe(false)
  })

  it('full-access franchise roles (owner, manager) write on active + past_due', () => {
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'owner', crmStatus: 'active' })).toBe(false)
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'manager', crmStatus: 'active' })).toBe(false)
    // past_due — full access during grace (the whole point of the ruling)
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'owner', crmStatus: 'pastdue' })).toBe(false)
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'manager', crmStatus: 'pastdue' })).toBe(false)
  })

  it('paused / inactive location is read-only for owner + manager', () => {
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'owner', crmStatus: 'inactive' })).toBe(true)
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'manager', crmStatus: 'inactive' })).toBe(true)
  })

  it('lite_user is read-only regardless of location status — all three vocab values', () => {
    // 'viewer' is what mapRole emits for DB lite_user; 'light'/'readonly'
    // come from the client role / view-as pickers. All mean read-only.
    for (const fr of ['viewer', 'light', 'readonly']) {
      expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: fr, crmStatus: 'active' })).toBe(true)
      expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: fr, crmStatus: 'pastdue' })).toBe(true)
      expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: fr, crmStatus: 'inactive' })).toBe(true)
    }
  })

  it('onboarding location is not read-only via this gate (owner)', () => {
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'owner', crmStatus: 'onboarding' })).toBe(false)
  })
})

describe('isLocationReadOnly — server paused-location predicate', () => {
  it('null / undefined location → not read-only', () => {
    expect(isLocationReadOnly(null)).toBe(false)
    expect(isLocationReadOnly(undefined)).toBe(false)
  })

  it('lifecycle_status "paused" → read-only', () => {
    expect(isLocationReadOnly({ lifecycle_status: 'paused', subscription_status: 'active' })).toBe(true)
  })

  it('subscription_status "inactive" → read-only', () => {
    expect(isLocationReadOnly({ lifecycle_status: 'active', subscription_status: 'inactive' })).toBe(true)
  })

  it('past_due is NOT read-only (grace keeps full access)', () => {
    expect(isLocationReadOnly({ lifecycle_status: 'active', subscription_status: 'past_due' })).toBe(false)
  })

  it('active / deferred locations are not read-only', () => {
    expect(isLocationReadOnly({ lifecycle_status: 'active', subscription_status: 'active' })).toBe(false)
    expect(isLocationReadOnly({ lifecycle_status: 'active', subscription_status: 'deferred' })).toBe(false)
  })
})
