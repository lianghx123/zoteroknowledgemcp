// Developer-driven Gecko layout checks; synthetic text, no library or provider writes.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";

const port = Number(process.env.ZOTERO_DEBUG_PORT ?? 5399);
const folder = path.resolve(".scaffold/citation-layout", `run-${Date.now()}`);
await fs.mkdir(folder, { recursive: true });
const state = JSON.parse(await evaluate("JSON.stringify({dir:Zotero.DataDirectory.dir,version:Zotero.version})", port));
if (!state.dir.replaceAll("\\", "/").includes("/.scaffold/")) throw Error("Isolated development Zotero required");
const probe = path.join(folder, "native-probe.js");
await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
import { CitationPreview } from "./src/ui/rendering/citation-preview.ts";
import { renderMarkdown } from "./src/ui/rendering/markdown.ts";
import styles from "./addon/content/ui/markdown-reader.css";
export async function run(folder) {
  const report = { runtime: Zotero.version, kind: "native Gecko DOM/layout; synthetic fixtures", checks: [], samples: [] };
  const check = (name, value) => { if (!value) throw Error(name); report.checks.push(name); };
  const main = Zotero.getMainWindow(), frame = main.document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
  const previews = [];
  try {
    frame.style.cssText = "position:fixed;left:-4000px;top:0;width:1400px;height:1200px";
    frame.src = "about:blank"; main.document.documentElement.append(frame);
    await new Promise(resolve => main.setTimeout(resolve, 200));
    const doc = frame.contentDocument, view = frame.contentWindow, style = doc.createElement("style");
    style.textContent = styles; doc.head.append(style);
    const references = "\\n\\n## References\\n\\n"
      + "[1] Baumeister, R., & Leary, M. (1997). A synthetic reference.\\n\\n"
      + "[2] Wong, G., Greenhalgh, T., Westhorp, G., Buckingham, J., & Pawson, R. (2013). A synthetic reference.\\n\\n"
      + "[3] Davis, J., Mengersen, K., Bennett, S., & Mazerolle, L. (2014). A synthetic reference.\\n\\n"
      + "[4] Liberati, A. (2009). A synthetic reference.\\n\\n"
      + "[5] Moher, D., Liberati, A., Tetzlaff, J., & Altman, D. (2009). A synthetic reference.\\n\\n"
      + "[6] Torraco, R. (2005). A synthetic reference.\\n\\n"
      + "[7] 张三、李四：《中文测试文献》，测试期刊，2022年第1期。";
    const fixtures = [
      "suggest different types of reviews, such as narrative or integrative reviews (e.g., Baumeister & Leary, 1997; Wong, Greenhalgh, Westhorp, Buckingham, & Pawson, 2013), systematic reviews, and meta-analysis (e.g., Davis, Mengersen, Bennett, & Mazerolle, 2014; Liberati et al., 2009; Moher, Liberati, Tetzlaff, & Altman, 2009) or integrative reviews (e.g., Torraco, 2005). There have also been some attempts to develop guidelines specifically for business or management research.",
      "Earlier **Baumeister & Leary** (1997) described a result [1–3], followed by another study <sup>[4]</sup> and a final conclusion.",
      "已有研究表明张三等（2022）支持这一结果。相关研究的作者标记应保持正文的自然换行、字距和原始内容，同时支持查看文献。"
    ];
    function article(text, width, size, alignment = "justify") {
      const node = doc.createElement("article"); node.className = "km-markdown-content";
      node.style.cssText = "position:absolute;top:0;left:0;flex:none;padding:0;width:" + width + "px;font-size:" + size + "px;text-align:" + alignment;
      node.append(renderMarkdown(doc, text + references, () => {}).fragment); doc.body.append(node); return node;
    }
    function positions(paragraph) {
      const origin = paragraph.getBoundingClientRect(), walker = doc.createTreeWalker(paragraph, 4), points = [];
      let node;
      while ((node = walker.nextNode())) for (let i = 0; i < node.length; i++) {
        const range = doc.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect(); points.push([r.left - origin.left, r.top - origin.top, r.width, r.height]);
      }
      return points;
    }
    const delta = (a, b) => a.length !== b.length ? Infinity : Math.max(0, ...a.flatMap((p, i) => p.map((v, j) => Math.abs(v - b[i][j]))));
    let reproduced = false;
    for (const [fixture, text] of fixtures.entries()) for (const width of [320, 560, 990]) for (const size of [15, 24]) for (const alignment of ["start", "justify"]) {
      const label = [fixture, width, size, alignment].join(",");
      const plain = article(text, width, size, alignment), original = positions(plain.querySelector("p"));
      const decorated = article(text, width, size, alignment), preview = new CitationPreview(decorated, () => {}); previews.push(preview);
      const triggers = [...decorated.querySelectorAll(".km-citation")];
      check("matched citations " + label, triggers.length > 0);
      const candidate = positions(decorated.querySelector("p")), maxDelta = delta(original, candidate);
      // Gecko can redistribute justified spaces at text-node boundaries; line
      // membership and unexpanded glyph geometry must still remain unchanged.
      const maxLineDelta = delta(original.map(p => [p[1], p[3]]), candidate.map(p => [p[1], p[3]]));
      check("unchanged line breaks and text height " + label, maxLineDelta < .1);
      if (alignment === "start") check("unchanged character geometry " + label, maxDelta < .1);
      const legacy = decorated.cloneNode(true); doc.body.append(legacy);
      for (const span of legacy.querySelectorAll(".km-citation")) {
        const button = doc.createElement("button"); button.className = "km-citation"; button.type = "button";
        button.append(...span.childNodes); span.replaceWith(button);
      }
      const buttonDelta = delta(original, positions(legacy.querySelector("p")));
      if (fixture === 0 && buttonDelta > 1) reproduced = true;
      report.samples.push({ fixture, width, size, alignment, citations: triggers.length, maxDelta, maxLineDelta, buttonDelta });
      triggers[0].focus({ preventScroll: true });
      triggers[0].dispatchEvent(new view.FocusEvent("focusin", { bubbles: true }));
      check("focus event opens preview " + label, !doc.querySelector(".km-citation-preview").hidden);
      triggers[0].dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      check("keyboard enters preview " + label, doc.activeElement.closest(".km-citation-preview"));
      doc.activeElement.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      check("escape restores citation focus " + label, doc.activeElement === triggers[0]);
      preview.dispose(); previews.pop();
      check("disposal preserves text " + label, decorated.textContent === plain.textContent && !decorated.querySelector(".km-citation"));
      plain.remove(); decorated.remove(); legacy.remove();
    }
    check("legacy buttons reproduce the reported layout change", reproduced);
    const capture = article(fixtures[0], 990, 24), preview = new CitationPreview(capture, () => {}); previews.push(preview);
    for (const node of [...capture.children].slice(1)) node.remove();
    doc.body.style.cssText = "margin:15px;background:white;color:#242424";
    const canvas = doc.createElement("canvas"); canvas.width = 1020; canvas.height = Math.ceil(capture.getBoundingClientRect().bottom + 15);
    canvas.getContext("2d").drawWindow(view, 0, 0, canvas.width, canvas.height, "white");
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), c => c.charCodeAt(0));
    await IOUtils.write(PathUtils.join(folder, "after.png"), bytes);
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = String(error); report.stack = error.stack; }
  finally { for (const preview of previews) preview.dispose(); frame.remove(); }
  await IOUtils.writeUTF8(PathUtils.join(folder, "report.json"), JSON.stringify(report, null, 2));
}` }, bundle: true, format: "iife", globalName: "CitationLayoutProbe", platform: "browser", target: "firefox140", loader: { ".css": "text" }, outfile: probe });
await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(probe).href)}); void CitationLayoutProbe.run(${JSON.stringify(folder)}).catch(error => Zotero.logError(error))`, port);
for (let i = 0; i < 150; i++) {
  let report;
  try { report = JSON.parse(await fs.readFile(path.join(folder, "report.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (report) {
    console.log(JSON.stringify({ ...report, checks: report.checks.length, folder }, null, 2));
    if (report.status !== "passed") process.exitCode = 1;
    break;
  }
  if (i === 149) throw Error("Native citation layout check timed out");
  await new Promise(resolve => setTimeout(resolve, 200));
}
