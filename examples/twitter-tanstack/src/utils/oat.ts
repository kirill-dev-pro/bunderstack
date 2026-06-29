type ToastOptions = {
  variant?: 'success' | 'danger' | 'warning' | ''
  placement?:
    | 'top-right'
    | 'top-left'
    | 'top-center'
    | 'bottom-right'
    | 'bottom-left'
    | 'bottom-center'
  duration?: number
}

declare global {
  interface Window {
    ot?: {
      toast: ((
        message: string,
        title?: string,
        options?: ToastOptions,
      ) => void) & {
        el: (element: Element, options?: ToastOptions) => void
        clear: (placement?: string) => void
      }
    }
  }
}

if (typeof window !== 'undefined') {
  void import('@knadh/oat/oat.min.js')
}

function otToast() {
  if (typeof window === 'undefined') return undefined
  return window.ot?.toast
}

export function showToast(
  message: string,
  title?: string,
  options?: ToastOptions,
) {
  const toast = otToast()
  if (typeof toast === 'function') toast(message, title, options)
}

export const toast = {
  success(message: string, title = 'Success') {
    showToast(message, title, { variant: 'success' })
  },
  error(message: string, title = 'Error') {
    showToast(message, title, { variant: 'danger' })
  },
  warning(message: string, title = 'Warning') {
    showToast(message, title, { variant: 'warning' })
  },
  info(message: string, title = '') {
    showToast(message, title)
  },
}

export function showDialog(dialog: HTMLDialogElement | null) {
  if (typeof window === 'undefined') return
  dialog?.showModal()
}

export function closeDialog(dialog: HTMLDialogElement | null) {
  if (typeof window === 'undefined') return
  dialog?.close()
}
