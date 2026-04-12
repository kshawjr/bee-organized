import { NextRequest, NextResponse } from 'next/server'
import { getZohoLocation } from '@/lib/zoho'

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_API_VERSION = '2025-04-16'

async function jobberQuery(accessToken: string, query: string) {
  const res = await fetch(JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
    },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  })
  return res.json()
}

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

async function refreshJobberToken(location: any, zohoToken: string): Promise<string> {
  const ZOHO_API_BASE = process.env.ZOHO_API_BASE!
  const expiry = parseInt(location.Token_Expiry || '0')
  const bufferMs = 5 * 60 * 1000

  if (expiry && Date.now() < expiry - bufferMs) {
    return location.Jobber_Access_Token
  }

  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.JOBBER_CLIENT_ID!,
      client_secret: process.env.JOBBER_CLIENT_SECRET!,
      refresh_token: location.Jobber_Refresh_Token,
    }),
    cache: 'no-store',
  })

  const tokens = await res.json()

  if (!tokens.access_token) {
    throw new Error('Failed to refresh Jobber token')
  }

  const expiryMs = Date.now() + 55 * 60 * 1000
  await zohoFetch(`${ZOHO_API_BASE}/Locations`, zohoToken, {
    method: 'PUT',
    body: JSON.stringify({ data: [{
      id: location.id,
      Jobber_Access_Token: tokens.access_token,
      Jobber_Refresh_Token: tokens.refresh_token,
      Token_Expiry: expiryMs.toString(),
      Token_Expiry_Display: new Date(expiryMs).toISOString().slice(0, 19),
      Last_Sync_Status: `Token refreshed by Hub: ${new Date().toLocaleString()}`,
    }] }),
  })

  return tokens.access_token
}

