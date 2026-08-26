# Declarative Agent Chat Experiment Design

**Date:** 2026-08-26
**Status:** validated through design discussion

## Goal

Evolve `examples/agent-chat` into an incubation surface for a declarative,
durable application agent. The primary product case is deliberately narrow:
one authenticated or anonymous user talks to one personal agent, and that
agent is the user's main interface to the web application's resources.

The experiment should make agent construction substantially smaller and make
authorization, memory, system-initiated turns, approvals, and effects visible.
It must remain app-local. It does not add a public `agent` key to
`createBunderstack`, create a package, or promise API stability.

## Scope and simplifying assumptions

- One agent definition per application.
- One durable agent thread per user; the existing unique `userId` on
  `agentThreads` is the personal agent instance.
- The agent always acts as the authenticated user. There is no service identity
  or generic actor model.
- One user interacts with one agent. Group chat, spaces, multiple agents,
  delegation, and agent-to-agent communication are non-goals.
- The current Bunderstack job queue, realtime facade, database, Better Auth
  integration, and generated read-only CRUD remain the infrastructure.
- The app continues to run without an AI credential through a deterministic
  responder.

These constraints are intentional. If a real application later requires group
or multi-agent interaction, it may introduce a different model rather than
paying that complexity in the 99% case now.

## App-local declaration

The example should be reshaped around an app-local declaration resembling the
possible future API:

```ts
export const agent = defineAgent({
  instructions: ({ user, memory }) => `
    You are ${user.name}'s personal application assistant.
    ${memory.preferences}
  `,

  model: ({ env }) => createModel(env.AI_MODEL),

  access: {
    interact: 'authenticated',
  },

  tools: {
    listTasks,
    createTask,
    completeTask,
    scheduleReminder,
    remember,
  },

  events: {
    'subscription.limit_near': limitNearEvent,
    'task.reminder_due': reminderDueEvent,
  },

  context: {
    conversation: { recent: 20 },
    inbox: { maxItems: 10 },
    memory: { maxItems: 8 },
  },
})
```

`defineAgent` and `defineTool` live inside the example. The example wires their
schema, jobs, API, and access rules into `createBunderstack` manually. The
declaration is allowed to change as experiments expose better boundaries.

## Tool boundary

A tool is a server-side application capability, not an API route and not raw
database access. It has a model-facing description and input schema, plus an
application-facing execution function and approval policy.

```ts
export const completeTask = defineTool({
  description: 'Complete a task owned by the current user.',
  input: type({ taskId: 'string' }),
  approval: 'none',

  execute: async ({ taskId }, ctx) => {
    return commands.tasks.complete({ taskId }, ctx)
  },
})
```

The model never receives the runtime context and cannot choose `userId`. Every
effect is scoped to the authenticated user inside the command or tool. The
declaration's tool map is the agent's capability allowlist.

The example may keep commands app-local and small, but authorization, resource
limits, idempotency, realtime publication, and audit must live below the model
adapter. The agent may explain a quota, but it cannot enforce billing by prompt.

## Turns, inbox, and context

A turn is a durable unit of decision-making, not necessarily a reply to a user
message:

```text
trigger
  -> assemble bounded context
  -> model decision and tool loop
  -> optional conversation message
  -> memory updates and inbox acknowledgement
```

Valid outcomes are `completed`, `no_action`, `waiting_for_input`,
`waiting_for_approval`, and `failed`. A system-triggered turn may update memory,
call an allowed tool, or do nothing without producing a user-visible message.

System input is stored in a durable, structured inbox rather than appended
directly to conversation history. Event definitions choose a delivery mode:

- `immediate`: enqueue a turn now;
- `next_turn`: keep the event pending until the next natural interaction;
- `silent`: make the event available without automatically placing it in the
  model context.

Delivery timing is separate from whether a user message is required. Event
types can aggregate pending items with `latest`, `collect`, or `count` policies
before context assembly.

The context assembler has an explicit budget and selects only:

- initial instructions;
- compact user preferences;
- a conversation summary and recent messages;
- relevant pending inbox events;
- the current trigger;
- the tools available to this agent.

Operational application state such as quotas, project status, and current
records is loaded through a context provider or tool. It is not copied into
long-term memory.

## Memory

The first memory model is structured and inspectable. It avoids vector search
and automatic persistence of arbitrary content.

```ts
type MemoryKind = 'preference' | 'fact' | 'summary'
```

Each record stores `kind`, `key`, `value`, source type, source ID, and
timestamps. A built-in `remember` capability performs validated writes.
External content and arbitrary tool results may affect the current turn but
cannot directly become trusted long-term memory. A user statement or trusted
system rule must authorize persistence.

