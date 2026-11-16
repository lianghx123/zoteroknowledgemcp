# Development Guide

This guide is for contributors building the plugin. To install the released
XPI, use the [user installation guide](../user/installation.md); end users
do not need Node.js or a development Zotero profile. Read
[AGENTS.md](../../AGENTS.md) and the applicable development skills before
changing the repository.

## Documentation Map

| Document | Use it for |
| --- | --- |
| [Project README](../../README.md) | User introduction, feature demonstrations and onboarding. |
| [User handbook](../user/index.md) | Installation, service configuration and daily workflows in seven languages. |
| [Repository guidelines](../../AGENTS.md) | Coding, data safety, verification and development skills. |
| This guide | Contributor environment, build commands and isolated development setup. |
| [Implementation overview](implementation-overview.md) | Detailed behavior, runtime boundaries and links to feature references. |
| [Project delivery status](project-status.md) | Implemented scope, acceptance gaps and dated verification evidence. |
| [Source architecture](src-architecture.md) | Layer ownership, current integration paths and the broader target design. |
| [Migration plan](migration-plan.md) | Delivery order, remaining work and acceptance gates. |
| [Release procedure](releases.md) | Versioning, XPI publication and the stable-update channel. |
| [Documentation maintenance](documentation.md) | Document ownership, translations, link maintenance and Pages publishing. |

Feature documents linked from the implementation overview own their contracts and
verification details. Historical release notes and acceptance reports retain their
original dates and results; do not treat them as a fresh validation of a later build.

## Environment and Setup

### Requirements

- Zotero 10 desktop application.
- Node.js 22.23.1 or newer, and npm. Development validation uses the local Node 22.23.1 runtime; other Node versions are not compatibility-tested. SQLite design tests use the experimental `node:sqlite` development API; it is never bundled into the plugin.
- Windows PowerShell for the commands below.

### Configure the Development Instance

```powershell
Copy-Item .env.example .env
```

Set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` in `.env` to your Zotero executable:

```ini
ZOTERO_PLUGIN_ZOTERO_BIN_PATH="C:/Program Files/Zotero/zotero.exe"
```

Scaffold uses `.scaffold/profile` and `.scaffold/data` for an isolated development instance by default. To use a specific development profile and library, set both paths:

```ini
ZOTERO_PLUGIN_PROFILE_PATH="E:/ZoteroDev/profile"
ZOTERO_PLUGIN_DATA_DIR="E:/ZoteroDev/data"
```

Use a dedicated development library and keep `.env` out of Git. Do not point the development instance to an active production database. Scaffold 0.8.8 may terminate Zotero by process name during shutdown cleanup on Windows, so avoid running production Zotero alongside the development instance.

### Start Development

```powershell
npm install --include=optional
npm run dev
```

Scaffold builds the plugin, launches the development Zotero instance, and installs the development plugin. Saving changes to `src/index.ts` triggers recompilation and plugin reload through the Remote Debugging Protocol.

Logs are available in `.scaffold/logs/`. Press `Ctrl+C` to stop the development process. Avoid manually installing another XPI with the same plugin ID in the development profile.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run init:src` | Recreate the source directory skeleton without overwriting existing modules. |
| `npm run dev` | Launch the development Zotero instance with automatic hot reload. |
| `npm run build` | Build the plugin XPI in `.scaffold/build/`. |
| `npm run typecheck` | Check TypeScript types without emitting files. |
| `npm test` | Build and run manifest, lifecycle, database, knowledge membership, parsing, retrieval, native verification-helper, Markdown and reader tests. |
| `npm run database:check` | Verify all sixteen migration snapshots, generated table types and the field dictionary against reviewed fixtures. |

Build and development commands share the configuration in `zotero-plugin.config.ts`.
Development builds retain inline source maps for debugging; production XPI builds omit them.

## Repository Structure

