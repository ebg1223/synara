export const meta = {
  name: "omp-provider",
  description: "Design and build a first-class oh-my-pi (omp) provider for Synara",
  phases: [
    {
      title: "Spec",
      detail: "parallel deep-reads → synthesis → cross-family critique → final spec + plan doc",
    },
    { title: "Thread", detail: 'ProviderKind "omp" threading across contracts/shared/server/web' },
    { title: "Runtime", detail: "omp RPC client: spawn, NDJSON framing, id correlation, restart" },
    { title: "Adapter", detail: "OmpAdapter: sessions, turns, event mapping, registry wiring" },
    { title: "Approvals", detail: "extension_ui_request bridge, runtime modes, user input" },
    { title: "Discovery", detail: "runtime models, slash commands, composer traits" },
    { title: "Subagents", detail: "subagent frames → task.*, todos, background jobs" },
    { title: "Review", detail: "multi-lens review → adversarial verify → fix → final gate" },
  ],
};

// Run modes:
//   default ("spec")  — produce the reviewed implementation spec + docs/omp-provider-plan.md, then stop.
//   --args '{"mode":"full"}' [--resume <runId>] — continue into the build stages (spec agents cache-hit).
const SYNARA = (args && args.synara) || "/home/fedora/synara-omp";
const OMP = (args && args.omp) || "/home/fedora/oh-my-pi";
const MODE = (args && args.mode) || "spec";

// ---------------------------------------------------------------------------
// Model routing — pi provider, tiers per the agent/model selection guide.
// pi model refs embed their thinking level, so `effort` is never passed.
// pi requires danger-full-access (its allowlists are not OS confinement).
// ---------------------------------------------------------------------------
const FAST = "windsurf/swe-1.6:fast"; //            fast coding: recon, mechanical edits
const FAST_ALT = "cliproxyapi/grok-composer-2.5-fast"; // fast coding, second family
const REASON = "openai-codex/gpt-5.5:medium"; //    strong reasoning: planning, hard implementation
const PREMIUM = "openai-codex/gpt-5.5:xhigh"; //    premium judgement, gpt family
const FABLE = "cliproxyapi/claude-fable-5:high"; // premium judgement/taste, claude family (decorrelated)
const pi = (model) => ({ provider: "pi", model, sandbox: "danger-full-access" });
const otherFamily = (model) => (model === FABLE ? PREMIUM : FABLE);

const RULES = `
Hard rules (Synara repo at ${SYNARA}):
- NEVER modify anything under ${OMP}. It is reference-only source.
- NEVER run "bun test". The test suite is "bun run test" (Vitest). fmt/lint/tests run ONCE at the final gate; during a stage only "bun typecheck" is allowed as a completion check.
- Maintainability is a core priority: extract shared logic instead of duplicating; follow the existing adapter patterns rather than inventing new ones.
- Correctness and robustness beat convenience: predictable behavior under session restarts, reconnects, partial streams.
- Any UI open/close toggle must reuse apps/web/src/lib/disclosureMotion.ts helpers (DisclosureRegion, disclosureShellClassName, etc.).
- The adapter must emit canonical ProviderRuntimeEventV2 events only; the ingestion/decider/projector pipeline is provider-agnostic and must NOT gain omp-specific code.
`;