The example UI exposes memory in the runtime rail with read, inline edit, and
delete controls. A future library should expose storage and access primitives,
but whether an application shows or edits memory remains a product decision.

Conversation summaries are derived context, not authoritative facts. Current
application data and structured preferences win when they conflict with a
summary.

## Approvals, grants, and autonomous effects

Tools define their minimum approval policy. The agent may ask for permission
more often but cannot weaken the tool policy.

An approval freezes one exact call: tool ID, tool version, arguments, user, and
expiry. `Allow now` executes only that call. `Always allow` also creates a
persistent grant scoped to this user's personal agent, tool, version, and any
tool-defined constraints. Grants are visible and revocable in the UI.

The runtime evaluates effects in this order:

```text
application authorization
  -> hard tool policy
  -> matching persistent grant or event capability
  -> user approval
  -> execute and audit
```

A model is never an authorization boundary. A future model-based evaluator may
recommend `ask_user` or `deny`, but it cannot independently create authority or
persistent grants.

For safe autonomous system turns, an event may create an exact, runtime-side
capability:

```ts
'post.approved': {
  delivery: 'immediate',
  capabilities: ({ event }) => [
    allowTool('publishPost', {
      postId: event.postId,
      channel: event.channel,
    }),
  ],
}
```

The capability is not serialized into model-visible text and cannot be widened
by prompt injection. Without a matching grant or capability, an effectful call
must ask the user.

## Requests and pause/resume

Clarifications and approvals are durable requests rather than only chat text.
They have `pending`, resolved, rejected, and expired states. A waiting request
does not retain a worker or thread lock.

When the user supplies information, the response becomes a new inbox item and
wakes the same agent. When the user approves an effect, the runtime executes the
frozen call rather than asking the model to reconstruct it, then wakes the agent
with the result.

## Anonymous-first authentication

The opening screen no longer asks for a name. Better Auth's anonymous plugin
creates the user and uses `generateName` to assign a friendly name such as
`Curious Owl` or `Quiet Wolf`.

Registration is an optional `Save your agent` action inside the agent desk. It
asks only for email and password, uses the existing friendly name for Better
Auth's required name field, and does not require email verification in the
experiment.

Better Auth calls `onLinkAccount` before deleting the old anonymous user. The
example must use that hook to transfer every agent-owned row from the anonymous
user ID to the new permanent user ID in a transaction. Application data is not
transferred automatically by the plugin, and the current cascade foreign keys
would otherwise delete it.

The initial experiment supports upgrading an anonymous user to a new account.
Merging into an already populated existing account is outside its scope.

## Durability and failures

- Every run and proposed tool call receives a stable ID.
- Effectful tools use an idempotency key derived from the agent thread, run, and
  call.
- Job retry may repeat computation but not an already completed external
  effect.
- Inbox events remain pending until a turn reaches an intentional outcome.
- Thread locks are always released.
- Pending requests do not retain locks.
- Conversation persistence and external channel delivery are separate; an
  outbox retry must not rerun the model or tools.
- Model-provider failure is recorded as a failed run and does not silently
  invent a user-facing success response.

## Verification matrix

The experiment needs focused integration tests proving:

1. Two anonymous users cannot read each other's conversation, memory, grants,
   requests, or runs.
2. Anonymous registration transfers the complete agent context without cascade
   deletion.
3. Duplicate inbox delivery and job retry do not duplicate effects.
4. A wake received during a turn schedules a recovery turn.
5. External prompt injection cannot create a capability or trusted memory.
6. The model cannot invoke a tool absent from the agent declaration.
7. `Allow now` executes only the frozen call and arguments.
8. `Always allow` creates a scoped, revocable grant for this personal agent.
9. An event capability matches only its declared tool and arguments.
10. Memory edits and deletion affect the next assembled context.
11. Delivery retry does not repeat the agent turn.
12. Expired inbox events and approval requests cannot be used.

## Explicit non-goals

- A public Bunderstack agent API or a new package.
- Multiple agent definitions in one application.
- Group chat, spaces, participants, shared memory, or multiple users per agent.
- Agent-to-agent messages, delegation, or loop prevention.
- Service identities or a generalized actor model.
- Automatic CRUD-to-tool generation or arbitrary database access.
- A model with authority to approve its own or another model's actions.
- Vector memory, hidden chain-of-thought persistence, or external messaging
  channel implementations.

The design should be revisited only after the app-local declaration has been
used in this example and at least one real application.
