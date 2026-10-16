// components/hive/shared/PhoneInput.jsx
// ─────────────────────────────────────────────────────────────
// THE phone box: an <input> that formats as the person types —
// "(336) 555-1234", extension after ten digits, a leading "+" left alone,
// pastes cleaned. The rules and every cursor/backspace case live in
// lib/phone-mask.ts; this file only wires them to a real input.
//
// Use it wherever someone TYPES a phone. Saving still formats
// (lib/phone.ts) — that is the backstop for the web form, the Jobber
// import and webhooks.
//
//   <PhoneInput value={phone} onValueChange={setPhone} style={…} … />
//
// Every other prop passes straight to the <input>. onValueChange gets the
// masked string; a plain onChange, if given, still gets the event after.
//
// THE CURSOR. React re-renders a controlled input with the new value and
// the browser then parks the cursor at the end. So the handler writes the
// masked value and cursor into the element itself, synchronously, and a
// layout effect re-applies the cursor after React's render — the person
// keeps editing exactly where they were. When the mask leaves the value
// unchanged (a letter typed and dropped), React does not re-render at all,
// which is why the synchronous write is needed too.
// ─────────────────────────────────────────────────────────────
import { forwardRef, useLayoutEffect, useRef } from 'react'
import { maskPhoneInput } from '@/lib/phone-mask'

const PhoneInput = forwardRef(function PhoneInput({ value, onValueChange, onChange, type = 'tel', ...rest }, outerRef) {
  const inner = useRef(null)
  const pendingCaret = useRef(null)

  const setRefs = (el) => {
    inner.current = el
    if (typeof outerRef === 'function') outerRef(el)
    else if (outerRef) outerRef.current = el
  }

  useLayoutEffect(() => {
    const el = inner.current
    const c = pendingCaret.current
    pendingCaret.current = null
    if (el && c !== null && el.ownerDocument?.activeElement === el) {
      try { el.setSelectionRange(c, c) } catch { /* type without selection API */ }
    }
  })

  return (
    <input
      {...rest}
      ref={setRefs}
      type={type}
      inputMode="tel"
      autoComplete={rest.autoComplete ?? 'tel'}
      value={value ?? ''}
      onChange={(e) => {
        const el = e.target
        const prev = String(value ?? '')
        const { value: next, caret } = maskPhoneInput(prev, el.value, el.selectionStart, e.nativeEvent?.inputType)
        if (el.value !== next) el.value = next
        try { el.setSelectionRange(caret, caret) } catch { /* ignore */ }
        pendingCaret.current = caret
        onValueChange?.(next)
        onChange?.(e)
      }}
    />
  )
})

export default PhoneInput