const DESIGN = `
Locked design decisions (do not relitigate; flag concerns instead):
- New ProviderKind literal "omp", display name "Oh My Pi", runtime raw-event source "omp.rpc.event".
- Integration surface: spawn one "omp --mode rpc" subprocess per session (NDJSON over stdio, protocol in ${OMP}/docs/rpc.md). Do NOT embed omp's SDK in-process (Bun-only, unstable internals). Do NOT use ACP mode (flattens omp-native events).
- Wire types: vendor/derive from ${OMP}/packages/coding-agent/src/modes/rpc/rpc-types.ts into one adapter-owned module; verify compatibility at startup via "omp --version"; unknown frame types degrade to config.warning, never crash.
- Models: no static model table — MODEL_OPTIONS_BY_PROVIDER.omp = [], excluded from DEFAULT_MODEL_BY_PROVIDER (mirror the "pi" exclusion pattern); runtime model list via get_available_models.
- Reasoning control: OmpModelOptions.thinkingLevel (off|minimal|low|medium|high|xhigh|auto) surfaced via reasoningDescriptorId "thinkingLevel" (same path as pi).
- resumeCursor = omp session id/file path (sessions are JSONL under ~/.omp/agent/sessions); resume via --resume/switch_session on respawn; native fork via branch / new_session{parentSession}.
- Approvals: Synara RuntimeMode "full-access" → omp --approval-mode yolo; "approval-required" → write/always-ask. Bridge extension_ui_request(confirm) → request.opened/respondToRequest; select/input/editor and the ask tool → user-input.requested/respondToUserInput.
- Subagents: enable set_subagent_subscription; map subagent_lifecycle/progress/event frames → task.started/progress/completed plus collab_agent_tool_call items carrying providerRefs parent keys; todo tool state → turn.tasks.updated; background bash/task jobs surface as background task activity.
- Capabilities: sessionModelSwitch "in-session" (set_model), supportsTurnSteering (steer/follow_up), supportsRuntimeModelList, supportsNativeSlashCommandDiscovery (get_available_commands + available_commands_update), supportsThreadCompaction (compact/handoff → context_compaction items).
`;

const KEY_FILES = `
Synara load-bearing files:
- packages/contracts/src/orchestration.ts (ProviderKind ~:51, ModelSelection ~:77-143, ProviderStartOptions ~:145-197)
- packages/contracts/src/providerDiscovery.ts (~:10 kinds, ~:50 ProviderComposerCapabilities)
- packages/contracts/src/model.ts (per-provider options/effort enums, MODEL_OPTIONS_BY_PROVIDER ~:321, DEFAULT_MODEL_BY_PROVIDER ~:598, PROVIDER_DISPLAY_NAMES ~:716)
- packages/contracts/src/providerRuntime.ts (RuntimeEventRawSource ~:20, canonical event union ~:969)
- packages/shared/src/model.ts (normalizers, reasoningDescriptorId ~:421, pi-style no-default-model guards) + model.test.ts
- apps/server/src/provider/Services/ProviderAdapter.ts (ProviderAdapterShape ~:74-250), Services/PiAdapter.ts (service-tag template)
- apps/server/src/provider/Layers/PiAdapter.ts (closest adapter template; also CodexAdapter.ts for subprocess supervision, OpenCodeAdapter.ts for configurable binary path)
- apps/server/src/provider/Layers/ProviderAdapterRegistry.ts (~:14-46), apps/server/src/provider/runtimeLayer.ts (~:52-102)
- apps/server/src/persistence/modelSelectionCompatibility.ts (~:59-96 inferLegacyModelProvider)
- apps/web/src/providerOrdering.ts, apps/web/src/components/ProviderIcon.tsx (~:65), apps/web/src/components/chat/composerProviderRegistry.tsx (~:247; pi case ~:213), apps/web/src/providerModelOptions.ts (~:125), apps/web/src/session-logic.ts (PROVIDER_OPTIONS ~:45)
oh-my-pi reference files (read-only):
- docs/rpc.md (canonical protocol), docs/session.md, docs/approval-mode.md, docs/sdk.md, docs/compaction.md
- packages/coding-agent/src/modes/rpc/{rpc-types.ts,rpc-mode.ts,rpc-client.ts,rpc-subagents.ts,host-tools.ts}
- packages/agent/src/types.ts (AgentEvent ~:705), packages/ai/src/types.ts (AssistantMessageEvent ~:876)
- packages/coding-agent/src/session/agent-session.ts (AgentSessionEvent ~:483)
`;

const RETURN_NOTE =
  "Your final message is consumed by an orchestrator as raw data, not shown to a human. Return exactly what was asked, no preamble.";

