// @vitest-environment happy-dom
//
// PhoneInput in a real DOM: the mask's cursor promises survive React's
// controlled re-render (which on its own would park the cursor at the end).
// The pure keystroke rules are pinned in lib/phone-mask.test.ts; this file
// pins that the component actually delivers them to a person typing.
import { describe, it, expect, afterEach } from 'vitest'
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import PhoneInput from '@/components/hive/shared/PhoneInput'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const hosts: HTMLElement[] = []
afterEach(() => { for (const h of hosts.splice(0)) h.remove() })

let lastValue = ''
function Harness({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial)
  lastValue = v
  return <PhoneInput aria-label="Phone" value={v} onValueChange={setV} />
}

async function mount(initial = '') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  hosts.push(host)
  const root = createRoot(host)
  await act(async () => { root.render(<Harness initial={initial} />) })
  const el = host.querySelector('input') as HTMLInputElement
  el.focus()
  return el
}

// What the browser does before React sees the edit: change the value, move
// the cursor, fire an input event carrying the edit's inputType.
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
async function edit(el: HTMLInputElement, raw: string, caret: number, inputType: string) {
  await act(async () => {
    setter.call(el, raw)
    el.setSelectionRange(caret, caret)
    el.dispatchEvent(new (window as any).InputEvent('input', { bubbles: true, inputType }))
  })
}
const type = (el: HTMLInputElement, ch: string) => {
  const c = el.selectionStart ?? el.value.length
  return edit(el, el.value.slice(0, c) + ch + el.value.slice(c), c + ch.length, 'insertText')
}
const backspace = (el: HTMLInputElement) => {
  const c = el.selectionStart ?? el.value.length
  return edit(el, el.value.slice(0, c - 1) + el.value.slice(c), c - 1, 'deleteContentBackward')
}
const paste = (el: HTMLInputElement, s: string) => {
  const c = el.selectionStart ?? el.value.length
  return edit(el, el.value.slice(0, c) + s + el.value.slice(c), c + s.length, 'insertFromPaste')
}
const place = async (el: HTMLInputElement, caret: number) => { await act(async () => { el.setSelectionRange(caret, caret) }) }
const show = (el: HTMLInputElement) => el.value.slice(0, el.selectionStart!) + '|' + el.value.slice(el.selectionStart!)

describe('PhoneInput — typed by a person', () => {
  it('builds (336) 555-1234 as they type, and the state holds the masked value', async () => {
    const el = await mount()
    for (const ch of '3365551234') await type(el, ch)
    expect(show(el)).toBe('(336) 555-1234|')
    expect(lastValue).toBe('(336) 555-1234')
  })

  it('backspace from the end never sees a separator come back', async () => {
    const el = await mount()
    for (const ch of '3365551') await type(el, ch)
    await backspace(el)
    expect(show(el)).toBe('(336) 555|')
    await backspace(el)
    expect(show(el)).toBe('(336) 55|')
  })

  it('editing mid-number: the cursor stays on the digit being edited, not the end', async () => {
    const el = await mount('(336) 555-1234')
    await place(el, 8)                       // "(336) 55|5-1234"
    await backspace(el)
    expect(show(el)).toBe('(336) 5|51-234')
    await type(el, '9')
    expect(show(el)).toBe('(336) 59|5-1234')
    expect(lastValue).toBe('(336) 595-1234')
  })

  it('backspace right after "-" deletes the digit before it and keeps the cursor there', async () => {
    const el = await mount('(336) 555-1234')
    await place(el, 10)                      // "(336) 555-|1234"
    await backspace(el)
    expect(show(el)).toBe('(336) 55|1-234')
  })

  it('a letter typed mid-number is dropped and the cursor does not jump', async () => {
    const el = await mount('(336) 555-1234')
    await place(el, 7)
    await type(el, 'a')
    expect(show(el)).toBe('(336) 5|55-1234')
  })

  it('keeps going into an extension after ten digits', async () => {
    const el = await mount('(336) 555-1234')
    await place(el, 14)
    for (const ch of '202') await type(el, ch)
    expect(show(el)).toBe('(336) 555-1234 ext. 202|')
  })

  it('a leading + leaves a foreign number exactly as typed', async () => {
    const el = await mount()
    for (const ch of '+82-10-2890-8574') await type(el, ch)
    expect(el.value).toBe('+82-10-2890-8574')
  })

  it('pasting "Phone: (512) 787-5175" comes out clean', async () => {
    const el = await mount()
    await paste(el, 'Phone: (512) 787-5175')
    expect(show(el)).toBe('(512) 787-5175|')
    expect(lastValue).toBe('(512) 787-5175')
  })

  it('pasting "512.787.5175" comes out clean', async () => {
    const el = await mount()
    await paste(el, '512.787.5175')
    expect(show(el)).toBe('(512) 787-5175|')
  })
})
