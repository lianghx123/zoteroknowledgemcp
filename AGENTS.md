# Repository Guidelines

## Project and Architecture

Zotero Knowledge MCP targets local literature knowledge and MCP access for AI clients. Use these documentation entry points:

- [README.md](README.md): user-facing project introduction, feature demonstrations and onboarding.
- [User handbook](docs/user/index.md): installation, configuration and user workflows; published in all seven supported languages.
- [Development guide](docs/development/getting-started.md): contributor setup, commands and documentation map.
- [Implementation overview](docs/development/implementation-overview.md): detailed runtime behavior and implementation boundaries.
- [Project delivery status](docs/development/project-status.md): delivered scope, remaining acceptance gates and dated verification evidence.

Keep setup instructions and detailed implementation notes in the development documents. Review the affected feature documents for contracts and evidence; the root README is a concise user overview.

- `src/`: TypeScript application code and Zotero declarations.
- `addon/`: JavaScript bootstrap, manifest and runtime assets.
- `test/`: Node tests, synthetic fixtures and native API mocks.
- `.agents/skills/`: task-specific development instructions.
- `.scaffold/`: generated builds, logs and isolated development data; Git-ignored.

Before knowledge-base implementation, read [migration-assessment.md](docs/development/migration-assessment.md). Prefer a pure plugin, local persistence, API parsing/embedding and scoped Streamable HTTP with SSE. Follow the parsing and connection requirements there; verify contracts and runtime capabilities before treating plans as implemented. Consider a helper process only after demonstrating a runtime limitation.

## Development Commands

Use the local Node.js 22.23.1 runtime for validation and Zotero 10 for native checks. Run from the repository root:

- `npm install --include=optional`: install dependencies.
- `npm run dev`: launch the isolated development instance with hot reload.
- `npm run build`: package the XPI under `.scaffold/build/`.
- `npm run typecheck`: check TypeScript types.
- `npm test`: build and run the full Node test suite.
- `npm run database:check`: verify migration snapshots, generated types and the field dictionary.

## Coding and Runtime

Use English for code, comments, documentation, configuration, file names and the source locale. Use two-space indentation, double quotes, semicolons and ES modules. Use camelCase functions/variables, PascalCase types and kebab-case module filenames. Keep identifiers independent of Zotero versions and consuming AI clients.

For features that add or change user-visible text, i18n is part of feature completion. Use Fluent resources and the shared formatter instead of hardcoded UI strings, and update the English source catalog and every supported locale in the same change. This includes menus, dialogs, status/error messages, tooltips and accessibility labels. Do not defer translations or use English fallback to fill missing messages. A feature is complete only after the localization checks in `npm test` pass and the affected localized UI is verified in isolated development Zotero. See [localization requirements and extension instructions](docs/development/localization.md).

Keep `addon/bootstrap.js` in JavaScript and application logic in strict TypeScript. Node.js is for build/tests only; avoid Node-only runtime dependencies. Extend Zotero declarations accurately, use native APIs for library access and keep plugin-owned persistence separate from Zotero's database schema. Release listeners, UI, connections and asynchronous work during cleanup.

## Verification

Use `node:test`, `node:assert/strict` and VM-based Zotero mocks in `test/*.test.mjs`. Cover changed behavior, failure cases, manifest consistency and cleanup.

Run type checks and the full test suite for code changes. Verify affected UI/reload behavior in isolated development Zotero. Distinguish simulations, developer-driven native checks and manual UI checks in reports.

Before retaining a performance optimization, measure the original and candidate implementations in the applicable runtime using representative isolated fixtures, warmups and repeated alternating samples. Report elapsed times, fixture sizes and variability. Query counts, complexity estimates and passing correctness tests alone do not prove a speedup. Defer or revert performance candidates without demonstrated gains or with material regressions; distinguish unused-code cleanup from runtime performance improvements.

### UI Automation Interference

On Windows, the Codex computer-use helper (`codex-computer-use.exe`) can activate Zotero/Gecko accessibility through Windows UI Automation. This interaction has caused severe PDF scrolling stalls, with roughly two-second main-thread pauses dominated by `UIAutomationCore`. Disabling platform accessibility resolved the stalls in the isolated test profile; the user also confirmed normal scrolling in another profile after exiting Codex. Treat this as a known test-tool interference risk, not evidence that all Zotero installations have the same bottleneck. Switching profiles alone does not isolate external accessibility clients.

- Start computer-use automation and its helper only when the task requires UI interaction that cannot reasonably be performed through a dedicated API or native debugger. Prefer Zotero's native debugging interface for runtime inspection, JavaScript execution and profiling.
- Immediately after UI automation finishes, including failed or interrupted work, close the automation session and shut down its task-owned helper. Verify that the helper process has exited; resetting a JavaScript session or closing a visible window alone is not sufficient. Identify the task-owned process before stopping it, and preserve unrelated sessions. If cleanup cannot be completed, report the remaining helper and required cleanup explicitly.
- Before recording a Zotero performance baseline, ensure the automation helper is stopped and inspect the native accessibility state and activation source. If the service remains active, restart isolated Zotero after helper cleanup and recheck without UI automation. Record accessibility settings and clients with the measurements; do not present contaminated samples as native baseline performance or silently disable accessibility to obtain better results.

## Commits and Documentation

Follow [code-commit](.agents/skills/code-commit/SKILL.md) for every commit or amendment, including documentation and skill changes. It defines message format, per-candidate checks, staging and verification evidence. Synchronize README and necessary documentation with the final changes before committing; a request to edit files does not itself authorize a commit.

Keep PRs focused, link relevant issues, report validation and include screenshots for UI changes.

## Data Safety

Keep `.env`, credentials, library data and generated output out of Git. Use isolated development libraries. Avoid concurrent production Zotero on Windows: Scaffold cleanup may terminate processes by name.

## Development Skills

Read applicable skills before implementation:

- [zotero-plugin-development](.agents/skills/zotero-plugin-development/SKILL.md): plugin lifecycle, windows, localization, packaging and hot reload.
- [structured-literature-development](.agents/skills/structured-literature-development/SKILL.md): content contracts, parsing, embeddings and retrieval.
- [knowledge-mcp-development](.agents/skills/knowledge-mcp-development/SKILL.md): MCP schemas, bounded reads, protocol integration and authorization.
- [code-commit](.agents/skills/code-commit/SKILL.md): commit preparation, documentation synchronization, validation, scoped staging and commit confirmation.

Keep skill paths and functional descriptions accurate when their purpose or applicability changes. Skills use English instructions, a YAML `name` matching the folder and an accurate `description`. Keep modification history in Git; do not maintain a skill changelog in this file.