const LEAN =
  "HARD CONTEXT BUDGET: your session has a finite context window and there is no compaction — a previous run of this step died by over-reading. Read only small targeted excerpts (grep -n first, then read <=120-line slices); NEVER read a whole large file or dump directory trees. Verify at most the handful of claims that are load-bearing for your output; anything you cannot verify cheaply, record as an explicit assumption/risk instead of digging further.";

const SPEC_SCHEMA = {
  type: "object",
  required: ["overview", "stages", "risks"],
  properties: {
    overview: { type: "string", description: "One-paragraph architecture summary" },
    stages: {
      type: "object",
      required: ["thread", "runtime", "adapter", "approvals", "discovery", "subagents"],
      properties: {
        thread: { type: "string", description: "Exact files + edits for ProviderKind threading" },
        runtime: { type: "string", description: "RPC client/process-supervisor module design" },
        adapter: {
          type: "string",
          description: "OmpAdapter design incl. full event mapping table",
        },
        approvals: { type: "string", description: "Approval/user-input bridge design" },
        discovery: { type: "string", description: "Models/commands/composer-capability design" },
        subagents: { type: "string", description: "Subagent/task/todo projection design" },
      },
    },
    risks: { type: "array", items: { type: "string" } },
  },
};

const CRITIQUE_SCHEMA = {
  type: "object",
  required: ["gaps", "verdict"],
  properties: {
    gaps: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "severity", "detail"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["blocking", "major", "minor"] },
          detail: { type: "string" },
        },
      },
    },
    verdict: { type: "string" },
  },
};

const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "file", "severity", "detail"],
        properties: {
          title: { type: "string" },
          file: { type: "string" },
          severity: { type: "string", enum: ["blocking", "major", "minor"] },
          detail: { type: "string" },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "reasoning"],
  properties: { refuted: { type: "boolean" }, reasoning: { type: "string" } },
};

const GATE_SCHEMA = {
  type: "object",
  required: ["pass", "summary"],
  properties: { pass: { type: "boolean" }, summary: { type: "string" } },
};

// ---------------------------------------------------------------------------
// Phase 1: Spec — recon on fast/mid tiers, synthesis and critique on premium.
// ---------------------------------------------------------------------------
phase("Spec");

