import type { DbFor, Driver } from '../db'
import type { AnyDb, Dialect } from '../dialect'

export type DatabaseConnection = {
  url: string
  authToken?: string
}

export type DatabaseConnectOptions = { introspect: boolean }

export type DatabaseConnectionResult<TSchema extends Record<string, unknown>> =
  {
    db: DbFor<TSchema>
    close?: () => void | Promise<void>
  }

export type DatabaseAdapter = {
  readonly dialect: Dialect
  readonly driver: Driver
  connect<TSchema extends Record<string, unknown>>(
    schema: TSchema,
    connection: DatabaseConnection,
    options: DatabaseConnectOptions,
  ): Promise<DatabaseConnectionResult<TSchema>>
  migrate(db: AnyDb, migrationsFolder: string): Promise<void>
}
