// lib/network/owner-safe-footprint.ts
// ─────────────────────────────────────────────────────────────
// The owner-safe routes pass (2026-11-20) added location checks to three
// Network routes that older slices pin byte for byte (clients-doors-footprint
// at 0c61afc, slice5-footprint at 70eab32). Those pins stay as they were: this
// takes exactly the owner-safe lines back out first, so each pin still proves
// that NOTHING ELSE in those files changed.
//
// Every step must find its text exactly once, or this throws. A file that
// moves on without updating these steps fails loudly instead of being
// fingerprinted wrongly.
// ─────────────────────────────────────────────────────────────

type Step = [string, string]
const STEPS: Record<string, Step[]> = {
  'app/api/network/contacts/route.ts': [
    ["import { networkWriteVerdict, READ_ONLY_ANSWER } from '@/lib/network/route-access'\n", ''],
    ["  const may = networkWriteVerdict(caller, locationId)\n  if (may === 'not_found') return NextResponse.json({ error: 'location_not_found', field: 'location' }, { status: 404 })\n  if (may === 'read_only') return NextResponse.json(READ_ONLY_ANSWER, { status: 403 })\n", ''],
  ],
  'app/api/network/import/route.ts': [
    ["import { mayReadNetworkLocation, networkWriteVerdict, READ_ONLY_ANSWER } from '@/lib/network/route-access'\n", ''],
    ["  if (!mayReadNetworkLocation(caller, locationId)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n", ''],
    ["  // Checking a file is a step towards writing, and reads the location's\n  // contacts: both modes need write rights here.\n  const may = networkWriteVerdict(caller, locationId)\n  if (may === 'not_found') return NextResponse.json({ ok: false, reason: 'location_not_found' }, { status: 404 })\n  if (may === 'read_only') return NextResponse.json(READ_ONLY_ANSWER, { status: 403 })\n", ''],
  ],
  'app/api/network/contacts/[id]/route.ts': [
    ["import { mayReadNetworkLocation, networkWriteVerdict, READ_ONLY_ANSWER } from '@/lib/network/route-access'\nimport type { Caller } from '@/lib/crm'\n", ''],
    ['async function loadSheet(id: string, caller: Caller) {\n  const userId = caller.userId\n', 'async function loadSheet(id: string, userId: string) {\n'],
    ["  // The contact's OWN location decides. Another location's contact is\n  // answered exactly like one that does not exist, and nothing else is read.\n  if (!mayReadNetworkLocation(caller, (row as any).location_id)) return { error: 'contact_not_found', status: 404 as const }\n", ''],
    ['  const sheet = await loadSheet(id, caller)\n  if (!sheet.body) return NextResponse.json({ error: sheet.error }, { status: sheet.status })', '  const sheet = await loadSheet(id, caller.userId)\n  if (!sheet.body) return NextResponse.json({ error: sheet.error }, { status: sheet.status })'],
    ["  // The contact's OWN location decides, never one sent by the screen.\n  const may = networkWriteVerdict(caller, (stored as any).location_id)\n  if (may === 'not_found') return NextResponse.json({ error: 'contact_not_found' }, { status: 404 })\n  if (may === 'read_only') return NextResponse.json({ ...READ_ONLY_ANSWER, written: [] }, { status: 403 })\n", ''],
    ['  const sheet = await loadSheet(id, caller)\n  if (!sheet.body) return NextResponse.json({ error: sheet.error, written: plan.written }', '  const sheet = await loadSheet(id, caller.userId)\n  if (!sheet.body) return NextResponse.json({ error: sheet.error, written: plan.written }'],
  ],
}

export function withoutOwnerSafe(path: string, src: string): string {
  let out = src
  for (const [from, to] of STEPS[path] || []) {
    const n = out.split(from).length - 1
    if (n !== 1) throw new Error(`owner-safe-footprint: ${path} has its step ${n} times, expected once: ${from.slice(0, 60)}`)
    out = out.replace(from, to)
  }
  return out
}
