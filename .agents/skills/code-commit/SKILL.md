---
name: code-commit
description: Prepare, validate, create, or amend commits in this repository. Requires current README and affected documentation, a classified Conventional Commit title, a detailed body, per-commit automated checks, applicable runtime verification, and truthful test evidence. Use for every commit, including documentation, configuration, dependency, skill, and revert changes.
---

# Code Commit

## Applicability and Authorization

Apply this workflow whenever preparing, creating, splitting, or amending a repository commit. It also applies to documentation, configuration, dependency, skill and revert commits. Read `AGENTS.md` and any applicable domain skills first.

Creating or updating this skill does not authorize a commit. Commit only when the user has requested or otherwise authorized committing. Once authorized, complete the preparation and checks without adding a separate routine approval step. A local commit does not authorize pushing, publishing, merging, or rewriting existing history.

## Prepare a Concrete Commit

1. Inspect `git status --short`, the working diff, staged diff and relevant untracked files. Preserve unrelated work; never stage everything indiscriminately, reset another change, or discard files to make tests pass.
2. Define one coherent purpose, affected modules, user-visible behavior, relevant failure cases and acceptance criteria. Split independent changes into separate commits. Each commit must build and pass on its own; do not rely on a later commit to repair it.
3. Before implementation, where possible, draft the title, the Why/Changes outline and the validation plan below. For existing work, prepare them before staging. Replace planned claims with observed results before committing.
4. Review `README.md` and all affected documentation against the final candidate, and update them before staging and final validation as described below. Update declarations, configuration, manifests and lockfiles as applicable. Keep the skill index accurate as described below.
5. Review the complete candidate for accidental credentials, document bodies, library data, `.env`, generated builds and unrelated changes. Include new source/test files explicitly.

## Synchronize Documentation Before Committing

Before every commit or amendment, use its actual changes to review `README.md` and the relevant usage, architecture, configuration, schema, migration, development and verification documents. Update affected descriptions in the same candidate before staging and running final checks. Documentation must describe the behavior and development status that this commit leaves behind.

Keep the root `README.md` focused on user introduction and onboarding. Contributor setup belongs in `docs/development/getting-started.md`, detailed behavior in `docs/development/implementation-overview.md`, and acceptance status in `docs/development/project-status.md`. When moving or renaming documentation, search repository-wide references, including `AGENTS.md`, development skills, source-directory READMEs and documentation-generating scripts. Update links and descriptions of the destination's purpose together; an existing file alone does not make a reference accurate. See the [documentation maintenance rules](../../../docs/development/documentation.md#documentation-entry-points-and-maintenance).

- For features and fixes, document user-visible behavior, limits, failure/recovery behavior and any changed setup or commands where relevant.
- For schema, contract or configuration changes, synchronize migration/upgrade guidance, references and generated dictionaries as applicable. Preserve historical evidence and distinguish new verification from earlier results.
- Remove obsolete claims, broken paths and stale implemented-versus-planned descriptions. Do not claim that tables, scaffolding, mocks or planned work implement a usable capability.
- For skill additions, renames, removals or changes in purpose/applicability, update the relevant path and functional description in `AGENTS.md`. Routine edits that leave this index accurate do not require an `AGENTS.md` edit. Keep modification history in Git; do not add dated update entries or a skill changelog to `AGENTS.md`.
- If a reviewed document remains accurate, leave it unchanged and record that review in the commit preparation or validation evidence. Do not create cosmetic README edits merely to satisfy this check.

Treat documentation synchronization as a commit prerequisite. A passing build/test suite does not compensate for stale affected documentation. If the candidate changes after documentation review, review the affected descriptions again before committing.

## Required Commit Message

Write project-maintained commit messages in English. Every commit must have the following subject and a substantive body; a one-line message alone is insufficient.

```text
type(scope): imperative summary
```

- Require both a lowercase type and a nonempty lowercase kebab-case scope.
- Use one of the types below; choose the primary intent rather than listing multiple types.
- Use a specific imperative title, such as `add`, `fix`, `preserve` or `document`. Keep the entire subject within 72 characters, with no trailing period. Do not use vague titles such as `update code`, `fix bugs` or `misc changes`.
- Use a stable affected area for the scope: for example `reader`, `ui`, `mcp`, `database`, `parsing`, `retrieval`, `lifecycle`, `build`, `skills` or `repo` for a cohesive cross-cutting change.
- For an actual incompatible change, use `type(scope)!: summary` and include a `BREAKING CHANGE:` footer with migration/action instructions. Do not mark ordinary internal refactors as breaking changes.

| Type | Purpose |
| --- | --- |
| `feat` | Add a user-facing capability |
| `fix` | Correct incorrect behavior |
| `refactor` | Restructure code while preserving behavior |
| `perf` | Improve performance with supporting measurement |
| `test` | Add or correct tests and test infrastructure |
| `docs` | Change documentation or instruction skills |
| `build` | Change packaging, build tooling or dependencies |
| `ci` | Change continuous integration workflows |
| `chore` | Repository maintenance outside the categories above |
| `revert` | Revert a specific earlier commit; identify its hash and reason |

Use this body template, filling every section with concrete information. Omit optional footers when they do not apply. Do not invent an issue ID, measurement or successful check.

