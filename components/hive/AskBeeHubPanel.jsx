// components/hive/AskBeeHubPanel.jsx
// ─────────────────────────────────────────────────────────────
// "Ask Bee Hub" — the screen-aware in-app help chat.
//
// A right-side drawer on desktop / bottom sheet on mobile. It answers
// how-to questions (it does NOT take actions) and is SCREEN-AWARE: on
// each question it captures a LIVE readout of the current screen — the
// friendly screen name (passed in from App state) plus a lightweight DOM
// text snapshot of what is actually rendered (headings, tab/section
// labels, button text). No maintained knowledge doc, so it stays current
// as the app changes.
//
// The Anthropic call happens server-side at /api/help-chat (the API key is
// never exposed to the browser); this component just streams the reply.
//
// Tokens-only (the hive hex/rgba sweep covers this file) — every color,
// radius, and shadow resolves through shared/tokens.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { IconX, IconSend, IconSparkles } from '@/components/ui/icons'
import { T } from './shared/tokens'

// Capture a live, readable snapshot of what is on screen right now — the
// core of "screen-aware". Reads visible headings, tabs, nav labels, and
// button text straight from the DOM (skipping this panel), so the answer
// reflects the actual rendered page, not a doc someone has to maintain.
function captureScreenText(excludeEl) {
  if (typeof document === 'undefined') return ''
  const parts = []
  const seen = new Set()
  const push = (raw) => {
    const s = (raw || '').replace(/\s+/g, ' ').trim()
    if (s && s.length <= 120 && !seen.has(s)) {
      seen.add(s)
      parts.push(s)
    }
  }
  const sel = 'h1,h2,h3,h4,[role="tab"],[aria-selected="true"],nav a,button,[role="button"]'
  document.querySelectorAll(sel).forEach((el) => {
    if (excludeEl && excludeEl.contains(el)) return
    const r = el.getBoundingClientRect && el.getBoundingClientRect()
    if (r && r.width === 0 && r.height === 0) return // not rendered
    push(el.getAttribute('aria-label') || el.textContent)
  })
  const out = parts.join(' · ')
  return out.length > 4000 ? out.slice(0, 4000) : out
}

// Screen-aware opening + suggested chips. Keyed by the friendly screen name
// App hands in (Home / Clients / Contacts / Reports / Settings / Admin).
function screenHints(name) {
  const n = (name || '').toLowerCase()
  if (n.includes('client'))
    return ['How do I move a deal forward?', 'What do the columns mean?', 'How do I log a call?']
  if (n.includes('contact')) return ['How do I add a contact?', 'What is this list for?']
  if (n.includes('report')) return ['What do these numbers mean?', 'How do I read this report?']
  if (n.includes('setting')) return ['How do I add a team member?', 'Where do I update billing?']
  if (n.includes('home')) return ['What needs my attention?', "How do I open a client's history?"]
  if (n.includes('admin') || n.includes('corp')) return ['What can I do here?', 'How do I review feedback?']
  return ['How do I get started?', 'Where do I find my clients?']
}

