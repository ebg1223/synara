# omp provider audit findings (2026-07-07)

Multi-lens review of the uncommitted omp branch: adapter correctness (gpt-5.5),
provider-enumeration sweep (grok-composer), web UI integration (sonnet-5), plus
orchestrator spot-verification of the critical claims. Already fixed before this
audit: modelSelectionCompatibility provider sniffing, profileStats/skillPromptInjection
omp gaps, "[Circular]" shared-ref serialization, tool/subagent activity throttling.

Status legend: [ ] open, [x] fixed, [-] wontfix/deferred.

## Critical

- [x] **A1. Crashed omp session blocks recovery.** `OmpAdapter.ts` `handleUnexpectedExit`
  (~1548) sets `context.stopped = true` but never `sessions.delete(threadId)`.
  `hasSession()` (~2058) then reports the dead session active, ProviderService
  (~633) adopts it ("adopt-existing") instead of restarting from the persisted
  resumeCursor, and subsequent operations die on ProviderAdapterSessionClosedError.
  Fix: remove from `sessions` in the unexpected-exit path (or make hasSession
  filter stopped contexts). Verified against source.

- [x] **A2. stdin EPIPE can crash the whole server.** `ompRpcClient.ts` `send()`
  (~168) writes to `child.stdin` with no `error` listener on the stream and no
  `writable` guard. Process death mid-turn (or write-after-`stdin.end()`) emits
  an unhandled stream error → Node-level crash. Fix: `child.stdin.on("error", ...)`
  routed to `#warn`, plus writable check in `send()`.

## Major

- [x] **A3. Ready-timeout leaks the spawned process.** `ompRpcClient.start()`
  (~89-139) rejects on ready timeout without killing the child; repeated session
  starts accumulate orphan `omp` processes.

- [x] **A4. Crash leaves approvals/user-inputs unresolved.** `handleUnexpectedExit`
  fails the turn but never calls `clearStalePending()`; UI keeps a request open
  forever after a crash. (`OmpAdapter.ts` ~1173 vs ~1548.)

- [x] **A5. Approval bookkeeping deleted before send succeeds.** `respondToRequest`/
  `respondToUserInput` (~1950, ~1998) delete pending map entries before
  `client.send()`; a transient write failure makes the request id unknown so the
  user cannot retry. Fix: delete after successful send (or restore on failure).
  Verified against source.

- [x] **A6. Known-type frames dereferenced without validation.** `ompRpcClient`
  only checks `{type: string}` then casts to `OmpRpcFrame` (~204); adapter
  handlers dereference required fields (`frame.message.role`, `frame.options.map`,
  `frame.payload.progress`). Upstream protocol drift → throw inside the readline
  callback. Fix: guard the hot handlers defensively or wrap `onFrame` dispatch in
  try/catch that degrades to a protocol warning.

- [x] **A7. Skills catalog: no omp home origin.** `skillsCatalog.ts` has
  `omp: ["pi", "agents"]` origin preferences (~437) but `HOME_ORIGIN_ORDER`/
  `SKILL_ORIGIN_ROOTS` lack an omp origin, and `includeMarkdownFiles` (~493, ~520)
  is pi-only. omp skills under `~/.omp/agent` are invisible.

## Minor

- [x] **A8. Abort timeout misclassifies interrupts.** On abort RPC error/timeout
  `abortRequested` resets to false (~1931-1934), so a late `agent_end` records
  "completed" instead of "interrupted".

- [x] **A9. Provider-discovery cache not invalidated for pi/omp.**
  `__root.tsx` (~1355) invalidates model-list caches on status change for
  kilo/opencode/cursor only; after `omp /login` the "no models" list stays cached
  until TTL.

- [ ] **A10. Codex fallback for pi/omp composer selection.** (pre-existing pi
  behavior, inherited) `composerDraftStore.ts` `resolvePreferredComposerModelSelection`
  (~1640) silently falls back to codex/gpt-5.5 when no sticky/project selection
  exists. Follow-up ticket material.

## Polish / deferred

- [-] **A11. omp shares pi's icon** — indistinguishable in dense lists except by
  label. Possibly intentional (fork).
- [-] **A12. Settings "update provider" packaging map has no omp entry** — same
  as grok/cursor; fine until omp ships an npm/brew update path.

## Verified fine (coverage)

Web integration mirrors pi everywhere it should (settings roundtrip, model picker,
favorites, empty states, kanban discovery, handoff, thinking levels, tests).
No further 9-provider enumerations missing omp beyond the three fixed pre-audit.
RPC client handles partial lines/invalid JSON/unknown frame types; agent_end
cleanup and get_state serialization are correct.
