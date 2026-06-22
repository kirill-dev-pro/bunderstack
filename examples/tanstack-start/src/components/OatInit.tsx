import { useEffect } from 'react'

/** Load Oat JS in the browser only — the bundle references HTMLElement at import time. */
export function OatInit() {
  useEffect(() => {
    void import('@knadh/oat/oat.min.js')
  }, [])
  return null
}
