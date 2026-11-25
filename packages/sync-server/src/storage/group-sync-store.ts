import fs from 'node:fs/promises';

import {
  create,
  merkle,
  MessageEnvelopeSchema,
  Timestamp,
} from '@actual-app/crdt';

import * as simpleSync from '../sync-simple';
import { getPathForGroupFile } from '#util/paths';
import type { GroupId } from '#util/paths';

import { getTursoClient, isTursoStorageEnabled } from './turso-client';

type SyncResult = ReturnType<typeof simpleSync.sync>;

type IncomingSyncMessage = {
  timestamp: string;
  isEncrypted: boolean;
  content: Uint8Array;
};

type GroupMessageRow = {
  timestamp: string;
  is_encrypted: number;
  content: Uint8Array | string | ArrayBuffer;
};

function normalizeGroupMessageRow(row: Record<string, unknown>): GroupMessageRow {
  const content = row.content;
  if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
    return {
      timestamp: String(row.timestamp),
      is_encrypted: Number(row.is_encrypted),
      content,
    };
  }

  return {
    timestamp: String(row.timestamp),
    is_encrypted: Number(row.is_encrypted),
    content: String(content ?? ''),
  };
}

// Matches the client's Timestamp maxDrift; later messages break sync on other devices
const MAX_FUTURE_DRIFT_MS = 5 * 60 * 1000;

export type GroupSyncStore = {
  sync(messages: unknown[], since: string, groupId: GroupId): Promise<SyncResult>;
  reset(groupId: GroupId): Promise<void>;
};

class LocalGroupSyncStore implements GroupSyncStore {
  async sync(messages: unknown[], since: string, groupId: GroupId): Promise<SyncResult> {
    return simpleSync.sync(messages, since, groupId);
  }

  async reset(groupId: GroupId): Promise<void> {
    try {
      await fs.unlink(getPathForGroupFile(groupId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

class TursoGroupSyncStore implements GroupSyncStore {
  private schemaReady: Promise<void> | null = null;

  private async ensureSchema() {
    if (!this.schemaReady) {
      const client = getTursoClient();
      this.schemaReady = (async () => {
        await client.execute(`
          CREATE TABLE IF NOT EXISTS group_messages_binary (
            group_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            is_encrypted INTEGER NOT NULL,
            content BLOB NOT NULL,
            PRIMARY KEY (group_id, timestamp)
          )
        `);

        await client.execute(`
          CREATE TABLE IF NOT EXISTS group_messages_merkles (
            group_id TEXT PRIMARY KEY,
            merkle TEXT NOT NULL
          )
        `);
      })();
    }

    await this.schemaReady;
  }

  async sync(messages: unknown[], since: string, groupId: GroupId): Promise<SyncResult> {
    await this.ensureSchema();

    const client = getTursoClient();

    const newMessagesResult = await client.execute({
      sql: `
        SELECT timestamp, is_encrypted, content
        FROM group_messages_binary
        WHERE group_id = ? AND timestamp > ?
        ORDER BY timestamp
      `,
      args: [groupId, since],
    });

    const currentMerkleResult = await client.execute({
      sql: 'SELECT merkle FROM group_messages_merkles WHERE group_id = ?',
      args: [groupId],
    });

    let trie = currentMerkleResult.rows[0]?.merkle
      ? JSON.parse(String(currentMerkleResult.rows[0].merkle))
      : {};

    for (const incoming of messages as IncomingSyncMessage[]) {
      const existingMessage = await client.execute({
        sql: `
          SELECT 1
          FROM group_messages_binary
          WHERE group_id = ? AND timestamp = ?
          LIMIT 1
        `,
        args: [groupId, incoming.timestamp],
      });

      // Preserve original behavior: a resent message already stored is accepted
      // even if its timestamp would now violate drift checks.
      if ((existingMessage.rows?.length || 0) > 0) {
        continue;
      }

      const parsedTimestamp = Timestamp.parse(incoming.timestamp);
      if (!parsedTimestamp) {
        return { error: 'invalid-timestamp' };
      }

      const error = this.getTimestampError(parsedTimestamp);
      if (error) {
        return { error };
      }

      const insertResult = await client.execute({
        sql: `
          INSERT OR IGNORE INTO group_messages_binary
            (group_id, timestamp, is_encrypted, content)
          VALUES (?, ?, ?, ?)
        `,
        args: [
          groupId,
          incoming.timestamp,
          incoming.isEncrypted ? 1 : 0,
          incoming.content,
        ],
      });

      if ((insertResult.rowsAffected || 0) > 0) {
        trie = merkle.insert(trie, parsedTimestamp);
      }
    }

    trie = merkle.prune(trie);

    await client.execute({
      sql: `
        INSERT INTO group_messages_merkles (group_id, merkle)
        VALUES (?, ?)
        ON CONFLICT(group_id) DO UPDATE SET merkle = excluded.merkle
      `,
      args: [groupId, JSON.stringify(trie)],
    });

    return {
      trie,
      newMessages: newMessagesResult.rows
        .map(row => normalizeGroupMessageRow(row as Record<string, unknown>))
        .map(row =>
          create(MessageEnvelopeSchema, {
            timestamp: String(row.timestamp),
            isEncrypted: Number(row.is_encrypted) === 1,
            content:
              row.content instanceof Uint8Array
                ? row.content
                : row.content instanceof ArrayBuffer
                  ? Buffer.from(row.content)
                  : Buffer.from(String(row.content)),
          }),
        ),
    };
  }

  async reset(groupId: GroupId): Promise<void> {
    await this.ensureSchema();

    await getTursoClient().batch(
      [
        {
          sql: 'DELETE FROM group_messages_binary WHERE group_id = ?',
          args: [groupId],
        },
        {
          sql: 'DELETE FROM group_messages_merkles WHERE group_id = ?',
          args: [groupId],
        },
      ],
      'write',
    );
  }

  private getTimestampError(timestamp: ReturnType<typeof Timestamp.parse>) {
    if (!timestamp) {
      return 'invalid-timestamp';
    }
    if (timestamp.millis() - Date.now() > MAX_FUTURE_DRIFT_MS) {
      return 'clock-drift';
    }
    return null;
  }
}

let groupSyncStore: GroupSyncStore | null = null;

export function getGroupSyncStore(): GroupSyncStore {
  if (groupSyncStore) {
    return groupSyncStore;
  }

  groupSyncStore = isTursoStorageEnabled()
    ? new TursoGroupSyncStore()
    : new LocalGroupSyncStore();

  return groupSyncStore;
}
