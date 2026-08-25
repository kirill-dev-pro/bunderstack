# Solid 2 и общий Bunderstack client

## Итоговая граница

```text
Bunderstack CRUD + realtime
  -> createClient<App>() (typed oRPC, no codegen)
       -> bunderstack/client LiveView (confirmed state)
       -> bunderstack/client/solid (keyed Solid store)
            -> createOptimisticStore (action-local speculation)
                 -> UI
```

Пример больше не содержит SSE parser, reconnect-loop, frame reducer,
AbortController, ручной `createStore` или `reconcile`. Эти механизмы не имеют
отношения к предметной области Todo и теперь живут в framework-neutral
`bunderstack/client`.

В `todos.ts` остались только:

- параметры live view;
- три синхронные optimistic-записи;
- три server mutations.

`App` содержит type-only carrier oRPC router, поэтому клиент получает CRUD,
custom procedures и `live` напрямую. Better Auth не входит в этот router:
`/api/auth/*` обслуживается тем же `app.handler`, но на фронтенде используется
официальный Better Auth client с его session primitives и plugin-aware types.

## Подтверждение мутации

`LiveView.mutate(method, input)` генерирует внутренний `operationId`, передаёт
его transport-методу и регистрирует waiter до начала HTTP request. CRUD
publisher добавляет тот же ID в realtime change, а live frame сохраняет его.
Action завершается только после этого frame.

Если HTTP уже завершился успешно, но соединение оборвалось до matching frame,
waiter не теряется: reconnect получает свежий authoritative snapshot, который
подтверждает все такие мутации. Heartbeat watchdog также сам перезапускает
«тихое» соединение, не ожидая следующего действия пользователя.

Так исчезает прежнее мигание `optimistic -> stale -> confirmed`: Solid держит
overlay, пока authoritative state уже не окажется в confirmed store.

`operationId` не является ID записи. Todo ID генерирует backend/database. При
create UI использует временный `pending:*` render key, после acknowledgement
snapshot заменяет его записью с настоящим server ID.

## Bounded view correctness

Для `limit: 100` клиент не знает строку 101 и не может корректно заполнить
границу после delete. Поэтому сервер повторно выполняет scoped list и отдаёт
snapshot с `operationId`. Это дороже одиночного delta, но корректно; позднее
протокол можно оптимизировать backfill/rank frame без изменения adapter API.

## Как это используется другими библиотеками

```text
bunderstack (server/protocol)
  -> bunderstack/client (oRPC, SSE, reconnect, LiveView, operation ack)
       -> /solid, /react, /vue, /svelte
       -> bunderstack/query (TanStack Query cache policy)
            -> bunderstack/sync (TanStack DB collections)
```

Raw realtime transport был вынесен из `bunderstack/query` в общий пакет;
старый Query module теперь лишь re-export. Query сохраняет query keys,
invalidation и patch policy. TanStack DB сохраняет collections и optimistic
transactions, но realtime получает напрямую из `bunderstack/client`, без
транзитного `QueryClient`.

## Framework adapters

- Solid — keyed mutable store, поверх которого приложение использует
  `createOptimisticStore` и `action`.
- React — `useSyncExternalStore`.
- Vue — `shallowRef` и `onScopeDispose`.
- Svelte — стандартный readable-store contract без runtime dependency.

Framework остается владельцем scheduling и optimism. Adapter не реализует
второй cache и не вычисляет server filters локально.

## Что еще стоит улучшить

1. Если появится offline-first сценарий, добавить persisted operation journal,
   переживающий полный reload приложения; обычный reconnect уже закрывается
   authoritative snapshot.
2. Обобщить raw stream transport так, чтобы `LiveView` использовал тот же
   Last-Event-ID replay engine, что и table-wide realtime; liveness watchdog
   уже есть в обоих путях.
3. Оставить route-map/OpenAPI REST adapter опциональным сценарием для отдельного
   frontend-репозитория, где импортировать `App` невозможно.
