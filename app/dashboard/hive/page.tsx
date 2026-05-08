'use client'

import { useState } from 'react'
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
  { key: 'Quote',                label: 'Quote',            color: '#8b5cf6', bg: 'rgba(139,92,246,0.08)', dot: '#8b5cf6', icon: '📋' },
  { key: 'Job in Progress',      label: 'Job in Progress',  color: '#10b981', bg: 'rgba(16,185,129,0.08)', dot: '#10b981', icon: '🔨' },
  { key: 'Final Processing',     label: 'Final Processing', color: '#22c55e', bg: 'rgba(34,197,94,0.08)',  dot: '#22c55e', icon: '✅' },
]

const STAGE_ORDER = STAGES.map(s => s.key)

// ─── Mock Leads ────────────────────────────────────────────────────────────

const emailPath = DEFAULT_PATHS[0]
const quickPath = DEFAULT_PATHS[1]
const directPath = DEFAULT_PATHS[2]

function makeDrips(path: DripPath): DripEmail[] {
  return path.steps.map((s, i) => ({
    id: i + 1,
    subject: s.label,
    scheduledAt: s.day === 0 ? 'Immediately' : `Day ${s.day}`,
    status: 'scheduled' as const,
    type: s.type,
  }))
}

const MOCK_LEADS: Lead[] = [
  { id: '1', name: 'Sarah Mitchell',  phone: '(303) 555-0182', email: 'sarah@email.com',   stage: 'New',                  source: 'Website',       projectType: 'Home Organization', description: 'Looking to organize her entire home before the holidays.', location: 'Denver', createdAt: 'May 1',  address: '1234 Maple St, Denver, CO 80202', path: emailPath, pausedDrip: false, drips: [{ id: 1, subject: 'Welcome to Bee Organized!', scheduledAt: 'May 1, 9:00am', sentAt: 'May 1, 9:00am', status: 'sent', type: 'email' }, { id: 2, subject: 'How We Help', scheduledAt: 'May 3', status: 'scheduled', type: 'email' }, { id: 3, subject: 'Real Results', scheduledAt: 'May 7', status: 'scheduled', type: 'email' }, { id: 4, subject: 'Ready to Book?', scheduledAt: 'May 14', status: 'scheduled', type: 'email' }], activity: [{ id: 'a1', type: 'system', text: 'Lead created from website', timestamp: 'May 1, 8:42am' }, { id: 'a2', type: 'email', text: 'Welcome email sent', timestamp: 'May 1, 9:00am' }] },
  { id: '2', name: 'Jennifer Torres', phone: '(720) 555-0244', email: 'jen@gmail.com',      stage: 'New',                  source: 'Referral',      projectType: 'Kitchen + Pantry',  description: 'Referred by Karen Martinez.',                              location: 'Denver', createdAt: 'May 2',  path: quickPath,  pausedDrip: false, drips: [{ id: 1, subject: 'Welcome Text', scheduledAt: 'Immediately', sentAt: 'May 2', status: 'sent', type: 'sms' }, { id: 2, subject: 'Call Reminder', scheduledAt: 'Day 1', status: 'scheduled', type: 'call_prompt' }, { id: 3, subject: 'Follow-up Email', scheduledAt: 'Day 3', status: 'scheduled', type: 'email' }], activity: [{ id: 'a1', type: 'system', text: 'Lead created — referred by Karen Martinez', timestamp: 'May 2' }, { id: 'a2', type: 'sms', text: 'Welcome text sent', timestamp: 'May 2' }] },
  { id: '3', name: 'Amanda Chen',     phone: '(303) 555-0371', email: 'amanda@me.com',       stage: 'Nurturing',            source: 'Word of Mouth', projectType: 'Move-In',           description: 'Moving in next month.',                                    location: 'Denver', createdAt: 'Apr 28', path: emailPath,  pausedDrip: false, drips: [{ id: 1, subject: 'Welcome Email', scheduledAt: 'Apr 28', sentAt: 'Apr 28', status: 'sent', type: 'email' }, { id: 2, subject: 'How We Help', scheduledAt: 'Apr 30', sentAt: 'Apr 30', status: 'sent', type: 'email' }, { id: 3, subject: 'Real Results', scheduledAt: 'May 4', status: 'scheduled', type: 'email' }, { id: 4, subject: 'Ready to Book?', scheduledAt: 'May 11', status: 'scheduled', type: 'email' }], activity: [{ id: 'a1', type: 'system', text: 'Lead created', timestamp: 'Apr 28' }, { id: 'a2', type: 'email', text: 'Welcome email sent', timestamp: 'Apr 28' }, { id: 'a3', type: 'email', text: 'Follow-up sent', timestamp: 'Apr 30' }, { id: 'a4', type: 'call', text: 'Called — no answer, left voicemail', timestamp: 'May 1', user: 'You' }] },
  { id: '4', name: 'Rachel Kim',      phone: '(720) 555-0498', email: 'rkim@outlook.com',    stage: 'Nurturing',            source: 'Website',       projectType: 'Closet',            description: 'Primary and guest closets.',                               location: 'Denver', createdAt: 'Apr 25', path: directPath, pausedDrip: true,  drips: [{ id: 1, subject: 'Scheduling Link', scheduledAt: 'Apr 25', sentAt: 'Apr 25', status: 'sent', type: 'link' }, { id: 2, subject: 'Link Reminder', scheduledAt: 'Apr 27', sentAt: 'Apr 27', status: 'sent', type: 'email' }, { id: 3, subject: 'Value Email', scheduledAt: 'Paused', status: 'skipped', type: 'email' }], activity: [{ id: 'a1', type: 'system', text: 'Lead created', timestamp: 'Apr 25' }, { id: 'a2', type: 'link', text: 'Scheduling link sent', timestamp: 'Apr 25' }, { id: 'a3', type: 'note', text: 'Asked to slow down emails', timestamp: 'Apr 28', user: 'You' }, { id: 'a4', type: 'system', text: 'Drip paused', timestamp: 'Apr 28' }] },
  { id: '5', name: 'Lisa Patel',      phone: '(303) 555-0512', email: 'lpatel@gmail.com',    stage: 'Assessment Scheduled', source: 'Referral',      projectType: 'Full Home',         description: 'Full home, moved in 3 months ago.',                       location: 'Denver', createdAt: 'Apr 20', path: emailPath,  scheduledAssessment: 'May 6, 2026 at 10:00 AM', drips: [{ id: 1, subject: 'Welcome Email', scheduledAt: 'Apr 20', sentAt: 'Apr 20', status: 'sent', type: 'email' }, { id: 2, subject: 'How We Help', scheduledAt: 'Apr 22', sentAt: 'Apr 22', status: 'sent', type: 'email' }, { id: 3, subject: 'Real Results', scheduledAt: 'Apr 26', sentAt: 'Apr 26', status: 'sent', type: 'email' }, { id: 4, subject: 'Ready to Book?', scheduledAt: 'Skipped', status: 'skipped', type: 'email' }], activity: [{ id: 'a1', type: 'system', text: 'Lead created', timestamp: 'Apr 20' }, { id: 'a2', type: 'call', text: 'Spoke with Lisa — scheduling assessment', timestamp: 'Apr 28', user: 'You' }, { id: 'a3', type: 'stage', text: 'Assessment scheduled for May 6 at 10am', timestamp: 'Apr 29' }] },
  { id: '7', name: 'Diana Walsh',     phone: '(303) 555-0724', email: 'dwalsh@gmail.com',    stage: 'Quote',                source: 'Website',       projectType: 'Garage',            location: 'Denver', createdAt: 'Apr 15', path: emailPath,  drips: [], activity: [{ id: 'a1', type: 'system', text: 'Lead created', timestamp: 'Apr 15' }, { id: 'a2', type: 'stage', text: 'Assessment completed — quote sent', timestamp: 'Apr 25' }] },
  { id: '8', name: 'Patricia Nguyen', phone: '(720) 555-0855', email: 'pnguyen@me.com',      stage: 'Job in Progress',      source: 'Referral',      projectType: 'Whole Home',        location: 'Denver', createdAt: 'Apr 10', path: emailPath,  jobberStatus: 'Job #2847', drips: [], activity: [{ id: 'a1', type: 'system', text: 'Lead created', timestamp: 'Apr 10' }, { id: 'a2', type: 'stage', text: 'Sent to Jobber — Job #2847', timestamp: 'Apr 22' }] },
  { id: '9', name: 'Karen Martinez',  phone: '(303) 555-0916', email: 'kmartinez@gmail.com', stage: 'Final Processing',     source: 'Website',       projectType: 'Kitchen',           location: 'Denver', createdAt: 'Apr 5',  path: emailPath,  jobberStatus: 'Job #2831', drips: [], activity: [{ id: 'a1', type: 'system', text: 'Lead created', timestamp: 'Apr 5' }, { id: 'a2', type: 'stage', text: 'Job completed', timestamp: 'May 1' }] },
]

