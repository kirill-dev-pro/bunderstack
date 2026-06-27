import { useEffect } from 'react'

export function OatInit() {
  useEffect(() => {
    void import('@knadh/oat/oat.min.js')
  }, [])
  return null
}
