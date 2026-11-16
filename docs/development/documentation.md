# Documentation Maintenance and Publishing

The end-user handbook lives in `docs/user/`. Implementation decisions, database
contracts, review checklists and bounded acceptance evidence remain in `docs/development/`.
Only the user handbook enters the published site. Keep both aligned when behavior
changes; do not move private fixtures, logs or credentials into the handbook.
Repository-visible development documents describe this plugin's own design and
verification. Exclude other private projects' checkout paths, commit identifiers,
source inventories, model mappings and authentication/deployment internals. Cite
public API specifications directly and retain only the integration boundaries
needed to explain this plugin.

## Documentation Entry Points and Maintenance

| Entry point | Maintained purpose |
| --- | --- |
| [Root README](../../README.md) | English project introduction, feature demonstrations, download and onboarding; links to the multilingual handbook. |
| [User handbook](../user/index.md) | Installation, configuration and user workflows; the seven-language Pages content. |
| [Development guide](getting-started.md) | Contributor setup, commands and the development documentation map. |
| [Implementation overview](implementation-overview.md) | Detailed implemented behavior and links to feature contracts. |
| [Project delivery status](project-status.md) | Delivered scope, remaining acceptance gates and dated evidence. |
| [Repository guidelines](../../AGENTS.md), development skills and source-directory READMEs | Contributor rules, task-specific reading and module boundaries; link to the development documents for technical context. |

When documentation is moved or its purpose changes, search all tracked references,
including `AGENTS.md`, `.agents/skills/`, `src/**/README.md` and scripts that generate
documentation. Update both links and descriptions of what readers will find.
For example, a source module's implementation-status link belongs in the delivery
status and implementation overview, while the root README remains the user entry.
Preserve existing module notes when running `npm run init:src`; the initializer
creates only missing directories and READMEs with responsibility descriptions and
links to the development references.

Update behavior and setup in their owning documents, then synchronize summaries
and navigation. Keep dated release notes, compatibility rules and useful benchmark evidence with
their original measurement scope; editing prose does not revalidate results.
Exclude development conversations, superseded prototypes, local commit inventories,
failed setup narratives, one-off log indexes and comparisons with private external
implementations. Keep modification history in Git.
Verify local links and relevant heading anchors after restructuring. Check skill
frontmatter and paths when editing development instructions. User-visible workflow
changes also require handbook updates in all seven languages.

The root README, source-directory READMEs, showcase assets under `docs/assets/`,
and development documents are browsed in GitHub. Only `docs/user/` is included in
the Pages site. Updating a GitHub document does not require rebuilding Pages;
handbook, theme, locale or site-configuration changes follow the workflow below.