const [threadMap, protocolBrief, adapterMap] = await parallel([
  () =>
    agent(
      `You are mapping registry-threading work in the Synara repo at ${SYNARA}.\n` +
        `Task: produce the EXACT, exhaustive edit list to add a new ProviderKind "omp" across contracts, shared, server persistence, and web registries — every Record<ProviderKind> map, exhaustive switch, enum literal, and pi-style exclusion (pi has no static default model; omp mirrors that). For each site give file path, approximate line, and the concrete edit. Include the OmpModelSelection/OmpProviderStartOptions/OmpModelOptions shapes (thinkingLevel off|minimal|low|medium|high|xhigh|auto) and which tests need updating.\n${KEY_FILES}\n${RETURN_NOTE} Return a markdown edit list.`,
      { ...pi(FAST), label: "read:threading", cwd: SYNARA, key: "read:threading" },
    ),
  () =>
    agent(
      `You are writing a protocol brief for driving oh-my-pi (repo at ${OMP}, reference-only) headlessly via "omp --mode rpc".\n` +
        `Read docs/rpc.md, docs/session.md, docs/approval-mode.md, and packages/coding-agent/src/modes/rpc/{rpc-types.ts,rpc-mode.ts,rpc-client.ts,rpc-subagents.ts}. Produce: (1) the full inbound command set and outbound frame set with exact field shapes we depend on; (2) the AgentSessionEvent/AssistantMessageEvent union members and their payloads; (3) session lifecycle: new/resume/switch_session/branch/handoff, session-file locations, resume-id matching; (4) approval + extension_ui_request/response flow incl. the ask tool; (5) subagent frames, set_subagent_subscription levels, get_subagent_messages; (6) todo/set_todos and job/bash background behavior; (7) gotchas: response ordering not guaranteed (correlate by id), abort_and_prompt caveat, setTitle suppression, version pinning.\n${RETURN_NOTE} Return a markdown protocol brief.`,
      { ...pi(REASON), label: "read:omp-protocol", cwd: OMP, key: "read:omp-protocol" },
    ),
  () =>
    agent(
      `You are mapping the server-side adapter architecture in the Synara repo at ${SYNARA}.\n` +
        `Read apps/server/src/provider/Services/ProviderAdapter.ts (ProviderAdapterShape), Layers/PiAdapter.ts (in-process pi template incl. resumeCursor/session-file handling and pi event mapping), Layers/CodexAdapter.ts + apps/server/src/codexAppServerManager.ts (subprocess JSON-RPC supervision: spawn, handshake, restart, stderr handling), Layers/OpenCodeAdapter.ts (configurable binary path pattern), Layers/ProviderAdapterRegistry.ts, runtimeLayer.ts, Layers/ProviderHealth.ts (health probes), and packages/contracts/src/providerRuntime.ts (canonical events, itemTypes, request types, providerRefs). Produce: (1) the required vs optional adapter methods with signatures; (2) which existing patterns to reuse for an "omp --mode rpc" subprocess adapter (process supervision, event Stream, error classification, health probe registration); (3) the canonical event payload shapes an adapter must emit for turn lifecycle, content deltas, tool items, diffs, token usage, approvals, task.*, and collab_agent_tool_call.\n${RETURN_NOTE} Return a markdown architecture brief.`,
      { ...pi(REASON), label: "read:adapter-arch", cwd: SYNARA, key: "read:adapter-arch" },
    ),
]);

if (!threadMap || !protocolBrief || !adapterMap) {
  throw new Error("A spec reader failed or was skipped; cannot synthesize a trustworthy spec.");
}

log("Deep-reads complete; synthesizing implementation spec");

const draftSpec = await agent(
  `Synthesize a complete implementation spec for a first-class "omp" (oh-my-pi) provider in Synara.\n${DESIGN}\n${RULES}\n` +
    `Inputs from three scouts follow.\n\n=== THREADING EDIT LIST ===\n${threadMap}\n\n=== OMP RPC PROTOCOL BRIEF ===\n${protocolBrief}\n\n=== SYNARA ADAPTER ARCHITECTURE ===\n${adapterMap}\n\n` +
    `Produce per-stage specs (thread, runtime, adapter, approvals, discovery, subagents), each concrete enough that an implementer needs no further design decisions: exact files, module boundaries, function responsibilities, and for the adapter stage a COMPLETE omp-event → canonical-event mapping table. The scouts ran on cheaper models: spot-check only the claims that look off AND are load-bearing, and resolve conflicts by consulting the locked design decisions. ${LEAN} List residual risks.\n${RETURN_NOTE}`,
  {
    ...pi(PREMIUM),
    label: "spec:synthesize",
    cwd: SYNARA,
    schema: SPEC_SCHEMA,
    key: "spec:synthesize",
  },
);

const critique = await agent(
  `Adversarially critique this implementation spec for adding an oh-my-pi provider to Synara. Hunt for: missed Record<ProviderKind>/switch sites, misread omp RPC semantics (verify claims against ${OMP}/docs/rpc.md and rpc-types.ts yourself), lifecycle races (interrupt vs turn end, respawn vs resume, orphaned approval requests), event-mapping errors against ${SYNARA}/packages/contracts/src/providerRuntime.ts, and violations of the locked design decisions. Default to reporting a gap when uncertain. ${LEAN}\n${DESIGN}\n\nSPEC:\n${JSON.stringify(draftSpec, null, 2)}\n${RETURN_NOTE}`,
  {
    ...pi(FABLE),
    label: "spec:critique",
    cwd: SYNARA,
    schema: CRITIQUE_SCHEMA,
    key: "spec:critique",
  },
);

