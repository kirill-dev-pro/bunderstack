import type { QueryClient, UseMutationOptions } from '@tanstack/react-query'

import type { TableClient } from './table-client'

export type TableMutationOptions<TRow, TCreate, TUpdate> = {
  createMutation: (
    options?: Omit<
      UseMutationOptions<TRow, Error, Partial<TCreate>>,
      'mutationFn'
    >,
  ) => UseMutationOptions<TRow, Error, Partial<TCreate>>
  updateMutation: (
    options?: Omit<
      UseMutationOptions<TRow, Error, { id: string | number; data: TUpdate }>,
      'mutationFn'
    >,
  ) => UseMutationOptions<TRow, Error, { id: string | number; data: TUpdate }>
  deleteMutation: (
    options?: Omit<
      UseMutationOptions<void, Error, string | number>,
      'mutationFn'
    >,
  ) => UseMutationOptions<void, Error, string | number>
}

export function attachMutationOptions<TRow, TCreate, TUpdate>(
  table: TableClient<TRow, TCreate, TUpdate>,
  queryClient?: QueryClient,
): TableMutationOptions<TRow, TCreate, TUpdate> {
  const invalidate = () => {
    if (queryClient)
      void queryClient.invalidateQueries({ queryKey: table.keys.all })
  }

  return {
    createMutation(options = {}) {
      const { onSuccess, ...rest } = options
      return {
        mutationFn: (data: Partial<TCreate>) => table.create(data),
        onSuccess: (data, variables, context) => {
          invalidate()
          onSuccess?.(data, variables, context)
        },
        ...rest,
      }
    },
    updateMutation(options = {}) {
      const { onSuccess, ...rest } = options
      return {
        mutationFn: ({ id, data }: { id: string | number; data: TUpdate }) =>
          table.update(id, data),
        onSuccess: (data, variables, context) => {
          invalidate()
          if (queryClient)
            void queryClient.setQueryData(table.keys.detail(variables.id), data)
          onSuccess?.(data, variables, context)
        },
        ...rest,
      }
    },
    deleteMutation(options = {}) {
      const { onSuccess, ...rest } = options
      return {
        mutationFn: (id: string | number) => table.delete(id),
        onSuccess: (data, variables, context) => {
          invalidate()
          onSuccess?.(data, variables, context)
        },
        ...rest,
      }
    },
  }
}
