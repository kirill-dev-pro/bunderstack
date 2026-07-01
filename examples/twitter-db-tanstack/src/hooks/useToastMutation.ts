import { useMutation, type UseMutationOptions } from '@tanstack/react-query'

import { toast } from '~/utils/oat'

export function useToastMutation<
  TData,
  TError extends Error,
  TVariables,
  TContext,
>(
  options: UseMutationOptions<TData, TError, TVariables, TContext> & {
    successMessage?: string
    errorMessage?: string
  },
) {
  const { successMessage, errorMessage, onSuccess, onError, ...rest } = options

  return useMutation({
    ...rest,
    onSuccess: (data, variables, context, meta) => {
      if (successMessage) toast.success(successMessage)
      onSuccess?.(data, variables, context, meta)
    },
    onError: (error, variables, context, meta) => {
      toast.error(errorMessage ?? error.message)
      onError?.(error, variables, context, meta)
    },
  })
}
