export interface ReferencePrefix {
  number: number;
  label: string;
  content: string;
}

const brackets: Record<string, string> = {
  "[": "]", "(": ")", "{": "}", "<": ">", "【": "】", "〔": "〕", "〖": "〗", "〘": "〙", "〚": "〛",
  "〈": "〉", "《": "》", "「": "」", "『": "』", "｟": "｠", "⟨": "⟩", "⟪": "⟫", "⦅": "⦆", "⦗": "⦘",
  "❨": "❩", "❪": "❫", "❬": "❭", "❮": "❯", "❰": "❱", "❲": "❳", "❴": "❵",
};
const bareSuffixes = new Set([".", "。", "、", ...Object.values(brackets)]);

/** Only call on bibliography content, never on arbitrary document paragraphs. */
export function referencePrefix(markdown: string, allowEmpty = false): ReferencePrefix | undefined {
  const match = /^\s*(\*\*|__|\*|_)?(?:([^\s0-9０-９])\s*([0-9０-９]{1,5})\s*([^\s0-9０-９])|([0-9０-９]{1,5})([^\s0-9０-９]))[.．。、:：]*\s*/u.exec(markdown);
  if (!match) return;
  if (match[2] ? brackets[match[2].normalize("NFKC")] !== match[4].normalize("NFKC") : !bareSuffixes.has(match[6].normalize("NFKC"))) return;
  const digits = (match[3] ?? match[5]).normalize("NFKC"), number = Number(digits);
  if (match[5] && (number >= 1800 && number <= 2199 || /^[0-9０-９]/u.test(markdown.slice(match[0].length)))) return;
  let content = markdown.slice(match[0].length);
  if (match[1]) {
    if (content.startsWith(match[1])) content = content.slice(match[1].length).trimStart();
    else content = match[1] + content;
  }
  content = content.replace(/^[.．。、:：]+\s*/u, "");
  if (!content.trim() && !allowEmpty) return;
  return { number, label: digits, content: content.trim() };
}

/** Frozen recognizer for comparing automatic projection-v1 records on upgrade. */
export function legacyReferencePrefix(markdown: string, allowEmpty = false): ReferencePrefix | undefined {
  const match = /^\s*(\*\*|__|\*|_)?(?:([\[［【（(])\s*([0-9０-９]{1,5})\s*([\]］】）)])|([0-9０-９]{1,5})[.．)、）])([.．、:：]*)(?:\s*)/u.exec(markdown);
  if (!match) return;
  const closing: Record<string, string> = { "[": "]", "［": "］", "【": "】", "（": "）", "(": ")" };
  if (match[2] && closing[match[2]] !== match[4]) return;
  const digits = (match[3] ?? match[5]).normalize("NFKC"), number = Number(digits);
  // A bare publication year or a decimal is not a citation label.
  if (match[5] && (number >= 1800 && number <= 2199 || /^[0-9０-９]/u.test(markdown.slice(match[0].length)))) return;
  let content = markdown.slice(match[0].length);
  if (match[1]) {
    if (content.startsWith(match[1])) content = content.slice(match[1].length).trimStart();
    else content = match[1] + content;
  }
  content = content.replace(/^[.．、:：]+\s*/u, "");
  if (!content.trim() && !allowEmpty) return;
  return { number, label: digits, content: content.trim() };
}

export const isReferenceType = (type: string): boolean => ["reference", "reference_entry", "bibliography"].includes(type);
