// lib/drip-step-extras.ts
//
// The four drip_path_steps columns added 2026-10-30, as the step save
// (app/api/drip-paths/[id]/steps) and the clone route handle them:
//
//   is_paused    migrations/drip_path_steps_paused.sql
//   delay_unit   migrations/drip_path_steps_delay_unit.sql
//   button_text  migrations/email_buttons.sql
//   button_link  migrations/email_buttons.sql
//   button_align migrations/button_align.sql (left | right; null = centre)
//
// WHY THIS IS CAREFUL. The step save is DELETE-then-INSERT. If the insert named
// a column whose migration hasn't run, it would fail after the delete and the
// location's sequence would be gone. So the save first asks which of these
// columns exist, refuses (before deleting anything) any save that tries to SET
// one that doesn't, and otherwise inserts only the columns that exist.

import { supabaseService } from './supabase-service'

export const STEP_EXTRA_COLUMNS = ['is_paused', 'delay_unit', 'button_text', 'button_link', 'button_align'] as const
export type StepExtraColumn = (typeof STEP_EXTRA_COLUMNS)[number]

export type DelayUnit = 'days' | 'months' | 'years'
const UNITS = new Set<DelayUnit>(['days', 'months', 'years'])

// undefined = the caller didn't send it.
export type StepExtrasIn = {
  is_paused?: boolean
  delay_unit?: DelayUnit | null
  button_text?: string | null
  button_link?: string | null
  // null = centre, the default; centre is stored as null so an untouched
  // email and a centred one are the same row.
  button_align?: 'left' | 'right' | null
}

function textOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, 500) : null
}

export function buttonAlignIn(v: unknown): 'left' | 'right' | null {
  return v === 'left' || v === 'right' ? v : null
}

export function parseStepExtras(raw: Record<string, unknown>): StepExtrasIn {
  const out: StepExtrasIn = {}
  if (raw.is_paused === true || raw.is_paused === false) out.is_paused = raw.is_paused
  if (raw.delay_unit === null) out.delay_unit = null
  else if (typeof raw.delay_unit === 'string' && UNITS.has(raw.delay_unit as DelayUnit)) out.delay_unit = raw.delay_unit as DelayUnit
  const bt = textOrNull(raw.button_text)
  if (bt !== undefined) out.button_text = bt
  const bl = textOrNull(raw.button_link)
  if (bl !== undefined) out.button_link = bl
  if (raw.button_align !== undefined) out.button_align = buttonAlignIn(raw.button_align)
  return out
}

// One cheap read: a single row with '*' names every column the table has.
// drip_path_steps always has rows (the corporate masters), so an empty answer
// only happens in a broken database — then nothing is treated as present,
// which is the safe direction.
export async function existingStepExtraColumns(): Promise<Set<StepExtraColumn>> {
  const found = new Set<StepExtraColumn>()
  try {
    const { data, error } = await supabaseService.from('drip_path_steps').select('*').limit(1)
    if (error || !Array.isArray(data) || !data[0]) return found
    const row = data[0] as Record<string, unknown>
    for (const c of STEP_EXTRA_COLUMNS) if (c in row) found.add(c)
  } catch {
    // treat as none present
  }
  return found
}

// The columns a save NEEDS but the database doesn't have yet. Only values
// that change behaviour count: pausing, a months/years unit, a button.
// Un-pausing, a days unit, an empty button and a centred one are today's
// behaviour already.
export function extrasNeedingMissingColumns(steps: StepExtrasIn[], cols: Set<StepExtraColumn>): StepExtraColumn[] {
  const need = new Set<StepExtraColumn>()
  for (const s of steps) {
    if (s.is_paused === true && !cols.has('is_paused')) need.add('is_paused')
    if ((s.delay_unit === 'months' || s.delay_unit === 'years') && !cols.has('delay_unit')) need.add('delay_unit')
    if (s.button_text && !cols.has('button_text')) need.add('button_text')
    if (s.button_link && !cols.has('button_link')) need.add('button_link')
    if (s.button_align && !cols.has('button_align')) need.add('button_align')
  }
  return Array.from(need)
}

// What goes into the insert: every extra column that EXISTS, with the step's
// value or the column's own default.
export function stepExtrasForInsert(s: StepExtrasIn, cols: Set<StepExtraColumn>): Partial<Record<StepExtraColumn, unknown>> {
  const out: Partial<Record<StepExtraColumn, unknown>> = {}
  if (cols.has('is_paused')) out.is_paused = s.is_paused === true
  if (cols.has('delay_unit')) out.delay_unit = s.delay_unit && s.delay_unit !== 'days' ? s.delay_unit : null
  if (cols.has('button_text')) out.button_text = s.button_text ?? null
  if (cols.has('button_link')) out.button_link = s.button_link ?? null
  if (cols.has('button_align')) out.button_align = s.button_align ?? null
  return out
}

// For the clone route: copy whichever extras a master row carries (it was read
// with '*', so a missing column is simply not there).
export function stepExtrasFromRow(row: Record<string, unknown>): Partial<Record<StepExtraColumn, unknown>> {
  const out: Partial<Record<StepExtraColumn, unknown>> = {}
  for (const c of STEP_EXTRA_COLUMNS) if (c in row) out[c] = row[c]
  return out
}
