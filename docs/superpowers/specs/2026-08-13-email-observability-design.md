# Email observability design

## Goal

Bunderstack 0.17.1 records every email passed to `app.email.send()` so managed
hosts can display the message even when no delivery provider is configured.
When Resend is active, the record also carries the provider message ID and the
latest delivery state.

## Public behavior

- `email: { from }` is capture-only in every environment unless a provider is
  explicitly configured in code or selected by the hosting platform through
  `BUNDERSTACK_EMAIL_PROVIDER`.
- Capture-only sends resolve successfully with an internal `id`, log the
  message to the console outside production, and never contact a provider.
- Resend sends return both the internal `id` and `providerId`.
- Provider API failures are persisted as `failed` before the error is rethrown.
- Existing custom adapters continue to work and are recorded as `custom`.
- A message still requires either HTML or text content.

## Storage

Two dialect-specific internal tables are provisioned with every app:

- `_bunderstack_emails`: message envelope, HTML/text content, provider,
  provider ID, current status, failure detail, and timestamps.
- `_bunderstack_email_events`: append-only provider event timeline with a
  unique external event ID for idempotency.

The email row uses Bunderstack's internal UUID as the correlation ID. Resend
requests include it as the `bunderstack_email_id` tag. On Bunderhost the
platform also supplies `bunderhost_environment_id`, which is sent as a second
tag and lets one project-level Resend account serve production and previews.

Status values are provider-neutral:

`captured`, `sending`, `sent`, `delivered`, `delayed`, `bounced`, `suppressed`,
`complained`, and `failed`.

Opened and clicked events remain timeline events and do not replace the
delivery status.

## Hosting contract

Bunderstack recognizes these reserved server variables without requiring the
application to declare them:

- `BUNDERSTACK_EMAIL_PROVIDER=resend`
- `BUNDERSTACK_EMAIL_FROM` (optional hosting override)
- `BUNDERHOST_ENVIRONMENT_ID` (optional Resend correlation tag)
- `RESEND_API_KEY`

The blueprint exposes `_system.emails` and `_system.emailEvents`, allowing a
managed host to read and update the journal without exposing CRUD routes to
the application.

## Privacy and retention

Email bodies are stored because the primary no-provider use case is inspecting
verification and reset links. They live in the application's own database and
inherit its access controls. Bunderstack does not impose retention in 0.17.1;
the host may add a retention policy later.

## Compatibility

The manifest and blueprint schema versions remain unchanged. The two new
system table declarations are additive. Applications that do not configure
email still get empty tables and no behavioral change.
