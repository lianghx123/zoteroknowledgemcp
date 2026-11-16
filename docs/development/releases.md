# Plugin Release Procedure

The source version is **0.2.0-preview.1**; no installer or release tag is
currently published. Future reviewed `v*` tags use GitHub Actions.
Tags with a prerelease suffix produce GitHub pre-releases; stable tags produce
stable releases. Repository visibility remains a separate maintainer decision.
While private, only users with repository access can download the assets.
npm's `private` flag remains enabled: distribution is an XPI, not an npm package.

## Release Contents and Identity

- `zotero-knowledge-mcp.xpi`: production build from the tagged commit.
- `SHA256SUMS`: SHA-256 checksum of that exact XPI.
- GitHub's automatically generated source archives: development sources, not
  substitute XPI installers.

The manifest declares author `lianghx123` and the GitHub project homepage.
Project code/documentation use MIT; bundled components retain their own licenses.
The asset rules explicitly include extensionless USearch `LICENSE` and `NOTICE`
files. The project license is also packaged under `content/licenses/project.txt`.
`content/licenses/third-party.txt` includes the installed runtime dependency
notices. Builds check their versions/text; after dependency updates, run
`node scripts/prepare-licenses.mjs --write` and review the upstream notices.

Keep `package.json`, both root package versions in `package-lock.json` and
`addon/manifest.json` synchronized. Keep the existing plugin ID, namespace and
Zotero `10.0`–`10.0.*` compatibility range unless a separately tested change is
intended. MCP application contract 2.4.0 and database migrations are versioned
independently. Preserve original native/benchmark report versions as history.

USearch source/JavaScript provenance canonicalizes CRLF to LF; the WASM hash
remains byte-exact. `npm test` verifies both local assets and committed blobs,
so fresh Windows and Linux checkouts use the same content identities.

Zotero requires `applications.zotero.update_url`; omitting it makes the package
invalid in native Zotero 10.0.8. Preserve its existing raw-GitHub URL so installed
previews can find future stable releases. The current feed remains empty while
the repository is private and there is no stable release. Public Pages hosting
does not grant anonymous access to private raw files or release assets.

## Prepare and Validate

An edit request does not authorize committing or publishing. When a release
commit is authorized, follow [code-commit](../../.agents/skills/code-commit/SKILL.md).
Review README, the [user handbook](../user/index.md),
[delivery ledger](project-status.md), migration plan,
architecture, installation instructions and version-specific release notes.
Create `docs/releases/<version>.md` before tagging a new version.
Historical acceptance reports retain their original dates and fixture sizes.

Use Node.js 22.23.1 from the repository root:

```powershell
npm run typecheck
npm test
npm run database:check
npm audit --omit=dev --registry=https://registry.npmjs.org
git diff --check
```

`npm test` includes the production build and localization checks. Record actual
counts and exit results. For a version/manifest-only runtime change, inspect the
packaged XPI through isolated Zotero's native AddonManager and check identity,
author, homepage, version ordering and compatibility. Changing dependencies, bootstrap or UI also
requires the affected native lifecycle/runtime checks. Keep these distinct from
manual UI and provider integration checks. Do not start a computer-use helper
when native debugging suffices.

