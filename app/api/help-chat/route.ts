// app/api/help-chat/route.ts
//
// POST /api/help-chat — CLOSED 2026-11-13.
//
// It was the server half of "Ask Bee Hub", the in-app help chat: it took the
// asker's question and a readout of the screen they were on, sent both to
// Anthropic, and streamed the answer back. Ask Bee Hub has left the app
// (Kevin: Help covers it) — its buttons, its panel and the prompt behind it
// are deleted — so nothing in Bee Hub calls this any more. It refuses, for
// everyone, rather than sit open on the server behind a screen that is gone:
// while it was open any signed-in user could still post to it by hand and
// spend the Anthropic key.
//
// 410 Gone, not 403: nobody is being told they lack permission. The answer is
// the same whoever asks and is given before anything is read — not the
// request, not the session, not the database, not the key — the same way
// /api/tags/own was closed.
//
// TO REOPEN: the route, the prompt (lib/help-chat-prompt.ts) and the panel
// (components/hive/AskBeeHubPanel.jsx) are in git at 722aaa0.

import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    {
      error: 'help_chat_closed',
      message: 'Ask Bee Hub is closed. Help has how-tos, and you can ask the team a question there.',
    },
    { status: 410 },
  )
}
