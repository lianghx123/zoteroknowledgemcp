import MarkdownIt from "markdown-it";
import { decodeHTML } from "entities";
import { t } from "../../shared/localization";
import { validateMarkdown } from "../../schemas/knowledge-content";
import type { MarkdownHeading } from "../../shared/contracts/knowledge-content";
import { markdownMath, renderMath, renderMathText } from "./markdown-math";
import { referencePrefix } from "../../shared/reference-number";
import { referenceEntryElement } from "./reference-entry";
import { markReaderSource } from "./reader-source";

const parser = new MarkdownIt({ html: true, linkify: false, typographer: false }).use(markdownMath);
const allowedTags = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
  "table", "thead", "tbody", "tr", "th", "td", "em", "strong", "s", "a",
]);
type Token = ReturnType<MarkdownIt["parse"]>[number];

// Preserve the distinction between provider line markers and an escaped
// backslash before Markdown's text_join rule merges their source identities.
parser.core.ruler.before("text_join", "table_newlines", state => {
  let cell = false;
  for (const token of state.tokens) {
    if (token.type === "td_open" || token.type === "th_open") cell = true;
    if (token.type === "td_close" || token.type === "th_close") cell = false;
    if (cell && token.type === "inline") for (const child of token.children ?? []) {
      if (child.type === "text_special" && child.info === "escape" && child.markup === "\\n") child.type = "table_newline";
    }
  }
});

function tableText(doc: Document, text: string): DocumentFragment {
  const fragment = doc.createDocumentFragment(); let consumed = 0;
  for (const match of text.matchAll(/(?<!\\)\\n/gu)) {
    fragment.append(doc.createTextNode(text.slice(consumed, match.index)), doc.createElement("br")); consumed = match.index + match[0].length;
  }
  fragment.append(doc.createTextNode(text.slice(consumed))); return fragment;
}

export function isSafeExternalURL(value: string): boolean {
  try { return ["https:", "http:", "mailto:"].includes(new URL(value).protocol); }
  catch { return false; }
}

/** Normalize display spacing in explicitly named reference sections only. */
function groupReferences(doc: Document, fragment: DocumentFragment): void {
  for (const heading of Array.from(fragment.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const title = (heading.textContent || "").trim().replace(/^(?:\d+(?:\.\d+)*[.、)]?\s*|[一二三四五六七八九十]+[、.]\s*)/, "").replace(/[:：]$/, "").replace(/\s+/g, "");
    if (!/^(?:参考文献|參考文獻|references|bibliography)$/i.test(title)) continue;
    let entry: HTMLElement | undefined, numbered = false, order = 0;
    const strip = (element: HTMLElement): number | undefined => {
      const text = element.textContent ?? "", prefix = referencePrefix(text);
      if (!prefix) return;
      let remaining = text.indexOf(prefix.content);
      if (remaining < 0) return;
      const walker = doc.createTreeWalker(element, 4), nodes: Text[] = [];
      let node: Node | null; while ((node = walker.nextNode())) nodes.push(node as Text);
      for (const text of nodes) {
        const count = Math.min(remaining, text.data.length); text.deleteData(0, count); remaining -= count;
        if (!remaining) break;
      }
      return prefix.number;
    };
    let cursor = heading.nextSibling;
    while (cursor) {
      const next = cursor.nextSibling;
      if (cursor.nodeType === 1) {
        const element = cursor as HTMLElement;
        if (/^H[1-6]$/.test(element.tagName)) break;
        if (element.tagName === "P") {
          const numberStyle = /^\s*(?:[（(]|\d+[)）])/u.test(element.textContent ?? "") ? "round" : "bracket";
          const number = strip(element), startsEntry = number !== undefined;
          if (!entry || startsEntry || !numbered) {
            entry = referenceEntryElement(doc, number ?? order + 1, [], number ?? null, numberStyle); order++;
            element.replaceWith(entry); numbered = startsEntry;
          }
          entry.querySelector(".km-reference-body")!.append(element);
        } else if (element.tagName === "OL" || element.tagName === "UL") {
          element.classList.add("km-reference-list");
          let nextNumber = Number(element.getAttribute("start") ?? 1);
          for (const item of Array.from(element.children)) {
            if (item.tagName !== "LI") continue;
            const actual = item.getAttribute("value"), number = strip(item as HTMLElement);
            const display = number ?? (element.tagName === "OL" ? actual !== null ? Number(actual) : nextNumber : order + 1);
            nextNumber = display + 1; order++;
            item.append(referenceEntryElement(doc, display, Array.from(item.childNodes), number ?? (element.tagName === "OL" ? display : null), element.dataset.referenceNumberStyle === "round" ? "round" : "bracket"));
          }
          entry = undefined;
        } else {
          entry = undefined;
        }
      } else if (cursor.nodeType === 3 && cursor.textContent?.trim()) entry = undefined;
      cursor = next;
    }
  }
}

