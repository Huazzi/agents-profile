---
name: code-simplifier
description: Use this skill when the user asks to simplify, refine, clean up, or make code more maintainable while preserving behavior. It adapts Anthropic's code-simplifier agent for Codex.
---

# Code Simplifier

Use this skill when the user asks to simplify code, refactor for clarity, reduce complexity, or polish recently modified code without changing behavior.

This is a Codex adaptation of Anthropic's `code-simplifier` Claude plugin. The original plugin files are preserved under `references/source/`.

## Goals

- Preserve exact functionality.
- Improve readability, consistency, and maintainability.
- Prefer explicit, understandable code over compact cleverness.
- Keep edits focused on recently modified or requested code unless the user asks for broader cleanup.

## Process

1. Identify the target scope:
   - Recently modified files, files named by the user, or a requested module.
2. Read local project guidance such as `AGENTS.md`, `CLAUDE.md`, README conventions, lint config, and nearby patterns.
3. Look for simplification opportunities:
   - Reduce unnecessary nesting.
   - Remove redundant abstractions or duplicated logic.
   - Improve names when they obscure intent.
   - Consolidate related logic when it improves clarity.
   - Remove comments that merely restate obvious code.
   - Avoid nested ternaries for multi-branch logic.
4. Avoid over-simplification:
   - Do not merge unrelated concerns.
   - Do not remove abstractions that clarify boundaries.
   - Do not optimize for fewer lines at the cost of readability.
   - Do not make wide refactors outside the requested scope.
5. Verify behavior:
   - Run focused tests, type checks, or lint when available and appropriate.
   - If tests are not run, explain why.

## Output

Summarize what was simplified and how behavior was preserved. Mention verification performed and any residual risk.