Review runtime dependency advisories before publication, and also inspect
`npm audit --registry=https://registry.npmjs.org` for build/test tooling issues.
The configured npm mirror may not implement the security audit endpoint; an
unsupported endpoint is not a clean audit. Review upgrades and regenerate
dependency notices rather than applying `npm audit fix --force` without checking
compatibility. The current Markdown parser is pinned to `markdown-it 14.3.3`;
the reader enables HTML parsing, so HTML and reference-parser denial-of-service
advisories apply even though rendered DOM is allowlisted. See the
[reader dependency verification](markdown-reader.md#markdown-parser-security).

After committing, rebuild and validate the exact clean commit so MCP's embedded
build identity reports the release commit with `dirty=false`. Verify the XPI
contains the expected manifest, bootstrap, scripts, seven locales and vector
assets, and excludes credentials, library fixtures, development profiles and
source maps. Check its native package metadata again before publishing. Generate
`SHA256SUMS` from that final package; do not rebuild after calculating the hash.

After creating an annotated `v<version>` tag on the reviewed release commit,
run the reusable package preparer from that clean checkout:

```sh
npm run release:prepare -- --tag v<version> --require-clean
```

The preparer verifies version/author/homepage consistency, tag-to-HEAD identity,
clean source, the packaged manifest and exact build-file bytes, required runtime
and license assets, all locales and unsafe archive paths. It stages the XPI,
checksum and release body under ignored `.scaffold/release/`. Relative release-note
links become tag-pinned GitHub links.

## Rehearse Before Publishing

Run **Actions → Release plugin → Run workflow → main** to validate a clean
checkout and upload the release asset set without creating a tag or release.
Manual runs derive the expected tag from the package version and use
`--require-clean --rehearsal`: only the existing-tag-to-HEAD check is skipped.
Version consistency, clean checkout, embedded build identity and exact package
checks still apply. Actual tag-triggered publication never skips tag identity.

Run **Actions → Stable update feed → Run workflow → main** to verify the catalog
and generate a feed artifact. Private repositories always stop before writing
`updates.json`. These rehearsals do not alter existing releases or publicize code.

## Automated Publication

Pushing a new version tag is the release trigger and should happen only after
release review and native acceptance. The `Release plugin` workflow:

1. Checks out the tag with Node 22.23.1; installs the lockfile with optional
   dependencies; runs types, all Node tests, packaging and database checks.
2. Runs the preparer with the actual tag and `--require-clean` and passes its
   immutable assets to a separate publishing job.
3. Rejects an existing release for that tag. Creates a draft with the XPI,
   checksum and committed release notes using scoped `GITHUB_TOKEN` access.
4. Downloads the draft assets and checks the checksum against the staged file.
5. Publishes only after successful byte verification. Preview tags use the
   pre-release flag and do not become the latest stable release.
6. Calls the stable-feed workflow explicitly after publication. This avoids
   relying on a new Actions event from a release created with `GITHUB_TOKEN`.

If uploading or verification fails, preserve the draft and validated files for
manual recovery. Re-running a workflow with a retained draft stops at the
existing-release guard; inspect/recover that draft manually. The workflow does
not overwrite assets, force-push tags or silently replace an existing release.
Publish only a newly reviewed version after checking the release inventory.

The normal `Plugin checks` workflow validates relevant PRs and main-branch pushes
on Windows and Linux and retains XPI artifacts. Documentation-only changes to
Markdown, development skills, handbook/theme assets, MkDocs configuration and
documentation tooling skip that workflow. Handbook inputs instead trigger the
[documentation workflow](documentation.md#github-pages-setup). A mixed change
still runs plugin checks when any changed path is outside the documentation
exclusions; database SQL fixtures under `docs/development/` remain checked.
Changes to plugin code/assets/locales, dependencies, build/test scripts and the
plugin CI workflow remain eligible. Manual `workflow_dispatch` always runs the
checks. Tagged release validation runs independently of these path filters.
Neither workflow starts Zotero or contacts parser/model providers during its
automated validation. CI on an OS does not imply native Zotero acceptance.

## Manual Publication and Recovery

Push the reviewed release commit and its annotated version tag without force.
Create a draft GitHub release from that tag, attach the final XPI and checksum,
then publish with `prerelease=true`. Use the committed version-specific notes as
the release body and use repository-resolving links in that body. Verify the
published tag points to the intended commit, the release is not a draft, and
downloaded asset bytes match the local checksum. Keep generated artifacts and
authentication credentials out of Git.

If uploading fails, preserve the draft and validated files for recovery; do not
silently replace an existing release/tag or publish an incomplete asset set.
Publishing is an explicit user-authorized action and does not authorize changing
repository visibility or production literature/settings.

## Stable Automatic Updates

Only published stable `v<major>.<minor>.<patch>` releases enter `updates.json`.
Drafts, prereleases, preview-suffixed tags and unpublished releases are excluded.
All eligible stable versions are retained so Zotero can select an older compatible
release when newer ones require a newer host. Preview releases remain manual.
Zotero's own automatic-update preference controls whether it installs an offered
update automatically; the plugin does not override that preference.

`Stable update feed` runs after automated publication, on manually published,
edited/deleted/unpublished releases, on the repository's `public` event and on
manual dispatch. `scripts/update-feed.mjs` paginates releases/assets, downloads
the XPI and checksum, checks exact SHA-256, plugin identity, tag/version and
packaged Zotero compatibility, and builds immutable version-specific URLs.
For public repositories it additionally downloads each XPI anonymously and
checks those bytes. An unreachable or invalid asset fails the refresh before
changing the current feed; inspect the failed job and recover manually.

Private repositories generate verification artifacts but never advertise updates.
After the maintainer makes this repository public, the `public` event refreshes
the feed automatically. If no stable release exists, it remains empty. No PAT or
extra deployment secret is needed. `npm run updates:check` generates a local
candidate without publishing; private asset checks need `GITHUB_TOKEN` in the
process environment. Never put a token into a command argument or repository file.

Before changing the public feed, the generator checks the actual candidate with
typechecking, the production build/full Node suite and whitespace validation.
It restores its local temporary edit on both success and failure, then writes
only `updates.json` through GitHub's Contents API using the observed file SHA.
Concurrent changes cause a conflict rather than an overwrite. The generated
maintenance commit records purpose, checks and compatibility. Branch rules must
permit `github-actions[bot]` to update this file; a rejection fails visibly and
does not change branch protection. A maintainer can inspect the generated artifact
and retry after resolving access or concurrent edits. Repository Pages is separate.

## Native Updater Acceptance

`node scripts/verify-plugin-update.mjs` connects to an already running empty
isolated Zotero profile with data at `.scaffold/stable-update-native/data` and
debugger port 19879 (override with `ZOTERO_DEBUG_PORT`). It refuses another data
directory, serves only loopback fixture endpoints, and exits that isolated runtime
when finished. Never use a production profile or Scaffold process-name cleanup.

The fixture copies the built XPI, preserves its ID and package metadata, and
replaces bootstrap hooks with inert version markers so updater validation does
not run the knowledge application or contact providers. It checks installation
of the preview, respect for the user's background-update preference, refusal of
a bad hash, omission of a Zotero-11-only candidate,
and native update discovery/download/installation of stable 0.2.0. This synthetic
version is never tagged or published.
These are developer-driven AddonManager tests, not a manual GUI or public-network
upgrade claim. Existing application lifecycle acceptance remains separate.
