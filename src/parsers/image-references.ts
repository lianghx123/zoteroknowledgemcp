import { decodeHTML } from "entities";

/** Rewrite complete image destinations, never matching substrings in prose or URLs. */
export function rewriteImageSources(content: string, resolve: (source: string) => string | undefined): string {
  const markdown = content.replace(/(!\[(?:\\.|[^\]\\\r\n])*\]\(\s*)(<[^<>\r\n]*>|(?:\\.|[^\\\s()]|\([^()\r\n]*\))+)/g,
    (match, prefix: string, destination: string) => {
      const angled = destination.startsWith("<"), source = (angled ? destination.slice(1, -1) : destination).replace(/\\([\\()[\] <>])/g, "$1");
      const target = resolve(source);
      if (target === undefined) return match;
      const escaped = target.replace(angled ? /[<>\r\n]/g : /[()<>\s\\]/g, value => encodeURIComponent(value));
      return `${prefix}${angled ? `<${escaped}>` : escaped}`;
    });
  return markdown.replace(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag => tag.replace(
    /(\s+)([\w:-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+?)(?=\s|\/?>))/g,
    (match, space: string, name: string, equal: string, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      if (name.toLowerCase() !== "src") return match;
      const target = resolve(decodeHTML(double ?? single ?? bare ?? ""));
      if (target === undefined) return match;
      const escaped = target.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      return `${space}${name}${equal}"${escaped}"`;
    }));
}
