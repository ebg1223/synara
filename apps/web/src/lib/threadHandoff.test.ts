import { type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffTitle,
  resolveThreadHandoffModelSelection,
} from "./threadHandoff";

describe("threadHandoff", () => {
  it("lists all supported handoff targets except the active provider", () => {
    expect(resolveAvailableHandoffTargetProviders("codex")).toEqual([
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
      "omp",
    ]);
    expect(resolveAvailableHandoffTargetProviders("claudeAgent")).toEqual([
      "codex",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
      "omp",
    ]);
    expect(resolveAvailableHandoffTargetProviders("cursor")).toEqual([
      "codex",
      "claudeAgent",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
      "omp",
    ]);
    expect(resolveAvailableHandoffTargetProviders("gemini")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "kilo",
      "opencode",
      "pi",
      "omp",
    ]);
    expect(resolveAvailableHandoffTargetProviders("grok")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "kilo",
      "opencode",
      "pi",
      "omp",
    ]);
    expect(resolveAvailableHandoffTargetProviders("kilo")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "opencode",
      "pi",
      "omp",
    ]);
    expect(resolveAvailableHandoffTargetProviders("opencode")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "pi",
      "omp",
    ]);
    expect(resolveAvailableHandoffTargetProviders("pi")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "omp",
    ]);
    expect(resolveAvailableHandoffTargetProviders("omp")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
    ]);
  });

  it("preserves the source thread title for the created handoff thread", () => {
    expect(resolveThreadHandoffTitle({ title: "General Greeting" })).toBe("General Greeting");
    expect(resolveThreadHandoffTitle({ title: "  Debug   Grok handoff  " })).toBe(
      "Debug Grok handoff",
    );
  });

  it("prefers sticky model selection for the chosen handoff target", () => {
    const stickySelection = {
      provider: "gemini",
      model: "gemini-2.5-pro",
    } satisfies ModelSelection;

    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        },
        targetProvider: "gemini",
        projectDefaultModelSelection: {
          provider: "gemini",
          model: "gemini-3.1-pro-preview",
        },
        stickyModelSelectionByProvider: {
          gemini: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
  });

  it("falls back to the resolved provider default model when no sticky or project default exists", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "gemini",
            model: "gemini-2.5-pro",
          },
        },
        targetProvider: "codex",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });
});
