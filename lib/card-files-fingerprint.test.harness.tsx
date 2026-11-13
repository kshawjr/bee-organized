// lib/card-files-fingerprint.test.harness.tsx
// Renders the client card and the job panel with fixed data at a fixed time,
// on the Overview tab and on the Timeline tab, and hashes the HTML of each —
// with ONE thing left out: the number beside the word "Files" on the tab
// strip. That number is the Files tab's own, and it is what changed.
//
// The "before" hashes in lib/__fixtures__/card-files.before.json were recorded
// by running this same file against commit 57331f8 — the cards as they stood
// when Files was still a placeholder. So a test can prove that everything on
// those cards OUTSIDE the Files tab renders byte for byte what it rendered
// then. Not a test file itself.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createHash } from 'node:crypto'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'

// Every date in the data is absolute, and the clock is pinned by the caller
// (vi.setSystemTime(FP_NOW)), so nothing here depends on today.
export const FP_NOW = new Date('2026-11-10T15:00:00Z')
const at = (day: string) => `2026-${day}T14:00:00Z`

const BUZZ = [{ id: 'b1', text: 'Gate code 4321 — call before arriving', user_label: 'Kevin', created_at: at('11-08') }]

const profile = () => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: '12 Hive Ln', city: 'Denver', state: 'CO', zip: '80014',
    created_at: at('10-01'), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: 'Garage overhaul', project_type: 'Client', location_name: 'Denver',
  },
  referred_us: [], contacts: [],
  engagements: [
    { id: 'eng-77', title: 'Pantry refresh', stage: 'Estimate', founded_by: 'request', created_at: at('10-31'), total_invoiced: 0, total_paid: 0, balance_owing: 0, quotes: [{ id: 'q1', status: 'sent', total: 900 }], jobs: [], invoices: [], assessments: [] },
    { id: 'eng-60', title: 'Garage', stage: 'Closed Won', founded_by: 'request', created_at: at('09-01'), closed_at: at('09-20'), total_invoiced: 4200, total_paid: 4200, balance_owing: 0, quotes: [], jobs: [], invoices: [], assessments: [] },
  ],
  touchpoints: [{ id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', status: 'no_answer', occurred_at: at('11-09'), engagement_id: 'eng-77', user_label: 'Kevin' }],
  buzz_notes: BUZZ,
  job_notes: [
    { id: 'jn1', text: 'Measured the garage', user_label: 'Kevin', created_at: at('11-07'), engagement_id: null },
    { id: 'jn2', text: 'Confirmed pantry scope', user_label: 'Kevin', created_at: at('11-08'), engagement_id: 'eng-77' },
  ],
  aggregates: { lifetime_paid: 4200, open_pipeline: 900, owing: 0, open_count: 1, total_count: 2 },
})

const engagement = () => ({
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: at('11-05'), stage_entered_at: at('11-05'), location_uuid: 'loc-uuid-1',
    project_type: 'Client', description: 'Full kitchen reorganization',
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
  },
  children: {
    service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [],
    notes: [{ id: 'en1', text: 'Client prefers mornings', user_label: 'Kevin', created_at: at('11-09') }],
    touchpoints: [],
  },
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
    request_details: null, source: 'Webform',
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: BUZZ, lifetime_paid: 4200, prior_engagements: 1, other_open: 0,
  },
})

const timeline = () => ({
  lead: { id: 'lead-9', snoozed_until: null, snoozed_note: null, welcome_email_scheduled_at: null, welcome_email_sent_at: null },
  touchpoints: [{ id: 'tt1', kind: 'system', method: 'system', label: 'Client created', occurred_at: at('10-01'), engagement_id: null }],
  notes: [], engagements: [], service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [], scheduled_stage_emails: [],
})
const drips = () => ({ items: [], drip_progress_id: null, drip_path_name: null, paused: false, stopped: false, completed: false, completed_at: null, stopped_at: null })

const json = (body: any) => ({ ok: true, status: 200, json: async () => body })

/** Canned answers for every read the two cards make. `files` is the client's file list. */
export function installCardFetch(files: any[] = []) {
  const asked: string[] = []
  ;(globalThis as any).fetch = async (url: any) => {
    const u = String(url)
    asked.push(u)
    if (u.includes('/api/client-files')) return json({ files })
    if (u.includes('/outreach-timeline')) return json(drips())
    if (u.includes('/api/leads/') && u.includes('/timeline')) return json(timeline())
    if (u.includes('/api/engagements/')) return json(engagement())
    if (u.includes('/api/partners')) return json([])
    if (u.includes('/profile')) return json(profile())
    return json({})
  }
  return asked
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** The card's HTML with the Files tab's own number taken out. */
export const withoutFilesCount = (html: string) =>
  html.replace(/(<button[^>]*aria-label="Files tab"[^>]*>Files)(<span[^>]*>[^<]*<\/span>)?/g, '$1')

const tab = (host: Element, label: string) =>
  Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === `${label} tab`) as HTMLElement

async function shoot(ui: React.ReactElement) {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  const overview = withoutFilesCount(host.innerHTML)
  await act(async () => { tab(host, 'Timeline').click() })
  await act(async () => { await Promise.resolve() })
  const timelineHtml = withoutFilesCount(host.innerHTML)
  await act(async () => root.unmount()); host.remove()
  return { overview, timeline: timelineHtml }
}

// The cards are plain .jsx: their props carry no types for tsc to check.
const Profile: any = ClientProfile
const Panel: any = EngagementPanel

export async function cardFingerprints(readOnly = false) {
  const p = await shoot(<Profile clientId="lead-9" onClose={() => {}} onSendToJobber={() => {}} readOnly={readOnly} />)
  const e = await shoot(<Panel engagementId="eng-1" onClose={() => {}} lookupOptions={{ sources: ['Webform'], projectTypes: ['Client'], closeLostReasons: [] }} readOnly={readOnly} />)
  return {
    profileOverview: sha(p.overview), profileTimeline: sha(p.timeline),
    panelOverview: sha(e.overview), panelTimeline: sha(e.timeline),
    // sizes, so "the hash matched" cannot mean "both rendered nothing"
    sizes: [p.overview.length, p.timeline.length, e.overview.length, e.timeline.length],
  }
}
