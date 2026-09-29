// The app backend that bunderstack() resolves in the app's Vite build.
declare module 'virtual:bunderstack/backend' {
  import type { BunderstackBackend } from './backend'

  export const backend: BunderstackBackend<any>
}
