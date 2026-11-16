export interface ReaderPageRange { id?: string; blockId?: string; pageStart?: number | null; pageEnd?: number | null; }

/** Display-only physical PDF page provenance; never infer a missing page. */
export function markReaderSource(element: HTMLElement, sources: readonly ReaderPageRange[]): void {
  const ids = sources.flatMap(source => source.blockId ?? source.id ?? []);
  if (ids.length) element.dataset.sourceBlockIds = JSON.stringify([...new Set([...JSON.parse(element.dataset.sourceBlockIds ?? "[]") as string[], ...ids])]);
  const ranges = sources.filter(source => Number.isSafeInteger(source.pageStart) && source.pageStart! > 0);
  if (!ranges.length) return;
  const start = Math.min(...ranges.map(source => source.pageStart!));
  const end = Math.max(...ranges.map(source => Number.isSafeInteger(source.pageEnd) && source.pageEnd! >= source.pageStart! ? source.pageEnd! : source.pageStart!));
  element.dataset.sourcePageStart = String(Math.min(Number(element.dataset.sourcePageStart) || start, start));
  element.dataset.sourcePageEnd = String(Math.max(Number(element.dataset.sourcePageEnd) || end, end));
}
