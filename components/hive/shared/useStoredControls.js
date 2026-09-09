// components/hive/shared/useStoredControls.js — SSR-safe persisted
// control state (the bee_hive_beta_lens pattern, generalized): hydrate
// from localStorage after mount, write-through on change, never write
// defaults before hydration finishes. clear() resets AND removes the
// stored key. One hook per surface key (bee_hive_list_filters,
// bee_hive_board_sort, bee_hive_inbox_*, bee_hive_clients_*).
//
// The key MAY be dynamic (issue 123: the Inbox filter key carries the
// location scope). When it changes, the effect re-reads the new key and
// resets to defaults if that key holds nothing — otherwise the previous
// scope's value would linger under a scope that never stored it. On mount
// with an empty key this is a no-op (setValue(defaultsRef.current) matches
// the initial state ref, so React bails — no wasted render for the common
// constant-key consumers).
//
// THE HYDRATION GUARD IS STATE, NOT A REF (Ankur, Palm Beach — "the A-Z
// sort is not permanent"). It previously was `hydrated = useRef(false)`
// flipped at the END of the hydrate effect. Effects run in declaration
// order within ONE commit, so the write-through effect below saw the flag
// already true while `value` was still the FIRST render's default — and
// wrote that default to localStorage before the hydrated value landed:
//
//   WRITES DURING MOUNT: ["{"key":"newest"}", "{"key":"client"}"]
//
// The re-render wrote the real value back a beat later, so it self-healed
// and looked fine. It does NOT self-heal when the consumer unmounts
// between those two writes, and HiveShell guarantees that: `lens` starts
// at 'engagements' and hydrates post-mount, so every load that lands on
// Client List or Inbox mounted EngagementBoard, clobbered
// bee_hive_board_sort to the default, then unmounted it. The owner's sort
// was destroyed on disk — surviving only if they happened to reload while
// sitting on the board, which is why it read as random.
//
// A ref cannot fix this: any ref written in the hydrate effect is visible
// to the write-through effect in the SAME commit. Only a state flip is
// invisible until the render that also carries the hydrated value. The
// guard holds the KEY rather than a boolean so the same clobber on a KEY
// CHANGE is closed too — the previous scope's value can no longer be
// written under a new scope's key before that key is read.
'use client'

import { useState, useEffect, useRef } from 'react'

export function useStoredState(key, defaults) {
  const [value, setValue] = useState(defaults)
  // The hydration guard is STATE, not a ref, and it holds the KEY it
  // hydrated — see the header. A ref would be visible to the write-through
  // effect in the same commit; only a state flip is invisible until the
  // render that also carries the hydrated value.
  const [hydratedKey, setHydratedKey] = useState(null)
  const defaultsRef = useRef(defaults)

  useEffect(() => {
    let next = defaultsRef.current
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null')
      if (raw && typeof raw === 'object') next = { ...defaultsRef.current, ...raw }
    } catch {}
    setValue(next)
    setHydratedKey(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    // Only write once `value` is the value that was read for THIS key.
    // Before that, `value` is still the pre-hydration default (on mount)
    // or the previous key's value (on a key change) — writing either one
    // is the clobber this guard exists to prevent.
    if (hydratedKey !== key) return
    try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
  }, [key, value, hydratedKey])

  const clear = () => {
    setValue(defaultsRef.current)
    try { localStorage.removeItem(key) } catch {}
  }
  return [value, setValue, clear]
}
