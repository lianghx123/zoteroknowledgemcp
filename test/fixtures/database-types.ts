import type { Selectable } from "kysely";
import type { Database } from "../../src/database/types";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

// Independently assert the public numeric contract, including SQL NULL.
export type ConfidenceTypes = [
  Assert<Equal<Selectable<Database["content_blocks"]>["confidence"], number | null>>,
  Assert<Equal<Selectable<Database["resource_annotations"]>["confidence"], number | null>>,
  Assert<Equal<Selectable<Database["resource_references"]>["confidence"], number | null>>,
  Assert<Equal<Selectable<Database["structure_nodes"]>["confidence"], number | null>>,
];
