// lib/email-timing.ts
//
// WHEN AN EMAIL GOES OUT, in days, months or years (Settings → Emails, 2026-10-30).
// From the designer's export (parseTiming / formatTiming / timingDays), adapted
// to what is stored.
//
// STORAGE — DAYS, PLUS THE UNIT THE OWNER CHOSE.
//   drip_path_steps.delay_days  stays the ONLY thing the sender reads
//                               (lib/drip-send.ts advanceOrComplete). A month
//                               is 30 days, a year 365 — the export's own
//                               timingDays, so the list's order and the send
//                               date agree.
//   drip_path_steps.delay_unit  only how to SHOW it. Without it, days alone
//                               can't be told apart: 30 days is both "Day 30"
//                               (the last new-lead email today) and "A month
//                               later", and 360 is "12 months" or "Day 360".
//                               Formatting from days would rewrite an owner's
//                               "Day 30" as "A month later" behind her back.
//                               NULL = days, every row today.

export type TimingUnit = 'days' | 'months' | 'years'
export type Timing = { immediate: boolean; n: number; unit: TimingUnit }

export const TIMING_UNITS: { v: TimingUnit; label: string }[] = [
  { v: 'days', label: 'days' },
  { v: 'months', label: 'months' },
  { v: 'years', label: 'years' },
]

export const DAYS_PER: Record<TimingUnit, number> = { days: 1, months: 30, years: 365 }

export function normalizeUnit(u: unknown): TimingUnit {
  return u === 'months' || u === 'years' ? u : 'days'
}

// Stored (delay_days, delay_unit) → editable value. A months/years unit whose
// days no longer divide evenly (edited elsewhere in days) falls back to days,
// so the screen never shows a rounded number that isn't the real send date.
export function timingFromStored(delayDays: number | null | undefined, delayUnit?: unknown): Timing {
  const d = Math.max(0, Math.round(Number(delayDays) || 0))
  if (d === 0) return { immediate: true, n: 1, unit: 'days' }
  const unit = normalizeUnit(delayUnit)
  if (unit !== 'days' && d % DAYS_PER[unit] === 0) return { immediate: false, n: d / DAYS_PER[unit], unit }
  return { immediate: false, n: d, unit: 'days' }
}

export function timingDays(t: Timing): number {
  if (t.immediate) return 0
  return t.n * DAYS_PER[t.unit]
}

// What the list shows. Days read as before ("Right away", "Next day", "Day 5").
export function formatTiming(t: Timing): string {
  if (t.immediate) return 'Right away'
  if (t.unit === 'days') return t.n === 1 ? 'Next day' : `Day ${t.n}`
  const one = t.unit.slice(0, -1)
  return t.n === 1 ? `A ${one} later` : `${t.n} ${t.unit} later`
}

// What gets stored for an edited timing. delay_unit is null for days.
export function timingToStored(t: Timing): { delay_days: number; delay_unit: TimingUnit | null } {
  return { delay_days: timingDays(t), delay_unit: t.immediate || t.unit === 'days' ? null : t.unit }
}

// The label for a stored row.
export function timingLabel(delayDays: number | null | undefined, delayUnit?: unknown): string {
  return formatTiming(timingFromStored(delayDays, delayUnit))
}
