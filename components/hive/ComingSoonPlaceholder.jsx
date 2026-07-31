// components/hive/ComingSoonPlaceholder.jsx
// ─────────────────────────────────────────────────────────────
// Section-agnostic "coming soon" panel (issue 139). A section renders this with
// its own title + body when the feature is being rebuilt and nothing is wired
// behind it yet — Reports uses it now, and Back Office (issue 140) will pass its
// own label without touching this component. Deliberately dumb: no data, no
// role logic, no section knowledge. The copy is the caller's job.
//
// Audience note: the sections that use this face a 45-65, non-technical owner —
// callers should phrase title/body as "being built," never "broken."
//
// Tokens only — this file lives under the components/hive/** hex sweep, so every
// visual value resolves through T (comments included: reference issues as
// "issue NNN", never the # form the sweep reads as a hex literal).
import React from 'react'
import { T } from './shared/tokens'

export default function ComingSoonPlaceholder({ title, body, icon = '✨' }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'48px 24px', minHeight:'46vh' }}>
      <div style={{ width:'100%', maxWidth:'400px', background:T.surface.raised, borderRadius:T.radius.card, border:T.border.card, boxShadow:T.shadow.card, padding:'36px 28px', textAlign:'center' }}>
        <div style={{ width:'56px', height:'56px', borderRadius:T.radius.inset, background:`linear-gradient(135deg,${T.accent.deep},${T.accent.fg})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'26px', margin:'0 auto 18px' }} aria-hidden="true">{icon}</div>
        <p style={{ fontSize:'19px', fontWeight:700, color:T.ink.primary, fontFamily:'Georgia,serif', marginBottom:'8px' }}>{title}</p>
        <p style={{ fontSize:'14px', color:T.ink.muted, lineHeight:1.6 }}>{body}</p>
      </div>
    </div>
  )
}
