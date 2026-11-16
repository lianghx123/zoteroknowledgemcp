/** Read-only evidence produced by the existing PDF reader, scoped to one file. */
export interface NativeCitationHint {
  page: number;
  text: string;
  before: string;
  after: string;
  references: string[];
}
