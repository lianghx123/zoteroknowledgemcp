"""Check handbook translations against the plugin locales and English source."""

import argparse
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

import yaml


def navigation(items):
    labels, pages = [], []
    for item in items:
        for label, value in item.items():
            labels.append(label)
            if isinstance(value, list):
                child_labels, child_pages = navigation(value)
                labels.extend(child_labels)
                pages.extend(child_pages)
            else:
                pages.append(value)
    return labels, pages


def check_sources(root):
    config = yaml.safe_load((root / "mkdocs.yml").read_text(encoding="utf-8"))
    i18n = next(plugin["i18n"] for plugin in config["plugins"] if isinstance(plugin, dict) and "i18n" in plugin)
    locales = {entry["locale"] for entry in i18n["languages"]}
    plugin_locales = {entry.name for entry in (root / "addon/locale").iterdir() if entry.is_dir()}
    assert locales == plugin_locales, "Handbook languages differ from plugin locales"
    assert i18n["fallback_to_default"] is False, "English fallback must remain disabled"
    defaults = [entry["locale"] for entry in i18n["languages"] if entry.get("default")]
    assert defaults == ["en-US"], "Keep English at the existing root URLs"
    labels, pages = navigation(config["nav"])
    docs = root / config["docs_dir"]
    expected = set(pages)
    for locale in locales - {"en-US"}:
        expected.update(f"{Path(page).stem}.{locale}.md" for page in pages)
    actual = {str(file.relative_to(docs)).replace("\\", "/") for file in docs.rglob("*.md")}
    assert actual == expected, f"Missing/extra handbook pages: {actual ^ expected}"
    source = {page: (docs / page).read_text(encoding="utf-8") for page in pages}
    links = lambda text: Counter(re.findall(r"\]\(([^\s)]+)\)", text))
    sections = lambda text: Counter(len(level) for level in re.findall(r"^(#{1,6}) ", text, re.M))
    examples = lambda text: re.findall(r"```[^\n]*\n(.*?)```", text, re.S)
    actions = {
        "configuration.md": ["settings-tab-parsing", "settings-tab-retrieval", "settings-tab-mcp", "vector-enqueue", "vector-rebuild", "vector-save"],
        "quick-start.md": ["settings-tab-parsing", "tasks-title", "add-default"],
        "knowledge-libraries.md": ["add-default"],
        "reader.md": ["reader-edit-save-document"],
        "troubleshooting.md": ["vector-enqueue", "vector-rebuild", "parse-selected"],
    }
    for language in i18n["languages"]:
        locale = language["locale"]
        theme = language["theme"]
        assert theme.get("language"), f"Missing Material language: {locale}"
        assert all(palette["toggle"].get("name") for palette in theme["palette"]), f"Missing theme labels: {locale}"
        if locale != "en-US":
            assert set(language["nav_translations"]) == set(labels), f"Incomplete navigation: {locale}"
            assert all(value.strip() for value in language["nav_translations"].values())
        catalog = (root / f"addon/locale/{locale}/knowledgemcp.ftl").read_text(encoding="utf-8")
        for page, original in source.items():
            translated = docs / (page if locale == "en-US" else f"{Path(page).stem}.{locale}.md")
            text = translated.read_text(encoding="utf-8")
            assert text.strip(), f"Empty page: {translated}"
            assert locale == "en-US" or text.strip() != original.strip(), f"English placeholder: {translated}"
            assert sections(text) == sections(original), f"Missing sections: {translated}"
            assert links(text) == links(original), f"Changed link destinations: {translated}"
            assert examples(text) == examples(original), f"Changed command examples: {translated}"
            assert not re.search(r"\b(?:TODO|TBD)\b|\ufffd", text), f"Placeholder or damaged text: {translated}"
            for action in actions.get(page, []):
                message = re.search(rf"^knowledgemcp-{action} = (.+)$", catalog, re.M)
                if not message:
                    message = re.search(rf"^knowledgemcp-{action} =\n +\.label = (.+)$", catalog, re.M)
                assert message and message.group(1) in text, f"Action label differs from Fluent ({action}): {translated}"
    return config, i18n, pages


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets = []
        self.language = None

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        if tag == "html":
            self.language = attributes.get("lang")
        for name in ("href", "src"):
            if attributes.get(name):
                self.targets.append(attributes[name])


def check_site(root, site, config, i18n, pages):
    base = urlsplit(config["site_url"])
    for language in i18n["languages"]:
        locale = language["locale"]
        prefix = Path() if locale == "en-US" else Path(locale)
        for page in pages:
            name = Path(page).stem
            target = site / prefix / ("index.html" if name == "index" else f"{name}/index.html")
            parser = Links()
            parser.feed(target.read_text(encoding="utf-8"))
            assert parser.language == language["theme"]["language"], f"Wrong HTML language: {target}"
            for link in parser.targets:
                url = urlsplit(link)
                if url.scheme or url.netloc:
                    continue
                href = unquote(url.path)
                if not href:
                    continue
                if href.startswith("/"):
                    assert href.startswith(base.path), f"Link escapes the Pages project path: {link}"
                    destination = site / href[len(base.path):]
                else:
                    destination = target.parent / href
                destination = destination.resolve()
                assert destination.is_relative_to(site), f"Link escapes site: {link}"
                if destination.is_dir():
                    destination /= "index.html"
                assert destination.is_file(), f"Broken site link in {target}: {link}"


if __name__ == "__main__":
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--site-dir", type=Path, help="Also validate the built HTML and internal links")
    args = arguments.parse_args()
    root = Path(__file__).resolve().parent.parent
    config, i18n, pages = check_sources(root)
    if args.site_dir:
        check_site(root, args.site_dir.resolve(), config, i18n, pages)
    print(f"Verified {len(i18n['languages'])} locales, {len(pages)} pages each; navigation, sections, links, commands and Fluent action labels agree.")
