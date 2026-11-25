import fs from 'node:fs/promises';

import { atomicWriteFile } from '#util/atomic-write';
import { getPathForUserFile } from '#util/paths';
import type { FileId } from '#util/paths';

import { getTursoClient, isTursoStorageEnabled } from './turso-client';

export type UserBlobStore = {
  write(fileId: FileId, content: Buffer): Promise<void>;
  read(fileId: FileId): Promise<Buffer>;
  delete(fileId: FileId): Promise<void>;
};

class LocalUserBlobStore implements UserBlobStore {
  async write(fileId: FileId, content: Buffer) {
    await atomicWriteFile(getPathForUserFile(fileId), content);
  }

  async read(fileId: FileId) {
    return await fs.readFile(getPathForUserFile(fileId));
  }

  async delete(fileId: FileId) {
    await fs.unlink(getPathForUserFile(fileId));
  }
}

class TursoUserBlobStore implements UserBlobStore {
  private schemaReady: Promise<void> | null = null;

  private async ensureSchema() {
    if (!this.schemaReady) {
      const client = getTursoClient();
      this.schemaReady = client
        .execute(`
          CREATE TABLE IF NOT EXISTS user_blobs (
            file_id TEXT PRIMARY KEY,
            content BLOB NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        .then(() => undefined);
    }

    await this.schemaReady;
  }

  async write(fileId: FileId, content: Buffer) {
    await this.ensureSchema();

    await getTursoClient().execute({
      sql: `
        INSERT INTO user_blobs (file_id, content, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET
          content = excluded.content,
          updated_at = excluded.updated_at
      `,
      args: [fileId, content, Date.now()],
    });
  }

  async read(fileId: FileId) {
    await this.ensureSchema();

    const result = await getTursoClient().execute({
      sql: 'SELECT content FROM user_blobs WHERE file_id = ?',
      args: [fileId],
    });

    const content = result.rows[0]?.content;
    if (!content) {
      throw new Error('file-not-found');
    }

    if (content instanceof Uint8Array) {
      return Buffer.from(content);
    }

    if (content instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(content));
    }

    return Buffer.from(String(content));
  }

  async delete(fileId: FileId) {
    await this.ensureSchema();

    await getTursoClient().execute({
      sql: 'DELETE FROM user_blobs WHERE file_id = ?',
      args: [fileId],
    });
  }
}

let userBlobStore: UserBlobStore | null = null;

export function getUserBlobStore(): UserBlobStore {
  if (userBlobStore) {
    return userBlobStore;
  }

  userBlobStore = isTursoStorageEnabled()
    ? new TursoUserBlobStore()
    : new LocalUserBlobStore();

  return userBlobStore;
}
