// app/api/jobber/webhook/route.ts
// ─────────────────────────────────────────────────────────────
// Receives Jobber webhook events and syncs to Supabase + Zoho.
// Jobber sends: topic + accountId + itemId
// We verify signature, find location, query full entity, upsert.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createHmac }                from 'crypto'
import { jobberQuery, getValidJobberToken } from '@/lib/jobber'
import { supabaseService }           from '@/lib/supabase-service'
import { writeSyncLog }              from '@/lib/sync-log'

// ── Jobber entity queries ─────────────────────────────────────

const CLIENT_QUERY = `
  query GetClient($id: ID!) {
    client(id: $id) {
      id firstName lastName companyName createdAt
      emails { address primary }
      phones  { number  primary }
      billingAddress { street city province postalCode }
    }
  }
`

const REQUEST_QUERY = `
  query GetRequest($id: ID!) {
    request(id: $id) {
      id createdAt jobberWebUri
      client { id }
      assessment { startAt }
    }
  }
`

const QUOTE_QUERY = `
  query GetQuote($id: ID!) {
    quote(id: $id) {
      id createdAt jobberWebUri
      request { id }
      amounts { subtotal taxAmount discountAmount total }
    }
  }
`

const JOB_QUERY = `
  query GetJob($id: ID!) {
    job(id: $id) {
      id createdAt jobberWebUri title jobStatus startAt completedAt total
      request { id }
    }
  }
`

const INVOICE_QUERY = `
  query GetInvoice($id: ID!) {
    invoice(id: $id) {
      id createdAt jobberWebUri
      job { nodes { id } }
      amounts { subtotal taxAmount discountAmount total }
    }
  }
`

// ── Signature verification ────────────────────────────────────

function verifySignature(body: string, signature: string | null): boolean {
  if (!signature) return false
  const secret = process.env.JOBBER_CLIENT_SECRET
  if (!secret) return false

  // Jobber signs with client secret as string, digest as base64
  const expectedBase64 = createHmac('sha256', secret).update(body).digest('base64')
  if (signature === expectedBase64) return true

  // Also try with secret decoded from hex (raw bytes)
  try {
    const secretBytes = Buffer.from(secret, 'hex')
    const expectedHexBytes = createHmac('sha256', secretBytes).update(body).digest('base64')
    if (signature === expectedHexBytes) return true
  } catch {}

  // Try hex digest
  const expectedHex = createHmac('sha256', secret).update(body).digest('hex')
  if (signature === expectedHex) return true

  console.log('[webhook] Signature debug — received:', signature)
  console.log('[webhook] Expected (base64/string):', expectedBase64)
  return false
}

// ── Find location by Jobber account ID ───────────────────────

async function getLocationByAccountId(accountId: string) {
  const { data } = await supabaseService
    .from('locations')
    .select('*')
    .eq('jobber_account_id', accountId)
    .single()
  return data
}

