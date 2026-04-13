import { NextRequest, NextResponse } from 'next/server'
import { getZohoLocation } from '@/lib/zoho'
import { jobberQuery, getValidJobberToken } from '@/lib/jobber'
import { writeSyncLog } from '@/lib/sync-log'

async function getZohoAccessToken(): Promise<string> {
  const res = await fetch(
    `https://accounts.zoho.com/oauth/v2/token?grant_type=refresh_token&client_id=${process.env.ZOHO_CLIENT_ID}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&refresh_token=${process.env.ZOHO_REFRESH_TOKEN}`,
    { method: 'POST', cache: 'no-store' }
  )
  const data = await res.json()
  return data.access_token
}

async function safeJson(res: Response) {
  const text = await res.text()
  if (!text || text.trim() === '') return {}
  try { return JSON.parse(text) } catch { return {} }
}

async function zohoFetch(url: string, token: string, options: RequestInit = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    cache: 'no-store',
  })
  return safeJson(res)
}

async function fetchAllPages(token: string, query: string, dataKey: string): Promise<any[]> {
  const all: any[] = []
  let hasNextPage = true
  let cursor: string | null = null

  while (hasNextPage) {
    const result = await jobberQuery(token, query, cursor ? { after: cursor } : {})
    const page = result?.data?.[dataKey]
    if (!page) {
      console.log('No page data for', dataKey, JSON.stringify(result).slice(0, 200))
      break
    }
    all.push(...page.nodes)
    hasNextPage = page.pageInfo.hasNextPage
    cursor = page.pageInfo.endCursor
    if (hasNextPage) await new Promise(r => setTimeout(r, 1000))
  }

  return all
}

async function fetchExistingJobberRequestIds(zohoToken: string, locationId: string): Promise<Set<string>> {
  const ZOHO_API_BASE = process.env.ZOHO_API_BASE!
  const ids = new Set<string>()
  let page = 1
  let hasMore = true

  while (hasMore) {
    const result = await zohoFetch(
      `${ZOHO_API_BASE}/Deals/search?criteria=(Location_ID:equals:${locationId})&fields=Jobber_Request_ID&per_page=200&page=${page}`,
      zohoToken
    )
    const records = result.data || []
    for (const rec of records) {
      if (rec.Jobber_Request_ID) ids.add(rec.Jobber_Request_ID)
    }
    hasMore = records.length === 200
    page++
    if (hasMore) await new Promise(r => setTimeout(r, 100))
  }

  page = 1
  hasMore = true
  while (hasMore) {
    const result = await zohoFetch(
      `${ZOHO_API_BASE}/Requests/search?criteria=(Location_ID:equals:${locationId})&fields=Jobber_Request_ID&per_page=200&page=${page}`,
      zohoToken
    )
    const records = result.data || []
    for (const rec of records) {
      if (rec.Jobber_Request_ID) ids.add(rec.Jobber_Request_ID)
    }
    hasMore = records.length === 200
    page++
    if (hasMore) await new Promise(r => setTimeout(r, 100))
  }

  return ids
}

function hasContactInfo(client: any): boolean {
  const email = client.emails?.find((e: any) => e.primary)?.address || client.emails?.[0]?.address || ''
  const phone = client.phones?.find((p: any) => p.primary)?.number || client.phones?.[0]?.number || ''
  return !!(email || phone)
}

