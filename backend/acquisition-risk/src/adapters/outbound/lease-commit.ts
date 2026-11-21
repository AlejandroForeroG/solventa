import { LeaseExpired } from '../../application/ports/lease';

type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: { live?: boolean }[] }> };

// Ends a transaction. When a lease applies, the database clock is read again right before COMMIT and everything is rolled back if the lease is over,
// so a lock wait or a later write cannot carry the commit past it. Without a lease it is a plain COMMIT.
export async function commitBeforeLease(db: Queryable, deadline: string | undefined): Promise<void> {
  if (deadline !== undefined) {
    const { rows } = await db.query('SELECT clock_timestamp() < $1::TIMESTAMPTZ AS live', [deadline]);
    if (!rows[0]?.live) {
      await db.query('ROLLBACK');
      throw new LeaseExpired();
    }
  }
  await db.query('COMMIT');
}
