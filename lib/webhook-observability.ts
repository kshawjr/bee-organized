// lib/webhook-observability.ts
// ─────────────────────────────────────────────────────────────
// Read-side enrichment for the admin webhook dashboard and the
// twice-daily Slack failure digest.
//
// sync_log rows are write-once strings (see lib/sync-log.ts + the
// webhook dispatcher in app/api/webhooks/jobber/route.ts) — the topic,
// lead id, stage transition, and error all live inside `message`.
// parseSyncLogMessage() recovers them; nothing here changes what the
// webhook path writes.
//
// "Landed" is RECORDED at processing time: the dispatcher runs
// lib/webhook-landed.ts checkLanded() at the end of every handler and
// stores the verdict in sync_log.landed_status (see the LANDED RULES
// header in that file for what "landed correctly" means per topic).
// This module just maps the stored value onto the dashboard's
// three-state indicator:
//   'landed'     → 'landed'  (✓)
//   'not_landed' → 'stuck'   (▲ amber — processed without error but the
//                             record never reached its intended state)
//   'na' / NULL  → null      ('—': processed-only events, errored rows,
//                             and rows written before the
//                             sync_log_landed_status.sql migration)
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { extractJobberId } from './jobber-import'

// ── message parsing ───────────────────────────────────────────