Documentation-only changes skip the Windows/Linux `Plugin checks` matrix through
its push/PR path exclusions. Handbook pages/assets, theme templates, MkDocs
configuration, documentation requirements/checker and the documentation workflow
still trigger the separate `User documentation` build and eligible Pages deploy.
Root README, development prose and skill-only edits do not rebuild the handbook.
Mixed code/documentation changes still run plugin checks. Database SQL fixtures
under `docs/development/` are test inputs and are deliberately not excluded.
See [plugin CI and release validation](releases.md#automated-publication).

## User Handbook Site

The site uses MkDocs Material with navigation, search, light/dark themes and code
copy controls. `mkdocs.yml` defines navigation and the project Pages base path.
`mkdocs-static-i18n` builds all seven plugin locales: `en-US`, `zh-CN`, `zh-TW`,
`de`, `fr-FR`, `es-ES` and `ja-JP`. English retains the root URLs; other languages
use their locale directory. The language selector keeps the equivalent page.
Translations use filename suffixes such as `installation.zh-CN.md`; relative
links continue to use `installation.md` and resolve within the selected language.
All 11 handbook pages must exist in every locale. English fallback is disabled.
Navigation, Material controls, descriptions and theme toggles are localized.
Search uses explicit English, German, French, Spanish, Japanese and Chinese
analyzers rather than treating region-tagged locale IDs as search language codes.
`docs/theme/partials/source.html` keeps a source link without anonymous GitHub
API calls for repository statistics. The theme uses system fonts without a
Google Fonts request.

All locale palettes use Material's `custom` primary/accent colors and load the
shared `docs/user/assets/brand.css`. The light palette uses the plugin mark's
`#6554c0`; the dark palette uses its `#b8a8ff` counterpart for links and actions,
with a darker purple header and contrasting button text. Keep locale palettes
aligned when changing these tokens. Header logos use a white CSS filter for
contrast, while the source SVG, favicon and README mark remain purple. Verify
both theme toggles, links, button states and narrow layouts after palette changes.

The deployed public URL is `https://lianghx123.github.io/zoteroknowledgemcp/`.
Pages visibility is independent of the repository and plugin download permissions.
Localized homepages and installation pages link to the release inventory and
currently state that no installer is published. Add version-pinned XPI and
checksum buttons only after the corresponding release assets exist. Update both
pages and support status in all seven languages when distribution changes;
never advertise a removed release or temporary Actions artifact as an installer.

## Local Build and Preview

Use Python 3.12, as in GitHub Actions. A project-local virtual environment keeps
documentation tooling separate from the plugin and does not enter the XPI:

```sh
python -m venv .scaffold/docs-venv
```

Activate it using `.scaffold/docs-venv/Scripts/Activate.ps1` on Windows, or
`source .scaffold/docs-venv/bin/activate` on macOS/Linux, then run:

```sh
python -m pip install -r docs/requirements.txt
python scripts/check-docs-locales.py
python -m mkdocs build --strict
python -m mkdocs serve
```

The static build goes to ignored `.scaffold/docs-site/`. Documentation tooling is
needed by maintainers and CI only; plugin users do not need Python or MkDocs.
The site logo in `docs/user/assets/knowledge.svg` preserves the paths and view box
from `addon/content/ui/knowledge.svg`, but uses the standard fixed stroke
`#6554c0`. The plugin's `context-fill #6554c0` stroke is intended for Zotero's
Gecko context paint and renders transparent in Chrome. Do not copy that stroke
into browser-facing assets. The root README uses `docs/assets/knowledge.png`, a
256 × 256 transparent PNG exported from the same paths with the fixed stroke.
When the project mark changes, update the site SVG and re-export the README PNG;
verify visible pixels as well as successful image loading. Keep the plugin SVG's
native context-paint behavior for Zotero.

## GitHub Pages Setup

The `User documentation` workflow builds relevant main-branch pushes and pull
requests. A manual dispatch also builds it. Build failures block deployment.
Only successful main-branch runs can publish.

1. Confirm the intended site audience. This project is intended to publish its
   user handbook publicly; enabling Pages does not change repository visibility.
2. In repository **Settings → Pages**, select **GitHub Actions** as the build
   source. While the repository is private, Pages availability/access depends
   on the account plan. If it is unavailable, keep building artifacts and enable
   deployment after the repository becomes public or the plan supports it.
3. In **Settings → Secrets and variables → Actions → Variables**, set the
   repository variable **`PUBLISH_DOCS`** to **`true`**.
4. Run **User documentation** from the Actions tab on `main`, or push a handbook
   change. Confirm the deployment's reported Pages URL and test navigation/search.

Without that variable, CI builds and uploads a regular documentation artifact
but does not deploy Pages. No personal access token, third-party hosting account,
custom domain or committed `gh-pages` output branch is required. The deploy job
uses the standard `github-pages` environment and scoped Pages/OIDC permissions.

## Content Rules

Maintain English source instructions and complete translations in every supported
plugin locale. `scripts/check-docs-locales.py` checks locale/page coverage,
section counts, destination links, code examples and navigation translations.
Update all languages together; do not ship English placeholders in translated
pages. The checker also compares documented action labels with Fluent catalogs.
Keep site-internal
links relative and developer references absolute to GitHub, because developer
documents are excluded from the site. Do not claim a future feature, supported
platform, automatic update feed or published site as already available.
Update release/version text when preparing a new release. Historical release
notes and acceptance reports retain their original version/date evidence.
