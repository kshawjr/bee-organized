'use client'

import { useState, useEffect } from 'react'
import { DEFAULT_PATHS, TOUCH_CONFIG, DripPath } from './paths'

// ─── Types ─────────────────────────────────────────────────────────────────

type Stage = 'New' | 'Nurturing' | 'Assessment Scheduled' | 'Quote' | 'Job in Progress' | 'Final Processing'
type ViewMode = 'kanban' | 'list'
type PanelTab = 'overview' | 'drip' | 'activity'
type TouchType = 'email' | 'sms' | 'call_prompt' | 'link' | 'wait'

interface ActivityEntry {
  id: string
  type: 'note' | 'email' | 'call' | 'stage' | 'system' | 'sms' | 'link'
  text: string
  timestamp: string
  user?: string
}

interface DripEmail {
  id: number
  subject: string
  scheduledAt: string
  sentAt?: string
  status: 'sent' | 'scheduled' | 'skipped'
  type: TouchType
}

interface Lead {
  id: string
  name: string
  phone: string
  email: string
  stage: Stage
  source: string
  projectType: string
  description?: string
  location: string
  createdAt: string
  address?: string
  scheduledAssessment?: string
  jobberStatus?: string
  jobber_client_id?: string
  location_id?: string
  quoteTotal?: number
  invoiceTotal?: number
  invoiceStatus?: string
  path: DripPath
  drips: DripEmail[]
  activity: ActivityEntry[]
  pausedDrip?: boolean
}

// ─── Stage Config ──────────────────────────────────────────────────────────

const STAGES: { key: Stage; label: string; color: string; bg: string; dot: string; icon: string }[] = [
  { key: 'New',                  label: 'New Lead',         color: '#6366f1', bg: 'rgba(99,102,241,0.08)',  dot: '#6366f1', icon: '✨' },
  { key: 'Nurturing',            label: 'Nurturing',        color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', dot: '#f59e0b', icon: '🌱' },
  { key: 'Assessment Scheduled', label: 'Assessment',       color: '#0ea5e9', bg: 'rgba(14,165,233,0.08)', dot: '#0ea5e9', icon: '📅' },
  { key: 'Quote',                label: 'Estimate Sent',    color: '#8b5cf6', bg: 'rgba(139,92,246,0.08)', dot: '#8b5cf6', icon: '📋' },
  { key: 'Job in Progress',      label: 'Job in Progress',  color: '#10b981', bg: 'rgba(16,185,129,0.08)', dot: '#10b981', icon: '🔨' },
  { key: 'Final Processing',     label: 'Final Processing', color: '#22c55e', bg: 'rgba(34,197,94,0.08)',  dot: '#22c55e', icon: '✅' },
]

const STAGE_ORDER = STAGES.map(s => s.key)

// ─── Helpers ───────────────────────────────────────────────────────────────

function getInitials(name: string) { return name.split(' ').map(w => w[0]).join('').slice(0, 2) }
function stageConfig(stage: Stage) { return STAGES.find(s => s.key === stage) || STAGES[0] }
function makeDrips(path: DripPath): DripEmail[] {
  return path.steps.map((s, i) => ({
    id: i + 1,
    subject: s.label,
    scheduledAt: s.day === 0 ? 'Immediately' : `Day ${s.day}`,
    status: 'scheduled' as const,
    type: s.type,
  }))
}

// ─── Shared UI ─────────────────────────────────────────────────────────────

function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.28, background: 'linear-gradient(135deg, #a8c9c4, #7ab5af)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.33, fontWeight: 700, color: 'white', flexShrink: 0, fontFamily: 'Playfair Display, serif' }}>
      {getInitials(name)}
    </div>
  )
}

function StagePill({ stage }: { stage: Stage }) {
  const s = stageConfig(stage)
  return <span style={{ fontSize: '11px', padding: '3px 9px', borderRadius: '20px', background: s.bg, color: s.color, fontWeight: 600 }}>{s.icon} {s.label}</span>
}

function SourcePill({ source }: { source: string }) {
  const map: Record<string, string> = { Website: '#0ea5e9', Referral: '#10b981', 'Word of Mouth': '#8b5cf6', Instagram: '#f59e0b', Facebook: '#6366f1' }
  const c = map[source] || '#6b7280'
  return <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '20px', background: `${c}18`, color: c, fontWeight: 500 }}>{source}</span>
}

// ─── Path Selector (mini) ─────────────────────────────────────────────────

