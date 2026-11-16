// Repository operations bind at most four values per element plus a few fixed
// predicates/SET values. 200 elements leave room below SQLite's older 999 limit.
export const DATABASE_BATCH_SIZE = 200;

/** Keep every batch on the caller's context/transaction; do not start or commit one. */
export async function forEachBatch<T>(values: readonly T[], execute: (batch: T[], offset: number) => Promise<unknown>): Promise<void> {
  for (let offset = 0; offset < values.length; offset += DATABASE_BATCH_SIZE) {
    await execute(values.slice(offset, offset + DATABASE_BATCH_SIZE), offset);
  }
}

/** ID predicates have set semantics, including when duplicates span batches. */
export async function queryInBatches<T, R>(values: readonly T[], execute: (batch: T[]) => Promise<readonly R[]>): Promise<R[]> {
  const rows: R[] = [];
  await forEachBatch([...new Set(values)], async batch => {
    for (const row of await execute(batch)) rows.push(row);
  });
  return rows;
}
