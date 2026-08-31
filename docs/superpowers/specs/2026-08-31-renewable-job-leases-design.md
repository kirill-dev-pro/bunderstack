# Renewable Job Leases and Execution Deadlines Design

**Date:** 2026-08-31
**Status:** approved through design discussion

## Problem

The continuous worker pumps while handlers are active. A handler that remains
healthy beyond its fixed lease is therefore recovered and claimed again while
the original invocation is still running. Agent jobs make the failure visible:
the replacement invocation quickly observes the thread lock and succeeds, so
the dashboard shows `succeeded`, two attempts, and `lease expired` together.
The original provider stream may still consume money and perform side effects.

The current `timeout` option is documented as a lease duration, but is easily
read as an execution deadline. One number cannot safely express both concerns:
a lease answers "when may another worker recover this row?" while a deadline
answers "how long may this handler keep working?"

## Contract

Background definitions gain two explicit options:

```ts
type BackgroundTiming = {
  leaseDuration?: number
  maxRuntime?: number
  /** @deprecated Use leaseDuration. */
  timeout?: number
}
```

`leaseDuration` defaults to 60 seconds. The deprecated `timeout` remains a
backward-compatible alias for one release line; declaring both is invalid.
`maxRuntime` is optional. When present it is a cooperative execution deadline,
not permission to run a duplicate invocation.

Every handler context contains `signal: AbortSignal`. A deadline aborts that
signal with a typed execution-timeout reason; lease loss aborts it with a
distinct reason. Integrations that can cancel external work must pass the
signal through. Because JavaScript cannot forcibly stop an
arbitrary promise, the worker keeps renewing ownership until a non-cooperative
handler settles; it logs that the deadline was exceeded but never creates a
concurrent retry merely to enforce wall-clock time.

## Lease ownership and renewal

The row's incremented `attempts` value is the fencing generation. A claim owns
`(id, attempts)` while the row is `running`. No schema migration or separate
lease identifier is needed.

At one third of `leaseDuration`, the worker atomically extends `lockedUntil`
only when the row still matches its job id, attempt generation, running status,
and prior `lockedUntil`. Renewal is serialized per invocation. Before a
terminal update, the worker stops and awaits the heartbeat, then fences the
update on the final `lockedUntil` and attempt generation.

If renewal changes no row, ownership has been lost. The handler signal is
aborted, the old invocation may not update queue state, and the active promise
is drained without an unhandled rejection. Expired-lease recovery is likewise
fenced on the expired generation and observed `lockedUntil`, so it cannot undo
a concurrent renewal.

## Deadline and retry behavior

When `maxRuntime` elapses, the signal is aborted and the runtime records one
warning. After the handler settles, the attempt follows the existing retry and
backoff policy with the stable error `execution timed out after <n>ms`. If the
handler returns successfully after swallowing the abort, the deadline still
wins and the attempt is treated as timed out.

An omitted `maxRuntime` means no framework execution deadline. Graceful worker
shutdown retains the existing contract: stop claiming and drain active handlers.
If the process is forcibly killed, heartbeat stops and another worker recovers
the row after the last renewed lease expires.

## Lifecycle logging

The runner emits bounded JSON strings through the existing logger for:

- `job.claimed` at info;
- `job.completed` at info;
- `job.retrying` at warn;
- `job.execution_timed_out` at warn;
- `job.lease_lost` at warn;
- `job.failed` at error.

Each event contains `jobId`, `jobType`, `attempt`, `durationMs`, and `outcome`
where applicable. Payloads, environment values, and exception stacks are not
included. This is the application-side contract consumed by Bunderhost logs;
no attempt-history table is introduced.

## Agent chat adoption

`agentTurn` and `agentCommitment` use a 30-second renewable lease and a
10-minute execution deadline. Their runtime links `ctx.signal` to the existing
provider/cancellation controller. `agentReminder` keeps the default lease and
has no execution deadline.

## Non-goals

- Strict global concurrency across multiple workers.
- Forcibly terminating non-cooperative JavaScript.
- A persistent job-attempt table.
- New dashboard or MCP background-run endpoints.
- Bunderhost container-log retention; that is a separate platform change.

## Verification

Tests prove renewal prevents a second claim beyond the original lease, a
crashed worker remains recoverable, renewal and completion cannot race, a
deadline aborts the handler and retries only after it settles, lease loss fences
the stale invocation, agent provider work receives the signal, and existing
deterministic tick, cron, retry, and shutdown behavior remains intact.
