// components/hive/shared/AddressAutofill.jsx
// ─────────────────────────────────────────────────────────────
// Google Places-backed address typeahead — EXTRACTED VERBATIM from
// components/BeeHub.jsx (classic side) so the hive AddressField can
// mount the same autocomplete. External API unchanged
// (value/onChange/onSelect/onParsed/placeholder/style) — the classic
// call sites import from here and don't need touching.
//
// How it works:
//   1. User types → debounced → POST /api/places/autocomplete
//   2. Show predictions → user clicks one → POST /api/places/details
//   3. Resolve to {street, city, state, zip}, fire onParsed
//   4. Regenerate session token (each cycle = one billable session)
//
// Failure modes are non-blocking: a Places error (including a missing
// GOOGLE_PLACES_API_KEY server-side) falls back to letting the user
// type manually. parseAddress() is the client-side fallback if
// /details fails after a successful /autocomplete.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef } from 'react'

// Parse "123 Main St, Denver CO 80202" → {street, city, state, zip, full}
export function parseAddress(s) {
  const parts = s.split(',')
  const street = (parts[0]||'').trim()
  const rest   = (parts[1]||'').trim()
  const tokens = rest.split(' ').filter(Boolean)
  const zip    = /^\d{5}/.test(tokens[tokens.length-1]||'') ? tokens.pop() : ''
  const state  = tokens.pop()||''
  const city   = tokens.join(' ')
  return { full:s, street, city, state, zip }
}

// onKeyDown is an additive prop for the hive AddressField (Enter saves /
// Esc cancels its inline edit) — the classic call sites don't pass it.
export default function AddressAutofill({ value, onChange, onSelect, onParsed, placeholder='Start typing a street address...', style:extraStyle={}, onKeyDown }) {
  const [suggestions, setSuggestions] = useState([])
  const [showDrop, setShowDrop] = useState(false)
  const [loading, setLoading] = useState(false)
  const debounceRef     = useRef(null)
  const sessionTokenRef = useRef(null)
  const reqIdRef        = useRef(0)

  // Session token lifecycle: created on first use, regenerated after each
  // pick. Reusing the token across keystrokes + /details bundles them under
  // one billable session (Google's session-based pricing is ~10x cheaper
  // than per-call). Token is opaque to us — any UUID works.
  function newSessionToken() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      sessionTokenRef.current = crypto.randomUUID()
    } else {
      sessionTokenRef.current = String(Date.now()) + '-' + Math.random().toString(36).slice(2)
    }
  }
  if (sessionTokenRef.current === null) newSessionToken()

  async function fetchPredictions(query) {
    // reqId guards against stale responses: if user keeps typing while a
    // request is in flight, only the most recent response's results show.
    const myReqId = ++reqIdRef.current
    setLoading(true)
    try {
      const res = await fetch('/api/places/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: query, sessiontoken: sessionTokenRef.current }),
      })
      const json = await res.json().catch(() => ({}))
      if (myReqId !== reqIdRef.current) return
      if (!res.ok) {
        setSuggestions([])
        setShowDrop(false)
        return
      }
      const preds = json.predictions || []
      setSuggestions(preds)
      setShowDrop(preds.length > 0)
    } catch {
      // Network/parse failure — graceful degrade to no suggestions.
      // User can still type manually; the form's plain text input works.
      if (myReqId === reqIdRef.current) {
        setSuggestions([])
        setShowDrop(false)
      }
    } finally {
      if (myReqId === reqIdRef.current) setLoading(false)
    }
  }

  function handleInput(val) {
    onChange(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (val.length > 2) {
      debounceRef.current = setTimeout(() => fetchPredictions(val), 175)
    } else {
      setSuggestions([])
      setShowDrop(false)
      setLoading(false)
    }
  }

  async function pick(prediction) {
    // Optimistic UI: drop the prediction's description into the input
    // immediately, then refine to the canonical formatted address once
    // /details returns.
    onChange(prediction.description)
    setSuggestions([])
    setShowDrop(false)
    if (onSelect) onSelect(prediction.description)

    try {
      const res = await fetch('/api/places/details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          place_id: prediction.place_id,
          sessiontoken: sessionTokenRef.current,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok && onParsed) {
        onParsed({
          full:   json.formatted || prediction.description,
          street: json.street    || '',
          apt:    json.apt       || '',
          city:   json.city      || '',
          state:  json.state     || '',
          zip:    json.zip       || '',
        })
      } else if (onParsed) {
        // /details failed — best-effort parse from the description string.
        onParsed(parseAddress(prediction.description))
      }
    } catch {
      if (onParsed) onParsed(parseAddress(prediction.description))
    } finally {
      // Next autocomplete cycle starts a fresh session
      newSessionToken()
    }
  }

  return (
    <div style={{ position:'relative' }}>
      <input
        value={value}
        onChange={e=>handleInput(e.target.value)}
        onBlur={()=>setTimeout(()=>setShowDrop(false),150)}
        onFocus={()=>{ if(suggestions.length>0) setShowDrop(true) }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ width:'100%', padding:'10px 12px', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'8px', fontSize:'16px', fontFamily:'inherit', color:'#1a2e2b', outline:'none', boxSizing:'border-box', ...extraStyle }}
      />
      {loading && value.length > 2 && (
        <div style={{ position:'absolute', top:'50%', right:'12px', transform:'translateY(-50%)', fontSize:'11px', color:'#8a9e9a', pointerEvents:'none' }}>
          Searching…
        </div>
      )}
      {showDrop && suggestions.length > 0 && (
        <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'white', border:'1px solid rgba(0,0,0,0.1)', borderRadius:'10px', boxShadow:'0 6px 20px rgba(0,0,0,0.1)', zIndex:300, marginTop:'4px', overflow:'hidden' }}>
          {suggestions.map((s,i)=>(
            <button key={s.place_id||i} onMouseDown={()=>pick(s)} style={{ width:'100%', padding:'10px 14px', background:'white', border:'none', borderBottom:i<suggestions.length-1?'1px solid rgba(0,0,0,0.05)':'none', cursor:'pointer', textAlign:'left', fontFamily:'inherit', display:'flex', alignItems:'center', gap:'8px' }}>
              <span style={{ fontSize:'14px', flexShrink:0 }}>📍</span>
              <div style={{ flex:1, minWidth:0 }}>
                <p style={{ fontSize:'13px', color:'#1a2e2b', fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.main_text || s.description.split(',')[0]}</p>
                <p style={{ fontSize:'11px', color:'#8a9e9a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.secondary_text || s.description.split(',').slice(1).join(',').trim()}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