// ── Route handler ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body      = await req.text()
  const signature = req.headers.get('x-jobber-hmac-sha256')

  // Verify webhook signature
  if (!verifySignature(body, signature)) {
    console.warn('[webhook] Invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const event = payload.webHookEvent
  if (!event) return NextResponse.json({ ok: true }) // ignore unknown format

  const { topic, accountId, itemId } = event
  console.log(`[webhook] ${topic} — account: ${accountId} — item: ${itemId}`)

  // Find location by Jobber account ID
  const location = await getLocationByAccountId(accountId)
  if (!location) {
    console.warn(`[webhook] No location found for account ${accountId}`)
    return NextResponse.json({ ok: true }) // acknowledge but skip
  }

  // Get valid token for this location
  let jobberToken: string
  try {
    jobberToken = await getValidJobberToken(location)
  } catch (err: any) {
    console.error(`[webhook] Token error for ${location.location_id}:`, err.message)
    return NextResponse.json({ ok: true })
  }

  // Route to handler based on topic
  try {
    switch (topic) {
      case 'CLIENT_CREATE':
      case 'CLIENT_UPDATE':
        await handleClient(itemId, location, jobberToken)
        break

      case 'REQUEST_CREATE':
      case 'REQUEST_UPDATE':
        await handleRequest(itemId, location, jobberToken)
        break

      case 'QUOTE_CREATE':
      case 'QUOTE_UPDATE':
      case 'QUOTE_APPROVED':
        await handleQuote(itemId, location, jobberToken)
        break

      case 'JOB_CREATE':
      case 'JOB_UPDATE':
      case 'JOB_COMPLETE':
        await handleJob(itemId, location, jobberToken)
        break

      case 'INVOICE_CREATE':
      case 'INVOICE_SENT':
      case 'INVOICE_PAID':
        await handleInvoice(itemId, location, jobberToken)
        break

      default:
        console.log(`[webhook] Unhandled topic: ${topic}`)
    }

    await writeSyncLog({
      location_id: location.location_id,
      entity_id:   itemId,
      status:      'success',
      message:     `Webhook: ${topic}`,
    })
  } catch (err: any) {
    console.error(`[webhook] Handler error for ${topic}:`, err.message)
    await writeSyncLog({
      location_id: location.location_id,
      entity_id:   itemId,
      status:      'error',
      message:     `Webhook ${topic} failed: ${err.message}`,
    })
  }

  // Always return 200 — Jobber retries on non-200
  return NextResponse.json({ ok: true })
}

// ── Handlers ──────────────────────────────────────────────────

async function handleClient(itemId: string, location: any, token: string) {
  const res = await jobberQuery(token, CLIENT_QUERY, { id: itemId })
  const client = res.data?.client
  if (!client) return

  const email = client.emails?.find((e: any) => e.primary)?.address ?? client.emails?.[0]?.address ?? null
  const phone = client.phones?.find((p: any) => p.primary)?.number  ?? client.phones?.[0]?.number  ?? null
  const addr  = client.billingAddress
    ? [client.billingAddress.street, client.billingAddress.city, client.billingAddress.province, client.billingAddress.postalCode].filter(Boolean).join(', ')
    : null

  const payload = {
    location_id:      location.location_id,
    jobber_client_id: client.id,
    name:             `${client.firstName||''} ${client.lastName||''}`.trim() || client.companyName || 'Unknown',
    first_name:       client.firstName   || null,
    last_name:        client.lastName    || null,
    company:          client.companyName || null,
    email, phone, address: addr,
    city:  client.billingAddress?.city       || null,
    state: client.billingAddress?.province   || null,
    zip:   client.billingAddress?.postalCode || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('leads').select('id')
    .eq('jobber_client_id', client.id).eq('location_id', location.location_id).maybeSingle()

  if (existing) {
    await supabaseService.from('leads').update(payload).eq('id', existing.id)
  } else {
    await supabaseService.from('leads')
      .insert({ ...payload, created_at: client.createdAt || new Date().toISOString() })
  }

  console.log(`[webhook] Client upserted: ${client.firstName} ${client.lastName}`)
}

async function handleRequest(itemId: string, location: any, token: string) {
  const res = await jobberQuery(token, REQUEST_QUERY, { id: itemId })
  const request = res.data?.request
  if (!request) return

  // Find the parent lead
  const { data: lead } = await supabaseService.from('leads').select('id')
    .eq('jobber_client_id', request.client?.id).eq('location_id', location.location_id).maybeSingle()

  if (!lead) {
    console.warn(`[webhook] No lead found for request ${itemId}`)
    return
  }

  const payload = {
    lead_id:           lead.id,
    location_id:       location.location_id,
    jobber_request_id: request.id,
    request_url:       request.jobberWebUri || null,
    stage:             request.assessment ? 'Assessment Scheduled' : 'New Request',
    status:            'active',
    source:            'jobber',
    jobber_synced_at:  new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('service_requests').select('id')
    .eq('jobber_request_id', request.id).maybeSingle()

  if (existing) {
    await supabaseService.from('service_requests').update(payload).eq('id', existing.id)
  } else {
    await supabaseService.from('service_requests')
      .insert({ ...payload, created_at: request.createdAt || new Date().toISOString() })
  }

  console.log(`[webhook] Request upserted: ${request.id}`)
}

async function handleQuote(itemId: string, location: any, token: string) {
  const res = await jobberQuery(token, QUOTE_QUERY, { id: itemId })
  const quote = res.data?.quote
  if (!quote) return

  const { data: serviceReq } = await supabaseService.from('service_requests').select('id, lead_id')
    .eq('jobber_request_id', quote.request?.id).maybeSingle()

  if (!serviceReq) return

  const payload = {
    service_request_id: serviceReq.id,
    lead_id:            serviceReq.lead_id,
    location_id:        location.location_id,
    jobber_quote_id:    quote.id,
    quote_url:          quote.jobberWebUri || null,
    status:             'sent',
    subtotal:           quote.amounts?.subtotal       ? parseFloat(quote.amounts.subtotal)       : null,
    tax_amount:         quote.amounts?.taxAmount      ? parseFloat(quote.amounts.taxAmount)      : null,
    discount_amount:    quote.amounts?.discountAmount ? parseFloat(quote.amounts.discountAmount) : null,
    total:              quote.amounts?.total          ? parseFloat(quote.amounts.total)          : null,
    sent_at:            quote.createdAt || null,
    jobber_synced_at:   new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('quotes').select('id')
    .eq('jobber_quote_id', quote.id).maybeSingle()

  if (existing) {
    await supabaseService.from('quotes').update(payload).eq('id', existing.id)
  } else {
    await supabaseService.from('quotes')
      .insert({ ...payload, created_at: quote.createdAt || new Date().toISOString() })
  }

  console.log(`[webhook] Quote upserted: ${quote.id}`)
}

async function handleJob(itemId: string, location: any, token: string) {
  const JOB_STATUS: Record<string, string> = {
    ACTIVE: 'in_progress', COMPLETED: 'completed',
    REQUIRES_INVOICING: 'completed', LATE: 'late',
    TODAY: 'today', UPCOMING: 'upcoming', ARCHIVED: 'archived',
  }

  const res = await jobberQuery(token, JOB_QUERY, { id: itemId })
  const job = res.data?.job
  if (!job) return

  const { data: serviceReq } = await supabaseService.from('service_requests').select('id, lead_id')
    .eq('jobber_request_id', job.request?.id).maybeSingle()

  if (!serviceReq) return

  const payload = {
    service_request_id: serviceReq.id,
    lead_id:            serviceReq.lead_id,
    location_id:        location.location_id,
    jobber_job_id:      job.id,
    job_url:            job.jobberWebUri  || null,
    title:              job.title         || null,
    status:             JOB_STATUS[job.jobStatus?.toUpperCase()] ?? 'unknown',
    scheduled_start:    job.startAt       || null,
    completed_at:       job.completedAt   || null,
    total:              job.total ? parseFloat(job.total) : null,
    jobber_synced_at:   new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('jobs').select('id')
    .eq('jobber_job_id', job.id).maybeSingle()

  if (existing) {
    await supabaseService.from('jobs').update(payload).eq('id', existing.id)
  } else {
    await supabaseService.from('jobs')
      .insert({ ...payload, created_at: job.createdAt || new Date().toISOString() })
  }

  // Update service_request stage
  await supabaseService.from('service_requests').update({
    stage:      job.completedAt ? 'Final Processing' : 'Job in Progress',
    updated_at: new Date().toISOString(),
  }).eq('id', serviceReq.id)

  console.log(`[webhook] Job upserted: ${job.id}`)
}

async function handleInvoice(itemId: string, location: any, token: string) {
  const res = await jobberQuery(token, INVOICE_QUERY, { id: itemId })
  const invoice = res.data?.invoice
  if (!invoice) return

  const jobId = invoice.job?.nodes?.[0]?.id
  if (!jobId) return

  const { data: job } = await supabaseService.from('jobs').select('id, service_request_id, lead_id')
    .eq('jobber_job_id', jobId).maybeSingle()

  if (!job) return

  const payload = {
    job_id:             job.id,
    service_request_id: job.service_request_id,
    lead_id:            job.lead_id,
    location_id:        location.location_id,
    jobber_invoice_id:  invoice.id,
    invoice_url:        invoice.jobberWebUri || null,
    status:             'sent',
    subtotal:           invoice.amounts?.subtotal       ? parseFloat(invoice.amounts.subtotal)       : null,
    tax_amount:         invoice.amounts?.taxAmount      ? parseFloat(invoice.amounts.taxAmount)      : null,
    discount_amount:    invoice.amounts?.discountAmount ? parseFloat(invoice.amounts.discountAmount) : null,
    total:              invoice.amounts?.total          ? parseFloat(invoice.amounts.total)          : null,
    issued_at:          invoice.createdAt || null,
    jobber_synced_at:   new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('invoices').select('id')
    .eq('jobber_invoice_id', invoice.id).maybeSingle()

  if (existing) {
    await supabaseService.from('invoices').update(payload).eq('id', existing.id)
    // Update status on INVOICE_PAID
    if (invoice.status === 'PAID') {
      await supabaseService.from('invoices').update({
        status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq('id', existing.id)
    }
  } else {
    await supabaseService.from('invoices')
      .insert({ ...payload, created_at: invoice.createdAt || new Date().toISOString() })
  }

  // Update service_request stage to Final Processing
  await supabaseService.from('service_requests').update({
    stage: 'Final Processing', updated_at: new Date().toISOString(),
  }).eq('id', job.service_request_id)

  console.log(`[webhook] Invoice upserted: ${invoice.id}`)
}