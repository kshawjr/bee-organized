// lib/mailchimp-flows.ts
//
// MAILCHIMP SLICE 6 (FL-75, 2026-11-25): which Mailchimp flows would send
// email because Bee Hub adds someone, or tags them. READ ONLY — every request
// here is a GET. The sending code (behind POST /api/mailchimp/sync) asks this right
// before it sends, every time; nothing here is saved or cached.
//
// WHY (tested live at Test Location, 2026-11-25): a contact added with the
// batch call starts a live "Contact signs up" journey within 5 seconds and is
// sent its email. Chattanooga's audience has two such journeys live (one had
// sent 416 welcome emails) and a third that starts when the tag CLOSEDJOB is
// added.
//
// KEVIN'S RULINGS (2026-11-25):
//   • Every flow that starts when a contact is added must be PAUSED. If any is
//     live, Bee Hub refuses to sync. Bee Hub sends its own welcome email.
//   • Read live from Mailchimp right before sending. If a flow changes between
//     the owner's look and the send, refuse and show them again.
//   • If Mailchimp can't be read, refuse. "Couldn't check" is never "nothing live".
//   • A tag that starts a live flow is never carried without the owner's yes,
//     one tag at a time.
//
// FAIL CLOSED, in three places:
//   • Status: a flow is "off" only when Mailchimp says paused or draft (classic
//     automations: paused or save). Any other status, known or not, is live.
//   • Trigger: a live flow that starts on a tag being added is a TAG flow (the
//     tag guard). Every other live flow — "signs up", or a start we don't
//     recognise, or one whose steps can't be read — must be paused.
//   • Reads: any request that fails after retries makes the whole answer
//     unreadable, and the sync refuses.

import { createHash } from 'crypto'
import { apiBase } from './mailchimp'
import { scrub } from './mailchimp-audience-look'

export type FlowKind = 'journey' | 'classic'

export type Flow = {
  kind: FlowKind
  id: string
  name: string
  status: string            // as Mailchimp says it
  live: boolean             // anything but paused/draft (classic: paused/save)
  start: 'signup' | 'tag' | 'other'
  startWords: string        // Mailchimp's own words for the start, e.g. "Contact signs up to …"
  tag: string | null        // for start 'tag': the tag's name (null if it could not be named)
  subjects: string[]        // subject lines of the emails it sends, from the steps already read (shown to the owner only)
}

export type FlowsRead =
  | { ok: false; reason: 'token_rejected' | 'audience_gone' | 'rate_limited' | 'request_failed' | 'mailchimp_error' | 'unreadable_flow'; detail: string }
  | {
      ok: true
      flows: Flow[]             // every journey and classic automation on THIS audience
      mustPause: Flow[]         // live, and not a tag flow — the sync refuses while any is here
      tagFlows: Flow[]          // live, starting on a tag being added
      signupFlows: Flow[]       // every flow (live or not) that is not a tag flow — named on the confirmation
      fingerprint: string       // changes when any flow on the audience changes state
    }

export type FlowFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; cache: 'no-store' }) =>
  Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

const OFF_JOURNEY = new Set(['paused', 'draft'])
const OFF_CLASSIC = new Set(['paused', 'save'])
const RETRIES = 3

// How an owner pauses one, in Mailchimp's words. Kept general on purpose:
// Mailchimp renames its menus; the flow's own name is what they look for.
export const HOW_TO_PAUSE =
  'In Mailchimp, go to Automations, open the flow by its name, and choose Pause. Then come back and press Check again.'

function failureFor(status: number) {
  if (status === 401 || status === 403) return 'token_rejected' as const
  if (status === 404) return 'audience_gone' as const
  if (status === 429) return 'rate_limited' as const
  return 'mailchimp_error' as const
}