const CLIENTS_QUERY = `
  query {
    clients(first: 50) {
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
  query {
    requests(first: 50) {
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

  let existingContactId = null

  // Search contact by email then phone
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

  // Search for existing deal by Jobber_Request_ID specifically
  let existingDealId = null
  if (request.id) {
    const dealResult = await zohoFetch(
      `${ZOHO_API_BASE}/Deals/search?criteria=(Jobber_Request_ID:equals:${encodeURIComponent(request.id)})&fields=id,Stage,Jobber_Client_ID`,
      zohoToken
    )
    if (dealResult.data?.[0]) {
      existingDealId = dealResult.data[0].id
      // Sync all fields with latest Jobber data
      const syncData: any = {
        Jobber_Client_ID: client.id,
        Jobber_Request_ID: request.id,
        Jobber_Request_URL: jobberRequestUrl,
        Imported_from_Jobber: true,
        Original_Jobber_Date: formatDate(date),
        Request_Created_in_Jobber: formatDateTime(request.createdAt),
        Lead_Source: 'Jobber Import',
      }
      if (assessmentDate) syncData.Scheduled_Assessment = formatDateTime(assessmentDate)
      if (jobberQuoteId) { syncData.Jobber_Quote_ID = jobberQuoteId; syncData.Jobber_Quote_URL = jobberQuoteUrl; syncData.Estimate_Sent = formatDateTime(request.quotes?.nodes?.[0]?.createdAt) }
      if (jobberJobId) { syncData.Jobber_Job_ID = jobberJobId; syncData.Jobber_Job_URL = jobberJobUrl; syncData.Job_in_Progress = formatDateTime(request.jobs?.nodes?.[0]?.startAt) }
      if (stage) syncData.Stage = stage
      await zohoFetch(`${ZOHO_API_BASE}/Deals`, zohoToken, { method: 'PUT', body: JSON.stringify({ data: [{ id: existingDealId, ...syncData }] }) })
      return { success: true, action: 'synced', dealId: existingDealId, stage }
    }
  }

  // Create new Request in Zoho
  const requestData: any = {
    Name: `${client.firstName} ${client.lastName || '(unknown)'}`,
    Request_First_Name: client.firstName,
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
    Request_Status: stage ? 'New' : 'Stagnant',
    Request_Created_in_Jobber: formatDateTime(request.createdAt),
    Request_Source: 'Jobber Import',
  }

  if (assessmentDate) requestData.Scheduled_Assessment = formatDateTime(assessmentDate)

  const createResult = await zohoFetch(`${ZOHO_API_BASE}/Requests`, zohoToken, { method: 'POST', body: JSON.stringify({ data: [requestData] }) })
  const reqId = createResult.data?.[0]?.details?.id

  if (!reqId) {
    return { success: false, action: 'failed', error: 'Failed to create request', details: createResult }
  }

  if (!stage) {
    return { success: true, action: 'created_stagnant', reqId }
  }

  const dealData: any = {
    Deal_Name: `${client.firstName} ${client.lastName}`,
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
    const newAcctResult = await zohoFetch(`${ZOHO_API_BASE}/Accounts`, zohoToken, { method: 'POST', body: JSON.stringify({ data: [{ Account_Name: `${client.firstName} ${client.lastName}`, Phone: phone, Primary_Email: email, Account_Type: 'Zee Bee Client', Owner: '6426180000000482001' }] }) })
    accountId = newAcctResult.data?.[0]?.details?.id
  }

  let contactId = existingContactId
  if (!contactId) {
    const newContactResult = await zohoFetch(`${ZOHO_API_BASE}/Contacts`, zohoToken, { method: 'POST', body: JSON.stringify({ data: [{ First_Name: client.firstName, Last_Name: client.lastName || '(unknown)', Phone: phone, Email: email, Contact_Type: 'Zee Bee Client', Account_Name: accountId, Owner: '6426180000000482001' }] }) })
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
    const { location_id, dry_run } = body

    if (!location_id) return NextResponse.json({ error: 'location_id required' }, { status: 400 })

    const location = await getZohoLocation(location_id)
    if (!location) return NextResponse.json({ error: 'Location not found' }, { status: 404 })

    if (!location.Jobber_Access_Token) return NextResponse.json({ error: 'No Jobber token' }, { status: 400 })

    const zohoToken = await getZohoAccessToken()
    const token = await refreshJobberToken(location, zohoToken)

    const clientResult = await jobberQuery(token, CLIENTS_QUERY)
    const clients = clientResult?.data?.clients?.nodes || []

    const requestResult = await jobberQuery(token, REQUESTS_QUERY)
    const requests = requestResult?.data?.requests?.nodes || []

    const requestsByClient: Record<string, any[]> = {}
    for (const req of requests) {
      const clientId = req.client?.id
      if (clientId) {
        if (!requestsByClient[clientId]) requestsByClient[clientId] = []
        requestsByClient[clientId].push(req)
      }
    }

    if (dry_run) {
      return NextResponse.json({
        dry_run: true,
        location: location.Name,
        client_count: clients.length,
        request_count: requests.length,
        preview: clients.map((c: any) => ({
          name: `${c.firstName} ${c.lastName}`,
          email: c.emails?.[0]?.address,
          requests: (requestsByClient[c.id] || []).map((r: any) => ({ id: r.id, ...determineStageAndDate(r) }))
        }))
      })
    }

    const results = []

    for (const client of clients) {
      const clientRequests = requestsByClient[client.id] || []
      if (clientRequests.length === 0) {
        try {
          const result = await createZohoRequest(client, { id: null, createdAt: client.createdAt, jobberWebUri: null, assessment: null, quotes: { nodes: [] }, jobs: { nodes: [] } }, location, zohoToken)
          results.push({ client: `${client.firstName} ${client.lastName}`, ...result })
        } catch (err) {
          results.push({ client: `${client.firstName} ${client.lastName}`, success: false, error: String(err) })
        }
      } else {
        for (const req of clientRequests) {
          try {
            const result = await createZohoRequest(client, req, location, zohoToken)
            results.push({ client: `${client.firstName} ${client.lastName}`, ...result })
          } catch (err) {
            results.push({ client: `${client.firstName} ${client.lastName}`, success: false, error: String(err) })
          }
        }
      }
    }

    return NextResponse.json({ success: true, location: location.Name, imported: results.length, results })

  } catch (error) {
    console.error('Import error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
