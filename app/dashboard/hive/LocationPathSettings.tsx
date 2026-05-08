'use client'

import { useState } from 'react'
import { DEFAULT_PATHS, TOUCH_CONFIG, DripPath, PathStep, TouchType } from './paths'

// ─── Path Card ────────────────────────────────────────────────────────────────

function PathCard({ path, selected, onSelect }: { path: DripPath; selected: boolean; onSelect: () => void }) {
  const firstStep = path.steps[0]
  const tc = TOUCH_CONFIG[path.firstTouch]

  return (
    <div
      onClick={onSelect}
      style={{
        background: 'white',
        border: `2px solid ${selected ? '#a8c9c4' : 'rgba(0,0,0,0.08)'}`,
        borderRadius: '12px',
        padding: '14px',
        cursor: 'pointer',
        transition: 'all 0.15s',
        boxShadow: selected ? '0 4px 16px rgba(168,201,196,0.2)' : '0 1px 4px rgba(0,0,0,0.04)',
        position: 'relative',
      }}
    >
      {selected && (
        <div style={{ position: 'absolute', top: '10px', right: '10px', width: '18px', height: '18px', borderRadius: '50%', background: '#a8c9c4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: '10px', color: 'white', fontWeight: 700 }}>✓</span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <span style={{ fontSize: '20px' }}>{path.icon}</span>
        <span style={{ fontSize: '14px', fontWeight: 600, color: '#1a2e2b' }}>{path.name}</span>
      </div>
      <p style={{ fontSize: '12px', color: '#8a9e9a', marginBottom: '10px', lineHeight: 1.4 }}>{path.description}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 8px', background: tc.bg, borderRadius: '6px', width: 'fit-content' }}>
        <span style={{ fontSize: '12px' }}>{tc.icon}</span>
        <span style={{ fontSize: '11px', color: tc.color, fontWeight: 500 }}>First touch: {tc.label}</span>
      </div>
      <div style={{ display: 'flex', gap: '3px', marginTop: '10px', flexWrap: 'wrap' }}>
        {path.steps.map((step, i) => {
          const sc = TOUCH_CONFIG[step.type]
          return (
            <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <div style={{ padding: '3px 7px', borderRadius: '20px', background: sc.bg, fontSize: '10px', color: sc.color, fontWeight: 500 }}>
                {i === 0 ? 'Day 0' : `Day ${step.day}`} {sc.icon}
              </div>
              {i < path.steps.length - 1 && <span style={{ fontSize: '10px', color: '#c8d8d4' }}>→</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Step Editor ─────────────────────────────────────────────────────────────

function StepEditor({ step, index, onChange, onRemove }: { step: PathStep; index: number; onChange: (s: PathStep) => void; onRemove: () => void }) {
  const tc = TOUCH_CONFIG[step.type]

  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '12px', background: 'white', border: '1px solid rgba(0,0,0,0.07)', borderRadius: '10px' }}>
      <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: tc.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', flexShrink: 0 }}>
        {tc.icon}
      </div>
      <div style={{ flex: 1, display: 'grid', gap: '6px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={step.type}
            onChange={e => onChange({ ...step, type: e.target.value as TouchType })}
            style={{ padding: '5px 8px', border: '1px solid rgba(0,0,0,0.1)', borderRadius: '6px', fontSize: '12px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', background: 'white', outline: 'none' }}
          >
            {Object.entries(TOUCH_CONFIG).map(([k, v]) => (
              <option key={k} value={k}>{v.icon} {v.label}</option>
            ))}
          </select>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ fontSize: '12px', color: '#8a9e9a' }}>Day</span>
            <input
              type="number"
              min={0}
              value={step.day}
              onChange={e => onChange({ ...step, day: parseInt(e.target.value) || 0 })}
              style={{ width: '50px', padding: '5px 6px', border: '1px solid rgba(0,0,0,0.1)', borderRadius: '6px', fontSize: '12px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', outline: 'none', textAlign: 'center' }}
            />
          </div>
        </div>
        <input
          value={step.label}
          onChange={e => onChange({ ...step, label: e.target.value })}
          placeholder="Step label..."
          style={{ padding: '5px 8px', border: '1px solid rgba(0,0,0,0.1)', borderRadius: '6px', fontSize: '12px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', outline: 'none' }}
        />
      </div>
      <button onClick={onRemove} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c8d8d4', fontSize: '16px', padding: '4px', lineHeight: 1, flexShrink: 0 }}>×</button>
    </div>
  )
}

// ─── Custom Path Builder ──────────────────────────────────────────────────────

function CustomPathBuilder({ path, onChange }: { path: DripPath; onChange: (p: DripPath) => void }) {
  function updateStep(index: number, updated: PathStep) {
    const steps = [...path.steps]
    steps[index] = updated
    onChange({ ...path, steps })
  }

  function removeStep(index: number) {
    onChange({ ...path, steps: path.steps.filter((_, i) => i !== index) })
  }

  function addStep() {
    const lastDay = path.steps[path.steps.length - 1]?.day || 0
    onChange({
      ...path,
      steps: [...path.steps, { id: `s${Date.now()}`, day: lastDay + 3, type: 'email', label: 'New Step' }],
    })
  }

  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      <div style={{ display: 'grid', gap: '8px' }}>
        <div>
          <label style={{ fontSize: '11px', fontWeight: 600, color: '#4a5e5a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px', display: 'block' }}>Path Name</label>
          <input
            value={path.name}
            onChange={e => onChange({ ...path, name: e.target.value })}
            style={{ width: '100%', padding: '9px 12px', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '8px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        <div>
          <label style={{ fontSize: '11px', fontWeight: 600, color: '#4a5e5a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px', display: 'block' }}>Description</label>
          <input
            value={path.description}
            onChange={e => onChange({ ...path, description: e.target.value })}
            placeholder="What makes this path unique?"
            style={{ width: '100%', padding: '9px 12px', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '8px', fontSize: '14px', fontFamily: 'DM Sans, sans-serif', color: '#1a2e2b', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      <div>
        <label style={{ fontSize: '11px', fontWeight: 600, color: '#4a5e5a', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px', display: 'block' }}>Steps</label>
        <div style={{ display: 'grid', gap: '8px' }}>
          {path.steps.map((step, i) => (
            <StepEditor key={step.id} step={step} index={i} onChange={s => updateStep(i, s)} onRemove={() => removeStep(i)} />
          ))}
          <button
            onClick={addStep}
            style={{ padding: '10px', background: 'rgba(168,201,196,0.1)', border: '1.5px dashed rgba(168,201,196,0.4)', borderRadius: '10px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}
          >
            + Add Step
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function LocationPathSettings({ locationName = 'Denver' }: { locationName?: string }) {
  const [paths, setPaths] = useState<DripPath[]>(DEFAULT_PATHS)
  const [selectedPathId, setSelectedPathId] = useState('email-nurture')
  const [editingPath, setEditingPath] = useState<DripPath | null>(null)
  const [showBuilder, setShowBuilder] = useState(false)
  const [saved, setSaved] = useState(false)

  const selectedPath = paths.find(p => p.id === selectedPathId) || paths[0]

  function handleSave() {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function handleCreateCustom() {
    const newPath: DripPath = {
      id: `custom-${Date.now()}`,
      name: 'Custom Path',
      description: 'My custom drip sequence',
      icon: '⭐',
      firstTouch: 'email',
      isCustom: true,
      steps: [
        { id: 's1', day: 0, type: 'email', label: 'Welcome Email' },
        { id: 's2', day: 3, type: 'email', label: 'Follow-up Email' },
      ],
    }
    setEditingPath(newPath)
    setShowBuilder(true)
  }

  function handleSaveCustomPath() {
    if (!editingPath) return
    const exists = paths.find(p => p.id === editingPath.id)
    if (exists) {
      setPaths(prev => prev.map(p => p.id === editingPath.id ? editingPath : p))
    } else {
      setPaths(prev => [...prev, editingPath])
    }
    setSelectedPathId(editingPath.id)
    setShowBuilder(false)
    setEditingPath(null)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '3px', height: '14px', background: '#d4a046', borderRadius: '2px' }} />
          <h2 style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Lead Path — {locationName}
          </h2>
        </div>
        <button
          onClick={handleSave}
          style={{ padding: '7px 16px', background: saved ? '#10b981' : '#1a2e2b', border: 'none', borderRadius: '8px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer', transition: 'background 0.2s' }}
        >
          {saved ? '✓ Saved' : 'Save Changes'}
        </button>
      </div>

      <p style={{ fontSize: '13px', color: '#8a9e9a', marginBottom: '1.25rem', lineHeight: 1.5 }}>
        Choose the default path for new leads at this location. This determines how and when the first touch happens.
      </p>

      {/* Path grid */}
      {!showBuilder && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px', marginBottom: '12px' }}>
            {paths.map(path => (
              <PathCard
                key={path.id}
                path={path}
                selected={selectedPathId === path.id}
                onSelect={() => setSelectedPathId(path.id)}
              />
            ))}
            <div
              onClick={handleCreateCustom}
              style={{ background: 'white', border: '2px dashed rgba(0,0,0,0.08)', borderRadius: '12px', padding: '14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', minHeight: '120px', transition: 'border-color 0.15s' }}
            >
              <span style={{ fontSize: '24px' }}>✨</span>
              <span style={{ fontSize: '13px', fontWeight: 500, color: '#4a5e5a' }}>Create Custom Path</span>
              <span style={{ fontSize: '11px', color: '#8a9e9a' }}>Build your own sequence</span>
            </div>
          </div>

          {/* Edit selected custom path */}
          {selectedPath?.isCustom && (
            <button
              onClick={() => { setEditingPath(selectedPath); setShowBuilder(true) }}
              style={{ fontSize: '12px', color: '#a8c9c4', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'DM Sans, sans-serif', padding: 0, textDecoration: 'underline' }}
            >
              Edit this custom path
            </button>
          )}
        </>
      )}

      {/* Custom path builder */}
      {showBuilder && editingPath && (
        <div style={{ background: '#f7f5f0', borderRadius: '12px', padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '15px', fontFamily: 'Playfair Display, serif', color: '#1a2e2b' }}>
              {editingPath.isCustom ? 'Custom Path' : editingPath.name}
            </h3>
            <button onClick={() => setShowBuilder(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8a9e9a', fontSize: '18px', lineHeight: 1 }}>×</button>
          </div>
          <CustomPathBuilder path={editingPath} onChange={setEditingPath} />
          <div style={{ display: 'flex', gap: '10px', marginTop: '1rem' }}>
            <button onClick={() => setShowBuilder(false)} style={{ flex: 1, padding: '10px', background: 'transparent', border: '1.5px solid rgba(0,0,0,0.1)', borderRadius: '8px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', color: '#4a5e5a', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleSaveCustomPath} style={{ flex: 2, padding: '10px', background: '#1a2e2b', border: 'none', borderRadius: '8px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, color: 'white', cursor: 'pointer' }}>
              Save Path
            </button>
          </div>
        </div>
      )}
    </div>
  )
}