// ─── Helpers ───────────────────────────────────────────────────────────────

function getInitials(name: string) { return name.split(' ').map(w => w[0]).join('').slice(0, 2) }
function stageConfig(stage: Stage) { return STAGES.find(s => s.key === stage) || STAGES[0] }

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
          <div
            key={path.id}
            onClick={() => onChange(path)}
            style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: isSelected ? 'rgba(168,201,196,0.12)' : 'white', border: `1.5px solid ${isSelected ? '#a8c9c4' : 'rgba(0,0,0,0.08)'}`, borderRadius: '10px', cursor: 'pointer', transition: 'all 0.15s' }}
          >
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
                <button key={t} onClick={() => setTime(t)} style={{ padding: '7px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', border: '1.5px solid', borderColor: time === t ? '#a8c9c4' : 'rgba(0,0,0,0.08)', background: time === t ? 'rgba(168,201,196,0.15)' : 'white', color: time === t ? '#1a2e2b' : '#4a5e5a', fontWeight: time === t ? 600 : 400 }}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onClose} style={{ flex: 1, padding: '12px', background: 'transparent', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => date && onSchedule(date, time)} disabled={!date} style={{ flex: 2, padding: '12px', background: date ? '#1a2e2b' : '#e5e7eb', border: 'none', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: date ? 'white' : '#9ca3af', cursor: date ? 'pointer' : 'not-allowed' }}>
            📅 Confirm
          </button>
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
    <button onClick={() => setTab(key)} style={{ flex: 1, padding: '8px', border: 'none', cursor: 'pointer', fontFamily: 'DM Sans, sans-serif', fontSize: '13px', fontWeight: tab === key ? 600 : 400, background: 'transparent', color: tab === key ? '#1a2e2b' : '#8a9e9a', borderBottom: `2px solid ${tab === key ? '#a8c9c4' : 'transparent'}`, transition: 'all 0.15s' }}>
      {label}
    </button>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <StagePill stage={lead.stage} />
                    <span style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '20px', background: `${TOUCH_CONFIG[lead.path.firstTouch].bg}`, color: TOUCH_CONFIG[lead.path.firstTouch].color, fontWeight: 500 }}>
                      {lead.path.icon} {lead.path.name}
                    </span>
                  </div>
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

            {/* Overview */}
            {tab === 'overview' && (
              <div style={{ display: 'grid', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {[['📞 Phone', lead.phone], ['✉️ Email', lead.email], ['🏠 Project', lead.projectType], ['📣 Source', lead.source]].map(([lbl, val]) => (
                    <div key={lbl} style={{ background: '#f7f5f0', borderRadius: '10px', padding: '10px 12px' }}>
                      <p style={{ fontSize: '10px', color: '#8a9e9a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>{lbl}</p>
                      <p style={{ fontSize: '13px', color: '#1a2e2b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val}</p>
                    </div>
                  ))}
                </div>
                {lead.address && <div style={{ background: '#f7f5f0', borderRadius: '10px', padding: '10px 12px' }}><p style={{ fontSize: '10px', color: '#8a9e9a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>📍 Address</p><p style={{ fontSize: '13px', color: '#1a2e2b' }}>{lead.address}</p></div>}
                {lead.description && <div style={{ background: '#f7f5f0', borderRadius: '10px', padding: '10px 12px' }}><p style={{ fontSize: '10px', color: '#8a9e9a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>📋 Notes</p><p style={{ fontSize: '13px', color: '#1a2e2b', lineHeight: 1.5 }}>{lead.description}</p></div>}
                {lead.scheduledAssessment && <div style={{ background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.2)', borderRadius: '10px', padding: '10px 12px' }}><p style={{ fontSize: '10px', color: '#0ea5e9', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>📅 Assessment</p><p style={{ fontSize: '13px', color: '#0369a1', fontWeight: 500 }}>{lead.scheduledAssessment}</p></div>}
                {lead.jobberStatus && <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '10px 12px' }}><p style={{ fontSize: '10px', color: '#10b981', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>⚡ Jobber</p><p style={{ fontSize: '13px', color: '#065f46', fontWeight: 500 }}>{lead.jobberStatus}</p></div>}

                {/* Actions */}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {(lead.stage === 'New' || lead.stage === 'Nurturing') && (
                    <button onClick={() => setShowScheduler(true)} style={{ flex: 1, minWidth: '140px', padding: '10px', background: '#0ea5e9', border: 'none', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer' }}>📅 Schedule Assessment</button>
                  )}
                  {(lead.stage === 'Assessment Scheduled' || lead.stage === 'Quote') && (
                    <button onClick={() => alert('Send to Jobber — coming soon!')} style={{ flex: 1, minWidth: '140px', padding: '10px', background: '#10b981', border: 'none', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer' }}>⚡ Send to Jobber</button>
                  )}
                  {canGoBack && <button onClick={() => update({ stage: STAGE_ORDER[stageIdx - 1] as Stage }, `Moved back to ${stageConfig(STAGE_ORDER[stageIdx - 1] as Stage).label}`)} style={{ padding: '10px 14px', background: 'white', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>← Back</button>}
                  {canGoForward && lead.stage !== 'Assessment Scheduled' && lead.stage !== 'Quote' && (
                    <button onClick={() => update({ stage: STAGE_ORDER[stageIdx + 1] as Stage }, `Moved to ${stageConfig(STAGE_ORDER[stageIdx + 1] as Stage).label}`)} style={{ flex: 1, padding: '10px', background: '#1a2e2b', border: 'none', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer' }}>Move to {stageConfig(STAGE_ORDER[stageIdx + 1] as Stage).label} →</button>
                  )}
                </div>
                <button onClick={() => setShowAddNote(true)} style={{ width: '100%', padding: '10px', background: 'transparent', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>📝 Log Activity</button>
              </div>
            )}

            {/* Drip */}
            {tab === 'drip' && (
              <div style={{ display: 'grid', gap: '10px' }}>
                {/* Status + pause */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: lead.pausedDrip ? 'rgba(245,158,11,0.08)' : 'rgba(168,201,196,0.12)', borderRadius: '10px', border: `1px solid ${lead.pausedDrip ? 'rgba(245,158,11,0.2)' : 'rgba(168,201,196,0.3)'}` }}>
                  <div>
                    <p style={{ fontSize: '13px', fontWeight: 600, color: lead.pausedDrip ? '#f59e0b' : '#1a2e2b', marginBottom: '2px' }}>{lead.pausedDrip ? '⏸ Paused' : '▶ Active'} · {lead.path.icon} {lead.path.name}</p>
                    <p style={{ fontSize: '12px', color: '#8a9e9a' }}>{dripSent} of {lead.drips.length} steps completed</p>
                  </div>
                  <button onClick={() => update({ pausedDrip: !lead.pausedDrip }, lead.pausedDrip ? 'Drip resumed' : 'Drip paused')} style={{ padding: '7px 14px', background: lead.pausedDrip ? '#1a2e2b' : 'white', border: '1.5px solid', borderColor: lead.pausedDrip ? '#1a2e2b' : 'rgba(0,0,0,0.1)', borderRadius: '8px', fontSize: '12px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: lead.pausedDrip ? 'white' : '#4a5e5a', cursor: 'pointer' }}>
                    {lead.pausedDrip ? 'Resume' : 'Pause'}
                  </button>
                </div>

                {/* Steps */}
                {lead.drips.map((drip, i) => {
                  const tc = TOUCH_CONFIG[drip.type]
                  return (
                    <div key={drip.id} style={{ display: 'flex', gap: '10px', padding: '12px', background: 'white', border: '1px solid rgba(0,0,0,0.07)', borderRadius: '10px' }}>
                      <div style={{ width: '28px', height: '28px', borderRadius: '8px', background: drip.status === 'sent' ? 'rgba(16,185,129,0.1)' : drip.status === 'skipped' ? 'rgba(0,0,0,0.04)' : tc.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', flexShrink: 0 }}>
                        {drip.status === 'sent' ? '✅' : drip.status === 'skipped' ? '⏭' : tc.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: '13px', fontWeight: 500, color: drip.status === 'skipped' ? '#9ca3af' : '#1a2e2b', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          Step {i + 1}: {drip.subject}
                        </p>
                        <p style={{ fontSize: '11px', color: drip.status === 'sent' ? '#10b981' : '#8a9e9a' }}>
                          {drip.status === 'sent' ? `Sent ${drip.sentAt}` : drip.status === 'skipped' ? drip.scheduledAt : `Scheduled: ${drip.scheduledAt}`}
                        </p>
                      </div>
                    </div>
                  )
                })}

                {/* Change path */}
                <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '1rem' }}>
                  <p style={{ fontSize: '11px', fontWeight: 600, color: '#8a9e9a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Change Path</p>
                  <PathSelector selected={lead.path} onChange={handleChangePath} />
                </div>
              </div>
            )}

            {/* Activity */}
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
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', source: '', projectType: '', description: '', street: '', city: '', state: '', zip: '' })
  const [selectedPath, setSelectedPath] = useState<DripPath>(defaultPath)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const input: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '8px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', background: 'white', outline: 'none', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: '#4a5e5a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px', display: 'block' }

  const STEPS = ['Contact', 'Project', 'Path']

  function handleCreate() {
    const name = `${form.firstName} ${form.lastName}`.trim()
    onCreate({
      id: `new-${Date.now()}`, name, phone: form.phone, email: form.email,
      stage: 'New', source: form.source, projectType: form.projectType,
      description: form.description, location: 'Denver',
      address: [form.street, form.city, form.state, form.zip].filter(Boolean).join(', '),
      createdAt: 'Just now', pausedDrip: false, path: selectedPath,
      drips: makeDrips(selectedPath),
      activity: [{ id: `a${Date.now()}`, type: 'system', text: `Lead created · ${selectedPath.name} path started`, timestamp: 'Just now' }],
    })
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(26,46,43,0.4)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'white', width: '100%', maxWidth: '540px', borderRadius: '20px 20px 0 0', padding: '1.5rem', zIndex: 1, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 -8px 40px rgba(26,46,43,0.15)' }}>
        <div style={{ width: '36px', height: '4px', background: 'rgba(0,0,0,0.12)', borderRadius: '2px', margin: '0 auto 1.25rem' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontFamily: 'Playfair Display, serif', color: '#1a2e2b' }}>New Lead</h2>
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
              <div><label style={lbl}>First Name</label><input style={input} placeholder="Sarah" value={form.firstName} onChange={e => set('firstName', e.target.value)} /></div>
              <div><label style={lbl}>Last Name</label><input style={input} placeholder="Mitchell" value={form.lastName} onChange={e => set('lastName', e.target.value)} /></div>
            </div>
            <div><label style={lbl}>Phone</label><input style={input} placeholder="(303) 555-0000" value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
            <div><label style={lbl}>Email</label><input style={input} type="email" placeholder="sarah@email.com" value={form.email} onChange={e => set('email', e.target.value)} /></div>
            <div>
              <label style={lbl}>How did they hear about us?</label>
              <select style={{ ...input, appearance: 'none' }} value={form.source} onChange={e => set('source', e.target.value)}>
                <option value="">Select source...</option>
                {['Website', 'Referral', 'Word of Mouth', 'Instagram', 'Facebook', 'Google', 'Other'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'grid', gap: '14px' }}>
            <div>
              <label style={lbl}>Project Type</label>
              <select style={{ ...input, appearance: 'none' }} value={form.projectType} onChange={e => set('projectType', e.target.value)}>
                <option value="">Select type...</option>
                {['Full Home', 'Kitchen + Pantry', 'Closet', 'Garage', 'Office', 'Move-In', 'Move-Out', 'Other'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Description</label><textarea style={{ ...input, height: '80px', resize: 'none' } as React.CSSProperties} placeholder="Tell us about the space..." value={form.description} onChange={e => set('description', e.target.value)} /></div>
            <div>
              <label style={lbl}>Service Address</label>
              <input style={{ ...input, marginBottom: '8px' }} placeholder="Street address" value={form.street} onChange={e => set('street', e.target.value)} />
              <input style={{ ...input, marginBottom: '8px' }} placeholder="City" value={form.city} onChange={e => set('city', e.target.value)} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <input style={input} placeholder="State" value={form.state} onChange={e => set('state', e.target.value)} />
                <input style={input} placeholder="Zip" value={form.zip} onChange={e => set('zip', e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'grid', gap: '12px' }}>
            <div style={{ padding: '10px 14px', background: 'rgba(168,201,196,0.1)', borderRadius: '10px', border: '1px solid rgba(168,201,196,0.25)' }}>
              <p style={{ fontSize: '12px', color: '#4a5e5a', lineHeight: 1.5 }}>
                <strong>Location default:</strong> {defaultPath.icon} {defaultPath.name} — override below for this lead only.
              </p>
            </div>
            <PathSelector selected={selectedPath} onChange={setSelectedPath} />
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '1.5rem' }}>
          {step > 1 && <button onClick={() => setStep(s => s - 1)} style={{ flex: 1, padding: '12px', background: 'transparent', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>Back</button>}
          <button onClick={() => step < STEPS.length ? setStep(s => s + 1) : handleCreate()} style={{ flex: 2, padding: '12px', background: '#1a2e2b', border: 'none', borderRadius: '10px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer' }}>
            {step < STEPS.length ? 'Continue →' : '🐝 Create Lead'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────

const LOCATION_DEFAULT_PATH = DEFAULT_PATHS[0] // In production, comes from location settings

export default function HivePage() {
  const [leads, setLeads] = useState<Lead[]>(MOCK_LEADS)
  const [view, setView] = useState<ViewMode>('list')
  const [showNewLead, setShowNewLead] = useState(false)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<Stage | ''>('')

  function updateLead(updated: Lead) {
    setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
    setSelectedLead(updated)
  }

  const filtered = leads.filter(lead => {
    const q = search.toLowerCase()
    const matchSearch = !search || lead.name.toLowerCase().includes(q) || lead.email.toLowerCase().includes(q) || lead.phone.includes(search)
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
          <p style={{ fontSize: '13px', color: '#8a9e9a' }}>{leads.length} leads · {leads.filter(l => l.stage === 'New').length} new</p>
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
            + New Lead
          </button>
        </div>
      </div>

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
        <input type="text" placeholder="Search leads..." value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1, padding: '9px 14px', border: '1.5px solid rgba(0,0,0,0.09)', borderRadius: '9px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', background: 'white', outline: 'none' }} />
        {(search || stageFilter) && <button onClick={() => { setSearch(''); setStageFilter('') }} style={{ padding: '9px 14px', background: 'white', border: '1.5px solid rgba(0,0,0,0.09)', borderRadius: '9px', fontSize: '13px', color: '#8a9e9a', cursor: 'pointer', fontFamily: 'DM Sans, sans-serif', whiteSpace: 'nowrap' }}>Clear</button>}
      </div>

      {/* List View */}
      {view === 'list' && (
        <div style={{ display: 'grid', gap: '8px' }}>
          {filtered.map(lead => {
            const s = stageConfig(lead.stage)
            const tc = TOUCH_CONFIG[lead.path.firstTouch]
            return (
              <div key={lead.id} onClick={() => setSelectedLead(lead)} style={{ background: 'white', border: '1px solid rgba(0,0,0,0.07)', borderRadius: '12px', padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
                <Avatar name={lead.name} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: '#1a2e2b' }}>{lead.name}</span>
                    <StagePill stage={lead.stage} />
                    <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '20px', background: tc.bg, color: tc.color, fontWeight: 500 }}>{lead.path.icon} {lead.path.name}</span>
                    {lead.pausedDrip && <span style={{ fontSize: '10px', color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '2px 6px', borderRadius: '20px' }}>⏸ Paused</span>}
                  </div>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', color: '#8a9e9a' }}>{lead.phone}</span>
                    <span style={{ fontSize: '12px', color: '#8a9e9a' }}>{lead.projectType}</span>
                    <SourcePill source={lead.source} />
                  </div>
                </div>
                <span style={{ fontSize: '12px', color: '#b0c0bc', flexShrink: 0 }}>{lead.createdAt}</span>
              </div>
            )
          })}
          {filtered.length === 0 && <div style={{ padding: '3rem', textAlign: 'center', color: '#b0c0bc', fontSize: '14px' }}>No leads found.</div>}
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
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <SourcePill source={lead.source} />
                          <span style={{ fontSize: '10px', color: '#b0c0bc' }}>{lead.createdAt}</span>
                        </div>
                        <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '20px', background: TOUCH_CONFIG[lead.path.firstTouch].bg, color: TOUCH_CONFIG[lead.path.firstTouch].color }}>{lead.path.icon} {lead.path.name}</span>
                        {lead.scheduledAssessment && <div style={{ marginTop: '8px', padding: '4px 8px', background: 'rgba(14,165,233,0.08)', borderRadius: '6px', fontSize: '11px', color: '#0ea5e9' }}>📅 {lead.scheduledAssessment}</div>}
                        {lead.pausedDrip && <div style={{ marginTop: '6px', padding: '4px 8px', background: 'rgba(245,158,11,0.08)', borderRadius: '6px', fontSize: '11px', color: '#f59e0b' }}>⏸ Drip paused</div>}
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

      {showNewLead && <NewLeadModal onClose={() => setShowNewLead(false)} onCreate={l => { setLeads(p => [l, ...p]); setSelectedLead(l) }} defaultPath={LOCATION_DEFAULT_PATH} />}
      {selectedLead && <LeadPanel lead={selectedLead} onClose={() => setSelectedLead(null)} onUpdate={updateLead} />}
    </div>
  )
}