log(
  `Critique found ${critique.gaps.length} gaps (${critique.gaps.filter((g) => g.severity !== "minor").length} non-minor)`,
);

const spec = await agent(
  `Revise this implementation spec by resolving every critique gap (verify each against the actual code in ${SYNARA} and ${OMP} rather than taking the critique on faith — reject a gap only with evidence). ${LEAN} Then write the final spec as a well-structured design doc to ${SYNARA}/docs/omp-provider-plan.md (create docs/ if needed). Also return the revised spec object.\n${DESIGN}\n${RULES}\n\nSPEC:\n${JSON.stringify(draftSpec, null, 2)}\n\nCRITIQUE:\n${JSON.stringify(critique, null, 2)}\n${RETURN_NOTE}`,
  { ...pi(PREMIUM), label: "spec:revise", cwd: SYNARA, schema: SPEC_SCHEMA, key: "spec:revise" },
);

if (MODE === "spec") {
  log(
    'Spec mode: stopping after plan. Re-run with --args \'{"mode":"full"}\' --resume <runId> to build.',
  );
  return { mode: "spec", spec, critiqueGaps: critique.gaps, planDoc: "docs/omp-provider-plan.md" };
}

// ---------------------------------------------------------------------------
// Phases 2-7: staged build. Sequential (each stage builds on the last),
// each stage: implement → cross-family preliminary review → bounded fix loop.
// Model per stage matches its hardest part; every cheap implementation gets a
// stronger preliminary reviewer before the final review phase.
// ---------------------------------------------------------------------------
const STAGES = [
  {
    key: "thread",
    phase: "Thread",
    model: FAST,
    goal: 'Thread ProviderKind "omp" through every contracts/shared/server-persistence/web registry site, add Omp* schema shapes, a pi-style thinkingLevel trait, a provider icon, and a compiling stub OmpAdapter registered in the adapter registry + runtimeLayer. Driven by adding the literal first and letting "bun typecheck" enumerate the remaining sites.',
  },
  {
    key: "runtime",
    phase: "Runtime",
    model: PREMIUM,
    goal: 'Build the omp RPC runtime module: spawn "omp --mode rpc" per session (configurable binary path), NDJSON framing, ready handshake, id-correlated request/response (ordering NOT guaranteed), typed vendored wire types, event de-multiplexing, process exit/restart classification with backoff, version probe. Pure framing/correlation logic must be unit-testable without a real omp binary.',
  },
  {
    key: "adapter",
    phase: "Adapter",
    model: PREMIUM,
    goal: "Implement OmpAdapter end-to-end on the runtime module: startSession/resume (resumeCursor = session id/file), sendTurn with images, interruptTurn, stopSession/stopAll/listSessions/hasSession/readThread/rollbackThread, and the full native→canonical event mapping (assistant/thinking deltas, tool items incl. command_output/file_change diffs, compaction items, token usage, turn lifecycle incl. cost, runtime errors, session.exited recovery).",
  },
  {
    key: "approvals",
    phase: "Approvals",
    model: REASON,
    goal: "Bridge extension_ui_request(confirm) → request.opened + respondToRequest (accept/acceptForSession/decline/cancel semantics), select/input/editor + ask tool → user-input.requested + respondToUserInput, map Synara RuntimeMode to omp --approval-mode, and handle orphaned pending requests on interrupt/exit.",
  },
  {
    key: "discovery",
    phase: "Discovery",
    model: REASON,
    goal: "Implement listModels (get_available_models incl. context-window metadata), listCommands (get_available_commands + available_commands_update), getComposerCapabilities, in-session model switch (set_model) and thinking-level changes, and the web composer trait wiring (mirror the pi case) so the model picker and thinkingLevel selector work.",
  },
  {
    key: "subagents",
    phase: "Subagents",
    model: REASON,
    goal: 'Enable subagent subscription; map subagent_lifecycle/progress/event → task.started/progress/completed and task tool calls → collab_agent_tool_call items with providerRefs parent keys; todo tool → turn.tasks.updated; background bash/task jobs → background task activity; use get_subagent_messages for incremental detail tailing at the "events" level.',
  },
];

