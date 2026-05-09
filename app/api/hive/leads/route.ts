// app/api/hive/leads/route.ts
// Returns leads with their latest service request stage, assessment,
// quote, job and invoice — shaped for the Hive Lead interface

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'

// Map Supabase stage → Hive stage
function mapStage(stage: string | null): string {
  if (!stage) return 'New'
  const map: Record<string, string> = {
    'New Request':           'Nurturing',
    'Assessment Scheduled':  'Assessment Scheduled',
    'Estimate Sent':         'Quote',
    'Job in Progress':       'Job in Progress',
    'Final Processing':      'Final Processing',
  }
  return map[stage] || 'New'
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const location_id = searchParams.get('location_id')

    if (!location_id) {
      return NextResponse.json({ error: 'location_id required' }, { status: 400 })
    }

    // Fetch leads
    const { data: leads, error: leadsError } = await supabaseService
      .from('leads')
      .select('*')
      .eq('location_id', location_id)
      .order('created_at', { ascending: false })

    if (leadsError) throw new Error(leadsError.message)
    if (!leads?.length) return NextResponse.json([])

    const leadIds = leads.map(l => l.id)

    // Fetch latest service_request per lead
    const { data: requests } = await supabaseService
      .from('service_requests')
      .select('*')
      .in('lead_id', leadIds)
      .order('created_at', { ascending: false })

    // Fetch assessments
    const { data: assessments } = await supabaseService
      .from('assessments')
      .select('*')
      .in('lead_id', leadIds)
      .order('created_at', { ascending: false })

    // Fetch quotes
    const { data: quotes } = await supabaseService
      .from('quotes')
      .select('*')
      .in('lead_id', leadIds)
      .order('created_at', { ascending: false })

    // Fetch jobs
    const { data: jobs } = await supabaseService
      .from('jobs')
      .select('*')
      .in('lead_id', leadIds)
      .order('created_at', { ascending: false })

    // Fetch invoices
    const { data: invoices } = await supabaseService
      .from('invoices')
      .select('*')
      .in('lead_id', leadIds)
      .order('created_at', { ascending: false })

    // Fetch notes
    const { data: notes } = await supabaseService
      .from('notes')
      .select('*')
      .in('lead_id', leadIds)
      .order('created_at', { ascending: false })

    // Build lookup maps — one per lead (most recent first)
    const requestByLead    = new Map<string, any>()
    const assessmentByLead = new Map<string, any>()
    const quoteByLead      = new Map<string, any>()
    const jobByLead        = new Map<string, any>()
    const invoiceByLead    = new Map<string, any>()
    const notesByLead      = new Map<string, any[]>()

    for (const r of (requests || [])) {
      if (!requestByLead.has(r.lead_id)) requestByLead.set(r.lead_id, r)
    }
    for (const a of (assessments || [])) {
      if (!assessmentByLead.has(a.lead_id)) assessmentByLead.set(a.lead_id, a)
    }
    for (const q of (quotes || [])) {
      if (!quoteByLead.has(q.lead_id)) quoteByLead.set(q.lead_id, q)
    }
    for (const j of (jobs || [])) {
      if (!jobByLead.has(j.lead_id)) jobByLead.set(j.lead_id, j)
    }
    for (const i of (invoices || [])) {
      if (!invoiceByLead.has(i.lead_id)) invoiceByLead.set(i.lead_id, i)
    }
    for (const n of (notes || [])) {
      if (!notesByLead.has(n.lead_id)) notesByLead.set(n.lead_id, [])
      notesByLead.get(n.lead_id)!.push(n)
    }

    // Shape into Lead interface
    const shaped = leads.map(lead => {
      const request    = requestByLead.get(lead.id)
      const assessment = assessmentByLead.get(lead.id)
      const quote      = quoteByLead.get(lead.id)
      const job        = jobByLead.get(lead.id)
      const invoice    = invoiceByLead.get(lead.id)
      const leadNotes  = notesByLead.get(lead.id) || []

      // Build address string
      const addressParts = [lead.address, lead.city, lead.state, lead.zip].filter(Boolean)
      const address = addressParts.length > 0 ? addressParts.join(', ') : undefined

      // Build activity from notes + system events
      const activity: any[] = []

      // System: lead created
      activity.push({
        id: `sys-created-${lead.id}`,
        type: 'system',
        text: `Lead created${lead.source ? ` via ${lead.source}` : ''}`,
        timestamp: formatDate(lead.created_at),
      })

      // System: request created
      if (request) {
        activity.push({
          id: `sys-req-${request.id}`,
          type: 'system',
          text: `Request created in ${request.source === 'jobber' ? 'Jobber' : 'Bee Hub'}`,
          timestamp: formatDate(request.created_at),
        })
      }

      // System: assessment scheduled
      if (assessment?.scheduled_at) {
        activity.push({
          id: `sys-assess-${assessment.id}`,
          type: 'stage',
          text: `Assessment scheduled for ${formatDate(assessment.scheduled_at)}`,
          timestamp: formatDate(assessment.created_at),
        })
      }

      // System: estimate sent
      if (quote?.sent_at) {
        activity.push({
          id: `sys-quote-${quote.id}`,
          type: 'stage',
          text: `Estimate sent${quote.total ? ` — $${Number(quote.total).toLocaleString()}` : ''}`,
          timestamp: formatDate(quote.sent_at),
        })
      }

      // System: job created
      if (job?.created_at) {
        activity.push({
          id: `sys-job-${job.id}`,
          type: 'stage',
          text: `Job created in Jobber${job.title ? ` — ${job.title}` : ''}`,
          timestamp: formatDate(job.created_at),
        })
      }

      // System: invoice issued
      if (invoice?.issued_at) {
        activity.push({
          id: `sys-inv-${invoice.id}`,
          type: 'stage',
          text: `Invoice sent${invoice.total ? ` — $${Number(invoice.total).toLocaleString()}` : ''}${invoice.status === 'paid' ? ' · Paid ✅' : ''}`,
          timestamp: formatDate(invoice.issued_at),
        })
      }

      // Notes from DB
      for (const note of leadNotes) {
        activity.push({
          id: `note-${note.id}`,
          type: 'note',
          text: note.content,
          timestamp: formatDate(note.created_at),
          user: note.author || undefined,
        })
      }

      // Sort activity by date
      activity.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

      // Determine jobber status label
      let jobberStatus: string | undefined
      if (job) jobberStatus = `Job in Jobber${job.title ? ` — ${job.title}` : ''}`
      else if (request?.jobber_request_id) jobberStatus = `Request in Jobber`

      // Assessment display string
      let scheduledAssessment: string | undefined
      if (assessment?.scheduled_at) {
        scheduledAssessment = new Date(assessment.scheduled_at).toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit'
        })
      }

      return {
        id:                  lead.id,
        name:                lead.name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Unknown',
        phone:               lead.phone || '',
        email:               lead.email || '',
        stage:               mapStage(request?.stage),
        source:              lead.source || 'Unknown',
        projectType:         lead.project_type || 'Home Organization',
        description:         lead.description || undefined,
        location:            location_id,
        createdAt:           formatDate(lead.created_at),
        address,
        scheduledAssessment,
        jobberStatus,
        jobber_client_id:    lead.jobber_client_id || undefined,
        location_id:         lead.location_id,
        // Finance summary
        quoteTotal:          quote?.total ? Number(quote.total) : undefined,
        invoiceTotal:        invoice?.total ? Number(invoice.total) : undefined,
        invoiceStatus:       invoice?.status || undefined,
        // Drips — empty for now, will be wired to drip system
        path:                null,
        drips:               [],
        activity,
        pausedDrip:          false,
      }
    })

    return NextResponse.json(shaped)
  } catch (err: any) {
    console.error('[hive/leads]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days < 7) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}