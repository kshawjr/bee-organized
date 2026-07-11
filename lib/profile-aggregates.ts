// lib/profile-aggregates.ts
//
// PURE aggregate math for GET /api/clients/:id/profile — extracted so the
// client-v4 metric band's numbers are unit-testable without a supabase
// harness.
//
// The card-restore build-2 drift fix lives here: OWING sums
// balance_owing across ALL engagements INCLUDING closed ones. The old
// open-scoped sum made debt vanish the moment an engagement closed
// (close ≠ paid — 'written_off' exists precisely because it doesn't).
// INVOICED is the same all-engagements sum of the total_invoiced denorm.
// open_pipeline stays open-scoped by definition (it's pipeline).

const num = (v: any) => (v == null ? 0 : Number(v) || 0)
const isOpen = (s: string) => s !== 'Closed Won' && s !== 'Closed Lost'

export function engagementDisplayValue(e: any): number {
  if (num(e.total_invoiced) > 0) return num(e.total_invoiced)
  return Math.max(0, ...(e.quotes || []).map((q: any) => num(q.total)))
}

export function profileAggregates(engagements: any[]) {
  const open = engagements.filter(e => isOpen(e.stage))
  return {
    lifetime_paid: engagements.reduce((s, e) => s + num(e.total_paid), 0),
    invoiced: engagements.reduce((s, e) => s + num(e.total_invoiced), 0),
    open_pipeline: open.reduce((s, e) => s + engagementDisplayValue(e), 0),
    // ALL engagements — closed debt stays visible (the drift fix).
    owing: engagements.reduce((s, e) => s + num(e.balance_owing), 0),
    open_count: open.length,
    total_count: engagements.length,
  }
}
