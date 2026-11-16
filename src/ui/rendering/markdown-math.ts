import type MarkdownIt from "markdown-it";
import katex from "katex";

const mathNamespace = "http://www.w3.org/1998/Math/MathML";

function escaped(source: string, position: number): boolean {
  let slashes = 0;
  while (position > 0 && source[--position] === "\\") slashes++;
  return slashes % 2 === 1;
}

function closingDelimiter(source: string, delimiter: string, start: number, limit = source.length, spaced = false): number {
  let position = source.indexOf(delimiter, start);
  while (position !== -1 && position + delimiter.length <= limit) {
    if (!escaped(source, position)
      && (delimiter !== "$" || ((spaced || !/\s/.test(source[position - 1])) && !/\d/.test(source[position + 1] || "")))) return position;
    position = source.indexOf(delimiter, position + delimiter.length);
  }
  return -1;
}

function inlineMath(source: string, start: number, limit = source.length) {
  if (escaped(source, start)) return undefined;
  const opening = ["$$", "\\[", "\\(", "$"].find(value => source.startsWith(value, start));
  if (!opening) return undefined;
  const contentStart = start + opening.length;
  const closing = opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
  const end = closingDelimiter(source, closing, contentStart, limit, /\s/.test(source[contentStart] || ""));
  if (end < 0 || end === contentStart) return undefined;
  const content = source.slice(contentStart, end);
  // OCR providers commonly surround inline TeX with spaces inside the dollars.
  if (!content.trim() || (opening === "$" && content.includes("\n"))) return undefined;
  return { content: content.trim(), opening, end: end + closing.length,
    display: opening === "$$" || opening === "\\[", source: source.slice(start, end + closing.length) };
}

/** Interpret only TeX in sanitized HTML text, leaving other characters literal. */
export function renderMathText(doc: Document, text: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  let consumed = 0;
  for (let position = 0; position < text.length; position++) {
    if (text[position] !== "$" && text[position] !== "\\") continue;
    const math = inlineMath(text, position);
    if (!math) continue;
    fragment.append(doc.createTextNode(text.slice(consumed, position)), renderMath(doc, math.content, math.source, math.display));
    position = math.end - 1;
    consumed = math.end;
  }
  fragment.append(doc.createTextNode(text.slice(consumed)));
  return fragment;
}

/** Recognize math before Markdown consumes backslashes, emphasis or HTML. */
export function markdownMath(parser: MarkdownIt): void {
  parser.inline.ruler.before("escape", "math", (state, silent) => {
    const math = inlineMath(state.src, state.pos, state.posMax);
    if (!math) return false;
    if (!silent) {
      const token = state.push("math", "", 0);
      token.content = math.content;
      token.markup = math.opening;
      token.meta = { display: math.display, source: math.source };
    }
    state.pos = math.end;
    return true;
  });

  parser.block.ruler.before("fence", "math", (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const opening = ["$$", "\\["].find(value => state.src.startsWith(value, start));
    if (!opening) return false;
    const closing = opening === "$$" ? "$$" : "\\]";
    for (let line = startLine; line < endLine; line++) {
      if (line > startLine && state.sCount[line] < state.blkIndent && !state.isEmpty(line)) break;
      const from = line === startLine ? start + opening.length : state.bMarks[line] + state.tShift[line];
      const end = closingDelimiter(state.src, closing, from, state.eMarks[line]);
      if (end < 0) continue;
      if (state.src.slice(end + closing.length, state.eMarks[line]).trim()) return false;
      if (silent) return true;
      const token = state.push("math", "", 0);
      token.block = true;
      token.map = [startLine, line + 1];
      token.content = state.src.slice(start + opening.length, end).trim();
      token.markup = opening;
      token.meta = { display: true, source: state.src.slice(start, end + closing.length) };
      state.line = line + 1;
      return true;
    }
    return false;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
}

/** Only KaTeX-generated, untrusted-TeX-disabled MathML is parsed into a document. */
export function renderMath(doc: Document, source: string, original: string, display: boolean): HTMLElement {
  const element = doc.createElement("span");
  element.className = display ? "km-math km-math-block" : "km-math km-math-inline";
  try {
    if (source.length > 16_384) throw new Error("Math input limit exceeded");
    const markup = katex.renderToString(source, {
      output: "mathml", displayMode: display, throwOnError: true, trust: false,
      strict: "ignore", maxExpand: 1000, maxSize: 20,
    });
    const Parser = (doc.defaultView as Window & typeof globalThis).DOMParser;
    const parsed = new Parser().parseFromString(markup, "text/html");
    const math = parsed.querySelector("math");
    if (!math || math.namespaceURI !== mathNamespace) throw new Error("Missing generated MathML");
    element.append(doc.importNode(math, true));
  } catch {
    // Preserve malformed or unsupported equations without breaking the paper.
    element.classList.add("km-math-fallback");
    element.textContent = original;
  }
  return element;
}