```text
type(scope): imperative summary

Why:
- Describe the concrete problem or requirement and its impact.

Changes:
- Describe the final behavior and affected modules, not just a file list.
- Explain relevant design choices, failure handling and cleanup.
- Include contract/schema/configuration/dependency changes when applicable.

Validation:
- Environment: Node version, OS, and Zotero version/profile when used.
- npm run typecheck — PASS; summarize the result.
- npm test — PASS; report test counts and the included build result.
- git diff --cached --check — PASS.
- Focused checks: command or scenario, expected behavior, observed result.
- Runtime/manual checks: setup, action, expected behavior, observed result.
- Not applicable / not run: state the check, reason and remaining limitation.

Risks and compatibility:
- Describe user-visible limitations, compatibility/data impact and recovery.
- State "No known compatibility or data-format changes" only if reviewed.

Refs: <real issue or requirement reference, if available>
BREAKING CHANGE: <impact and required migration, only when applicable>
```

Adjust the number of bullets to the change, but retain all four body sections. Explain what changed and why, not the conversation history or abandoned work. A validation line must identify a check and its outcome; `tested`, `works` or `all good` is insufficient.

## Verify Every Individual Commit

Run the following baseline for every candidate, including documentation and skill-only commits:

```text
npm run typecheck
npm test
git diff --cached --check
```

`npm test` already includes the production build; do not run a duplicate build unless a new change or failure requires it. Do not add meaningless tests for prose changes or tests that merely mirror the implementation. Add focused behavior/regression tests for substantive code changes and failure modes.

Run checks against the actual candidate contents. If unstaged changes make the tested working tree different from the staged snapshot, validate the candidate in an isolated checkout/export, or include the required changes in the same coherent commit. Do not claim that a mixed working-tree run proves an untested staged snapshot. Do not disturb unrelated user changes to create a clean tree.

In addition to the baseline, select and document the applicable checks:

| Changed area | Required targeted verification |
| --- | --- |
| Plugin lifecycle, reader UI, windows, reload | Focused lifecycle/cleanup tests and real isolated Zotero checks for affected behavior; include existing/new readers/windows, repeated reload and resource cleanup where relevant. Record UI evidence without committing private library content. |
| Markdown/content/parsing/retrieval | Relevant input/output, attachment identity, ordering, bounds, malformed/untrusted input, provider failure and stale-result checks. Distinguish synthetic fixtures from actual parse output. |
| Database schema/migrations | Dictionary consistency check when fixtures change; new/upgrade/failure/rollback/data-integrity checks appropriate to the change. Verify native transactions/driver/migrations in Zotero when changing runtime storage; SQLite design tests alone do not prove native behavior. |
| MCP, authorization, transport | Protocol initialization/discovery/calls, schemas, bounded reads, access rejection and lifecycle/error checks relevant to the change. Confirm interoperability with the intended real client for changes affecting it. |
| Build, manifest, dependencies | Packaging/identity consistency and Gecko runtime compatibility for affected dependencies. Installation or browser bundling alone does not establish Zotero compatibility. |
| Documentation and skills | Verify frontmatter, folder/name agreement, referenced files/commands, implemented-versus-planned claims and the accuracy of the `AGENTS.md` skill paths/descriptions. Explain why runtime/manual checks are not applicable when no runtime behavior changes. |

For schema fixture/dictionary changes, if the generator is present in the candidate, run:

```text
node scripts/generate-database-dictionary.mjs --check
```

When the candidate does not contain that generator, add/run the relevant schema integrity checks with the database implementation instead. Do not claim a missing command passed or stage unrelated design artifacts merely to supply it.

Record commands, exit outcomes, meaningful counts, actual environment and focused scenarios in the commit body. Distinguish Node/VM/jsdom simulations, developer-driven native checks, real client checks and manual UI checks. Never label unavailable, skipped, failing or simulated checks as passed manual verification. Redact credentials and private content; large raw logs may stay in ignored development artifacts.

Every commit, including each member of a split series and every amended candidate, must complete its own required checks. Earlier results may be reused only for the identical candidate contents and environment, with evidence clearly tied to that snapshot. After a change, rerun the baseline and any affected focused checks before committing. Do not reuse a previous commit's successful run as validation of a different candidate.

If a required check fails or the required runtime/client is unavailable, fix or complete the verification before committing. If that is impossible, leave the candidate ready for review, explain the exact missing evidence, and request the user's explicit authorization to make that particular exception. Explain that this skill's verification gate is the source of the request and link to this file. Never silently bypass checks or ask for a routine confirmation after they have passed.

## Stage, Commit and Confirm

1. Confirm `README.md` and necessary documentation have been reviewed and synchronized with the final candidate. Stage only the reviewed files/hunks for the candidate. Inspect `git diff --cached --stat`, the full staged diff and `git diff --cached --check` after staging. Confirm documentation and regression tests belong to the same commit as the behavior they describe.
2. Finalize the detailed message using actual validation results. Review it against the format, candidate diff, compatibility implications and test evidence. Use a UTF-8 message file with `git commit --file <path>` to preserve real newlines and avoid shell-quoting errors; keep the temporary file outside tracked source.
3. Commit only after all required gates pass or the user explicitly authorizes the documented exception. Do not use `--no-verify` to evade hooks. If a hook modifies files, review the changes and revalidate the affected candidate before retrying.
4. Verify the created commit with `git log -1 --format=fuller`, `git show --stat --oneline HEAD` and `git status --short`. Confirm its actual contents and full message match the reviewed candidate and report any remaining uncommitted work.
5. Report the short hash, classified subject, key changes, tests and material limitations to the user. Do not push or amend an existing commit unless that action is authorized.
