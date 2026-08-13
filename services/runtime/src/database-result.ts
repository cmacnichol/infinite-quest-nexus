type QueryRows<T> = Readonly<{ rows: readonly T[] }>;

export function loadOrNotFound<T>(result: QueryRows<T>, resource: string): T {
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error(`${resource} not found.`), { statusCode: 404 });
  return row;
}
