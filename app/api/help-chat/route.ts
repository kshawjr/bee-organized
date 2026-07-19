// app/api/help-chat/route.ts
//
// POST /api/help-chat — the "Ask Bee Hub" in-app help assistant.
//
// A screen-aware, answers-only help bot. On each question the client sends:
//   - screen: { name, detail } — the current screen name plus a lightweight,
//     LIVE readout of what's on it (visible tab/section labels, headings,
//     button text). Captured from app state + a DOM text snapshot at ask
//     time — NOT a maintained knowledge doc, so it stays current for free.
//   - messages: the running chat thread ([{role:'user'|'assistant', content}]).
//
// The reply streams back as plain-text chunks (the route parses Anthropic's
// SSE and emits only the assistant's text deltas, so the client stays simple).
//
// Model: claude-sonnet-5 (the fast Sonnet). Thinking is disabled for snappy,
// low-latency answers — this is short-form how-to help, not deep reasoning.
//
// SECURITY / PRIVACY:
//   - The Anthropic call is made HERE, server-side, with ANTHROPIC_API_KEY
//     read from the environment. The key is NEVER sent to the browser.
//   - The screen snapshot may contain the user's own client data (names, $).
//     That is the user's own data; we forward it ONLY to the Anthropic API for
//     that user's own question and log NONE of the screen contents.
//   - Available to ALL signed-in users — no role gate (any authenticated
//     hub_user can ask for help).

import { createServerSupabaseClient } from '@/lib/supabase-server'

// The fast Sonnet — see components/hive/shared (help chat). Concise how-to
// answers for a non-technical audience; thinking off keeps it snappy.
const MODEL = 'claude-sonnet-5'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MAX_HISTORY = 12 // last N turns kept — a help chat needs no long memory
const MAX_SCREEN_CHARS = 6000
const MAX_QUESTION_CHARS = 4000

const SYSTEM_BRIEF = [
  'You are the in-app help assistant for Bee Hub, a franchise CRM.',
  'Answer how-to questions clearly for a non-technical audience (franchise',
  'owners, roughly 45-65). Be concise, plain-language, and warm.',
  '',
  'You can EXPLAIN how to do things, but you CANNOT take actions on the',
  "user's behalf. If asked to do something (transfer a lead, send an email,",
  'change a setting), never claim you did it — explain, step by step, how the',
  'user can do it themselves in the app.',
  '',
  'Base your answers on the CURRENT SCREEN context provided below. It is a',
  'live readout of what is actually on the screen right now. If the context',
  "does not tell you the answer, say so plainly and suggest where they might",
  'look (e.g. "try the Settings screen" or "the ··· menu on that card").',
  'Keep answers short — a sentence or a few short steps. No preamble.',
].join('\n')

function buildSystem(screen: { name?: string; detail?: string } | null): string {
  const name = (screen?.name || 'Bee Hub').toString().slice(0, 200)
  const detail = (screen?.detail || '').toString().slice(0, MAX_SCREEN_CHARS)
  return [
    SYSTEM_BRIEF,
    '',
    '── CURRENT SCREEN ──',
    `The user is on: ${name}`,
    detail ? `\nWhat is visible on this screen right now:\n${detail}` : '(No extra on-screen detail was captured.)',
  ].join('\n')
}

export async function POST(req: Request) {
  // Auth — any signed-in hub_user may use the help chat (no role gate).
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    // Fail-closed with a friendly, non-technical message (the client shows
    // .error verbatim). The key must be set in the Vercel project env.
    return Response.json(
      { error: "The help assistant isn't set up yet. Please try again later." },
      { status: 503 },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad request' }, { status: 400 })
  }

  const screen = body?.screen && typeof body.screen === 'object' ? body.screen : null

  // Normalize the chat history: only user/assistant text turns, capped.
  const rawMessages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const messages = rawMessages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_QUESTION_CHARS) }))

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return Response.json({ error: 'bad request' }, { status: 400 })
  }

  let upstream: globalThis.Response
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        thinking: { type: 'disabled' }, // snappy how-to answers, no deep reasoning
        system: buildSystem(screen),
        messages,
        stream: true,
      }),
    })
  } catch {
    return Response.json({ error: "I couldn't reach the assistant. Please try again." }, { status: 502 })
  }

  if (!upstream.ok || !upstream.body) {
    // Drain the upstream error but never surface its raw contents to the user.
    await upstream.text().catch(() => '')
    return Response.json({ error: "I couldn't reach the assistant. Please try again." }, { status: 502 })
  }

  // Transform Anthropic's SSE into a plain-text stream of assistant deltas.
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      buffer += decoder.decode(value, { stream: true })
      // SSE events are separated by blank lines; parse complete lines.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep the trailing partial line
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const evt = JSON.parse(payload)
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            controller.enqueue(encoder.encode(evt.delta.text))
          }
          // Silently ignore ping/thinking/other events. An upstream `error`
          // event mid-stream just ends the text; the client already has a
          // partial answer and can retry.
        } catch {
          /* skip malformed SSE chunk */
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
