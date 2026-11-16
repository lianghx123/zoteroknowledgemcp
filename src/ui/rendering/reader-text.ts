/** Copy readable content without reader controls or MathML duplicates. */
export function readerText(article: HTMLElement): string {
  const text = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return "";
    const element = node as HTMLElement;
    if (element.matches("summary,script,style,annotation")) return "";
    if (element.matches(".km-math")) {
      const source = element.querySelector("annotation")?.textContent ?? element.textContent ?? "";
      return element.matches(".km-math-block") ? `\n\n${source}\n\n` : source;
    }
    if (element.tagName === "IMG") return element.getAttribute("alt") ?? "";
    if (element.tagName === "BR") return "\n";
    const children = Array.from(element.childNodes).map(text).join("");
    if (element.tagName === "PRE") return `\n\n${children.replace(/\n$/, "")}\n\n`;
    if (element.matches("td,th")) return children.trim() + "\t";
    if (element.tagName === "TR") return children.trimEnd() + "\n";
    if (element.matches(".km-reference-number")) return children + " ";
    if (element.tagName === "LI") return children.trim() + "\n";
    if (element.matches("p,div,section,figure,figcaption,blockquote,table,ul,ol,details,h1,h2,h3,h4,h5,h6")) return children.trim() + "\n\n";
    return children;
  };
  return text(article).replace(/\n{3,}/g, "\n\n").trim();
}

/** Serialize the selected safe reader DOM, retaining only formatting around the selection. */
export function readerMarkdown(root: HTMLElement): string {
  const escape = (value: string) => value.replace(/([\\`*_[\]<>#!])/g, "\\$1");
  const code = (value: string, block = false) => {
    const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
    const fence = "`".repeat(Math.max(block ? 3 : 1, longest + 1));
    return block ? `\n\n${fence}\n${value.replace(/\n$/, "")}\n${fence}\n\n` : `${fence}${/^[` ]|[` ]$/.test(value) ? " " : ""}${value}${/^[` ]|[` ]$/.test(value) ? " " : ""}${fence}`;
  };
  const render = (node: Node): string => {
    if (node.nodeType === 3) return escape(node.textContent ?? "");
    if (node.nodeType !== 1) return "";
    const element = node as HTMLElement, tag = element.tagName.toLowerCase();
    if (element.matches("summary,script,style,annotation")) return "";
    if (element.matches(".km-math")) {
      const source = element.querySelector("annotation")?.textContent ?? element.textContent ?? "";
      return element.matches(".km-math-block") ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`;
    }
    if (tag === "pre") return code(element.textContent ?? "", true);
    if (tag === "code") return code(element.textContent ?? "");
    const children = Array.from(element.childNodes).map(render).join("");
    if (element.matches("strong,b")) return children ? `**${children}**` : "";
    if (element.matches("em,i")) return children ? `*${children}*` : "";
    if (element.matches("sup,sub,u")) return `<${tag}>${children}</${tag}>`;
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${children.trim()}\n\n`;
    if (tag === "a") {
      const href = element.getAttribute("href");
      return href ? `[${children}](<${href.replace(/>/g, "%3E")}>)` : children;
    }
    if (tag === "br") return "  \n";
    if (tag === "img") return escape(element.getAttribute("alt") ?? "");
    if (tag === "blockquote") return children.trim().split("\n").map(line => `> ${line}`).join("\n") + "\n\n";
    if (tag === "li") {
      const parent = element.parentElement;
      const index = Array.from(parent?.children ?? []).indexOf(element);
      const number = element.getAttribute("value") ?? Number(parent?.getAttribute("start") ?? 1) + index;
      const marker = parent?.tagName === "OL" ? `${number}. ` : "- ";
      return marker + children.trim().replace(/\n/g, "\n" + " ".repeat(marker.length)) + "\n";
    }
    if (tag === "table") {
      const rows = Array.from(element.querySelectorAll("tr")).map(row => Array.from(row.children)
        .map(cell => Array.from(cell.childNodes).map(render).join("").trim().replace(/\|/g, "\\|").replace(/\n+/g, "<br>")));
      const width = Math.max(0, ...rows.map(row => row.length));
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
      return rows.length ? "\n\n" + [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n") + "\n\n" : "";
    }
    if (element.matches(".km-reference-number")) return children + " ";
    if (element.matches("p,div,section,figure,figcaption,ul,ol,details")) return children.trim() + "\n\n";
    return children;
  };
  return render(root).replace(/\n{3,}/g, "\n\n").trim();
}

export function readerSelection(article: HTMLElement): { text: string; markdown: string } | null {
  const selection = article.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return null;
  const parts: HTMLElement[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
    let fragment: Node = range.cloneContents();
    let ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType === 3) ancestor = ancestor.parentNode!;
    for (; ancestor !== article; ancestor = ancestor.parentNode!) {
      const wrapper = ancestor.cloneNode(false); wrapper.appendChild(fragment); fragment = wrapper;
    }
    const root = article.ownerDocument.createElement("article"); root.append(fragment);
    for (const hidden of Array.from(root.querySelectorAll("[hidden],details:not([open])"))) hidden.remove();
    parts.push(root);
  }
  const text = parts.map(readerText).join("\n\n");
  return text.trim() ? { text, markdown: parts.map(readerMarkdown).join("\n\n") } : null;
}
