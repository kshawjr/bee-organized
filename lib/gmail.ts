// lib/gmail.ts
//
// Gmail sync step 1 — domain-wide delegation auth only.
//
// A GCP service account with domain-wide delegation (authorized in the
// Workspace admin console for gmail.readonly + gmail.send) impersonates
// @beeorganized.com users via the JWT "subject" field. No OAuth flow, no
// refresh tokens, no consent screen — the JWT grant mints an access token
// directly for whichever mailbox we name.
//
// GOOGLE_SA_KEY holds the raw service-account JSON (all Vercel envs).
// Never log, echo, or return the private key or an access token.

import { JWT } from 'google-auth-library'

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

export class GoogleServiceAccountKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleServiceAccountKeyError'
  }
}

export interface ServiceAccountCredentials {
  client_email: string
  private_key: string
}

// Pure parser, exported for tests. Raw JSON pasted into a Vercel env box can
// arrive with the private key's newlines either real or as the two-character
// sequence backslash-n — normalize the latter or JWT signing fails with an
// opaque DECODER error.
export function parseServiceAccountKey(raw: string): ServiceAccountCredentials {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GoogleServiceAccountKeyError(
      'GOOGLE_SA_KEY is not valid JSON — expected the raw service-account key file contents'
    )
  }
  if (!parsed?.client_email || !parsed?.private_key) {
    throw new GoogleServiceAccountKeyError(
      'GOOGLE_SA_KEY is missing client_email or private_key'
    )
  }
  let privateKey: string = parsed.private_key
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n')
  }
  return { client_email: parsed.client_email, private_key: privateKey }
}

let credentialsCache: ServiceAccountCredentials | null = null

export function getServiceAccountCredentials(): ServiceAccountCredentials {
  if (credentialsCache) return credentialsCache
  const raw = process.env.GOOGLE_SA_KEY
  if (!raw) {
    throw new GoogleServiceAccountKeyError('GOOGLE_SA_KEY env var is not set')
  }
  credentialsCache = parseServiceAccountKey(raw)
  return credentialsCache
}

// Token cache keyed by impersonated user. Tokens last an hour; expire ours
// 5 minutes early so we never hand out one about to die mid-request.
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

export async function getAccessToken(userEmail: string): Promise<string> {
  const cached = tokenCache.get(userEmail)
  if (cached && Date.now() < cached.expiresAt) return cached.token

  const creds = getServiceAccountCredentials()
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: GMAIL_SCOPES,
    subject: userEmail,
  })
  const tokens = await client.authorize()
  if (!tokens.access_token) {
    throw new Error(`Google returned no access token for ${userEmail}`)
  }
  const expiryDate = tokens.expiry_date ?? Date.now() + 60 * 60 * 1000
  tokenCache.set(userEmail, {
    token: tokens.access_token,
    expiresAt: expiryDate - TOKEN_EXPIRY_MARGIN_MS,
  })
  return tokens.access_token
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

// Typed so callers can branch on status — the history.list 404 (cursor too
// old) fallback in gmail-sync depends on it.
export class GmailApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GmailApiError'
    this.status = status
  }
}

