// Minimal structural view of a pg pool/client: just the one `query` shape the
// device-flow code actually uses. Using this instead of `Pick<Pool, 'query'>`
// keeps the real Pool assignable while letting an in-memory fake satisfy the
// same contract in tests (pg's `query` is heavily overloaded and a narrow
// concrete signature isn't assignable to it).
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
