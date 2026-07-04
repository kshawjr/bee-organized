// lib/people-mapper.ts
//
// Maps Supabase rows (leads + joined tables) into the Person shape that
// components/BeeHub.jsx consumes. Centralized here so both initial-hydration
// (in app/page.tsx) and any future refetch path can use the same logic.

type LeadRow = {
  id: string
  location_uuid: string | null
  location_id: string
  assigned_to: string | null
  name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  stage: string | null
  source: string | null
  project_type: string | null
  is_junk: boolean | null
  drip_path: string | null
  move_drip_path: string | null
  final_processed: boolean | null
  final_processed_at: string | null
  closed_lost_reason: string | null
  closed_lost_note: string | null
  referred_by_kind: string | null
  referred_by_id: string | null
  addresses: any
  jobber_client_id: string | null
  jobber_synced_at: string | null
  paid_amount?: number | null
  invoice_paid_at?: string | null
  created_at: string | null
  updated_at: string | null
  request_details: string | null
  snoozed_until: string | null
  snoozed_note: string | null
  marketing_opt_out: boolean | null
  paused: boolean | null
  drip_last_send_status: string | null
  drip_last_send_at: string | null
  drip_last_send_step: number | null
  drip_last_send_error: string | null
}

// Joined data — all optional. Anything passed populates richer Person fields.
type JoinedData = {
  lead_notes?: any[]
  touchpoints?: any[]
  lead_contacts?: any[]
  lead_tags?: any[]
  assessments?: any[]
  service_requests?: any[]
  quotes?: any[]
  jobs?: any[]
  invoices?: any[]
  // Lookup table for tag IDs → tag definitions (id, label, color, etc.)
  tag_lookups?: Record<string, any>
}