export type ParsedSyncLogMessage = {
  topic: string | null
  skipped: boolean          // "[skipped] unknown topic=X" rows
  itemRaw: string | null    // item=… as written (b64 global id or numeric)
  leadId: string | null     // lead=<uuid> when the handler resolved one
  stageFrom: string | null  // "(stage A → B)" when the lead stage moved
  stageTo: string | null
  error: string | null      // error=… (runs to " — " or end of message)
  note: string | null       // trailing " — …" note
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSyncLogMessage(message: string): ParsedSyncLogMessage {
  const skippedMatch = message.match(/^\[skipped\] unknown topic=(\S+)/)
  if (skippedMatch) {
    return {
      topic: skippedMatch[1], skipped: true, itemRaw: null, leadId: null,
      stageFrom: null, stageTo: null, error: null, note: null,
    }
  }
  const topic     = message.match(/(?:^|\s)topic=(\S+)/)?.[1] || null
  const itemRaw   = message.match(/(?:^|\s)item=(\S+)/)?.[1] || null
  const leadRaw   = message.match(/(?:^|\s)lead=(\S+)/)?.[1] || null
  const stage     = message.match(/\(stage (.+?) → (.+?)\)/)
  // error text runs until the " — note" separator or end of message.
  const error     = message.match(/(?:^|\s)error=([\s\S]+?)(?= — |$)/)?.[1] || null
  const note      = message.match(/ — ([\s\S]+)$/)?.[1] || null
  return {
    topic,
    skipped: false,
    itemRaw,
    leadId: leadRaw && UUID_RE.test(leadRaw) ? leadRaw : null,
    stageFrom: stage?.[1] || null,
    stageTo: stage?.[2] || null,
    error,
    note,
  }
}

// ── topic metadata ────────────────────────────────────────────

export const TOPIC_FRIENDLY: Record<string, string> = {
  REQUEST_CREATE:     'Request created',
  REQUEST_UPDATE:     'Request updated',
  REQUEST_DESTROY:    'Request deleted',
  QUOTE_CREATE:       'Quote created',
  QUOTE_UPDATE:       'Quote updated',
  QUOTE_SENT:         'Quote sent',
  QUOTE_APPROVED:     'Quote approved',
  QUOTE_DESTROY:      'Quote deleted',
  JOB_CREATE:         'Job created',
  JOB_UPDATE:         'Job updated',
  JOB_COMPLETE:       'Job completed',
  JOB_DESTROY:        'Job deleted',
  INVOICE_CREATE:     'Invoice created',
  INVOICE_PAID:       'Invoice paid',
  INVOICE_DESTROY:    'Invoice deleted',
  CLIENT_UPDATE:      'Client updated',
  CLIENT_DESTROY:     'Client deleted',
  PROPERTY_CREATE:    'Property added',
  PROPERTY_UPDATE:    'Property updated',
  PROPERTY_DESTROY:   'Property deleted',
  ASSESSMENT_DESTROY: 'Assessment deleted',
  APP_DISCONNECT:     'App disconnected',
  // Capture-everything rows from the dispatcher's pre-handler paths:
  UNPARSEABLE:        'Unparseable event',
  UNKNOWN:            'Unknown event',
  // Inbound lead intake (app/api/leads/intake) — not a Jobber webhook,
  // but the same silent-failure class rides the same log + digest.
  LEAD_INTAKE:        'Lead intake',
}

export function friendlyTopic(topic: string | null, skipped: boolean): string {
  if (!topic) return 'Sync note'
  if (skipped) return `Ignored (${topic})`
  return TOPIC_FRIENDLY[topic] || topic
}

// ── landed mapping (stored column → dashboard indicator) ──────

export type Landed = 'landed' | 'stuck' | null

export function mapLandedStatus(stored: string | null | undefined): Landed {
  if (stored === 'landed') return 'landed'
  if (stored === 'not_landed') return 'stuck'
  return null // 'na' + pre-migration NULL rows both render "—"
}

// ── enriched event shape ──────────────────────────────────────

export type WebhookLogEvent = {
  id: string
  created_at: string
  topic: string | null
  friendly: string
  skipped: boolean
  processed: boolean          // sync_log.status === 'success'
  error: string | null
  landed: Landed              // null = N/A ("—")
  client_name: string | null
  lead_id: string | null
  location_id: string | null  // slug; null = event we couldn't scope
  location_name: string | null
  jobber_item: string | null  // numeric Jobber id (search target)
  stage_from: string | null
  stage_to: string | null
  message: string
}

// '12h' exists for the Slack digest cron; the dashboard pills only
// offer 24h/7d/30d/all.
export type FetchWindow = '12h' | '24h' | '7d' | '30d' | 'all'

export const WINDOW_MS: Record<Exclude<FetchWindow, 'all'>, number> = {
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const FETCH_CAP = 1000

// Which subrecord table a topic resolves client names through. Fetched
// for EVERY quote/job/invoice/request topic: a failed QUOTE_UPDATE still
// resolves to a client name through the quotes row's lead_id, which is
// what makes failures searchable by name.
function topicSubTable(topic: string): {
  table: 'service_requests' | 'quotes' | 'jobs' | 'invoices'
  idCol: 'jobber_request_id' | 'jobber_quote_id' | 'jobber_job_id' | 'jobber_invoice_id'
} | null {
  if (topic.startsWith('REQUEST_'))
    return { table: 'service_requests', idCol: 'jobber_request_id' }
  if (topic.startsWith('QUOTE_'))
    return { table: 'quotes', idCol: 'jobber_quote_id' }
  if (topic.startsWith('JOB_'))
    return { table: 'jobs', idCol: 'jobber_job_id' }
  if (topic.startsWith('INVOICE_'))
    return { table: 'invoices', idCol: 'jobber_invoice_id' }
  return null
}

// Fetch sync_log rows in the window and enrich each into a
// WebhookLogEvent: parse the message, resolve client name + location
// name, and map the recorded landed_status. Non-webhook rows
// (engagement founding breadcrumbs, outbound syncs — anything without
// a parseable topic) are dropped.
export async function fetchWebhookLogEvents(opts: {
  window: FetchWindow
  locationId?: string | null
  limit?: number
} = { window: '7d' }): Promise<{ events: WebhookLogEvent[]; truncated: boolean }> {
  const limit = Math.min(opts.limit ?? FETCH_CAP, FETCH_CAP)

  let query = supabaseService
    .from('sync_log')
    .select('id, location_id, entity_id, entity_type, jobber_record_id, status, message, created_at, landed_status')
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (opts.window !== 'all') {
    const since = new Date(Date.now() - WINDOW_MS[opts.window]).toISOString()
    query = query.gte('created_at', since)
  }
  if (opts.locationId) query = query.eq('location_id', opts.locationId)

  const { data: rows, error } = await query
  if (error) throw new Error(`sync_log read: ${error.message}`)
  const truncated = (rows?.length ?? 0) >= limit

  type Working = {
    row: NonNullable<typeof rows>[number]
    parsed: ParsedSyncLogMessage
    numericId: string | null
  }
  const working: Working[] = (rows || [])
    .map(row => ({
      row,
      parsed: parseSyncLogMessage(row.message || ''),
      numericId: extractJobberId(row.jobber_record_id || '') || null,
    }))
    .filter(w => !!w.parsed.topic)

  // ── batch subrecord lookups (client-name resolution) ────────
  const subIds: Record<string, Set<string>> = {}
  for (const w of working) {
    const topic = w.parsed.topic!
    if (!w.numericId) continue
    const spec = topicSubTable(topic)
    if (!spec) continue
    ;(subIds[spec.table] ||= new Set()).add(w.numericId)
  }

  // sub[table][numericJobberId] → { lead_id }
  const sub: Record<string, Map<string, any>> = {}
  await Promise.all(
    Object.entries(subIds).map(async ([table, ids]) => {
      const idCol =
        table === 'service_requests' ? 'jobber_request_id'
        : table === 'quotes' ? 'jobber_quote_id'
        : table === 'jobs' ? 'jobber_job_id'
        : 'jobber_invoice_id'
      const { data } = await supabaseService
        .from(table)
        .select(`${idCol}, lead_id`)
        .in(idCol, Array.from(ids))
      const map = new Map<string, any>()
      for (const r of (data as any[]) || []) map.set(String(r[idCol]), r)
      sub[table] = map
    }),
  )

  // ── leads for client names ──────────────────────────────────
  const leadIds = new Set<string>()
  for (const w of working) {
    if (w.parsed.leadId) leadIds.add(w.parsed.leadId)
    else if (UUID_RE.test(w.row.entity_id || '')) leadIds.add(w.row.entity_id)
  }
  Object.values(sub).forEach(map => {
    map.forEach(r => { if (r.lead_id) leadIds.add(r.lead_id) })
  })
  const leadName = new Map<string, string>()
  if (leadIds.size) {
    const { data } = await supabaseService
      .from('leads')
      .select('id, name')
      .in('id', Array.from(leadIds))
    for (const l of data || []) leadName.set(l.id, l.name || '')
  }

  // ── location names ──────────────────────────────────────────
  const { data: locs } = await supabaseService
    .from('locations')
    .select('location_id, name')
  const locName = new Map<string, string>()
  for (const l of locs || []) locName.set(l.location_id, l.name || l.location_id)

  // ── compose ─────────────────────────────────────────────────
  const events: WebhookLogEvent[] = working.map(({ row, parsed, numericId }) => {
    const topic = parsed.topic!
    const spec = topicSubTable(topic)
    const subRow = spec && numericId ? sub[spec.table]?.get(numericId) || null : null

    const leadId =
      parsed.leadId ||
      (UUID_RE.test(row.entity_id || '') ? row.entity_id : null) ||
      subRow?.lead_id ||
      null

    return {
      id: row.id,
      created_at: row.created_at,
      topic,
      friendly: friendlyTopic(topic, parsed.skipped),
      skipped: parsed.skipped,
      processed: row.status === 'success',
      error: parsed.error,
      landed: mapLandedStatus((row as any).landed_status),
      client_name: leadId ? leadName.get(leadId) || null : null,
      lead_id: leadId,
      location_id: row.location_id || null,
      location_name: row.location_id
        ? locName.get(row.location_id) || null
        : 'Unknown account',
      jobber_item: numericId,
      stage_from: parsed.stageFrom,
      stage_to: parsed.stageTo,
      message: row.message || '',
    }
  })

  return { events, truncated }
}