function PathSelector({ selected, onChange }: { selected: DripPath; onChange: (p: DripPath) => void }) {
  return (
    <div style={{ display: 'grid', gap: '8px' }}>
      {DEFAULT_PATHS.map(path => {
        const tc = TOUCH_CONFIG[path.firstTouch]
        const isSelected = selected.id === path.id
        return (
          <div key={path.id} onClick={() => onChange(path)} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: isSelected ? 'rgba(168,201,196,0.12)' : 'white', border: `1.5px solid ${isSelected ? '#a8c9c4' : 'rgba(0,0,0,0.08)'}`, borderRadius: '10px', cursor: 'pointer', transition: 'all 0.15s' }}>
            <span style={{ fontSize: '18px', flexShrink: 0 }}>{path.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: '13px', fontWeight: 600, color: '#1a2e2b', marginBottom: '2px' }}>{path.name}</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '10px' }}>{tc.icon}</span>
                <span style={{ fontSize: '11px', color: tc.color }}>First: {tc.label}</span>
                <span style={{ fontSize: '11px', color: '#c8d8d4' }}>·</span>
                <span style={{ fontSize: '11px', color: '#8a9e9a' }}>{path.steps.length} steps</span>
              </div>
            </div>
            {isSelected && <span style={{ fontSize: '14px', color: '#a8c9c4', flexShrink: 0 }}>✓</span>}
          </div>
        )
      })}
    </div>
  )
}

// ─── Assessment Scheduler ─────────────────────────────────────────────────

function AssessmentScheduler({ lead, onSchedule, onClose }: { lead: Lead; onSchedule: (date: string, time: string) => void; onClose: () => void }) {
  const [date, setDate] = useState('')
  const [time, setTime] = useState('10:00')
  const times = ['8:00', '9:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10001, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(26,46,43,0.4)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'white', width: '100%', maxWidth: '420px', borderRadius: '20px 20px 0 0', padding: '1.5rem', zIndex: 1, boxShadow: '0 -8px 40px rgba(26,46,43,0.15)' }}>
        <div style={{ width: '36px', height: '4px', background: 'rgba(0,0,0,0.12)', borderRadius: '2px', margin: '0 auto 1.25rem' }} />
        <h3 style={{ fontSize: '17px', fontFamily: 'Playfair Display, serif', color: '#1a2e2b', marginBottom: '4px' }}>Schedule Assessment</h3>
        <p style={{ fontSize: '13px', color: '#8a9e9a', marginBottom: '1.25rem' }}>For {lead.name}</p>
        <div style={{ display: 'grid', gap: '12px', marginBottom: '1.25rem' }}>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, color: '#4a5e5a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px', display: 'block' }}>Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} min={new Date().toISOString().split('T')[0]} style={{ width: '100%', padding: '10px 12px', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '8px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', background: 'white', outline: 'none', boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, color: '#4a5e5a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px', display: 'block' }}>Time</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {times.map(t => (
                <button key={t} onClick={() => setTime(t)} style={{ padding: '7px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', border: '1.5px solid', borderColor: time === t ? '#a8c9c4' : 'rgba(0,0,0,0.08)', background: time === t ? 'rgba(168,201,196,0.15)' : 'white', color: time === t ? '#1a2e2b' : '#4a5e5a', fontWeight: time === t ? 600 : 400 }}>{t}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onClose} style={{ flex: 1, padding: '12px', background: 'transparent', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => date && onSchedule(date, time)} disabled={!date} style={{ flex: 2, padding: '12px', background: date ? '#1a2e2b' : '#e5e7eb', border: 'none', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: date ? 'white' : '#9ca3af', cursor: date ? 'pointer' : 'not-allowed' }}>📅 Confirm</button>
        </div>
      </div>
    </div>
  )
}

// ─── Add Note ─────────────────────────────────────────────────────────────

function AddNoteModal({ onAdd, onClose }: { onAdd: (text: string, type: 'note' | 'call') => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [type, setType] = useState<'note' | 'call'>('note')

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10001, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(26,46,43,0.4)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'white', width: '100%', maxWidth: '420px', borderRadius: '20px 20px 0 0', padding: '1.5rem', zIndex: 1, boxShadow: '0 -8px 40px rgba(26,46,43,0.15)' }}>
        <div style={{ width: '36px', height: '4px', background: 'rgba(0,0,0,0.12)', borderRadius: '2px', margin: '0 auto 1.25rem' }} />
        <h3 style={{ fontSize: '17px', fontFamily: 'Playfair Display, serif', color: '#1a2e2b', marginBottom: '1rem' }}>Log Activity</h3>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
          {([['note', '📝 Note'], ['call', '📞 Call']] as ['note' | 'call', string][]).map(([v, l]) => (
            <button key={v} onClick={() => setType(v)} style={{ flex: 1, padding: '8px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', border: '1.5px solid', borderColor: type === v ? '#a8c9c4' : 'rgba(0,0,0,0.08)', background: type === v ? 'rgba(168,201,196,0.15)' : 'white', color: '#1a2e2b', fontWeight: type === v ? 600 : 400 }}>{l}</button>
          ))}
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder={type === 'call' ? 'What happened on the call?' : 'Add a note...'} style={{ width: '100%', padding: '10px 12px', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '8px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', outline: 'none', resize: 'none', height: '100px', boxSizing: 'border-box', marginBottom: '1rem' }} />
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onClose} style={{ flex: 1, padding: '12px', background: 'transparent', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => text.trim() && onAdd(text.trim(), type)} disabled={!text.trim()} style={{ flex: 2, padding: '12px', background: text.trim() ? '#1a2e2b' : '#e5e7eb', border: 'none', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: text.trim() ? 'white' : '#9ca3af', cursor: text.trim() ? 'pointer' : 'not-allowed' }}>Save</button>
        </div>
      </div>
    </div>
  )
}

