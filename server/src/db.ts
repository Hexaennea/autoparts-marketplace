// PostgreSQL access layer.
//
// * One shared connection pool. Reads run on the pool; every write request runs inside one
//   transaction on a dedicated client (see http.ts), so a handler either fully commits or not at all.
// * SQL is written with `?` placeholders (converted to $1, $2 ... here) so queries stay readable.
//   Only parameterised queries are used anywhere in the codebase.
// * Type parsing: BIGINT / NUMERIC come back as JS numbers (money is integer paise, far below 2^53),
//   TIMESTAMPTZ comes back as an ISO-8601 UTC string ("2026-11-17T09:30:00+00:00").

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (SUM/AVG results)
pg.types.setTypeParser(1184, (v) => isoUtc(new Date(v))); // timestamptz
pg.types.setTypeParser(1114, (v) => isoUtc(new Date(`${v}Z`))); // timestamp (no tz) treated as UTC

export type Row = Record<string, any>;
export type Params = readonly unknown[];

export function isoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function utcnow(): string {
  return isoUtc(new Date());
}

/** Shift an ISO timestamp (or now) by a number of milliseconds. */
export function addMs(ms: number, from: string | Date = new Date()): string {
  return isoUtc(new Date(new Date(from).getTime() + ms));
}

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const DAY = 24 * HOUR;

/** Convert `?` placeholders to `$n`, skipping quoted strings and identifiers. */
export function toPg(sql: string): string {
  let out = "";
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

type Queryable = pg.Pool | pg.PoolClient;

export class Db {
  private depth = 0;

  constructor(
    readonly conn: Queryable,
    private readonly ownsTransaction = false,
  ) {}

  async query(sql: string, params: Params = []): Promise<pg.QueryResult> {
    return this.conn.query(toPg(sql), params as unknown[]);
  }

  async one<T extends Row = Row>(sql: string, params: Params = []): Promise<T | null> {
    const res = await this.query(sql, params);
    return (res.rows[0] as T | undefined) ?? null;
  }

  async all<T extends Row = Row>(sql: string, params: Params = []): Promise<T[]> {
    const res = await this.query(sql, params);
    return res.rows as T[];
  }

  async scalar<T = any>(sql: string, params: Params = []): Promise<T | null> {
    const res = await this.query(sql, params);
    const row = res.rows[0];
    if (!row) return null;
    const first = Object.keys(row)[0];
    return (first === undefined ? null : row[first]) as T | null;
  }

  /** Run a statement; returns the number of affected rows. */
  async execute(sql: string, params: Params = []): Promise<number> {
    const res = await this.query(sql, params);
    return res.rowCount ?? 0;
  }

  /** INSERT and return the new row's id. */
  async insert(sql: string, params: Params = []): Promise<number> {
    const text = /\breturning\b/i.test(sql) ? sql : `${sql} RETURNING id`;
    const res = await this.query(text, params);
    return Number(res.rows[0].id);
  }

  /**
   * Run `fn` in a transaction. When this Db already wraps a request transaction (writes),
   * nested calls join it. On the pool, a dedicated client is checked out for the duration.
   */
  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.ownsTransaction || this.depth > 0) {
      this.depth++;
      try {
        return await fn(this);
      } finally {
        this.depth--;
      }
    }
    if (!(this.conn instanceof pg.Pool)) {
      // A bare client without an outer transaction.
      await this.conn.query("BEGIN");
      this.depth = 1;
      try {
        const result = await fn(this);
        await this.conn.query("COMMIT");
        return result;
      } catch (err) {
        await this.conn.query("ROLLBACK");
        throw err;
      } finally {
        this.depth = 0;
      }
    }
    const client = await this.conn.connect();
    try {
      await client.query("BEGIN");
      const inner = new Db(client, true);
      const result = await fn(inner);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

export class Database {
  readonly pool: pg.Pool;

  constructor(readonly url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000 });
    this.pool.on("error", (err) => console.error("postgres pool error", err));
  }

  /** A Db for reads (each query may use a different pooled connection). */
  reader(): Db {
    return new Db(this.pool);
  }

  /** Run `fn` inside a single transaction on one dedicated connection. */
  async writer<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return new Db(this.pool).transaction(fn);
  }

  /** Run `fn` with one dedicated connection and no implicit transaction. */
  async withClient<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(new Db(client));
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<string[]> {
    const applied: string[] = [];
    await this.withClient(async (db) => {
      // Serialise concurrent migrators (several Cloud Run instances starting at once).
      await db.query("SELECT pg_advisory_lock(727274)");
      try {
        await db.query(
          "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
        );
        const done = new Set((await db.all("SELECT name FROM schema_migrations")).map((r) => r.name as string));
        const files = fs
          .readdirSync(MIGRATIONS_DIR)
          .filter((f) => f.endsWith(".sql"))
          .sort();
        for (const file of files) {
          if (done.has(file)) continue;
          const script = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
          await db.query("BEGIN");
          try {
            // Multi-statement simple query (no parameters), so `?` is never rewritten here.
            await db.conn.query(script);
            await db.conn.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
            await db.query("COMMIT");
          } catch (err) {
            await db.query("ROLLBACK");
            throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
          }
          applied.push(file);
        }
      } finally {
        await db.query("SELECT pg_advisory_unlock(727274)");
      }
    });
    return applied;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
