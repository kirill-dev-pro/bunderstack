# Solid native simplification implementation plan

**Goal:** Implement the accepted review's interaction fixes and local simplifications.
**Architecture:** Keep LiveView acknowledgement and Solid optimistic actions. Guard temporary IDs at the action boundary and disable their UI controls. Extract form state into a small testable primitive; use an edit/submission revision to prevent stale recovery.
**Scope:** The shared async adapter and SSR integration remain a separate optional design. No dependency upgrades or public library API changes.

- [x] Reproduce temporary-ID mutations with the existing injected transport; verify no update/delete is sent and the optimistic row remains.
- [x] Extract existing form behavior into src/native/form.ts and reproduce failed-add recovery overwriting newer typing/submissions.
- [x] Guard pending IDs; preserve drafts using a revision captured at submission and incremented by each edit/submission.
- [x] Infer Todo from the API response and TodoStore from its factory; retain the test API seam.
- [x] Remove component mutation wrappers, use For fallback with valid list markup, and disable temporary-row controls.
- [x] Run the browser-condition Bun suite, example typecheck, production build, formatting and diff review. Update README with the behavior.

## Verification results

- Eleven browser-condition Bun tests pass, including the five assertions that failed before the fixes.
- Example TypeScript check, focused oxlint, formatting, and git diff whitespace checks pass.
- Solid client and SSR compilation pass. Final Nitro packaging fails with 16 missing optional Drizzle driver export errors; an untouched HEAD copy reproduces the same failure.
- No shared package source or public library API changed.