function fmtCreatedShort(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${months[d.getMonth()]} ${d.getDate()}`
  } catch {
    return ''
  }
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    let hours = d.getHours()
    const minutes = String(d.getMinutes()).padStart(2, '0')
    const ampm = hours >= 12 ? 'PM' : 'AM'
    hours = hours % 12 || 12
    return `${months[d.getMonth()]} ${d.getDate()} at ${hours}:${minutes} ${ampm}`
  } catch {
    return ''
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
  } catch {
    return ''
  }
}

// DB invoice statuses (lowercase, written by lib/jobber-import.ts) → the
// capitalized labels BeeHub.jsx compares against and keys INVOICE_STATUS on.
const INVOICE_STATUS_LABELS: Record<string, string> = {
  paid: 'Paid',
  partial: 'Partial',
  sent: 'Awaiting Payment',
  bad_debt: 'Bad Debt',
  draft: 'Draft',
  void: 'Void',
}

export function mapLeadToPerson(row: LeadRow, joined: JoinedData = {}) {
  // Addresses
  const addresses = Array.isArray(row.addresses) ? row.addresses : []
  const legacyAddr = addresses.length === 0 && row.address
    ? [{ type: 'Service', value: row.address, street: row.address, city: row.city || '', state: row.state || '', zip: row.zip || '' }]
    : []
  const finalAddresses = addresses.length > 0 ? addresses : legacyAddr

  // Notes — split by kind
  const allNotes = joined.lead_notes || []
  const buzzNotes = allNotes.filter(n => n.kind === 'buzz').map(n => ({
    id: n.id,
    text: n.text,
    ts: fmtCreatedShort(n.created_at),
    created_at: n.created_at, // raw — the beta BuzzDrawer ages it live
    user: n.user_label || 'Unknown',
  }))
  const jobNotes = allNotes.filter(n => n.kind === 'job').map(n => ({
    id: n.id,
    text: n.text,
    ts: fmtCreatedShort(n.created_at),
    user: n.user_label || 'Unknown',
  }))
  const closeNotes = allNotes.filter(n => n.kind === 'close').map(n => ({
    id: n.id,
    text: n.text,
    ts: fmtCreatedShort(n.created_at),
    user: n.user_label || 'Unknown',
  }))

  // Touchpoints → split into outreachTimeline (everything) + activity (system events)
  const allTouchpoints = (joined.touchpoints || []).slice().sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  )
  const outreachTimeline = allTouchpoints.map(t => ({
    id: t.id,
    type: t.kind,
    method: t.method,
    label: t.label,
    ts: fmtDateTime(t.occurred_at),
    // Raw ISO for accurate sorting alongside drip items (which come from
    // the API as ISO). `ts` is the human-readable display string.
    occurred_at: t.occurred_at,
    status: t.status || 'done',
  }))
  const activity = allTouchpoints
    .filter(t => t.kind === 'system' || t.kind === 'stage_change')
    .map(t => ({
      type: t.kind,
      text: t.label,
      ts: fmtDateTime(t.occurred_at),
    }))

  // Reach-out method = most recent reach_out touchpoint's method
  const lastReachOut = [...allTouchpoints].reverse().find(t => t.kind === 'reach_out')
  const reachOutMethod = lastReachOut?.method || null

  // Job contacts
  const jobContacts = (joined.lead_contacts || []).map(c => ({
    id: c.id,
    name: c.name,
    role: c.role || '',
    phone: c.phone || '',
    email: c.email || '',
  }))

  // Tags — junction row gives us tag_lookup_id; resolve via tag_lookups
  const tags = (joined.lead_tags || [])
    .map(lt => {
      const def = joined.tag_lookups?.[lt.tag_lookup_id]
      if (!def) return null
      // Tag ID format must match what BeeHub expects (from ALL_TAGS list).
      // Lookups have attrs.key for the tag ID, fall back to lookup id.
      return def.attrs?.key || def.id
    })
    .filter(Boolean)

  // Assessment — most recent
  const assessmentRow = (joined.assessments || [])
    .slice()
    .sort((a, b) => new Date(b.scheduled_at || b.created_at).getTime() - new Date(a.scheduled_at || a.created_at).getTime())[0]
  const assessment = assessmentRow?.scheduled_at ? fmtDateTime(assessmentRow.scheduled_at) : null
  const assessmentType = null // Schema doesn't have a type column yet

  // Estimate sent — most recent quote
  const quoteRow = (joined.quotes || [])
    .slice()
    .sort((a, b) => new Date(b.sent_at || b.created_at).getTime() - new Date(a.sent_at || a.created_at).getTime())[0]
  const estimateSent = quoteRow ? fmtDate(quoteRow.sent_at || quoteRow.created_at) : null
  const estimateApproved = quoteRow?.approved_at ? fmtDate(quoteRow.approved_at) : null

  // Most recent service_request — drives Assessment milestone hyperlinks
  // (assessments don't have their own URL; they live on the parent request).
  const requestRow = (joined.service_requests || [])
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

  // Jobs
  const jobs = (joined.jobs || []).map(j => ({
    id: j.id,
    title: j.title || 'Job',
    status: j.status || 'pending',
    scheduledStart: j.scheduled_start ? fmtDate(j.scheduled_start) : null,
    total: j.total || 0,
    jobberRef: j.jobber_job_id || null,
  }))

  // Invoices — components/BeeHub.jsx (INVOICE_STATUS map, PersonPanel,
  // InvoicePopup) speaks the capitalized mock-data vocabulary and reads
  // `number`/`date`/`paidDate`/`dueDate`. DB stays lowercase; this mapping
  // is the single normalization point.
  const invoices = (joined.invoices || []).map(inv => ({
    id: inv.id,
    amount: inv.total || 0,
    paidAmount: inv.paid_amount || 0,
    balance: inv.balance_owing || 0,
    status: INVOICE_STATUS_LABELS[(inv.status || '').toLowerCase()] || inv.status || 'Draft',
    issuedAt: inv.issued_at ? fmtDate(inv.issued_at) : null,
    paidAt: inv.paid_at ? fmtDate(inv.paid_at) : null,
    invoiceUrl: inv.invoice_url || null,
    jobberRef: inv.jobber_invoice_id || null,
    // Compat aliases — raw ISO dates: BeeHub's fmtDate formats ISO input
    // and passes through anything already formatted.
    number: `INV-${String(inv.jobber_invoice_id || inv.id).slice(-6).toUpperCase()}`,
    date: inv.issued_at || null,
    paidDate: inv.paid_at || null,
    dueDate: null, // not imported from Jobber
  }))

  return {
    id: row.id,
    assignedTo: row.assigned_to,
    locationId: row.location_uuid || row.location_id, // UUID matches BeeHub's locFilter
    name: row.name || [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || '(unnamed)',
    phone: row.phone || '',
    email: row.email || '',
    address: finalAddresses[0]?.value || row.address || '',
    addresses: finalAddresses,
    stage: row.stage || 'New',
    source: row.source || '',
    project: row.project_type || '',
    // Raw ISO — components/BeeHub.jsx `fmtCreated` formats this in the
    // browser's local TZ. Earlier we passed `fmtCreatedShort` output
    // ("May 24") which lost the time and forced a hash-derived fake.
    created: row.created_at || '',
    tags,
    isJunk: row.is_junk || false,
    finalProcessed: row.final_processed || false,
    referredBy: row.referred_by_id || null,
    referredByKind: row.referred_by_kind || null,
    path: row.drip_path || null,
    moveDripPath: row.move_drip_path || null,
    closedLostReason: row.closed_lost_reason || null,
    closedLostNote: row.closed_lost_note || null,
    jobberRef: row.jobber_client_id || null,
    jobberClient: null,
    jobberSearchStatus: row.jobber_client_id ? 'found' : 'not_found',
    // Derived refs for Journey milestone hyperlinks
    requestRef: requestRow?.jobber_request_id || null,
    quoteRef: quoteRow?.jobber_quote_id || null,
    buzzNotes,
    jobNotes,
    closeNotes,
    jobContacts,
    outreachTimeline,
    activity,
    jobs,
    invoices,
    // Lead-row payment roll-ups (written by the bulk import alongside the
    // invoice rows) — financials fallback when invoice child rows are absent.
    paidAmount: row.paid_amount ?? null,
    invoicePaidAt: row.invoice_paid_at || null,
    assessment,
    assessmentType,
    estimateSent,
    estimateApproved,
    reachOutMethod,
    jobDetail: row.request_details || '',
    snoozeUntil: row.snoozed_until || null,
    snoozeNote: row.snoozed_note || '',
    marketingOptOut: !!row.marketing_opt_out,
    paused: !!row.paused,
    // Last drip-step send outcome — surfaced in PersonPanel so silent
    // failures (missing sender config / Resend errors) are visible.
    dripLastSendStatus: row.drip_last_send_status || null,
    dripLastSendAt: row.drip_last_send_at || null,
    dripLastSendStep: row.drip_last_send_step ?? null,
    dripLastSendError: row.drip_last_send_error || null,
  }
}