```text
.
|-- addon/
|   |-- manifest.json           # Zotero compatibility and plugin metadata
|   |-- bootstrap.js            # Native Zotero lifecycle entry point
|   |-- locale/                 # One shared Fluent file per supported language
|   `-- content/ui/             # Bundled reader/knowledge styles and icons
|-- src/
|   |-- index.ts                # Application startup, shutdown, and window events
|   |-- app/                    # Compose services and own plugin resources
|   |-- core/                   # Shared runtime cleanup primitives
|   |-- shared/contracts/       # Reader and knowledge membership contracts
|   |-- schemas/                # Validate imported and stored Markdown
|   |-- database/               # Native Kysely driver, typed tables, migrations and backup
|   |-- repositories/           # Reader interface and transactional knowledge metadata
|   |-- services/               # Reader operations and knowledge admission/reconciliation
|   |-- storage/                # Local per-attachment Markdown import cache
|   |-- ui/                     # Native knowledge tree/section/menus and Markdown reader
|   |-- worker/                 # Durable parsing and local vector index workers
|   |-- integrations/           # Native metadata, content and protected credential adapters
|   |-- security/               # Scoped personal tokens and signed cursors
|   |-- mcp/                    # Protocol contracts and 16 local tools
|   |-- connections/            # Local SSE transport; remote adapters planned
|   `-- zotero-globals.d.ts      # Zotero API type declarations used by this project
|-- test/
|   |-- smoke.test.mjs          # Build output and lifecycle checks
|   |-- database-migrations.test.mjs # Adapter, upgrade, rollback and migration checks
|   |-- database-schema.test.mjs # In-memory schema and bulk tree-integrity checks
|   |-- knowledge-library.test.mjs # Admission, updates, memberships and rollback
|   `-- markdown-reader.test.mjs # Rendering, attachment storage and reader lifecycle
|-- scripts/
|   |-- initialize-source-layout.mjs # Idempotent directory initializer
|   |-- promote-database-schema.mjs # Migration snapshots and typed tables
|   `-- generate-database-dictionary.mjs # Development-only field dictionary
|-- docs/development/
|   |-- getting-started.md      # Contributor setup and documentation map
|   |-- implementation-overview.md # Detailed behavior and implementation boundaries
|   |-- project-status.md       # Delivered scope and acceptance gaps
|   |-- markdown-reader.md      # Reader usage, implementation and verification
|   |-- knowledge-membership-metadata.md # Admission usage, fields/tables and update policy
|   |-- src-architecture.md     # Full source design and implemented boundaries
|   |-- migration-assessment.md # Feasibility, constraints, and prototype gates
|   |-- migration-plan.md       # Accepted five-step order and work packages
|   |-- database-design.md      # Local schema decisions and source mapping
|   |-- database-field-dictionary.md # Generated current fields and relationships
|   `-- database-*.sql          # Core, search, MCP and tree-integrity fixtures
|-- zotero-plugin.config.ts     # Scaffold build and development configuration
|-- package.json
|-- tsconfig.json
|-- .env.example
`-- README.md
```

## Development Guidelines

- Use English for code, comments, configuration, documentation, file names and the source locale. Keep translated interface text in `addon/locale/<locale>/knowledgemcp.ftl` and use the shared Fluent formatter for runtime text.
- Keep `addon/bootstrap.js` in JavaScript. Application code is written in TypeScript and bundled from `src/index.ts` into `content/main.js`.
- The bootstrap exposes explicit install/uninstall hooks; these perform no installation-specific work and preserve user data when the addon is removed or replaced.
- Access Zotero through its in-process JavaScript APIs. Add accurate type declarations as additional APIs are introduced.
- Handle plugin reloads with existing windows open, and release listeners, UI elements, and resources during shutdown and window cleanup.
- Account for Zotero's runtime when selecting dependencies; Node-specific modules such as `fs` and `child_process` cannot be used directly in plugin code.
- Keep `config.prefsPrefix` in `package.json`, which Scaffold 0.8.8 requires when parsing configuration.
- Before every commit or amendment, review the repository README and necessary usage, architecture, schema/migration and verification documentation against the final changes. Update affected descriptions before staging and final checks; record the review when existing documentation remains accurate. See [the commit skill](../../.agents/skills/code-commit/SKILL.md).
- Keep local literature fixtures in the ignored `test_documents/` directory; never commit library data, credentials or generated development artifacts.
- Retest before changing the pinned `@swc/core` version, `1.15.13`, which addresses a native binding cache permission issue on Windows.
- Preview releases use manual XPI installation. The stable-update pipeline verifies assets and anonymous reachability before advertising updates in a public repository. Preserve the installed feed URL. See the [release procedure](releases.md).

### Development Ports

New development profiles use Scaffold 0.8.8's default local HTTP port, `23124`. An existing profile may retain a different value in `prefs.js`. Production Zotero commonly uses port `23119` for its local HTTP API and browser Connector integration.

Scaffold also uses a dynamic debugging port for plugin reloads. These development and Zotero API ports are separate from the default MCP port, `23126`.

## References

- [Zotero 10 for Developers](https://www.zotero.org/support/dev/zotero_10_for_developers)
- [Zotero Plugin Structure and Lifecycle](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [Zotero JavaScript API](https://www.zotero.org/support/dev/client_coding/javascript_api)
- [Zotero Plugin Scaffold](https://zotero-plugin.dev/zotero-plugin-scaffold/serve.html)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## Live Model Probe Configuration

`verify-model-http.mjs`, `verify-vector-live.mjs` and
`verify-vector-settings.mjs` read this plugin's saved model settings and Gecko
Login Manager inside isolated Zotero. Configure Bailian's default embedding and
rerank models at 768 dimensions, using HTTPS `dashscope.aliyuncs.com` endpoints.
Shared or separate keys are supported. Missing or incompatible settings fail
before provider calls; no neighboring repository or plaintext configuration is
required. Keys are never returned through the debugger controller.

These explicit live checks consume provider quota; routine tests do not. To
compile the probes without contacting Zotero or a provider, run:

```powershell
node scripts/verify-model-http.mjs --prepare-only
node scripts/verify-vector-live.mjs --prepare-only
node scripts/verify-vector-settings.mjs --prepare-only
```

Full live-vector checks additionally require prepared isolated corpus/query
fixtures; see [retrieval verification](vector-retrieval.md).
