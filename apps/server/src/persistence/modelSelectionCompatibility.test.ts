import { assert, it } from "@effect/vitest";

import { normalizePersistedModelSelection } from "./modelSelectionCompatibility.ts";

it("preserves canonical Pi model selections", () => {
  assert.deepEqual(normalizePersistedModelSelection({ provider: "pi", model: "openai/gpt-5.5" }), {
    provider: "pi",
    model: "openai/gpt-5.5",
  });
});

it("preserves canonical Oh My Pi model selections", () => {
  // Regression: "openai-codex/gpt-5.5" must not be sniffed back to codex.
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "omp",
      model: "openai-codex/gpt-5.5",
      options: { thinkingLevel: "low" },
    }),
    {
      provider: "omp",
      model: "openai-codex/gpt-5.5",
      options: { thinkingLevel: "low" },
    },
  );
});

it("infers Oh My Pi from persisted instance labels without matching Pi", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "oh-my-pi-runtime",
      model: "openai/gpt-5.5",
    }),
    {
      provider: "omp",
      model: "openai/gpt-5.5",
    },
  );
});

it("infers Pi from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "local-pi-runtime-instance",
      model: "openai/gpt-5.5",
    }),
    {
      provider: "pi",
      model: "openai/gpt-5.5",
    },
  );
});
