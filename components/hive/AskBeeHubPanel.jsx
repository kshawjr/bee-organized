// components/hive/AskBeeHubPanel.jsx
// ─────────────────────────────────────────────────────────────
// "Ask Bee Hub" — the screen-aware in-app help chat, help-companion pass
// (#79, direction B).
//
// DESKTOP is now a floating companion window — 400 × min(560px,
// viewport − 96px), hovering 24px off the bottom-right corner with
// radius.card on all corners — NOT a full-height drawer, and with NO
// scrim: the panel coexists with the screen it explains (it's
// screen-aware — you should be able to look at the page while reading
// the answer). Click anywhere outside closes it; so does Esc. MOBILE
// keeps the bottom sheet (85vh, scrim, scroll lock).
//
// Identity: sage header band + gold-ringed bee mark; the empty state is
// a goldSoft honeycomb welcome card over staggered question chips; the
// waiting state pulses three hex cells beside a "Gathering an answer…"
// label while the bee avatar bobs. All motion is functional (open,
// arrival, waiting), transform/opacity only, and gated on
// useReducedMotion — reduced users get everything static, with the text
// label carrying the waiting status.
//
// It answers how-to questions (it does NOT take actions) and is
// SCREEN-AWARE: on each question it captures a LIVE readout of the
// current screen — the friendly screen name (passed in from App state)
// plus a lightweight DOM text snapshot of what is actually rendered
// (headings, tab/section labels, button text). No maintained knowledge
// doc, so it stays current as the app changes.
//
// The Anthropic call happens server-side at /api/help-chat (the API key
// is never exposed to the browser); this component just streams the
// reply.
//
// Tokens-only (the hive hex/rgba sweep covers this file) — every color,
// radius, and shadow resolves through shared/tokens (sage washes via the
// exported sage() helper). Suggestion chips wear .bee-chip-action (the
// 13.5px release from the 16px!important button floor — see globals.css);
// the footer link wears .bee-small-action.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { IconX, IconSend } from '@/components/ui/icons'
import { T, sage } from './shared/tokens'
import { useReducedMotion, useMotionKeyframes } from './shared/motion'

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

// The little honeycomb cell — the brand hex, clip-path only (no color of
// its own; callers hand in a token fill). Decorative, aria-hidden.
const hexClip = 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)'