// ─── Lead Panel ────────────────────────────────────────────────────────────

function LeadPanel({ lead, onClose, onUpdate }: { lead: Lead; onClose: () => void; onUpdate: (l: Lead) => void }) {
  const [tab, setTab] = useState<PanelTab>('overview')
  const [showScheduler, setShowScheduler] = useState(false)
  const [showAddNote, setShowAddNote] = useState(false)
  const s = stageConfig(lead.stage)
  const stageIdx = STAGE_ORDER.indexOf(lead.stage)
  const canGoForward = stageIdx < STAGE_ORDER.length - 1
  const canGoBack = stageIdx > 0
  const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const dripSent = lead.drips.filter(d => d.status === 'sent').length

  function update(patch: Partial<Lead>, activityText?: string) {
    onUpdate({
      ...lead,
      ...patch,
      activity: activityText ? [...lead.activity, { id: `a${Date.now()}`, type: 'stage' as const, text: activityText, timestamp: now }] : lead.activity,
    })
  }

  function handleSchedule(date: string, time: string) {
    const formatted = new Date(`${date}T${time}`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    update({ stage: 'Assessment Scheduled', scheduledAssessment: formatted }, `Assessment scheduled for ${formatted}`)
    setShowScheduler(false)
  }

  function handleAddNote(text: string, type: 'note' | 'call') {
    onUpdate({ ...lead, activity: [...lead.activity, { id: `a${Date.now()}`, type, text, timestamp: now, user: 'You' }] })
    setShowAddNote(false)
  }

  function handleChangePath(path: DripPath) {
    update({ path, drips: makeDrips(path) }, `Path changed to ${path.name}`)
  }

  const tabBtn = (key: PanelTab, label: string) => (
    <button onClick={() => setTab(key)} style={{ flex: 1, padding: '8px', border: 'none', cursor: 'pointer', fontFamily: 'DM Sans, sans-serif', fontSize: '13px', fontWeight: tab === key ? 600 : 400, background: 'transparent', color: tab === key ? '#1a2e2b' : '#8a9e9a', borderBottom: `2px solid ${tab === key ? '#a8c9c4' : 'transparent'}`, transition: 'all 0.15s' }}>{label}</button>
  )

  const actIcon = (type: string) => ({ email: '📧', call: '📞', note: '📝', stage: '→', system: '·', sms: '💬', link: '🔗' }[type] || '·')

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'flex-end' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(26,46,43,0.25)' }} onClick={onClose} />
        <div style={{ position: 'relative', background: 'white', width: '100%', borderRadius: '20px 20px 0 0', zIndex: 1, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 -8px 40px rgba(26,46,43,0.15)' }}>
          <div style={{ width: '36px', height: '4px', background: 'rgba(0,0,0,0.12)', borderRadius: '2px', margin: '12px auto 0' }} />

          {/* Header */}
          <div style={{ padding: '1rem 1.5rem 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Avatar name={lead.name} size={44} />
                <div>
                  <h2 style={{ fontSize: '17px', fontFamily: 'Playfair Display, serif', color: '#1a2e2b', marginBottom: '4px' }}>{lead.name}</h2>
                  <StagePill stage={lead.stage} />
                </div>
              </div>
              <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '22px', color: '#8a9e9a', cursor: 'pointer', padding: '4px 8px', lineHeight: 1 }}>×</button>
            </div>

            {/* Stage dots */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '12px', overflowX: 'auto', paddingBottom: '2px' }}>
              {STAGES.map((stage, i) => {
                const isActive = stage.key === lead.stage
                const isPast = i < stageIdx
                return (
                  <div key={stage.key} style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: isActive ? stage.dot : isPast ? '#a8c9c4' : 'rgba(0,0,0,0.1)', boxShadow: isActive ? `0 0 0 3px ${stage.dot}30` : 'none', transition: 'all 0.2s' }} />
                    {i < STAGES.length - 1 && <div style={{ width: '20px', height: '2px', background: isPast ? '#a8c9c4' : 'rgba(0,0,0,0.08)', borderRadius: '1px' }} />}
                  </div>
                )
              })}
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex' }}>
              {tabBtn('overview', 'Overview')}
              {tabBtn('drip', `Drip (${dripSent}/${lead.drips.length})`)}
              {tabBtn('activity', `Activity (${lead.activity.length})`)}
            </div>
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem' }}>

            {tab === 'overview' && (
              <div style={{ display: 'grid', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {[
                    ['📞 Phone', lead.phone || '—'],
                    ['✉️ Email', lead.email || '—'],
                    ['🏠 Project', lead.projectType],
                    ['📣 Source', lead.source],
                  ].map(([lbl, val]) => (
                    <div key={lbl} style={{ background: '#f7f5f0', borderRadius: '10px', padding: '10px 12px' }}>
                      <p style={{ fontSize: '10px', color: '#8a9e9a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>{lbl}</p>
                      <p style={{ fontSize: '13px', color: '#1a2e2b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val}</p>
                    </div>
                  ))}
                </div>

                {/* Address */}
                {lead.address && (
                  <div style={{ background: '#f7f5f0', borderRadius: '10px', padding: '10px 12px' }}>
                    <p style={{ fontSize: '10px', color: '#8a9e9a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>📍 Address</p>
                    <p style={{ fontSize: '13px', color: '#1a2e2b' }}>{lead.address}</p>
                  </div>
                )}

                {/* Description */}
                {lead.description && (
                  <div style={{ background: '#f7f5f0', borderRadius: '10px', padding: '10px 12px' }}>
                    <p style={{ fontSize: '10px', color: '#8a9e9a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>📋 Notes</p>
                    <p style={{ fontSize: '13px', color: '#1a2e2b', lineHeight: 1.5 }}>{lead.description}</p>
                  </div>
                )}

                {/* Assessment */}
                {lead.scheduledAssessment && (
                  <div style={{ background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.2)', borderRadius: '10px', padding: '10px 12px' }}>
                    <p style={{ fontSize: '10px', color: '#0ea5e9', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>📅 Assessment</p>
                    <p style={{ fontSize: '13px', color: '#0369a1', fontWeight: 500 }}>{lead.scheduledAssessment}</p>
                  </div>
                )}

                {/* Jobber status */}
                {lead.jobberStatus && (
                  <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '10px 12px' }}>
                    <p style={{ fontSize: '10px', color: '#10b981', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>⚡ Jobber</p>
                    <p style={{ fontSize: '13px', color: '#065f46', fontWeight: 500 }}>{lead.jobberStatus}</p>
                  </div>
                )}

                {/* Financials */}
                {(lead.quoteTotal || lead.invoiceTotal) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    {lead.quoteTotal && (
                      <div style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.15)', borderRadius: '10px', padding: '10px 12px' }}>
                        <p style={{ fontSize: '10px', color: '#8b5cf6', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>📋 Estimate</p>
                        <p style={{ fontSize: '14px', color: '#1a2e2b', fontWeight: 700 }}>${lead.quoteTotal.toLocaleString()}</p>
                      </div>
                    )}
                    {lead.invoiceTotal && (
                      <div style={{ background: lead.invoiceStatus === 'paid' ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)', border: `1px solid ${lead.invoiceStatus === 'paid' ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)'}`, borderRadius: '10px', padding: '10px 12px' }}>
                        <p style={{ fontSize: '10px', color: lead.invoiceStatus === 'paid' ? '#22c55e' : '#f59e0b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>🧾 Invoice {lead.invoiceStatus === 'paid' ? '✅' : ''}</p>
                        <p style={{ fontSize: '14px', color: '#1a2e2b', fontWeight: 700 }}>${lead.invoiceTotal.toLocaleString()}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {(lead.stage === 'New' || lead.stage === 'Nurturing') && (
                    <button onClick={() => setShowScheduler(true)} style={{ flex: 1, minWidth: '140px', padding: '10px', background: '#0ea5e9', border: 'none', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer' }}>📅 Schedule Assessment</button>
                  )}
                  {(lead.stage === 'Assessment Scheduled' || lead.stage === 'Quote') && (
                    <button
                      onClick={() => {
                        if (!lead.phone || !lead.email) {
                          alert(`Please add ${!lead.phone ? 'phone number' : ''}${!lead.phone && !lead.email ? ' and ' : ''}${!lead.email ? 'email' : ''} before sending to Jobber.`)
                          return
                        }
                        alert('Send to Jobber — coming soon!')
                      }}
                      style={{ flex: 1, minWidth: '140px', padding: '10px', background: '#10b981', border: 'none', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer' }}
                    >⚡ Send to Jobber</button>
                  )}
                  {canGoBack && (
                    <button onClick={() => update({ stage: STAGE_ORDER[stageIdx - 1] as Stage }, `Moved back to ${stageConfig(STAGE_ORDER[stageIdx - 1] as Stage).label}`)} style={{ padding: '10px 14px', background: 'white', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>← Back</button>
                  )}
                  {canGoForward && lead.stage !== 'Assessment Scheduled' && lead.stage !== 'Quote' && (
                    <button onClick={() => update({ stage: STAGE_ORDER[stageIdx + 1] as Stage }, `Moved to ${stageConfig(STAGE_ORDER[stageIdx + 1] as Stage).label}`)} style={{ flex: 1, padding: '10px', background: '#1a2e2b', border: 'none', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer' }}>Move to {stageConfig(STAGE_ORDER[stageIdx + 1] as Stage).label} →</button>
                  )}
                </div>
                <button onClick={() => setShowAddNote(true)} style={{ width: '100%', padding: '10px', background: 'transparent', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>📝 Log Activity</button>
              </div>
            )}

            {tab === 'drip' && (
              <div style={{ display: 'grid', gap: '10px' }}>
                <div style={{ padding: '12px 14px', background: 'rgba(168,201,196,0.1)', borderRadius: '10px', border: '1px solid rgba(168,201,196,0.2)' }}>
                  <p style={{ fontSize: '13px', color: '#4a5e5a' }}>Drip path integration coming soon. Emails managed via your current system.</p>
                </div>
                <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '1rem' }}>
                  <p style={{ fontSize: '11px', fontWeight: 600, color: '#8a9e9a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Assign Path</p>
                  <PathSelector selected={lead.path || DEFAULT_PATHS[0]} onChange={p => update({ path: p, drips: makeDrips(p) }, `Path changed to ${p.name}`)} />
                </div>
              </div>
            )}

            {tab === 'activity' && (
              <div>
                <button onClick={() => setShowAddNote(true)} style={{ width: '100%', padding: '10px', background: 'rgba(168,201,196,0.15)', border: '1.5px solid rgba(168,201,196,0.3)', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: '#1a2e2b', cursor: 'pointer', marginBottom: '1rem' }}>+ Log Activity</button>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {[...lead.activity].reverse().map(entry => (
                    <div key={entry.id} style={{ display: 'flex', gap: '10px', padding: '10px 12px', background: '#f7f5f0', borderRadius: '10px' }}>
                      <span style={{ fontSize: '16px', flexShrink: 0 }}>{actIcon(entry.type)}</span>
                      <div>
                        <p style={{ fontSize: '13px', color: '#1a2e2b', lineHeight: 1.4 }}>{entry.text}</p>
                        <p style={{ fontSize: '11px', color: '#8a9e9a', marginTop: '3px' }}>{entry.timestamp}{entry.user ? ` · ${entry.user}` : ''}</p>
                      </div>
                    </div>
                  ))}
                  {lead.activity.length === 0 && <p style={{ fontSize: '13px', color: '#b0c0bc', textAlign: 'center', padding: '2rem' }}>No activity yet.</p>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showScheduler && <AssessmentScheduler lead={lead} onSchedule={handleSchedule} onClose={() => setShowScheduler(false)} />}
      {showAddNote && <AddNoteModal onAdd={handleAddNote} onClose={() => setShowAddNote(false)} />}
    </>
  )
}

// ─── New Lead Modal ────────────────────────────────────────────────────────

function NewLeadModal({ onClose, onCreate, defaultPath }: { onClose: () => void; onCreate: (l: Lead) => void; defaultPath: DripPath }) {
  const [step, setStep] = useState(1)
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', source: 'Website', projectType: 'Home Organization', description: '', street: '', city: '', state: '', zip: '' })
  const [selectedPath, setSelectedPath] = useState<DripPath>(defaultPath)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const input: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '8px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', background: 'white', outline: 'none', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: '#4a5e5a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px', display: 'block' }

  const STEPS = ['Contact', 'Project', 'Path']

  async function handleCreate() {
    const name = `${form.firstName} ${form.lastName}`.trim()
    const newLead: Lead = {
      id: `new-${Date.now()}`,
      name,
      phone: form.phone,
      email: form.email,
      stage: 'New',
      source: form.source,
      projectType: form.projectType,
      description: form.description,
      location: 'loc',
      address: [form.street, form.city, form.state, form.zip].filter(Boolean).join(', '),
      createdAt: 'Just now',
      pausedDrip: false,
      path: selectedPath,
      drips: makeDrips(selectedPath),
      activity: [{ id: `a${Date.now()}`, type: 'system', text: `Lead created · ${selectedPath.name} path started`, timestamp: 'Just now' }],
    }

    // Write to Supabase
    try {
      await fetch('/api/hive/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name:   form.firstName,
          last_name:    form.lastName,
          name,
          phone:        form.phone || null,
          email:        form.email || null,
          source:       form.source,
          project_type: form.projectType,
          description:  form.description || null,
          address:      form.street || null,
          city:         form.city || null,
          state:        form.state || null,
          zip:          form.zip || null,
        }),
      })
    } catch (err) {
      console.error('Failed to save lead to Supabase:', err)
    }

    onCreate(newLead)
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(26,46,43,0.4)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'white', width: '100%', maxWidth: '540px', borderRadius: '20px 20px 0 0', padding: '1.5rem', zIndex: 1, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 -8px 40px rgba(26,46,43,0.15)' }}>
        <div style={{ width: '36px', height: '4px', background: 'rgba(0,0,0,0.12)', borderRadius: '2px', margin: '0 auto 1.25rem' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontFamily: 'Playfair Display, serif', color: '#1a2e2b' }}>New Client</h2>
            <p style={{ fontSize: '12px', color: '#8a9e9a', marginTop: '2px' }}>Step {step} of {STEPS.length} — {STEPS[step - 1]}</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '22px', color: '#8a9e9a', cursor: 'pointer', padding: '4px 8px', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ display: 'flex', gap: '4px', marginBottom: '1.25rem' }}>
          {STEPS.map((_, i) => <div key={i} style={{ height: '3px', flex: 1, borderRadius: '2px', background: i < step ? '#a8c9c4' : 'rgba(0,0,0,0.08)', transition: 'background 0.2s' }} />)}
        </div>

        {step === 1 && (
          <div style={{ display: 'grid', gap: '14px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div><label style={lbl}>First Name *</label><input style={input} placeholder="Sarah" value={form.firstName} onChange={e => set('firstName', e.target.value)} /></div>
              <div><label style={lbl}>Last Name *</label><input style={input} placeholder="Mitchell" value={form.lastName} onChange={e => set('lastName', e.target.value)} /></div>
            </div>
            <div><label style={lbl}>Phone</label><input style={input} placeholder="(303) 555-0000" value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
            <div><label style={lbl}>Email</label><input style={input} type="email" placeholder="sarah@email.com" value={form.email} onChange={e => set('email', e.target.value)} /></div>
            <div>
              <label style={lbl}>How did they hear about us?</label>
              <select style={{ ...input, appearance: 'none' } as React.CSSProperties} value={form.source} onChange={e => set('source', e.target.value)}>
                {['Website', 'Referral', 'Word of Mouth', 'Instagram', 'Facebook', 'Google', 'Other'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'grid', gap: '14px' }}>
            <div>
              <label style={lbl}>Project Type</label>
              <select style={{ ...input, appearance: 'none' } as React.CSSProperties} value={form.projectType} onChange={e => set('projectType', e.target.value)}>
                {['Home Organization', 'Full Home', 'Kitchen + Pantry', 'Closet', 'Garage', 'Office', 'Move-In', 'Move-Out', 'Other'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Description</label><textarea style={{ ...input, height: '80px', resize: 'none' } as React.CSSProperties} placeholder="Tell us about the space..." value={form.description} onChange={e => set('description', e.target.value)} /></div>
            <div>
              <label style={lbl}>Service Address</label>
              <input style={{ ...input, marginBottom: '8px' }} placeholder="Street address" value={form.street} onChange={e => set('street', e.target.value)} />
              <input style={{ ...input, marginBottom: '8px' }} placeholder="City" value={form.city} onChange={e => set('city', e.target.value)} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <input style={input} placeholder="State" value={form.state} onChange={e => set('state', e.target.value)} />
                <input style={input} placeholder="ZIP" value={form.zip} onChange={e => set('zip', e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'grid', gap: '12px' }}>
            <div style={{ padding: '10px 14px', background: 'rgba(168,201,196,0.1)', borderRadius: '10px', border: '1px solid rgba(168,201,196,0.25)' }}>
              <p style={{ fontSize: '12px', color: '#4a5e5a', lineHeight: 1.5 }}>Choose the drip path for this client. You can change this at any time.</p>
            </div>
            <PathSelector selected={selectedPath} onChange={setSelectedPath} />
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '1.5rem' }}>
          {step > 1 && <button onClick={() => setStep(s => s - 1)} style={{ flex: 1, padding: '12px', background: 'transparent', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>Back</button>}
          <button
            onClick={() => step < STEPS.length ? setStep(s => s + 1) : handleCreate()}
            disabled={step === 1 && (!form.firstName || !form.lastName)}
            style={{ flex: 2, padding: '12px', background: step === 1 && (!form.firstName || !form.lastName) ? '#e5e7eb' : '#1a2e2b', border: 'none', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: step === 1 && (!form.firstName || !form.lastName) ? '#9ca3af' : 'white', cursor: step === 1 && (!form.firstName || !form.lastName) ? 'not-allowed' : 'pointer' }}
          >
            {step < STEPS.length ? 'Continue →' : '🐝 Create Client'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Loading State ─────────────────────────────────────────────────────────

function LoadingHive() {
  return (
    <div style={{ display: 'grid', gap: '8px', marginTop: '1rem' }}>
      {[1,2,3,4,5].map(i => (
        <div key={i} style={{ background: 'white', border: '1px solid rgba(0,0,0,0.07)', borderRadius: '12px', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(168,201,196,0.2)', animation: 'pulse 1.5s ease-in-out infinite' }} />
          <div style={{ flex: 1 }}>
            <div style={{ width: '40%', height: 14, background: 'rgba(168,201,196,0.2)', borderRadius: 4, marginBottom: 8 }} />
            <div style={{ width: '60%', height: 10, background: 'rgba(168,201,196,0.1)', borderRadius: 4 }} />
          </div>
        </div>
      ))}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }`}</style>
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────

const LOCATION_DEFAULT_PATH = DEFAULT_PATHS[0]

export default function HivePage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('list')
  const [showNewLead, setShowNewLead] = useState(false)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<Stage | ''>('')

  // ── Fetch real leads from Supabase ──────────────────────────────────────
  useEffect(() => {
    async function fetchLeads() {
      try {
        setLoading(true)
        // Get location_id from URL params or user session
        // For now, read from URL search params
        const params = new URLSearchParams(window.location.search)
        const locationId = params.get('location_id') || 'loc_scottsdale'

        const res = await fetch(`/api/hive/leads?location_id=${locationId}`)
        if (!res.ok) throw new Error('Failed to fetch leads')
        const data = await res.json()

        // Ensure every lead has a path
        const shaped = data.map((l: any) => ({
          ...l,
          path: l.path || LOCATION_DEFAULT_PATH,
          drips: l.drips || [],
          activity: l.activity || [],
        }))

        setLeads(shaped)
      } catch (err: any) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchLeads()
  }, [])

  function updateLead(updated: Lead) {
    setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
    setSelectedLead(updated)
  }

  const filtered = leads.filter(lead => {
    const q = search.toLowerCase()
    const matchSearch = !search || lead.name.toLowerCase().includes(q) || (lead.email || '').toLowerCase().includes(q) || (lead.phone || '').includes(search)
    const matchStage = !stageFilter || lead.stage === stageFilter
    return matchSearch && matchStage
  })

  const byStage = (stage: Stage) => filtered.filter(l => l.stage === stage)

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontFamily: 'Playfair Display, serif', color: '#1a2e2b', marginBottom: '2px' }}>The Hive 🐝</h1>
          <p style={{ fontSize: '13px', color: '#8a9e9a' }}>
            {loading ? 'Loading...' : `${leads.length} clients · ${leads.filter(l => l.stage === 'New').length} new`}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.05)', borderRadius: '8px', padding: '3px' }}>
            {(['list', 'kanban'] as ViewMode[]).map(v => (
              <button key={v} onClick={() => setView(v)} style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 500, fontFamily: 'DM Sans, sans-serif', background: view === v ? 'white' : 'transparent', color: view === v ? '#1a2e2b' : '#8a9e9a', boxShadow: view === v ? '0 1px 4px rgba(0,0,0,0.08)' : 'none', transition: 'all 0.15s' }}>
                {v === 'kanban' ? '⊞' : '☰'} {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <button onClick={() => setShowNewLead(true)} style={{ padding: '9px 16px', background: '#1a2e2b', color: 'white', border: 'none', borderRadius: '9px', fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: 'DM Sans, sans-serif', boxShadow: '0 2px 8px rgba(26,46,43,0.2)' }}>
            + New Client
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '12px 16px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', marginBottom: '1rem', fontSize: '13px', color: '#ef4444' }}>
          ⚠️ {error} — <button onClick={() => window.location.reload()} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>Retry</button>
        </div>
      )}

      {/* Loading */}
      {loading && <LoadingHive />}

      {!loading && !error && (
        <>
          {/* Stage filter pills */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '1rem', flexWrap: 'wrap' }}>
            {STAGES.map(s => {
              const count = leads.filter(l => l.stage === s.key).length
              if (!count) return null
              const active = stageFilter === s.key
              return (
                <button key={s.key} onClick={() => setStageFilter(active ? '' : s.key)} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '20px', cursor: 'pointer', background: active ? s.bg : 'white', border: `1px solid ${active ? s.color + '40' : 'rgba(0,0,0,0.08)'}`, fontFamily: 'DM Sans, sans-serif', transition: 'all 0.15s' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: s.dot }} />
                  <span style={{ fontSize: '12px', color: s.color, fontWeight: 500 }}>{s.label}</span>
                  <span style={{ fontSize: '11px', color: s.color, opacity: 0.6 }}>{count}</span>
                </button>
              )
            })}
          </div>

          {/* Search */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '1.25rem' }}>
            <input type="text" placeholder="Search clients..." value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1, padding: '9px 14px', border: '1.5px solid rgba(0,0,0,0.09)', borderRadius: '9px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', background: 'white', outline: 'none' }} />
            {(search || stageFilter) && <button onClick={() => { setSearch(''); setStageFilter('') }} style={{ padding: '9px 14px', background: 'white', border: '1.5px solid rgba(0,0,0,0.09)', borderRadius: '9px', fontSize: '13px', color: '#8a9e9a', cursor: 'pointer', fontFamily: 'DM Sans, sans-serif', whiteSpace: 'nowrap' }}>Clear</button>}
          </div>

          {/* List View */}
          {view === 'list' && (
            <div style={{ display: 'grid', gap: '8px' }}>
              {filtered.map(lead => {
                const s = stageConfig(lead.stage)
                return (
                  <div key={lead.id} onClick={() => setSelectedLead(lead)} style={{ background: 'white', border: '1px solid rgba(0,0,0,0.07)', borderRadius: '12px', padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
                    <Avatar name={lead.name} size={36} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '14px', fontWeight: 600, color: '#1a2e2b' }}>{lead.name}</span>
                        <StagePill stage={lead.stage} />
                        {lead.invoiceTotal && lead.invoiceStatus === 'paid' && (
                          <span style={{ fontSize: '11px', color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>${lead.invoiceTotal.toLocaleString()} paid</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        {lead.phone && <span style={{ fontSize: '12px', color: '#8a9e9a' }}>{lead.phone}</span>}
                        <span style={{ fontSize: '12px', color: '#8a9e9a' }}>{lead.projectType}</span>
                        <SourcePill source={lead.source} />
                      </div>
                    </div>
                    <span style={{ fontSize: '12px', color: '#b0c0bc', flexShrink: 0 }}>{lead.createdAt}</span>
                  </div>
                )
              })}
              {filtered.length === 0 && <div style={{ padding: '3rem', textAlign: 'center', color: '#b0c0bc', fontSize: '14px' }}>No clients found.</div>}
            </div>
          )}

          {/* Kanban View */}
          {view === 'kanban' && (
            <div style={{ overflowX: 'auto', paddingBottom: '1rem' }}>
              <div style={{ display: 'flex', gap: '12px', minWidth: 'max-content', alignItems: 'flex-start' }}>
                {STAGES.map(stage => {
                  const stageLeads = byStage(stage.key)
                  return (
                    <div key={stage.key} style={{ width: '220px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: stage.dot }} />
                        <span style={{ fontSize: '11px', fontWeight: 600, color: stage.color, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{stage.label}</span>
                        <span style={{ fontSize: '11px', color: '#b0c0bc', marginLeft: 'auto' }}>{stageLeads.length}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {stageLeads.map(lead => (
                          <div key={lead.id} onClick={() => setSelectedLead(lead)} style={{ background: 'white', border: '1px solid rgba(0,0,0,0.07)', borderRadius: '10px', padding: '12px', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                              <Avatar name={lead.name} size={28} />
                              <div style={{ minWidth: 0 }}>
                                <p style={{ fontSize: '13px', fontWeight: 600, color: '#1a2e2b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead.name}</p>
                                <p style={{ fontSize: '11px', color: '#8a9e9a' }}>{lead.projectType}</p>
                              </div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <SourcePill source={lead.source} />
                              <span style={{ fontSize: '10px', color: '#b0c0bc' }}>{lead.createdAt}</span>
                            </div>
                            {lead.scheduledAssessment && <div style={{ marginTop: '8px', padding: '4px 8px', background: 'rgba(14,165,233,0.08)', borderRadius: '6px', fontSize: '11px', color: '#0ea5e9' }}>📅 {lead.scheduledAssessment}</div>}
                            {lead.invoiceTotal && <div style={{ marginTop: '6px', padding: '4px 8px', background: 'rgba(34,197,94,0.08)', borderRadius: '6px', fontSize: '11px', color: '#22c55e' }}>💰 ${lead.invoiceTotal.toLocaleString()}</div>}
                          </div>
                        ))}
                        {stageLeads.length === 0 && <div style={{ padding: '16px', textAlign: 'center', color: '#c8d8d4', fontSize: '12px', border: '1px dashed rgba(0,0,0,0.08)', borderRadius: '10px' }}>Empty</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {showNewLead && <NewLeadModal onClose={() => setShowNewLead(false)} onCreate={l => { setLeads(p => [l, ...p]); setSelectedLead(l) }} defaultPath={LOCATION_DEFAULT_PATH} />}
      {selectedLead && <LeadPanel lead={selectedLead} onClose={() => setSelectedLead(null)} onUpdate={updateLead} />}
    </div>
  )
}