// Delegation failures (unauthorized_client, subject not in domain, scope not
// granted in the admin console) are only diagnosable from the response body,
// so include it in the error. The body never contains our token or key.
export async function gmailFetch(
  userEmail: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getAccessToken(userEmail)
  const res = await fetch(`${GMAIL_API_BASE}/${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new GmailApiError(res.status, `Gmail API ${res.status} on ${path} (as ${userEmail}): ${body}`)
  }
  return res
}

export interface GmailMessageRef {
  id: string
  threadId: string
}

export interface GmailMessageList {
  messages: GmailMessageRef[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

export async function listMessageIds(
  userEmail: string,
  opts: { query?: string; maxResults?: number; pageToken?: string } = {}
): Promise<GmailMessageList> {
  const params = new URLSearchParams()
  if (opts.query) params.set('q', opts.query)
  if (opts.maxResults) params.set('maxResults', String(opts.maxResults))
  if (opts.pageToken) params.set('pageToken', opts.pageToken)
  const res = await gmailFetch(userEmail, `messages?${params}`)
  const data = await res.json()
  return {
    messages: data.messages ?? [],
    nextPageToken: data.nextPageToken,
    resultSizeEstimate: data.resultSizeEstimate,
  }
}

export interface GmailMessageMetadata {
  id: string
  threadId: string
  internalDate: string
  // header names lowercased; repeated headers joined with ", "
  headers: Record<string, string>
}

const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID']

// format=metadata only — never fetches message bodies.
export async function getMessageMetadata(
  userEmail: string,
  messageId: string
): Promise<GmailMessageMetadata> {
  const params = new URLSearchParams({ format: 'metadata' })
  for (const h of METADATA_HEADERS) params.append('metadataHeaders', h)
  const res = await gmailFetch(userEmail, `messages/${encodeURIComponent(messageId)}?${params}`)
  const data = await res.json()
  const headers: Record<string, string> = {}
  for (const h of data.payload?.headers ?? []) {
    const key = String(h?.name ?? '').toLowerCase()
    if (!key) continue
    const value = String(h?.value ?? '')
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value
  }
  return {
    id: data.id,
    threadId: data.threadId,
    internalDate: data.internalDate,
    headers,
  }
}

export interface GmailHistoryPage {
  messagesAdded: GmailMessageRef[]
  nextPageToken?: string
  historyId?: string
}

// Incremental sync: messages added since a history cursor. Google returns
// 404 (as GmailApiError) when the cursor is too old to replay.
export async function listHistory(
  userEmail: string,
  opts: { startHistoryId: string; pageToken?: string; maxResults?: number }
): Promise<GmailHistoryPage> {
  const params = new URLSearchParams({
    startHistoryId: opts.startHistoryId,
    historyTypes: 'messageAdded',
  })
  if (opts.pageToken) params.set('pageToken', opts.pageToken)
  if (opts.maxResults) params.set('maxResults', String(opts.maxResults))
  const res = await gmailFetch(userEmail, `history?${params}`)
  const data = await res.json()
  const messagesAdded: GmailMessageRef[] = []
  for (const h of data.history ?? []) {
    for (const ma of h.messagesAdded ?? []) {
      if (ma.message?.id) messagesAdded.push({ id: ma.message.id, threadId: ma.message.threadId })
    }
  }
  return { messagesAdded, nextPageToken: data.nextPageToken, historyId: data.historyId }
}

// format=full — body included. Only ever call this for messages that have
// already passed the lead-match filter; unmatched mail must never leave
// the metadata stage.
export async function getMessageFull(userEmail: string, messageId: string): Promise<any> {
  const res = await gmailFetch(userEmail, `messages/${encodeURIComponent(messageId)}?format=full`)
  return res.json()
}

// Extract every email address from an RFC 5322 address header value:
// "Name <a@b.com>", bare a@b.com, comma-separated lists, and quoted
// display names containing commas ("Doe, John" <j@x.com>). Pulling
// @-tokens rather than splitting on commas is what makes the quoted-
// comma case safe. Lowercased, trimmed, deduped, order of appearance.
const ADDRESS_RE = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

export function parseAddresses(headerValue?: string | null): string[] {
  if (!headerValue) return []
  const seen = new Set<string>()
  for (const match of headerValue.match(ADDRESS_RE) ?? []) {
    seen.add(match.trim().toLowerCase())
  }
  return Array.from(seen)
}

export interface GmailProfile {
  emailAddress: string
  messagesTotal: number
  threadsTotal: number
  historyId: string
}

export async function getProfile(userEmail: string): Promise<GmailProfile> {
  const res = await gmailFetch(userEmail, 'profile')
  const data = await res.json()
  return {
    emailAddress: data.emailAddress,
    messagesTotal: data.messagesTotal,
    threadsTotal: data.threadsTotal,
    historyId: data.historyId,
  }
}