const CLIENTS_QUERY = `
  query GetClients($after: String) {
    clients(first: 50, after: $after) {
      nodes {
        id
        firstName
        lastName
        companyName
        emails { address primary }
        phones { number primary }
        createdAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const REQUESTS_QUERY = `
  query GetRequests($after: String) {
    requests(first: 50, after: $after) {
      nodes {
        id
        createdAt
        jobberWebUri
        client { id }
        assessment {
          id
          startAt
          completedAt
        }
        quotes(first: 1) {
          nodes { id createdAt jobberWebUri }
        }
        jobs(first: 1) {
          nodes {
            id
            createdAt
            jobStatus
            startAt
            jobberWebUri
            invoices(first: 1) {
              nodes { id createdAt }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

function determineStageAndDate(request: any) {
  const assessment = request.assessment
  const job = request.jobs?.nodes?.[0]
  const quote = request.quotes?.nodes?.[0]
  const invoice = job?.invoices?.nodes?.[0]

  if (invoice) {
    return { stage: 'Final Processing', date: invoice.createdAt, assessmentDate: assessment?.startAt || null, jobberJobId: job?.id, jobberQuoteId: quote?.id, jobberInvoiceId: invoice.id, jobberRequestUrl: request.jobberWebUri, jobberQuoteUrl: quote?.jobberWebUri, jobberJobUrl: job?.jobberWebUri }
  }
  if (job) {
    return { stage: 'Job in Progress', date: job.startAt || job.createdAt, assessmentDate: assessment?.startAt || null, jobberJobId: job.id, jobberQuoteId: quote?.id, jobberInvoiceId: null, jobberRequestUrl: request.jobberWebUri, jobberQuoteUrl: quote?.jobberWebUri, jobberJobUrl: job?.jobberWebUri }
  }
  if (quote) {
    return { stage: 'Quote', date: quote.createdAt, assessmentDate: assessment?.startAt || null, jobberJobId: null, jobberQuoteId: quote.id, jobberInvoiceId: null, jobberRequestUrl: request.jobberWebUri, jobberQuoteUrl: quote?.jobberWebUri, jobberJobUrl: null }
  }
  if (assessment) {
    return { stage: 'Assessment Scheduled', date: assessment.startAt, assessmentDate: assessment.startAt, jobberJobId: null, jobberQuoteId: null, jobberInvoiceId: null, jobberRequestUrl: request.jobberWebUri, jobberQuoteUrl: null, jobberJobUrl: null }
  }
  return { stage: null, date: request.createdAt, assessmentDate: null, jobberJobId: null, jobberQuoteId: null, jobberInvoiceId: null, jobberRequestUrl: request.jobberWebUri, jobberQuoteUrl: null, jobberJobUrl: null }
}

function formatDateTime(isoString: string | null): string | null {
  if (!isoString) return null
  return isoString.replace('Z', '+00:00')
}

function formatDate(isoString: string | null): string | null {
  if (!isoString) return null
  return isoString.split('T')[0]
}

async function createZohoRequest(client: any, request: any, location: any, zohoToken: string) {
  const ZOHO_API_BASE = process.env.ZOHO_API_BASE!
  const email = client.emails?.find((e: any) => e.primary)?.address || client.emails?.[0]?.address || ''
  const phone = client.phones?.find((p: any) => p.primary)?.number || client.phones?.[0]?.number || ''
  const { stage, date, assessmentDate, jobberJobId, jobberQuoteId, jobberRequestUrl, jobberQuoteUrl, jobberJobUrl } = determineStageAndDate(request)
  const hasContact = !!(email || phone)

  let existingContactId = null
  let contactSearch = null
  if (email) {
    contactSearch = await zohoFetch(`${ZOHO_API_BASE}/Contacts/search?criteria=(Email:equals:${encodeURIComponent(email)})&fields=id,Email`, zohoToken)
  }
  if (!contactSearch?.data?.[0] && phone) {
    contactSearch = await zohoFetch(`${ZOHO_API_BASE}/Contacts/search?criteria=(Phone:equals:${encodeURIComponent(phone)})&fields=id,Phone`, zohoToken)
  }
  if (contactSearch?.data?.[0]) {
    existingContactId = contactSearch.data[0].id
  }

  const requestData: any = {
    Name: `${client.firstName} ${client.lastName || '(unknown)'}`.trim(),
    Request_First_Name: client.firstName || '(unknown)',
    Request_Last_Name: client.lastName || '(unknown)',
    Request_Phone: phone,
    Email: email,
    Franchise_Location: location.id,
    Location_ID: location.Location_ID,
    Owner: '6426180000000482001',
    Imported_from_Jobber: true,
    Original_Jobber_Date: formatDate(date),
    Jobber_Client_ID: client.id,
    Jobber_Request_ID: request.id,
    Request_Status: (stage && hasContact) ? 'New' : 'Stagnant',
    Request_Created_in_Jobber: formatDateTime(request.createdAt),
    Request_Source: 'Jobber Import',
  }

  if (assessmentDate) requestData.Scheduled_Assessment = formatDateTime(assessmentDate)

  const createResult = await zohoFetch(`${ZOHO_API_BASE}/Requests`, zohoToken, { method: 'POST', body: JSON.stringify({ data: [requestData] }) })
  const reqId = createResult.data?.[0]?.details?.id

  if (!reqId) {
    return { success: false, action: 'failed', error: 'Failed to create request', details: createResult }
  }

  if (!stage || !hasContact) {
    return { success: true, action: 'created_stagnant', reqId, reason: !hasContact ? 'no contact info' : 'no activity' }
  }

  const dealData: any = {
    Deal_Name: `${client.firstName} ${client.lastName || ''}`.trim(),
    Phone: phone,
    Email: email,
    Type: 'Zee Bee Client',
    Owner: '6426180000000482001',
    Layout: { id: '6426180000010735010' },
    Stage: stage,
    Pipeline: 'Bee Organized Zee Bee',
    Franchise_Location: location.id,
    Location_ID: location.Location_ID,
    Imported_from_Jobber: true,
    Original_Jobber_Date: formatDate(date),
    Jobber_Client_ID: client.id,
    Jobber_Request_ID: request.id,
    Jobber_Request_URL: jobberRequestUrl,
    Request_Created_in_Jobber: formatDateTime(request.createdAt),
    Lead_Source: 'Jobber Import',
  }

  if (assessmentDate) dealData.Scheduled_Assessment = formatDateTime(assessmentDate)
  if (jobberQuoteId) { dealData.Jobber_Quote_ID = jobberQuoteId; dealData.Jobber_Quote_URL = jobberQuoteUrl; dealData.Estimate_Sent = formatDateTime(request.quotes?.nodes?.[0]?.createdAt) }
  if (jobberJobId) { dealData.Jobber_Job_ID = jobberJobId; dealData.Jobber_Job_URL = jobberJobUrl; dealData.Job_in_Progress = formatDateTime(request.jobs?.nodes?.[0]?.startAt) }

  let accountId = null
  if (email) {
    const acctResult = await zohoFetch(`${ZOHO_API_BASE}/Accounts/search?criteria=(Primary_Email:equals:${encodeURIComponent(email)})&fields=id`, zohoToken)
    accountId = acctResult.data?.[0]?.id
  }
  if (!accountId && phone) {
    const acctResult = await zohoFetch(`${ZOHO_API_BASE}/Accounts/search?criteria=(Phone:equals:${encodeURIComponent(phone)})&fields=id`, zohoToken)
    accountId = acctResult.data?.[0]?.id
  }
  if (!accountId) {
    const newAcctResult = await zohoFetch(`${ZOHO_API_BASE}/Accounts`, zohoToken, { method: 'POST', body: JSON.stringify({ data: [{ Account_Name: `${client.firstName} ${client.lastName || ''}`.trim(), Phone: phone, Primary_Email: email, Account_Type: 'Zee Bee Client', Owner: '6426180000000482001' }] }) })
    accountId = newAcctResult.data?.[0]?.details?.id
  }

  let contactId = existingContactId
  if (!contactId) {
    const newContactResult = await zohoFetch(`${ZOHO_API_BASE}/Contacts`, zohoToken, { method: 'POST', body: JSON.stringify({ data: [{ First_Name: client.firstName || '(unknown)', Last_Name: client.lastName || '(unknown)', Phone: phone, Email: email, Contact_Type: 'Zee Bee Client', Account_Name: accountId, Owner: '6426180000000482001' }] }) })
    contactId = newContactResult.data?.[0]?.details?.id
  }

  dealData.Account_Name = accountId
  dealData.Contact_Name = contactId

  const dealResult = await zohoFetch(`${ZOHO_API_BASE}/Deals`, zohoToken, { method: 'POST', body: JSON.stringify({ data: [dealData], trigger: ['workflow'] }) })
  const dealId = dealResult.data?.[0]?.details?.id

  if (reqId) {
    await zohoFetch(`${ZOHO_API_BASE}/Requests`, zohoToken, { method: 'PUT', body: JSON.stringify({ data: [{ id: reqId, Converted: true, Request_Status: 'Converted', Account: accountId, Contact: contactId, Opportunity: dealId, Job_Slug: dealId, Account_Slug: accountId, Contact_Slug: contactId }] }) })
  }

  if (dealId && stage) {
    await zohoFetch(`${ZOHO_API_BASE}/Deals`, zohoToken, { method: 'PUT', body: JSON.stringify({ data: [{ id: dealId, Stage: stage }] }) })
  }

  return { success: true, action: 'created', reqId, dealId, stage, accountId, contactId }
}

export async function POST(request: NextRequest) {
  try {
    let body: any = {}
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    const { location_id, dry_run, batch_size = 100 } = body

    if (!location_id) return NextResponse.json({ error: 'location_id required' }, { status: 400 })

    const location = await getZohoLocation(location_id)
    if (!location) return NextResponse.json({ error: 'Location not found' }, { status: 404 })

    if (!location.Jobber_Access_Token) return NextResponse.json({ error: 'No Jobber token' }, { status: 400 })

    const zohoToken = await getZohoAccessToken()
    const token = await getValidJobberToken(location, zohoToken)

    const clients = await fetchAllPages(token, CLIENTS_QUERY, 'clients')
    console.log('Clients fetched:', clients.length)
    await new Promise(r => setTimeout(r, 3000))
    const requests = await fetchAllPages(token, REQUESTS_QUERY, 'requests')
    console.log('Requests fetched:', requests.length)

    const requestsByClient: Record<string, any[]> = {}
    for (const req of requests) {
      const clientId = req.client?.id
      if (clientId) {
        if (!requestsByClient[clientId]) requestsByClient[clientId] = []
        requestsByClient[clientId].push(req)
      }
    }

    const workItems: Array<{ client: any; request: any }> = []
    for (const client of clients) {
      const clientRequests = requestsByClient[client.id] || []
      if (clientRequests.length === 0) {
        workItems.push({ client, request: { id: null, createdAt: client.createdAt, jobberWebUri: null, assessment: null, quotes: { nodes: [] }, jobs: { nodes: [] } } })
      } else {
        for (const req of clientRequests) {
          workItems.push({ client, request: req })
        }
      }
    }

    if (dry_run) {
      const stageCounts: Record<string, number> = {
        'Final Processing': 0,
        'Job in Progress': 0,
        'Quote': 0,
        'Assessment Scheduled': 0,
        'Stagnant': 0,
        'No contact info': 0,
      }

      for (const item of workItems) {
        const { stage } = determineStageAndDate(item.request)
        const hasContact = hasContactInfo(item.client)
        if (!hasContact) {
          stageCounts['No contact info']++
        } else if (!stage) {
          stageCounts['Stagnant']++
        } else {
          stageCounts[stage] = (stageCounts[stage] || 0) + 1
        }
      }

      const stageBreakdown = Object.entries(stageCounts)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])

      return NextResponse.json({
        dry_run: true,
        location: location.Name,
        client_count: clients.length,
        request_count: requests.length,
        total_work_items: workItems.length,
        stage_breakdown: stageBreakdown,
        preview: clients.slice(0, 20).map((c: any) => ({
          name: `${c.firstName} ${c.lastName}`,
          email: c.emails?.find((e: any) => e.primary)?.address || c.emails?.[0]?.address || '',
          phone: c.phones?.find((p: any) => p.primary)?.number || c.phones?.[0]?.number || '',
          has_contact: hasContactInfo(c),
          requests: (requestsByClient[c.id] || []).map((r: any) => ({ id: r.id, ...determineStageAndDate(r) }))
        }))
      })
    }

    const existingIds = await fetchExistingJobberRequestIds(zohoToken, location.Location_ID)

    const remaining = workItems.filter(item => {
      if (!item.request.id) return !existingIds.has(item.client.id)
      return !existingIds.has(item.request.id)
    })

    const batch = remaining.slice(0, batch_size)
    const results = []

    for (const item of batch) {
      const clientName = `${item.client.firstName} ${item.client.lastName}`.trim()
      try {
        const result = await createZohoRequest(item.client, item.request, location, zohoToken)
        results.push({ client: clientName, ...result })

        await writeSyncLog({
          location_id: location.Location_ID,
          entity_id: clientName,
          zoho_record_id: result.dealId || result.reqId,
          jobber_record_id: item.request.id || undefined,
          status: result.success ? 'success' : 'error',
          message: result.action
            + (result.stage ? ` — ${result.stage}` : '')
            + (result.reason ? ` (${result.reason})` : '')
            + (result.error ? ` — ${result.error}` : ''),
        })
      } catch (err) {
        results.push({ client: clientName, success: false, error: String(err) })
        await writeSyncLog({
          location_id: location.Location_ID,
          entity_id: clientName,
          jobber_record_id: item.request.id || undefined,
          status: 'error',
          message: String(err),
        })
      }
    }

    return NextResponse.json({
      success: true,
      location: location.Name,
      total_in_jobber: workItems.length,
      already_imported: existingIds.size,
      remaining_before: remaining.length,
      remaining_after: remaining.length - batch.length,
      batch_size: batch.length,
      results,
    })

  } catch (error) {
    console.error('Import error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}