export default function AskBeeHubPanel({
  isMobile,
  onClose,
  screenName = 'Bee Hub',
  onOpenFeedback = null,
}) {
  const rootRef = useRef(null)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const reduced = useReducedMotion()
  useMotionKeyframes()
  const [messages, setMessages] = useState([
    { role: 'assistant', content: `Hi! I see you're on the ${screenName} screen — how can I help?` },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const suggestions = screenHints(screenName)

  // Esc closes on both breakpoints. The scroll lock is MOBILE-ONLY now:
  // the desktop float deliberately leaves the page usable behind it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    if (!isMobile) return () => document.removeEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, isMobile])

  // Desktop has no scrim to click, so outside-click closes via a document
  // listener instead. mousedown (not click) so a drag that starts on the
  // page closes it immediately, matching scrim behavior.
  useEffect(() => {
    if (isMobile) return
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [isMobile, onClose])

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

  // Messages ease up 8px as they arrive — functional (marks arrival),
  // short, transform/opacity only. Skipped entirely under reduced motion.
  const msgAnim = reduced ? undefined : 'beeMsgIn 0.18s cubic-bezier(0.2,0.8,0.2,1) both'

  // The sage bee disc that fronts every assistant turn — the companion's
  // face. It bobs gently while an answer is being gathered.
  const beeDisc = (bobbing) => (
    <span
      aria-hidden="true"
      style={{
        width: '26px',
        height: '26px',
        flexShrink: 0,
        alignSelf: 'flex-end',
        borderRadius: T.radius.round,
        background: T.brand.sage,
        color: T.brand.onSage,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '13px',
        animation: bobbing && !reduced ? 'beeBob 1.3s ease-in-out infinite alternate' : undefined,
      }}
    >
      🐝
    </span>
  )

  // Waiting state — three brand hex cells pulse in sequence beside a text
  // label. The LABEL is the accessible status: under reduced motion the
  // cells hold still and the words alone say what's happening.
  const typing = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '9px' }}>
      <span aria-hidden="true" style={{ display: 'inline-flex', gap: '4px' }}>
        {[T.brand.sage, T.brand.gold, T.brand.sage].map((fill, i) => (
          <i
            key={i}
            style={{
              width: '10px',
              height: '11px',
              clipPath: hexClip,
              background: fill,
              opacity: reduced ? 0.7 : undefined,
              animation: reduced ? undefined : `beeCellPulse 1.3s ease-in-out ${i * 0.18}s infinite`,
            }}
          />
        ))}
      </span>
      <span style={{ fontSize: '13px', color: T.ink.muted }}>Gathering an answer…</span>
    </span>
  )

  const bubbleFor = (m, i) => {
    const isUser = m.role === 'user'
    const isError = m.role === 'error'
    const waiting = m.role === 'assistant' && !m.content && sending
    return (
      <div
        key={i}
        style={{
          display: 'flex',
          justifyContent: isUser ? 'flex-end' : 'flex-start',
          gap: '8px',
          marginBottom: '12px',
          animation: msgAnim,
        }}
      >
        {!isUser && beeDisc(waiting)}
        <div
          style={{
            maxWidth: '76%',
            background: isUser ? T.accent.fg : isError ? T.state.danger.soft : T.surface.sunken,
            color: isUser ? T.accent.onFill : isError ? T.state.danger.fg : T.ink.primary,
            borderRadius: isUser
              ? `${T.radius.card} ${T.radius.card} ${T.radius.control} ${T.radius.card}`
              : `${T.radius.card} ${T.radius.card} ${T.radius.card} ${T.radius.control}`,
            padding: '10px 14px',
            fontSize: '15px',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {waiting ? typing : m.content}
        </div>
      </div>
    )
  }

  // The floating companion window (desktop) / bottom sheet (mobile).
  // Desktop deliberately does NOT span the viewport: canvas stays visible
  // above and beside it, and there is no scrim.
  const shell = isMobile
    ? {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: '85vh',
        borderRadius: `${T.radius.card} ${T.radius.card} 0 0`,
        boxShadow: T.shadow.sheet,
        animation: reduced ? undefined : 'beeSheetUp 0.32s cubic-bezier(0.2,0.8,0.2,1)',
      }
    : {
        position: 'fixed',
        right: '24px',
        bottom: '24px',
        width: 'min(400px, calc(100vw - 32px))',
        height: 'min(560px, calc(100vh - 96px))',
        border: T.border.card,
        borderRadius: T.radius.card,
        boxShadow: T.shadow.drawer,
        animation: reduced ? undefined : 'beePanelRise 0.3s cubic-bezier(0.2,0.8,0.2,1)',
      }

  const hasUserTurns = messages.some((m) => m.role === 'user')

  const panel = (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Ask Bee Hub help chat"
      onClick={(e) => e.stopPropagation()}
      style={{
        ...shell,
        zIndex: 10006,
        background: T.surface.raised,
        display: 'flex',
        flexDirection: 'column',
        maxWidth: '100vw',
        overflow: 'hidden',
      }}
    >
      {/* Header — the identity moment: a sage wash band with the
          gold-ringed bee mark. Text on the band is onSage/secondary ink,
          never white (white-on-sage is a banned pair). */}
      <div
        style={{
          flexShrink: 0,
          padding: '14px 16px',
          background: `linear-gradient(180deg, ${sage(0.28)}, ${sage(0.12)})`,
          borderBottom: T.border.thin,
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: '38px',
            height: '38px',
            flexShrink: 0,
            borderRadius: T.radius.round,
            background: T.surface.raised,
            border: `2px solid ${T.brand.gold}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '19px',
          }}
        >
          🐝
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '15px', fontWeight: 700, color: T.brand.onSage, lineHeight: 1.2, letterSpacing: T.type.trackTitle }}>
            Ask Bee Hub
          </p>
          <p style={{ fontSize: '12.5px', color: T.ink.secondary, marginTop: '1px' }}>
            Helping with: {screenName}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close help chat"
          style={{
            width: '30px',
            height: '30px',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: T.accent.deep,
            cursor: 'pointer',
            borderRadius: T.radius.round,
          }}
        >
          <IconX size={16} />
        </button>
      </div>

      {/* Thread */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 14px 10px' }}>
        {!hasUserTurns ? (
          <>
            {/* Empty state — the honeycomb welcome card. Text on the
                goldSoft wash is primary/secondary ink (gold never
                carries text). */}
            <div
              style={{
                position: 'relative',
                overflow: 'hidden',
                background: T.brand.goldSoft,
                border: T.border.thin,
                borderRadius: T.radius.card,
                padding: '18px 16px 16px',
                marginBottom: '14px',
                animation: msgAnim,
              }}
            >
              <span aria-hidden="true" style={{ position: 'absolute', top: '-14px', right: '-10px', display: 'flex', gap: '4px', opacity: 0.55 }}>
                <i style={{ width: '34px', height: '38px', clipPath: hexClip, background: sage(0.28) }} />
                <i style={{ width: '34px', height: '38px', clipPath: hexClip, background: T.brand.gold, opacity: 0.35, marginTop: '16px' }} />
                <i style={{ width: '34px', height: '38px', clipPath: hexClip, background: sage(0.28) }} />
              </span>
              <p style={{ fontSize: '16px', fontWeight: 700, color: T.ink.primary, letterSpacing: T.type.trackTitle, position: 'relative' }}>
                Hi! I can see your screen.
              </p>
              <p style={{ fontSize: '14px', color: T.ink.secondary, lineHeight: 1.55, marginTop: '5px', maxWidth: '30ch', position: 'relative' }}>
                Ask me anything about the {screenName} page — I&apos;ll walk you through it, step by step.
              </p>
            </div>

            <p style={{ fontSize: '12px', fontWeight: 600, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '2px 0 8px' }}>
              Popular questions
            </p>
            {suggestions.map((s, i) => (
              <button
                key={s}
                className="bee-chip-action"
                onClick={() => send(s)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  marginBottom: '7px',
                  border: T.border.thin,
                  borderRadius: T.radius.inset,
                  background: T.surface.raised,
                  color: T.ink.secondary,
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  cursor: 'pointer',
                  boxShadow: T.shadow.card,
                  animation: reduced ? undefined : `beeMsgIn 0.18s cubic-bezier(0.2,0.8,0.2,1) ${0.14 + i * 0.08}s both`,
                }}
              >
                <span aria-hidden="true" style={{ width: '12px', height: '13px', flexShrink: 0, clipPath: hexClip, background: T.brand.gold }} />
                {s}
              </button>
            ))}
          </>
        ) : (
          messages.map(bubbleFor)
        )}
      </div>

      {/* Composer — pill field + a compact round send. The field keeps
          16px type (the globals.css floor is an iOS zoom-on-focus guard
          and text fields are exactly what it exists for). */}
      <div style={{ flexShrink: 0, borderTop: T.border.thin, padding: '10px 14px 12px' }}>
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
              padding: '9px 16px',
              borderRadius: T.radius.pill,
              border: T.border.control,
              background: T.surface.raised,
              color: T.ink.primary,
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
              width: '34px',
              height: '34px',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              borderRadius: T.radius.round,
              background: sending || !input.trim() ? T.surface.sunken : T.accent.fg,
              color: sending || !input.trim() ? T.ink.quiet : T.accent.onFill,
              cursor: sending || !input.trim() ? 'default' : 'pointer',
            }}
          >
            <IconSend size={15} />
          </button>
        </form>

        {/* Escalation link — report a bug or request a feature. Wears the
            small-action release so the floor doesn't inflate it mid-line. */}
        {onOpenFeedback && (
          <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '8px', lineHeight: 1.5 }}>
            Something not working?{' '}
            <button onClick={onOpenFeedback} className="bee-small-action" style={linkBtn}>
              Report Bug or Feature
            </button>
          </p>
        )}
      </div>
    </div>
  )

  // Mobile keeps the scrim + sheet (tap-scrim closes, page locked).
  // Desktop mounts the float directly — no scrim, page stays usable.
  if (!isMobile) return panel
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10006,
        background: T.surface.scrim,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-end',
      }}
      onClick={onClose}
    >
      {panel}
    </div>
  )
}

const linkBtn = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  color: T.accent.deep,
  fontFamily: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
  textDecoration: 'underline',
}
