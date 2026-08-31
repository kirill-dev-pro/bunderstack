# Agent Chat IQdoc Adapter Design

**Date:** 2026-08-31
**Status:** approved through design discussion

## Goal

Allow `examples/agent-chat` to run a durable chat turn against IQdoc as an
alternative to the existing OpenAI-compatible responder. IQdoc remains the
upstream agent: it owns medical retrieval, calculators, and any other
provider-side actions. Bunderstack owns the worker lifecycle, canonical answer
draft, observable activity ledger, cancellation, realtime delivery, and
browser recovery.

## Provider boundary

The existing local/OpenAI responder keeps its current Bunderstack tools and
approval behavior. A separate IQdoc responder uses
`@ai-sdk/openai-compatible`, sends conversation messages without Bunderstack
tools, and consumes the response inside the existing server-owned job.

Provider selection is explicit:

```env
AI_PROVIDER=iqdoc
IQDOC_API_KEY=...
IQDOC_BASE_URL=https://...
IQDOC_MODEL=assistant_auto
```

`AI_PROVIDER=openai` preserves the current `AI_API_KEY`, `AI_BASE_URL`, and
`AI_MODEL` configuration. An absent AI key continues to select the deterministic
demo responder. The IQdoc base URL is normalized by removing trailing slashes.

The supported IQdoc model identifiers are:

- `assistant_auto`
- `pubmed_assistant_fast`
- `clinrec_assistant_fast`
- `standart_assistant_fast`
- `esmo_assistant_fast`
- `asa_assistant_fast`
- `far_assistant_fast`
- `assistant_pro`

The model remains an environment setting in this experiment; no model picker
is added to the browser UI.

## IQdoc request contract

IQdoc authenticates with `X-Api-Key`. Each request also sends `X-Chat-Id` and
`X-Message-Id`. Bunderstack TypeIDs encode UUIDv7 bytes, so the adapter decodes
the thread TypeID for the stable chat UUID and the run TypeID for the stable
message UUID. This preserves IQdoc's UUID-shaped correlation contract without
adding provider-specific database columns.

The adapter sends the bounded conversation transcript but does not send the
current Bunderstack tool declaration, tool approval messages, task memory
envelope, or commitment tools. This prevents two independent agent loops from
competing for tool authority.

## Stream translation

IQdoc emits standard OpenAI-compatible text chunks plus provider extensions in
`choices[0].delta`:

- `status: string`
- `calculator_result: object`
- `transcription: string`

A response-stream interceptor parses complete SSE events across arbitrary byte
boundaries. It removes events whose delta contains only provider extensions
before forwarding the stream to the AI SDK. Mixed events remain in the stream
after the intercepted keys are removed, so standard text in the same event is
never lost. SSE comments and `[DONE]` remain valid.

Distinct consecutive statuses call the durable stream observer as completed
`status` steps. Calculator results become completed visible `tool_call` steps;
the title uses the result name, calculator ID, or `Calculator result`, and the
complete structured result is stored as output. Transcription events are
filtered for protocol compatibility but are not displayed because this example
does not submit audio.

Text deltas continue through `writeTextDelta`, using the existing 150 ms
canonical snapshot pacing. The browser never consumes the IQdoc HTTP response
directly.

## Recovery and errors

Browser disconnect, reload, route change, and mobile suspension retain the
existing guarantee: the worker continues consuming IQdoc, writes answer
snapshots and activity steps to the database, and a returning browser refetches
the latest canonical state.

Non-success IQdoc responses and malformed standard model chunks fail the
server-owned run through the existing runtime error path while preserving any
text and completed activity already persisted. Provider-stream continuation
after the worker or upstream connection itself fails remains outside scope.

## Testing

Unit tests use an injected fetch and literal SSE fixtures; they require no API
key or network. They cover split chunks, status deduplication, mixed text and
extension deltas, calculator results, auth/correlation headers, model and
endpoint selection, and failure responses. A runtime test proves translated
activity becomes durable ledger rows while text uses the canonical draft.

An actual IQdoc call is an optional manual smoke test using local secrets. It
is not part of the default test suite.

## Non-goals

- Passing Bunderstack task, memory, approval, or commitment tools to IQdoc.
- Reimplementing IQdoc medical tools inside Bunderstack.
- Persisting hidden chain-of-thought.
- Adding a browser model selector.
- Resuming an interrupted provider connection from an exact token.
- Modifying the separate `iqdoc.ai` repository.