/** Build a small allowlisted DOM directly. Parser output never enters innerHTML. */
export function renderMarkdown(doc: Document, markdown: string, openURL: (url: string) => void, assets: Record<string, string> = {}, options: {
  headingOffset?: number; caption?: boolean;
  sourceSpans?: { blockId?: string; startLine: number; endLine: number; pageStart?: number | null; pageEnd?: number | null; isDocumentTitle?: boolean }[];
} = {}) {
  validateMarkdown(markdown);
  const fragment = doc.createDocumentFragment();
  const htmlText = new Set<Text>();
  const headings: MarkdownHeading[] = [];
  const stack: Array<HTMLElement | DocumentFragment> = [fragment];
  const markSource = (element: HTMLElement, token: Token) => {
    if (!token.map) return;
    const source = options.sourceSpans?.find(span => token.map![0] >= span.startLine && token.map![0] < span.endLine);
    if (source?.pageStart) { element.dataset.citationPageStart = String(source.pageStart); element.dataset.citationPageEnd = String(source.pageEnd ?? source.pageStart); }
    markReaderSource(element, options.sourceSpans?.filter(span => token.map![0] < span.endLine && token.map![1] > span.startLine) ?? []);
  };
  const appendText = (text: string) => stack[stack.length - 1].append(doc.createTextNode(text));
  const image = (key: string, alt: string): HTMLElement => {
    const source = Object.hasOwn(assets, key) ? assets[key] : undefined;
    if (source && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(source)) {
      const img = doc.createElement("img"); img.src = source; img.alt = alt; img.loading = "lazy";
      img.style.maxWidth = "100%"; return img;
    }
    const notice = doc.createElement("span"); notice.className = "km-image-placeholder";
    notice.textContent = t("reader-image-placeholder", { alt: alt || t("reader-image-alt") });
    notice.title = t("reader-image-title"); return notice;
  };
  const link = (element: HTMLElement, href: string) => {
    if (!isSafeExternalURL(href)) return;
    element.setAttribute("href", href); element.setAttribute("rel", "noopener noreferrer");
    element.addEventListener("click", event => { event.preventDefault(); openURL(href); });
  };
  // Tokenize a conservative HTML subset directly into our DOM. No source HTML is
  // parsed into a document, so remote images and active elements cannot load.
  const htmlTags = new Set([...allowedTags, "div", "span", "caption", "tfoot", "br", "sub", "sup", "b", "i", "u", "code"]);
  const decode = decodeHTML;
  const renderHTML = (source: string, opened: string[], token?: Token) => {
    source = source.replace(/<!--(?:[\s\S]*?-->|[\s\S]*$)/g, "")
      .replace(/<(script|style|iframe|svg|object|embed|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
    for (const match of source.matchAll(/<\/?[A-Za-z][^>]*>|[^<]+|</g)) {
      const value = match[0], tagMatch = /^<(\/?)\s*([A-Za-z][\w-]*)\b/.exec(value);
      if (!tagMatch) {
        const parent = stack[stack.length - 1], last = parent.lastChild;
        if (last?.nodeType === 3 && htmlText.has(last as Text)) (last as Text).appendData(decode(value));
        else {
          const text = doc.createTextNode(decode(value)); parent.append(text); htmlText.add(text);
        }
        continue;
      }
      const tag = tagMatch[2].toLowerCase();
      if (tagMatch[1]) {
        if (opened[opened.length - 1] === tag) { opened.pop(); stack.pop(); }
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const attr of value.slice(tagMatch[0].length).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[attr[1].toLowerCase()] = decode(attr[2] ?? attr[3] ?? attr[4]);
      if (tag === "img") {
        // HTML images, like Markdown images, resolve only explicitly supplied local assets.
        if (Object.hasOwn(assets, attrs.src ?? "")) stack[stack.length - 1].append(image(attrs.src, attrs.alt || ""));
        continue;
      }
      if (!htmlTags.has(tag)) continue;
      const element = doc.createElement(tag);
      if (token) markSource(element, token);
      if (tag === "a") link(element, attrs.href || "");
      if (tag === "td" || tag === "th") for (const name of ["rowspan", "colspan"]) {
        const count = Number(attrs[name]); if (Number.isInteger(count) && count >= 1 && count <= 1000) element.setAttribute(name, String(count));
      }
      if (tag === "ol" || tag === "li") {
        const key = tag === "ol" ? "start" : "value", value = attrs[key];
        if (/^\d{1,5}$/.test(value ?? "")) element.setAttribute(key, value);
      }
      const align = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i.exec(attrs.style || "");
      if (align) element.style.textAlign = align[1].toLowerCase();
      if (tag === "table") { element.style.margin = "auto"; element.style.overflowWrap = "break-word"; if (attrs.border === "1") element.setAttribute("border", "1"); }
      stack[stack.length - 1].append(element);
      if (tag !== "br" && !/\/\s*>$/.test(value)) { opened.push(tag); stack.push(element); }
    }
  };
  const render = (tokens: Token[]) => {
    const opened: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const parent = stack[stack.length - 1];
      if (token.type === "math") {
        const math = renderMath(doc, token.content, token.meta.source, token.meta.display);
        markSource(math, token); parent.append(math); continue;
      }
      if (token.type === "inline") { render(token.children || []); continue; }
      if (token.type === "html_block" || token.type === "html_inline") {
        if (token.type === "html_block") {
          const blockTags: string[] = []; renderHTML(token.content, blockTags, token);
          for (const _tag of blockTags) stack.pop();
        } else renderHTML(token.content, opened);
        continue;
      }
      if (token.type === "fence" || token.type === "code_block") {
        const pre = doc.createElement("pre");
        markSource(pre, token);
        const code = doc.createElement("code");
        code.textContent = token.content;
        pre.append(code); parent.append(pre); continue;
      }
      if (token.type === "code_inline") {
        const code = doc.createElement("code"); code.textContent = token.content;
        parent.append(code); continue;
      }
      if (token.type === "table_newline") {
        const element = parent.nodeType === 1 ? parent as Element : undefined;
        if (element?.closest("td, th") && !element.closest("math, .km-math, pre, code")) parent.append(doc.createElement("br"));
        else appendText(token.content);
        continue;
      }
      if (token.type === "softbreak") { appendText("\n"); continue; }
      if (token.type === "hardbreak" || token.type === "hr") {
        parent.append(doc.createElement(token.type === "hr" ? "hr" : "br")); continue;
      }
      if (token.type === "image") {
        parent.append(image(token.attrGet("src") || "", token.content)); continue;
      }
      if (token.nesting === 1 && allowedTags.has(token.tag)) {
        const element = doc.createElement(token.tag);
        markSource(element, token);
        if (/^h[1-6]$/.test(token.tag)) {
          element.id = `knowledgemcp-heading-${(options.headingOffset ?? 0) + headings.length + 1}`;
          const titleToken = tokens[index + 1];
          const title = titleToken?.children?.map(child => child.content).join("") || titleToken?.content || t("reader-section");
          const source = token.map && options.sourceSpans?.find(span => token.map![0] >= span.startLine && token.map![0] < span.endLine);
          headings.push({ id: element.id, title, level: Number(token.tag[1]), ...(source?.isDocumentTitle ? { isDocumentTitle: true } : {}) });
        }
        if (token.tag === "a") {
          const href = token.attrGet("href") || "";
          link(element, href);
        }
        if (token.tag === "ol" && /^\d+$/.test(token.attrGet("start") || "")) {
          element.setAttribute("start", token.attrGet("start")!);
        }
        if (token.tag === "ol" && token.markup === ")") element.dataset.referenceNumberStyle = "round";
        if (token.tag === "li" && /^\d{1,5}$/.test(token.info)) element.setAttribute("value", token.info);
        if (["td", "th"].includes(token.tag)) {
          const align = /^text-align:(left|center|right)$/.exec(token.attrGet("style") || "");
          if (align) element.style.textAlign = align[1];
        }
        parent.append(element); stack.push(element); continue;
      }
      if (token.nesting === -1 && allowedTags.has(token.tag)) { stack.pop(); continue; }
      if (token.content) appendText(token.content);
    }
    for (const _tag of opened) stack.pop();
  };
  render(parser.parse(markdown, {}));
  // OCR tables are raw HTML tokens, so Markdown's inline math rule never sees
  // their cells. Process sanitized text nodes without reparsing provider HTML.
  for (const text of htmlText) {
    const parent = text.parentElement;
    if (!parent || !(options.caption || parent.closest("td, th, caption")) || parent.closest("math, .km-math, pre, code")) continue;
    const math = /\$|\\(?:\(|\[)/.test(text.data), cell = !!parent.closest("td, th");
    if (!math && !(cell && text.data.includes("\\n"))) continue;
    const content = math ? renderMathText(doc, text.data) : doc.createDocumentFragment();
    if (!math) content.append(doc.createTextNode(text.data));
    if (cell) for (const node of Array.from(content.childNodes)) {
      if (node.nodeType === 3 && node.textContent?.includes("\\n")) node.replaceWith(tableText(doc, node.textContent));
    }
    text.replaceWith(content);
  }
  // Plain OCR divs are paragraph wrappers; apply spacing independently of script.
  for (const element of Array.from(fragment.querySelectorAll("div:not([style])"))) {
    if (element.textContent?.trim() && !element.querySelector("p, div, h1, h2, h3, h4, h5, h6, table, ul, ol, blockquote, pre, img")) element.classList.add("km-body-prose");
  }
  // Gecko's automatic justification follows the reader UI language, which can
  // remain English even for Chinese prose. Mark CJK blocks explicitly so their
  // complete lines distribute spacing between characters instead of only words.
  const textNodes = doc.createTreeWalker(fragment, 4);
  let node: Node | null;
  while ((node = textNodes.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest("math, .km-math, pre, code")
      || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(node.textContent || "")) continue;
    parent.closest("p, li, blockquote, div")?.classList.add("km-cjk-prose");
  }
  groupReferences(doc, fragment);
  // Keep the native table grid full-width; its wrapper owns narrow-pane scrolling.
  for (const [index, table] of Array.from(fragment.querySelectorAll("table")).entries()) {
    const wrapper = doc.createElement("div"); wrapper.className = "km-table-scroll";
    wrapper.tabIndex = 0; wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", t("reader-table", { number: index + 1 }));
    table.replaceWith(wrapper); wrapper.append(table);
  }
  // Parser footnotes and table notes use blockquotes. Preserve their content and
  // handlers inside a native disclosure rather than flattening it into a label.
  for (const quote of Array.from(fragment.querySelectorAll("blockquote"))) {
    if (quote.parentElement?.closest("blockquote")) continue;
    let previous = quote.previousSibling;
    while (previous && (previous.nodeType === 8 || (previous.nodeType === 3 && !previous.textContent?.trim()))) previous = previous.previousSibling;
    if (previous?.nodeType === 1 && (previous as Element).matches("details.km-reader-note")) {
      previous.appendChild(quote); continue;
    }
    const note = doc.createElement("details"); note.className = "km-reader-note";
    const summary = doc.createElement("summary"); summary.textContent = t("reader-note");
    quote.replaceWith(note); note.append(summary, quote);
  }
  return { fragment, headings };
}
