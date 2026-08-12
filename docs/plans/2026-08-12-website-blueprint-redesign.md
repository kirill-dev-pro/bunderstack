# Website Blueprint Redesign

## Status

Approved for implementation on 2026-08-12.

## Goal

Make the public website explain Bunderstack's oRPC-first mental model with a
more expressive visual identity, while keeping type inspection only where it
helps a reader understand an important boundary.

## Audience and job

The audience is a TypeScript developer evaluating a backend foundation for a
new Bun application. The page has one job: show that a Drizzle schema, custom
procedures, clients, and realtime form one typed graph without code generation
or a parallel transport layer.

## Visual system

The site uses an architectural-blueprint vocabulary without becoming a dark
CAD imitation. A cold paper background (`#f4f7fa`) carries ink text
(`#15202b`), structural blue-grey rules (`#cbd7e3`), cobalt typed connections
(`#2864dc`), teal live state (`#08a88a`), and sparing amber boundary markers
(`#d97724`). Large display type establishes the thesis; body text stays quiet;
monospace is reserved for code, inferred types, paths, and system labels.

The signature element is a type trace: a line connects a significant code
expression to a compact label containing its inferred type. The landing page
shows only four to six traces. It does not expose Twoslash popups for every
identifier. On narrow screens, traces become inline labels below the relevant
code line.

## Landing information architecture

1. Hero: one typed path from schema to procedure, client, and live state.
2. Procedure: a compact `api: (o)` example using Valibot and `o.protected`.
3. Client: the inferred result at the call site, without code generation.
4. Realtime: oRPC Publisher feeds the same cache and collections; heartbeat and
   reconnect stay internal.
5. Batteries: a structured capability map rather than an autoplay code
   carousel.
6. Examples and comparison: concrete proof and a restrained decision table.
7. Install: one command and direct links to the five-minute guide and GitHub.

Motion is concentrated in the hero's path trace and disabled with
`prefers-reduced-motion`. Keyboard focus remains visible. The layout collapses
to one column without horizontal code scrolling on phones.

## Documentation architecture

The primary path is Introduction, Getting Started, Schema & CRUD, API
Procedures, Query Client, and Sync & Realtime. `API Procedures` replaces the
tRPC page and explains public/protected/webhook procedures, Standard Schema,
optional output validation, typed errors, and ordinary HTTP routing. `HTTP &
Webhooks` replaces Hono custom routes and makes raw request wrapping the rare
escape hatch.

Realtime documentation describes one path: oRPC Publisher to a typed event
iterator to query caches and TanStack DB collections. Transport heartbeats,
resume, and exponential reconnect are library concerns. Mutation responses are
canonical rows, reconciled locally without an immediate list refetch.

Capability pages remain task-focused. The API reference is updated to the
current oRPC and Standard Schema surface. Historical plans and design notes are
not rewritten.

## Verification

Repository contract tests reject current public references to tRPC, Hono
extension APIs, custom SSE setup, and Zod-only validation. The website build
must regenerate typed snippets and complete without degraded `any` types. The
finished page is inspected at desktop and mobile widths, including focus,
reduced motion, type labels, navigation, and documentation routes.