const stageReports = [];
for (const stage of STAGES) {
  phase(stage.phase);
  const specSlice = spec.stages[stage.key];
  let report = await agent(
    `Implement this stage of the omp provider in ${SYNARA}.\nSTAGE GOAL: ${stage.goal}\n\nSTAGE SPEC:\n${specSlice}\n${DESIGN}\n${RULES}\n${KEY_FILES}\n` +
      `Prior stage summaries (context, do not redo): ${JSON.stringify(stageReports.map((r) => r.slice(0, 600)))}\n` +
      `Finish only when "bun typecheck" passes in ${SYNARA}. Do not run fmt/lint/tests. ${RETURN_NOTE} Return a markdown summary: files touched, decisions taken, anything deferred.`,
    { ...pi(stage.model), label: `impl:${stage.key}`, cwd: SYNARA, key: `impl:${stage.key}` },
  );
  if (!report) throw new Error(`Stage ${stage.key} implementation was skipped/failed`);

  for (let round = 1; round <= 2; round++) {
    const review = await agent(
      `Review the CURRENT uncommitted/recent changes in ${SYNARA} for the "${stage.key}" stage of the omp provider (git diff/status will show them). Implementer's report:\n${report}\n\nSTAGE SPEC:\n${specSlice}\n${RULES}\n` +
        `Check: spec conformance, correctness (esp. stream/lifecycle races, id correlation, resume/restart paths), canonical-event payload fidelity vs packages/contracts/src/providerRuntime.ts, duplicated logic that belongs in a shared module, and cross-checks against omp semantics in ${OMP}/docs/rpc.md. Only report findings an implementer must act on; severity "minor" for style-level notes. Do NOT edit any files.\n${RETURN_NOTE}`,
      {
        ...pi(FABLE),
        label: `review:${stage.key}:${round}`,
        cwd: SYNARA,
        schema: FINDINGS_SCHEMA,
        key: `review:${stage.key}:${round}`,
      },
    );
    const blocking = (review && review.findings ? review.findings : []).filter(
      (f) => f.severity !== "minor",
    );
    if (!blocking.length) {
      log(`stage ${stage.key}: review clean (round ${round})`);
      break;
    }
    log(`stage ${stage.key}: ${blocking.length} findings to fix (round ${round})`);
    report =
      (await agent(
        `Fix these review findings in ${SYNARA} for the omp provider "${stage.key}" stage. Verify each finding against the code first; if one is wrong, say so with evidence instead of "fixing" it.\nFINDINGS:\n${JSON.stringify(blocking, null, 2)}\n\nSTAGE SPEC:\n${specSlice}\n${RULES}\nFinish with "bun typecheck" passing. ${RETURN_NOTE} Return an updated stage summary noting each finding's resolution.`,
        {
          ...pi(stage.model === FAST ? REASON : stage.model),
          label: `fix:${stage.key}:${round}`,
          cwd: SYNARA,
          key: `fix:${stage.key}:${round}`,
        },
      )) || report;
  }
  stageReports.push(report);
}

// ---------------------------------------------------------------------------
// Phase 8: final review — diverse lenses split across model families,
// adversarial verify on the opposite family, fix confirmed, single gate.
// ---------------------------------------------------------------------------
phase("Review");

