// lib/client-list-fingerprint.test.harness.tsx
// Renders the Client List for a location whose clients ALL loaded, and hashes
// the HTML — collapsed, and with every band open. The "before" hashes in
// lib/__fixtures__/client-list-complete.before.json were recorded from the
// component as it stood at 54dfb5a (before Show more existed), so a test can
// prove that such a location renders byte-for-byte what it rendered then.
// Not a test file itself. Nothing in the fixture depends on today's date.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createHash } from 'node:crypto'
import ClientGroupedList from '@/components/hive/ClientGroupedList'

export const FP_LOC = '11111111-1111-4111-8111-111111111111'
const TAG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const person = (id: string, name: string, over: any = {}) => ({
  id, name, email: `${id}@x.com`, phone: '610-555-0000', locationId: FP_LOC, created: '2024-03-01T10:00:00+00:00',
  tagIds: [], outreachTimeline: [], importSource: 'jobber_initial', ...over,
})
export const completeLoadPeople = () => [
  person('n1', 'Zed Nurture'),
  person('n2', 'Abel Nurture', { tagIds: [TAG] }),
  person('n3', 'Mona Nurture'),
  person('c1', 'Cora Client', { wonEngagements: { count: 1, value: 800, lastClosedAt: '2024-06-01T10:00:00+00:00' } }),
  person('a1', 'Avi Active'),
  person('x1', 'Nix Nocontact', { email: '', phone: '' }),
  person('p1', 'Pat Past', { paidAmount: 300 }),
]
export const completeLoadProps = (): any => ({
  people: completeLoadPeople(),
  engagements: [{ id: 'e1', client_id: 'a1', stage: 'Request', location_uuid: FP_LOC }],
  locFilter: FP_LOC, locations: [{ id: FP_LOC, name: 'Smallville' }], tags: [{ id: TAG, label: 'Realtor' }],
  searchLocationId: FP_LOC, leadsTruncated: false, clientsCutoff: null,
})
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export async function completeLoadFingerprints(): Promise<{ collapsed: string; expanded: string; rows: number }> {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<ClientGroupedList {...completeLoadProps()} />) })
  await act(async () => { await Promise.resolve() })
  const collapsed = sha(host.innerHTML)
  // open every band, the way a person does
  for (const h of Array.from(host.querySelectorAll('[role="button"][aria-expanded="false"]'))) {
    await act(async () => { (h as HTMLElement).click() })
  }
  await act(async () => { await Promise.resolve() })
  const expanded = sha(host.innerHTML)
  const rows = host.querySelectorAll('.bee-grp-row').length
  await act(async () => root.unmount()); host.remove()
  return { collapsed, expanded, rows }
}
