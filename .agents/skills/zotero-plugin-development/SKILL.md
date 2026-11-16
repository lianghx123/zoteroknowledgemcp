---
name: zotero-plugin-development
description: Develop or debug this repository's Zotero plugin lifecycle, window integration, interface localization, manifest, assets, build configuration, and hot reload. Use for runtime and packaging changes; use the domain-specific skills for content processing or MCP contracts.
---

# Zotero Plugin Development

## Establish the Runtime Boundary

Read `AGENTS.md` and inspect the affected entry points: `src/index.ts`, `src/zotero-globals.d.ts`, `addon/bootstrap.js`, `addon/manifest.json`, and `zotero-plugin.config.ts`.

Use the [development guide](../../../docs/development/getting-started.md) for isolated setup, the [implementation overview](../../../docs/development/implementation-overview.md) for runtime behavior, and [delivery status](../../../docs/development/project-status.md) for acceptance limits. The root `README.md` introduces user workflows.

The application runs in Zotero's privileged Gecko environment. Node.js runs the build and tests only. Check that dependencies support the plugin runtime; package installation alone does not establish compatibility.

Keep `addon/bootstrap.js` in JavaScript. Scaffold bundles `src/index.ts` into `content/main.js` as the `ZoteroKnowledgeMCP` global. When changing lifecycle exports or that global, update both ends and the lifecycle tests together.

## Implement Lifecycle and Window Changes

- Handle windows already open at startup or hot reload as well as subsequently opened windows. Check Zotero's actual callback order before adding initialization that could run twice.
- Track registrations and per-window resources so shutdown and window unload can remove them. Cancel or invalidate asynchronous work before releasing its state.
- Account for partial startup failures and repeated startup/shutdown cycles when changing resource ownership.
- Read and modify items, collections, and attachments through Zotero APIs. Keep plugin-owned content and indexes separate from Zotero's database schema.
- Add accurate declarations to `src/zotero-globals.d.ts` when introducing Zotero APIs. Confirm version-specific behavior using official Zotero developer documentation when necessary.

## Complete Interface Localization

Features that add or change user-visible text must complete i18n in the same change before being declared complete. Read [the localization requirements](../../../docs/development/localization.md).

- Use Fluent IDs for native registrations and `t(key, args)` from `src/shared/localization.ts` for runtime UI text. Do not introduce hardcoded menus, dialogs, status/error messages, tooltips or accessibility labels.
- Update the English source catalog and every currently supported locale under `addon/locale/` together. Preserve message IDs, attributes and variable names; do not defer translations or rely on English fallback to supply missing messages.
- Keep native menu and section-header messages attribute-only. A main message value replaces native child nodes and can remove icons or submenus.
- Run `npm run typecheck` and `npm test`, including localization checks, and inspect changed UI code for hardcoded text that catalog tests cannot detect. Verify affected localized behavior in isolated Zotero, including icon/submenu preservation when changing native menu messages. Passing catalog checks alone does not establish complete UI localization.

## Preserve Build Consistency

Keep package names, plugin IDs, namespaces, preference prefixes, runtime globals, and log labels independent of Zotero versions and consuming AI clients. The plugin is Zotero Knowledge MCP; AI-Scientist is a consuming client. Express version compatibility through the manifest, build target, and requirements. Synchronize changed identities across source, configuration, lockfile, tests, and documentation; do not broaden compatibility as a side effect of renaming.

Use the existing Scaffold configuration for both development and release builds. `makeManifest` is disabled because `addon/manifest.json` is authoritative. Keep package and manifest versions synchronized. Preserve plugin ID consistency across configuration, manifest, and tests when an ID change is required by the task.

Keep `config.prefsPrefix` and the pinned SWC version unless the task calls for changing them. Package runtime assets through the configured `addon/**/*.*` asset rule; do not edit generated `.scaffold/build/` files as source.

## Verify the Change

Run `npm run typecheck` and `npm test` for code or build changes. Add focused `node:test` cases for changed lifecycle behavior, including cleanup and error handling where relevant.

For window integration or hot reload changes, verify the affected behavior in an isolated Zotero 10 development profile. Report manual checks separately from VM-based tests, and state when GUI verification was unavailable.