export default function AskBeeHubPanel({
  isMobile,
  onClose,
  screenName = 'Bee Hub',
  onOpenFeedback = null,
}) {
  const rootRef = useRef(null)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const [messages, setMessages] = useState([
    { role: 'assistant', content: `Hi! I see you're on the ${screenName} screen — how can I help?` },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const suggestions = screenHints(screenName)

  // Scroll lock behind the panel (classic overlay discipline) + Esc closes.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep the thread pinned to the newest content as it streams.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const send = useCallback(
    async (text) => {
      const q = (text || '').trim()
      if (!q || sending) return
      setInput('')
      setSending(true)

      // Build the API history from real turns only (drop the greeting +
      // any prior error notice); the greeting is UI-only.
      const priorTurns = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
      const apiMessages = [...priorTurns.slice(1), { role: 'user', content: q }]

      // Optimistic: show the user's message + an empty assistant bubble.
      setMessages((m) => [...m, { role: 'user', content: q }, { role: 'assistant', content: '' }])

      // LIVE screen readout, captured now (excludes this panel's own text).
      const detail = captureScreenText(rootRef.current)

      const fail = (msg) =>
        setMessages((m) => {
          const copy = m.slice()
          copy[copy.length - 1] = { role: 'error', content: msg }
          return copy
        })

      try {
        const res = await fetch('/api/help-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ screen: { name: screenName, detail }, messages: apiMessages }),
        })
        if (!res.ok || !res.body) {
          let msg = "I couldn't reach the assistant, please try again."
          try {
            const j = await res.json()
            if (j && j.error) msg = j.error
          } catch {
            /* non-JSON error — keep the friendly default */
          }
          fail(msg)
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let acc = ''
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          acc += decoder.decode(value, { stream: true })
          setMessages((m) => {
            const copy = m.slice()
            copy[copy.length - 1] = { role: 'assistant', content: acc }
            return copy
          })
        }
        if (!acc.trim()) fail("I couldn't reach the assistant, please try again.")
      } catch {
        fail("I couldn't reach the assistant, please try again.")
      } finally {
        setSending(false)
      }
    },
    [messages, sending, screenName],
  )

  const bubbleFor = (m, i) => {
    const isUser = m.role === 'user'
    const isError = m.role === 'error'
    const bg = isUser ? T.accent.soft : isError ? T.state.danger.soft : T.surface.sunken
    const color = isError ? T.state.danger.fg : T.ink.primary
    return (
      <div
        key={i}
        style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: '10px' }}
      >
        <div
          style={{
            maxWidth: '86%',
            background: bg,
            color,
            border: isUser ? 'none' : T.border.thin,
            borderRadius: T.radius.inset,
            padding: '10px 12px',
            fontSize: '14px',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {m.content || (m.role === 'assistant' && sending ? '…' : '')}
        </div>
      </div>
    )
  }

  const shell = isMobile
    ? {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: '85vh',
        borderRadius: `${T.radius.card} ${T.radius.card} 0 0`,
        boxShadow: T.shadow.sheet,
      }
    : {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(420px, 100vw)',
        borderLeft: T.border.card,
        boxShadow: T.shadow.drawer,
      }

  const showChips = !sending && messages.filter((m) => m.role === 'user').length === 0

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10006,
        background: T.surface.scrim,
        display: 'flex',
        justifyContent: isMobile ? 'center' : 'flex-end',
        alignItems: isMobile ? 'flex-end' : 'stretch',
      }}
      onClick={onClose}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-label="Ask Bee Hub help chat"
        onClick={(e) => e.stopPropagation()}
        style={{
          ...shell,
          background: T.surface.raised,
          display: 'flex',
          flexDirection: 'column',
          maxWidth: '100vw',
        }}
      >
        {/* Header — screen line + close */}
        <div
          style={{
            flexShrink: 0,
            padding: '14px 14px 12px',
            borderBottom: T.border.thin,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
          }}
        >
          <span
            style={{
              width: '32px',
              height: '32px',
              flexShrink: 0,
              borderRadius: T.radius.round,
              background: T.accent.soft,
              color: T.accent.deep,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconSparkles size={17} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: T.ink.primary, lineHeight: 1.2 }}>Ask Bee Hub</p>
            <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '2px' }}>
              You&apos;re on: {screenName}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close help chat"
            style={{
              width: '32px',
              height: '32px',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: T.ink.quiet,
              cursor: 'pointer',
              borderRadius: T.radius.control,
            }}
          >
            <IconX size={16} />
          </button>
        </div>

        {/* Thread */}
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px' }}>
          {messages.map(bubbleFor)}

          {showChips && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  style={{
                    padding: '7px 11px',
                    borderRadius: T.radius.pill,
                    border: T.border.control,
                    background: T.surface.raised,
                    color: T.ink.secondary,
                    fontSize: '12.5px',
                    fontFamily: 'inherit',
                    fontWeight: 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Composer */}
        <div style={{ flexShrink: 0, borderTop: T.border.thin, padding: '10px 12px' }}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
            style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(input)
                }
              }}
              rows={1}
              placeholder="Ask a question…"
              style={{
                flex: 1,
                resize: 'none',
                maxHeight: '120px',
                minHeight: '40px',
                padding: '10px 12px',
                borderRadius: T.radius.control,
                border: T.border.control,
                background: T.surface.raised,
                color: T.ink.primary,
                fontSize: '14px',
                fontFamily: 'inherit',
                lineHeight: 1.4,
                outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              aria-label="Send"
              style={{
                width: '40px',
                height: '40px',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                borderRadius: T.radius.control,
                background: sending || !input.trim() ? T.hairline.control : T.accent.fg,
                color: T.accent.onFill,
                cursor: sending || !input.trim() ? 'default' : 'pointer',
              }}
            >
              <IconSend size={16} />
            </button>
          </form>

          {/* Escalation link — report a bug or request a feature. */}
          {onOpenFeedback && (
            <p style={{ fontSize: '11.5px', color: T.ink.muted, marginTop: '8px', lineHeight: 1.5 }}>
              Something not working?{' '}
              <button onClick={onOpenFeedback} style={linkBtn}>
                Report Bug or Feature
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

const linkBtn = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  color: T.accent.deep,
  fontSize: '11.5px',
  fontFamily: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
  textDecoration: 'underline',
}
