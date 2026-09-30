// lib/reminders.ts
// ─────────────────────────────────────────────────────────────
// Reminders — a date and a note, on any record, in one list.
//
// Pure logic shared by /api/reminders (server) and the Reminder strip, Home
// block and Reminders page (browser). No imports from Supabase or Next here,
// so both sides can use it and the tests can hit it directly.
//
// Kept to two fields on purpose (Kevin, 2026-09-30): owners are not
// technical, and Bee Hub is already too much. No priority, category,
// assignee, repeat or sub-tasks. If you are about to add a third field, stop
// and ask.
// ─────────────────────────────────────────────────────────────

export const REMINDER_NOTE_MAX = 500

// The three record columns a reminder can point at. A lead and a client are
// the same leads row (and the same card), so both use lead_id.
export const RECORD_KEYS = ['lead_id', 'engagement_id', 'partner_id'] as const
export type RecordKey = (typeof RECORD_KEYS)[number]

export type ReminderRecord = { key: RecordKey; id: string }

// ── dates ────────────────────────────────────────────────────
// Everything is a plain 'YYYY-MM-DD' in the VIEWER'S local calendar. No
// timestamps, no UTC: a reminder due Tuesday is "today" all of Tuesday.

function pad(n: number) { return n < 10 ? `0${n}` : String(n) }

export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayYmd(now: Date = new Date()): string {
  return toYmd(now)
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return toYmd(new Date(y, m - 1, d + days))
}

// The two quick picks. "Next week" is simply seven days on — one rule, no
// "which Monday?" puzzle.
export function quickDates(now: Date = new Date()) {
  const today = todayYmd(now)
  return { tomorrow: addDays(today, 1), nextWeek: addDays(today, 7) }
}

export function isValidYmd(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

export type DueState = 'overdue' | 'today' | 'upcoming'

export function dueState(dueOn: string, today: string): DueState {
  if (dueOn < today) return 'overdue'
  if (dueOn === today) return 'today'
  return 'upcoming'
}

// How a due date reads to an owner: "Today", "Tomorrow", "Yesterday",
// a weekday within the coming week ("Tuesday"), else "Oct 14".
export function dueLabel(dueOn: string, today: string): string {
  if (dueOn === today) return 'Today'
  if (dueOn === addDays(today, 1)) return 'Tomorrow'
  if (dueOn === addDays(today, -1)) return 'Yesterday'
  const [y, m, d] = dueOn.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  if (dueOn > today && dueOn < addDays(today, 7)) {
    return dt.toLocaleDateString('en-US', { weekday: 'long' })
  }
  const [ty] = today.split('-').map(Number)
  return dt.toLocaleDateString('en-US', y === ty
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
}

// Soonest due first; ties keep the order they were made in.
export function sortReminders<T extends { due_on: string; created_at?: string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    a.due_on.localeCompare(b.due_on) || String(a.created_at || '').localeCompare(String(b.created_at || '')))
}

// What Home shows: overdue ones (amber, on top), then today's. Nothing
// later than today — Home is "what needs you now"; the rest live on the
// Reminders page.
export function homeReminders<T extends { due_on: string; done_at?: string | null }>(list: T[], today: string) {
  const open = sortReminders(list.filter(r => !r.done_at))
  return {
    overdue: open.filter(r => r.due_on < today),
    today: open.filter(r => r.due_on === today),
  }
}

// ── input checks (server) ────────────────────────────────────

// Exactly one record column must be named. Returns it, or null.
export function pickRecord(body: Record<string, unknown>): ReminderRecord | null {
  const named = RECORD_KEYS.filter(k => typeof body[k] === 'string' && (body[k] as string).length > 0)
  if (named.length !== 1) return null
  return { key: named[0], id: body[named[0]] as string }
}

export function cleanNote(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.length > REMINDER_NOTE_MAX) return null
  return t
}

// ── ownership ────────────────────────────────────────────────
// THE RULE: a reminder belongs to whoever set it. Not the record's
// assignee, not the location owner — the signed-in person who pressed Done.
// This is the only place the insert row is built, so the rule lives here and
// the test that pins it points here.
export function buildReminderInsert(args: {
  setterId: string
  record: ReminderRecord
  locationUuid: string
  dueOn: string
  note: string
}) {
  return {
    user_id: args.setterId,
    location_uuid: args.locationUuid,
    [args.record.key]: args.record.id,
    due_on: args.dueOn,
    note: args.note,
  }
}