const LENSES = [
  {
    key: "correctness",
    model: PREMIUM,
    prompt:
      "correctness: event mapping fidelity, turn/session lifecycle, resume cursors, id correlation, approval round-trips",
  },
  {
    key: "robustness",
    model: FABLE,
    prompt:
      "failure modes: process crash/respawn, interrupt races, partial NDJSON frames, orphaned requests, backpressure, reconnect behavior under load",
  },
  {
    key: "maintainability",
    model: FABLE,
    prompt:
      "maintainability: duplicated logic vs shared modules, adapter pattern consistency with PiAdapter/CodexAdapter/OpenCodeAdapter, contracts staying schema-only, web capability-gating conventions",
  },
  {
    key: "protocol",
    model: REASON,
    prompt: `protocol fidelity: every RPC command/frame usage cross-checked against ${OMP}/docs/rpc.md and rpc-types.ts (reference-only repo)`,
  },
];

// Barrier justified: findings must be deduped across all lenses before paying for verification.
const lensResults = await parallel(
  LENSES.map(
    (l) => () =>
      agent(
        `Final review of the complete omp provider implementation in ${SYNARA} (all uncommitted/branch changes). Lens — ${l.prompt}.\n${RULES}\nStage summaries:\n${stageReports.map((r, i) => `[${STAGES[i].key}] ${r.slice(0, 800)}`).join("\n")}\nDo NOT edit any files.\n${RETURN_NOTE}`,
        {
          ...pi(l.model),
          label: `lens:${l.key}`,
          cwd: SYNARA,
          schema: FINDINGS_SCHEMA,
          key: `lens:${l.key}`,
        },
      ).then((r) => ({ lens: l, findings: (r && r.findings) || [] })),
  ),
);

const seen = new Set();
const deduped = [];
for (const lr of lensResults.filter(Boolean)) {
  for (const f of lr.findings) {
    if (f.severity === "minor") continue;
    const k = `${f.file}::${f.title}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push({ ...f, lens: lr.lens.key, lensModel: lr.lens.model });
  }
}
log(`${deduped.length} unique non-minor findings to verify`);

// Adversarial verify each finding on the OTHER model family (decorrelated refutation).
const verified = await parallel(
  deduped.map(
    (f, i) => () =>
      agent(
        `Try to REFUTE this code-review finding against the actual code in ${SYNARA} (and ${OMP} docs where relevant). Default to refuted=true if you cannot concretely demonstrate the failure. Do NOT edit any files.\nFINDING:\n${JSON.stringify(f, null, 2)}\n${RETURN_NOTE}`,
        {
          ...pi(otherFamily(f.lensModel)),
          label: `verify:${i}:${f.title.slice(0, 40)}`,
          cwd: SYNARA,
          schema: VERDICT_SCHEMA,
          key: `verify:${i}`,
        },
      ).then((v) => ({
        ...f,
        refuted: v ? v.refuted : false,
        reasoning: v ? v.reasoning : "verifier skipped",
      })),
  ),
);

const confirmed = verified.filter(Boolean).filter((f) => !f.refuted);
log(`${confirmed.length} findings confirmed`);

let fixReport = "no confirmed findings";
if (confirmed.length) {
  fixReport =
    (await agent(
      `Fix these CONFIRMED review findings in the omp provider implementation in ${SYNARA}.\n${JSON.stringify(confirmed, null, 2)}\n${RULES}\nFinish with "bun typecheck" passing. ${RETURN_NOTE} Return a summary of each fix.`,
      { ...pi(PREMIUM), label: "fix:final", cwd: SYNARA, key: "fix:final" },
    )) || fixReport;
}

const gate = await agent(
  `Run the single heavyweight verification pass for the omp provider work in ${SYNARA}: "bun fmt", "bun lint", "bun typecheck", then "bun run test" (NEVER "bun test"). Fix trivial fallout (formatting, unused imports, straightforward test updates) yourself; anything non-trivial goes in the summary as a failure. ${RETURN_NOTE}`,
  { ...pi(FAST_ALT), label: "gate:final", cwd: SYNARA, schema: GATE_SCHEMA, key: "gate:final" },
);

return {
  mode: "full",
  planDoc: "docs/omp-provider-plan.md",
  stages: STAGES.map((s, i) => ({ key: s.key, summary: stageReports[i] })),
  confirmedFindings: confirmed,
  fixReport,
  gate,
};
