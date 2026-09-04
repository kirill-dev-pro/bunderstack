export const MESSAGING_DESCRIPTOR: unique symbol = Symbol.for(
  'bunderstack.messaging-descriptor',
)

export type MessagingDescriptor<
  TKind extends string,
  TProvider extends string,
  TInput,
  TResult,
  TConfig = unknown,
> = {
  readonly kind: TKind
  readonly provider: TProvider
  readonly config: Readonly<TConfig>
  readonly [MESSAGING_DESCRIPTOR]: {
    readonly input: TInput
    readonly result: TResult
  }
}

export type AnyMessagingDescriptor = MessagingDescriptor<
  string,
  string,
  any,
  any,
  any
>

export type MessagingConfig = Record<string, AnyMessagingDescriptor>

export type MessagingFacade<TDescriptor extends AnyMessagingDescriptor> = {
  send(
    input: TDescriptor[typeof MESSAGING_DESCRIPTOR]['input'],
  ): Promise<TDescriptor[typeof MESSAGING_DESCRIPTOR]['result']>
}

export type MessagingFacades<TConfig extends MessagingConfig> = {
  readonly [K in keyof TConfig]: MessagingFacade<TConfig[K]>
}

export type MessagingFacadesFor<TConfig extends MessagingConfig | undefined> =
  TConfig extends MessagingConfig
    ? MessagingFacades<TConfig>
    : Record<never, never>

export function descriptor<
  TKind extends string,
  TProvider extends string,
  TInput,
  TResult,
  TConfig,
>(
  kind: TKind,
  provider: TProvider,
  config: TConfig,
): MessagingDescriptor<TKind, TProvider, TInput, TResult, TConfig> {
  return Object.freeze({
    kind,
    provider,
    config: Object.freeze({ ...config }),
    [MESSAGING_DESCRIPTOR]: undefined as never,
  })
}

export function isMessagingDescriptor(
  value: unknown,
): value is AnyMessagingDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    MESSAGING_DESCRIPTOR in value &&
    typeof (value as AnyMessagingDescriptor).kind === 'string' &&
    typeof (value as AnyMessagingDescriptor).provider === 'string'
  )
}
