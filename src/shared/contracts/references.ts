export interface ReaderReference {
  id: string;
  number: number | null;
  order: number;
  markdown: string;
  blockIds: string[];
}
