export type NumberingValue = number | string | Array<number | string> | null;
export interface Numbering {
  kind: string;
  value: NumberingValue;
  token: string;
  title: string;
  unit?: string;
  reason?: string;
  caseLower?: boolean;
  ambiguousLetter?: boolean;
  risky?: boolean;
}

/** Matching-only normalization. Original title text and provider data survive. */
export function normalizeHeadingNumbering(text: string): string {
  let value = text.normalize("NFKC").replace(/^\s*#{1,6}\s*/, "").replace(/[\u200b-\u200d\ufeff]/g, "").trim();
  const numeral = "零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟";
  value = value.replace(new RegExp(`^\\(\\s*([${numeral}]+|[0-9]+|[A-Za-z]+)\\s*\\)`), "($1)")
    .replace(new RegExp(`^([${numeral}]+)\\s+([、,.])`), "$1$2")
    .replace(/^(\d+)\s+\)/, "$1)")
    .replace(/^([A-Za-z]+)\s+([.)])/, "$1$2")
    .replace(/^(\d+(?:\s*\.\s*\d+)+)/, prefix => prefix.replace(/\s/g, ""))
    .replace(/^(\d+)\s+([、.])/, "$1$2")
    .replace(new RegExp(`^第\\s*([${numeral}0-9]+)\\s*(篇|部分|章|节|節|条|條|目)`), "第$1$2");
  return value;
}

const cn = "零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟";
const cnValue = (text: string): number => {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9 };
  const units: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000 };
  let sum = 0, digit = 0;
  for (const char of text) if (char in digits) digit = digits[char]; else { sum += (digit || 1) * units[char]; digit = 0; }
  return sum + digit;
};
const romanValue = (text: string): number | null => {
  if (!/^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/.test(text)) return null;
  const values: Record<string, number> = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  return [...text].reduce((sum, ch, i, chars) => sum + (values[ch] < (values[chars[i + 1]] || 0) ? -values[ch] : values[ch]), 0);
};
const result = (kind: string, value: NumberingValue, token: string, title: string, extra: Partial<Numbering> = {}): Numbering => ({ kind, value, token, title, ...extra });

