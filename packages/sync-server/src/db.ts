import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { Client, InStatement, InValue } from '@libsql/client';

type SqlParam = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;
type SqlInputParam = SqlParam | undefined;

type MutateResult = {
  changes: number;
  insertId: bigint | number | null;
};

export type AsyncDatabase = {
  all<Row = unknown>(sql: string, params?: SqlInputParam[]): Promise<Row[]>;
  first<Row = unknown>(sql: string, params?: SqlInputParam[]): Promise<Row | null>;
  mutate(sql: string, params?: SqlInputParam[]): Promise<MutateResult>;
  batchMutate(
    statements: { sql: string; params?: SqlInputParam[] }[],
  ): Promise<void>;
};

export class WrappedDatabase {
  private db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  all<Row = unknown>(sql: string, params: SqlInputParam[] = []): Row[] {
    const stmt = this.db.prepare<unknown[], Row>(sql);
    return stmt.all(...params);
  }

  first<Row = unknown>(sql: string, params: SqlInputParam[] = []): Row | null {
    const rows = this.all<Row>(sql, params);
    return rows.length === 0 ? null : rows[0];
  }

  exec(sql: string): SqliteDatabase {
    return this.db.exec(sql);
  }

  mutate(sql: string, params: SqlInputParam[] = []): MutateResult {
    const stmt = this.db.prepare(sql);
    const info = stmt.run(...params);
    return { changes: info.changes, insertId: info.lastInsertRowid };
  }

  transaction<Result>(fn: () => Result): Result {
    return this.db.transaction(fn)();
  }

  close() {
    this.db.close();
  }
}

class WrappedDatabaseAsyncAdapter implements AsyncDatabase {
  private db: WrappedDatabase;

  constructor(db: WrappedDatabase) {
    this.db = db;
  }

  async all<Row = unknown>(
    sql: string,
    params: SqlInputParam[] = [],
  ): Promise<Row[]> {
    return this.db.all<Row>(sql, params);
  }

  async first<Row = unknown>(
    sql: string,
    params: SqlInputParam[] = [],
  ): Promise<Row | null> {
    return this.db.first<Row>(sql, params);
  }

  async mutate(
    sql: string,
    params: SqlInputParam[] = [],
  ): Promise<MutateResult> {
    return this.db.mutate(sql, params);
  }

  async batchMutate(
    statements: { sql: string; params?: SqlInputParam[] }[],
  ): Promise<void> {
    this.db.transaction(() => {
      for (const statement of statements) {
        this.db.mutate(statement.sql, statement.params ?? []);
      }
    });
  }
}

function normalizeParams(params: SqlInputParam[] = []): InValue[] {
  return params.map(param => (param === undefined ? null : param));
}

class TursoDatabaseAdapter implements AsyncDatabase {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async all<Row = unknown>(
    sql: string,
    params: SqlInputParam[] = [],
  ): Promise<Row[]> {
    const result = await this.client.execute({
      sql,
      args: normalizeParams(params),
    });
    return result.rows.map(row => ({ ...row }) as Row);
  }

  async first<Row = unknown>(
    sql: string,
    params: SqlInputParam[] = [],
  ): Promise<Row | null> {
    const rows = await this.all<Row>(sql, params);
    return rows.length === 0 ? null : rows[0];
  }

  async mutate(
    sql: string,
    params: SqlInputParam[] = [],
  ): Promise<MutateResult> {
    const result = await this.client.execute({
      sql,
      args: normalizeParams(params),
    });
    return {
      changes: result.rowsAffected ?? 0,
      insertId: result.lastInsertRowid ?? null,
    };
  }

  async batchMutate(
    statements: { sql: string; params?: SqlInputParam[] }[],
  ): Promise<void> {
    const batchStatements: InStatement[] = statements.map(statement => ({
      sql: statement.sql,
      args: normalizeParams(statement.params ?? []),
    }));

    await this.client.batch(batchStatements, 'write');
  }
}

export function openDatabase(filename: string) {
  return new WrappedDatabase(new Database(filename));
}

export function wrapDatabaseAsync(db: WrappedDatabase): AsyncDatabase {
  return new WrappedDatabaseAsyncAdapter(db);
}

export function openTursoDatabase(client: Client): AsyncDatabase {
  return new TursoDatabaseAdapter(client);
}