export async function readFlows(args: {
  token: string
  serverPrefix: string
  listId: string
  fetchImpl?: FlowFetch
  sleep?: (ms: number) => Promise<void>
}): Promise<FlowsRead> {
  const { token, serverPrefix, listId } = args
  const doFetch: FlowFetch = args.fetchImpl || ((url, init) => fetch(url, init) as any)
  const sleep = args.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const base = apiBase(serverPrefix)

  class ReadFail extends Error { constructor(public reason: any, public detail: string) { super(detail) } }

  const get = async (path: string): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<FlowFetch>>
      try {
        res = await doFetch(base + path, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      } catch (err: any) {
        if (attempt < RETRIES) { await sleep(1000 * 2 ** attempt); continue }
        throw new ReadFail('request_failed', scrub(err?.message || err, token))
      }
      const text = await res.text().catch(() => '')
      let body: any = null
      try { body = JSON.parse(text) } catch { body = { detail: text.slice(0, 200) } }
      if (res.status >= 200 && res.status < 300) return body
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        const after = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt)
        continue
      }
      throw new ReadFail(failureFor(res.status), scrub(body?.detail || body?.title || `http ${res.status}`, token))
    }
  }

  // Every page of a list endpoint. A total that cannot be read is a failure,
  // never "that's all of them".
  const getAll = async (path: string, key: string): Promise<any[]> => {
    const out: any[] = []
    for (let offset = 0; ; offset += 100) {
      const sep = path.includes('?') ? '&' : '?'
      const body = await get(`${path}${sep}count=100&offset=${offset}`)
      const rows = Array.isArray(body?.[key]) ? body[key] : null
      const total = Number(body?.total_items)
      if (!rows || !Number.isFinite(total)) throw new ReadFail('mailchimp_error', `Mailchimp's answer for ${path.split('?')[0]} had no list`)
      out.push(...rows)
      if (rows.length === 0 || out.length >= total) return out
    }
  }

  try {
    const flows: Flow[] = []

    // 1. Journeys ("Flows" / Customer Journeys) on this audience, with their start step.
    const journeys = (await getAll('customer-journeys/journeys', 'journeys')).filter((j) => String(j?.list_id || '') === listId)
    const tagIds = new Set<string>()
    const pending: Array<{ j: any; trigger: any | null; steps: any[] }> = []
    for (const j of journeys) {
      const steps = await get(`customer-journeys/journeys/${encodeURIComponent(String(j.id))}/steps`)
      const list = Array.isArray(steps?.steps) ? steps.steps : null
      if (!list) throw new ReadFail('unreadable_flow', `The steps of the flow "${String(j?.journey_name || j.id)}" could not be read`)
      const trigger = list.find((s: any) => String(s?.step_type || '').startsWith('trigger')) || null
      if (trigger && String(trigger.step_type) === 'trigger-tag_added' && trigger?.trigger_settings?.tag_id != null) tagIds.add(String(trigger.trigger_settings.tag_id))
      pending.push({ j, trigger, steps: list })
    }

    // Tag flows name their tag by id; the tag's name is a static segment's name.
    const tagName = new Map<string, string>()
    if (tagIds.size) {
      for (const s of await getAll(`lists/${encodeURIComponent(listId)}/segments?type=static&fields=segments.id,segments.name,total_items`, 'segments')) {
        tagName.set(String(s.id), String(s.name || ''))
      }
    }

    for (const { j, trigger, steps } of pending) {
      const status = String(j?.status || 'unknown')
      const stepType = String(trigger?.step_type || '')
      const isTag = stepType === 'trigger-tag_added'
      const isSignup = stepType === 'trigger' && String(trigger?.trigger_type || '') === 'signup'
      const tag = isTag ? (tagName.get(String(trigger?.trigger_settings?.tag_id)) || null) : null
      flows.push({
        kind: 'journey',
        id: String(j.id),
        name: String(j?.journey_name || `Flow ${j.id}`),
        status,
        live: !OFF_JOURNEY.has(status),
        // A tag flow whose tag cannot be named cannot be guarded: treat it as
        // a flow that must be paused instead.
        start: isTag && tag ? 'tag' : isSignup ? 'signup' : 'other',
        startWords: [trigger?.display_text, trigger?.display_subtext].filter(Boolean).join('').trim() || (trigger ? stepType : 'start step not found'),
        tag,
        subjects: subjectsOf(steps),
      })
    }

    // 2. Classic automations on this audience. Mailchimp no longer offers new
    // ones, but old ones still run; any live one must be paused.
    const classic = (await getAll('automations?fields=automations.id,automations.status,automations.settings.title,automations.recipients.list_id,automations.trigger_settings.workflow_type,total_items', 'automations'))
      .filter((a) => String(a?.recipients?.list_id || '') === listId)
    for (const a of classic) {
      const status = String(a?.status || 'unknown')
      flows.push({
        kind: 'classic', id: String(a.id), name: String(a?.settings?.title || `Automation ${a.id}`), status,
        live: !OFF_CLASSIC.has(status), start: String(a?.trigger_settings?.workflow_type || '') === 'welcomeSeries' ? 'signup' : 'other',
        startWords: String(a?.trigger_settings?.workflow_type || 'unknown start'), tag: null, subjects: [],
      })
    }

    flows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    return {
      ok: true,
      flows,
      mustPause: flows.filter((f) => f.live && f.start !== 'tag'),
      tagFlows: flows.filter((f) => f.live && f.start === 'tag'),
      signupFlows: flows.filter((f) => f.start !== 'tag'),
      fingerprint: flowsFingerprint(flows),
    }
  } catch (err: any) {
    if (err instanceof ReadFail) return { ok: false, reason: err.reason, detail: err.detail }
    return { ok: false, reason: 'request_failed', detail: scrub(err?.message || err, token) }
  }
}

// The subject line of every email a journey sends, in step order, as Mailchimp
// returns them inside the steps (action_details.email.settings.subject_line).
// For the owner's eyes only; never part of the fingerprint.
function subjectsOf(steps: any[]): string[] {
  const out: string[] = []
  for (const s of steps) {
    if (String(s?.step_type || '') !== 'action-send_email') continue
    const subj = String(s?.action_details?.email?.settings?.subject_line || '').trim()
    if (subj && !out.includes(subj)) out.push(subj)
  }
  return out
}

// Changes when any flow on the audience appears, goes, is renamed, changes
// status, or changes what it starts on.
export function flowsFingerprint(flows: readonly Flow[]): string {
  const lines = flows.map((f) => [f.kind, f.id, f.name, f.status, f.start, f.tag || ''].join('|')).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

export const FLOWS_UNREADABLE_WORDS =
  'Bee Hub could not check your Mailchimp flows, so nothing was sent. A flow that sends email when someone is added might be on. Please try again in a few minutes.'