export function tokenizeNumbering(original: string): Numbering | null {
  const text = normalizeHeadingNumbering(original); let m: RegExpExecArray | null;
  if (/^(?:table|tab\.?|figure|fig\.?|algorithm|panel|equation|图|表|算法)\s*[\dA-ZIVX]/i.test(text)) return result("nonsection", null, "", text, { reason: "caption-or-algorithm" });
  if (/^(?:H\d+[a-z]?\s*[:：]|假[说设]\s*\d+[a-z]?\s*[:：])/i.test(text)) return result("nonsection", null, "", text, { reason: "hypothesis" });
  if ((m = /^(?:appendix|appendices|annex|附录|附錄)\s*([IVXLCDM]+|[A-Z]|[一二三四五六七八九十]+|\d+)(?:[.:、\s]+|(?=[\u3400-\u9fff]))(.+)$/i.exec(text))) return result("appendix", m[1].toUpperCase(), m[1].toUpperCase(), m[2]);
  if ((m = /^(?:appendix|annex|附录|附錄)\s*([A-Z]|[一二三四五六七八九十]+|\d+)\s*$/i.exec(text))) return result("appendix", m[1].toUpperCase(), m[1].toUpperCase(), "");
  if ((m = new RegExp(`^第([${cn}0-9]+)(篇|部分|章|节|節|条|條|目)\\s*[、.:]?\\s*(.+)$`).exec(text))) return result("unit", /^\d+$/.test(m[1]) ? Number(m[1]) : cnValue(m[1]), m[1], m[3], { unit: m[2].replace("節", "节").replace("條", "条") });
  if ((m = /^(Part|Chapter|Section)\s+([IVXLCDM]+|\d+(?:\.\d+)*)(?:[.:\s]+)(.+)$/i.exec(text))) {
    const value = /^\d/.test(m[2]) ? m[2].split(".").map(Number) : [romanValue(m[2].toUpperCase())!];
    return result("english-unit", value, m[2], m[3], { unit: m[1].toLowerCase() });
  }
  if ((m = new RegExp(`^([${cn}]+)[、,．.]\\s*(.+)$`).exec(text))) return result("cn-major", cnValue(m[1]), m[1], m[2]);
  if ((m = new RegExp(`^\\(([${cn}]+)\\)\\s*(.+)$`).exec(text))) return result("cn-paren", cnValue(m[1]), m[1], m[2]);
  // Circled numerals are preserved as a separate ambiguous enumeration family.
  if ((m = /^([①-⑳❶-❿])\s*(.+)$/.exec(original.trim()))) return result("list-like", null, m[1], m[2], { reason: "circled-enumeration" });
  if ((m = /^\((\d+)\)\s*(.+)$/.exec(text))) return result("list-like", Number(m[1]), m[1], m[2], { reason: "parenthesized-enumeration" });
  if ((m = /^\(([A-Za-z]|[ivxlcdm]+)\)\s*(.+)$/.exec(text))) return result("list-like", m[1], m[1], m[2], { reason: "parenthesized-enumeration" });
  if ((m = /^([IVXLCDM]+\.[A-Z](?:\.\d+)*|[IVXLCDM]+(?:\.\d+)+)\.?\s+(.+)$/.exec(text))) return result("alpha-path", m[1].split("."), m[1], m[2]);
  if ((m = /^((?:[IVXLCDM]+\.)?[A-Z](?:\.\s*\d+)+)\.?\s+(.+)$/.exec(text))) return result("alpha-path", m[1].replace(/\s/g, "").split("."), m[1], m[2]);
  if ((m = /^([ivxlcdm]+)[.)]\s+(.+)$/.exec(text)) && romanValue(m[1].toUpperCase()) !== null) return result("roman", romanValue(m[1].toUpperCase()), m[1], m[2], { caseLower: true, ambiguousLetter: m[1].length === 1 });
  if ((m = /^([IVXLCDM]+)(?:\.\s*|\s+)(.+)$/.exec(text)) && romanValue(m[1]) !== null) return result("roman", romanValue(m[1]), m[1], m[2], { ambiguousLetter: m[1].length === 1 });
  if ((m = /^([A-Z])\.\s*(.+)$/.exec(text))) return result("alpha", m[1].charCodeAt(0) - 64, m[1], m[2]);
  if ((m = /^([a-z])[.)]\s*(.+)$/.exec(text))) return result("list-like", m[1], m[1], m[2], { reason: "lowercase-enumeration" });
  if ((m = /^(\d+)\)\s*(.+)$/.exec(text))) return result("list-like", Number(m[1]), m[1], m[2], { reason: "parenthesized-enumeration" });
  if ((m = /^§\s*(\d+(?:\s*\.\s*\d+)*)(?:\.?\s+|(?=[\u3400-\u9fff]))(.+)$/.exec(text))) return result("decimal", m[1].replace(/\s/g, "").split(".").map(Number), m[1], m[2]);
  if ((m = /^(\d+(?:\s*\.\s*\d+)*)\.[lIOo](?:\.|\s)(.+)$/.exec(text))) return result("list-like", null, m[1], m[2], { reason: "ambiguous-ocr-digit" });
  // Resolve a complete no-space CJK number path before a permissive dot
  // separator can backtrack and reinterpret its final component as prose.
  if ((m = /^(\d+(?:\s*\.\s*\d+)+)\s*(?=[\u3400-\u9fff])(.+)$/.exec(text))) return result("decimal", m[1].replace(/\s/g, "").split(".").map(Number), m[1], m[2]);
  if ((m = /^(\d+(?:\s*\.\s*\d+)*)(?:\.\s*|[、]\s*|\s+)(.+)$/.exec(text))) {
    const values = m[1].replace(/\s/g, "").split(".").map(Number);
    if (values[0] >= 1900 && values[0] <= 2100 || values.some(v => v > 999) || /^(?:%|percent\b|e[-+]\d)/i.test(m[2])) return result("nonsection", null, "", text, { reason: "date-or-measurement" });
    return result("decimal", values, m[1], m[2]);
  }
  if (/^\[\d+\]/.test(text)) return result("nonsection", null, "", text, { reason: "reference-entry" });
  return null;
}
