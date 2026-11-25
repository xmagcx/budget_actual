// @ts-strict-ignore
import { Buffer } from 'node:buffer';

import {
  create,
  fromBinary,
  SyncRequestSchema,
  SyncResponseSchema,
  toBinary,
} from '@actual-app/crdt';
import type { Request, Response } from 'express';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

import { getAccountDb, isAdmin } from './account-db';
import { FileNotFound } from './app-sync/errors';
import {
  File,
  FilesService,
  FileUpdate,
} from './app-sync/services/files-service';
import {
  validateSyncedFile,
  validateUploadedFile,
} from './app-sync/validation';
import { config } from './load-config';
import { SecretName, secretsService } from './services/secrets-service';
import * as UserService from './services/user-service';
import {
  errorMiddleware,
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares';
import { isValidFileId, isValidGroupId } from './util/paths';
import { getGroupSyncStore } from './storage/group-sync-store';
import { getUserBlobStore } from './storage/user-blob-store';
import type { GroupId } from './util/paths';
import { validateBudgetSession } from './util/validate-budget-session';

const app = express();
app.use(async (req, res, next) => {
  const supportsApiKey =
    (req.method === 'GET' &&
      [
        '/list-user-files',
        '/get-user-file-info',
        '/download-user-file',
      ].includes(req.path)) ||
    (req.method === 'POST' && ['/sync', '/user-get-key'].includes(req.path));
  if (!supportsApiKey) {
    return validateSessionMiddleware(req, res, next);
  }
  const session = await validateBudgetSession(req, res);
  if (session) {
    res.locals = session;
    next();
  }
});
app.use(errorMiddleware);
app.use(requestLoggerMiddleware);
app.use(
  express.raw({
    type: 'application/actual-sync',
    limit: `${config.get('upload.fileSizeSyncLimitMB')}mb`,
  }),
);
app.use(
  express.raw({
    type: 'application/encrypted-file',
    limit: `${config.get('upload.syncEncryptedFileSizeLimitMB')}mb`,
  }),
);
app.use(express.json({ limit: `${config.get('upload.fileSizeLimitMB')}mb` }));

export { app as handlers };

const OK_RESPONSE = { status: 'ok' };

function boolToInt(deleted: boolean) {
  return deleted ? 1 : 0;
}

function generateGroupId(): GroupId {
  const id = uuidv4();
  if (!isValidGroupId(id)) {
    throw new TypeError('UUID format no longer matches expected format');
  }
  return id;
}

function extractSingleHeader(
  req: Request,
  res: Response,
  key: string,
): string | null {
  const value = req.headers[key];
  if (!value) {
    return null;
  }
  if (typeof value !== 'string') {
    res.status(400).send('Duplicate headers encountered for key ' + key);
    return null;
  }
  return value;
}

const verifyFileExists = async (
  fileId: unknown,
  filesService: FilesService,
  res: Response,
  errorObject: string | Record<string, unknown>,
) => {
  if (res.locals.apiKeyFileIds && !res.locals.apiKeyFileIds.includes(fileId)) {
    res.status(403).send('file-access-not-allowed');
    return;
  }
  if (typeof fileId !== 'string' || !isValidFileId(fileId)) {
    res.status(400).send('invalid fileId');
    return;
  }

  try {
    return await filesService.get(fileId);
  } catch (e) {
    if (e instanceof FileNotFound) {
      //FIXME: error code should be 404. Need to make sure frontend is ok with it.
      //TODO: put this into a middleware that checks if FileNotFound is thrown and returns 404 and same error message
      // for every FileNotFound error
      res.status(400).send(errorObject);
      return;
    }
    throw e;
  }
};

function requireFileOwner(file: File, userId: string) {
  const isOwner = file.owner === userId;
  const isServerAdmin = isAdmin(userId);
  if (isOwner || isServerAdmin) {
    return null;
  }
  return 'file-access-not-allowed';
}

async function requireFileAccess(file: File, userId: string) {
  if (requireFileOwner(file, userId) === null) {
    return null;
  }
  if ((await UserService.countUserAccessAsync(file.id, userId)) > 0) {
    return null;
  }
  return 'file-access-not-allowed';
}

app.post('/sync', async (req, res): Promise<void> => {
  let requestPb;
  try {
    requestPb = fromBinary(SyncRequestSchema, req.body);
  } catch (e) {
    console.log('Error parsing sync request', e);
    res.status(500);
    res.send({ status: 'error', reason: 'internal-error' });
    return;
  }

  const fileId = requestPb.fileId || null;
  const groupId = requestPb.groupId || null;
  const keyId = requestPb.keyId || null;
  const since = requestPb.since || null;
  const messages = requestPb.messages;

  if (!since) {
    res.status(422).send({
      details: 'since-required',
      reason: 'unprocessable-entity',
      status: 'error',
    });
    return;
  }

  const filesService = new FilesService(getAccountDb());

  const currentFile = await verifyFileExists(
    fileId,
    filesService,
    res,
    'file-not-found',
  );

  if (!currentFile) {
    return;
  }

  const fileAccessError = await requireFileAccess(currentFile, res.locals.user_id);
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  const errorMessage = validateSyncedFile(groupId, keyId, currentFile);
  if (errorMessage) {
    res.status(400);
    res.send(errorMessage);
    return;
  }

  const result = await getGroupSyncStore().sync(messages, since, groupId);
  if (result.error) {
    res.status(400).send(result.error);
    return;
  }
  const { trie, newMessages } = result;

  const responsePb = create(SyncResponseSchema, {
    merkle: JSON.stringify(trie),
    messages: newMessages,
  });

  res.set('Content-Type', 'application/actual-sync');
  res.set('X-ACTUAL-SYNC-METHOD', 'simple');
  res.send(Buffer.from(toBinary(SyncResponseSchema, responsePb)));
});

app.post('/user-get-key', async (req, res) => {
  if (!res.locals) return;

  const { fileId } = req.body || {};

  const filesService = new FilesService(getAccountDb());
  const file = await verifyFileExists(
    fileId,
    filesService,
    res,
    'file-not-found',
  );

  if (!file) {
    return;
  }

  const fileAccessError = await requireFileAccess(file, res.locals.user_id);
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  res.send({
    status: 'ok',
    data: {
      id: file.encryptKeyId,
      salt: file.encryptSalt,
      test: file.encryptTest,
    },
  });
});

app.post('/user-create-key', async (req, res) => {
  const { fileId, keyId, keySalt, testContent } = req.body || {};

  const filesService = new FilesService(getAccountDb());
  const file = await verifyFileExists(
    fileId,
    filesService,
    res,
    'file-not-found',
  );

  if (!file) {
    return;
  }

  const fileAccessError = requireFileOwner(file, res.locals.user_id);
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  await filesService.update(
    file.id,
    new FileUpdate({
      encryptSalt: keySalt,
      encryptKeyId: keyId,
      encryptTest: testContent,
    }),
  );

  res.send(OK_RESPONSE);
});

app.post('/reset-user-file', async (req, res) => {
  const { fileId } = req.body || {};

  const filesService = new FilesService(getAccountDb());
  const file = await verifyFileExists(
    fileId,
    filesService,
    res,
    'User or file not found',
  );

  if (!file) {
    return;
  }

  const fileAccessError = requireFileOwner(file, res.locals.user_id);
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  const groupId = file.groupId;

  await filesService.update(file.id, new FileUpdate({ groupId: null }));

  if (groupId) {
    try {
      await getGroupSyncStore().reset(groupId);
    } catch {
      console.log(`Unable to delete sync data for group "${groupId}"`);
    }
  }

  res.send(OK_RESPONSE);
});

app.post('/upload-user-file', async (req, res) => {
  if (typeof req.headers['x-actual-name'] !== 'string') {
    // FIXME: Not sure how this cannot be a string when the header is
    // set.
    res.status(400).send('single x-actual-name is required');
    return;
  }

  const name = decodeURIComponent(req.headers['x-actual-name']);
  const fileId = req.headers['x-actual-file-id'];

  if (!fileId || typeof fileId !== 'string') {
    res.status(400).send('fileId is required');
    return;
  }
  if (!isValidFileId(fileId)) {
    res.status(400).send('invalid fileId');
    return;
  }

  const groupIdHeader = req.headers['x-actual-group-id'];
  const encryptMeta = extractSingleHeader(req, res, 'x-actual-encrypt-meta');
  if (res.headersSent) return;
  const syncFormatVersion = extractSingleHeader(req, res, 'x-actual-format');
  if (res.headersSent) return;

  let groupId: GroupId | null = null;
  if (groupIdHeader !== undefined) {
    if (typeof groupIdHeader !== 'string' || !isValidGroupId(groupIdHeader)) {
      res.status(400).send('invalid groupId');
      return;
    }
    groupId = groupIdHeader;
  }

  const keyId =
    encryptMeta && typeof encryptMeta === 'string'
      ? JSON.parse(encryptMeta).keyId
      : null;

  const filesService = new FilesService(getAccountDb());
  let currentFile;

  try {
    currentFile = await filesService.get(fileId);
  } catch (e) {
    if (e instanceof FileNotFound) {
      currentFile = null;
    } else {
      throw e;
    }
  }

  const fileAccessError = currentFile
    ? await requireFileAccess(currentFile, res.locals.user_id)
    : null;
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  const errorMessage = validateUploadedFile(groupId, keyId, currentFile);
  if (errorMessage) {
    res.status(400).send(errorMessage);
    return;
  }

  try {
    await getUserBlobStore().write(fileId, Buffer.from(req.body));
  } catch (err) {
    console.log('Error writing file', err);
    res.status(500).send({ status: 'error' });
    return;
  }

  if (!currentFile) {
    // it's new
    const newGroupId = generateGroupId();
    groupId = newGroupId;
    await filesService.set(
      new File({
        id: fileId,
        groupId: newGroupId,
        syncVersion: syncFormatVersion,
        name,
        encryptMeta,
        owner:
          res.locals.user_id ||
          (() => {
            throw new Error('User ID is required for file creation');
          })(),
      }),
    );

    res.send({ status: 'ok', groupId });
    return;
  }

  if (!groupId) {
    // sync state was reset, create new group
    const newGroupId = generateGroupId();
    groupId = newGroupId;
    await filesService.update(fileId, new FileUpdate({ groupId: newGroupId }));
  }

  // Regardless, update some properties
  await filesService.update(
    fileId,
    new FileUpdate({
      syncVersion: syncFormatVersion,
      encryptMeta,
      name,
    }),
  );

  res.send({ status: 'ok', groupId });
});

app.get('/download-user-file', async (req, res) => {
  const fileId = req.headers['x-actual-file-id'];
  if (typeof fileId !== 'string') {
    // FIXME: Not sure how this cannot be a string when the header is
    // set.
    res.status(400).send('Single file ID is required');
    return;
  }
  if (!isValidFileId(fileId)) {
    res.status(400).send('invalid fileId');
    return;
  }

  const filesService = new FilesService(getAccountDb());
  const file = await verifyFileExists(
    fileId,
    filesService,
    res,
    'User or file not found',
  );

  if (!file) {
    return;
  }

  const fileAccessError = await requireFileAccess(file, res.locals.user_id);
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  try {
    const blob = await getUserBlobStore().read(fileId);
    res.setHeader('Content-Disposition', `attachment;filename=${fileId}`);
    res.send(blob);
  } catch {
    res.status(404).send('file-not-found');
  }
});

app.post('/update-user-filename', async (req, res) => {
  const { fileId, name } = req.body || {};

  const filesService = new FilesService(getAccountDb());
  const file = await verifyFileExists(
    fileId,
    filesService,
    res,
    'file-not-found',
  );

  if (!file) {
    return;
  }

  const fileAccessError = await requireFileAccess(file, res.locals.user_id);
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  await filesService.update(file.id, new FileUpdate({ name }));
  res.send(OK_RESPONSE);
});

app.get('/list-user-files', async (_req, res) => {
  const fileService = new FilesService(getAccountDb());
  const rows = (await fileService.find({ userId: res.locals.user_id })).filter(
    row =>
      !res.locals.apiKeyFileIds || res.locals.apiKeyFileIds.includes(row.id),
  );
  res.send({
    status: 'ok',
    data: await Promise.all(
      rows.map(async row => ({
        deleted: boolToInt(row.deleted),
        fileId: row.id,
        groupId: row.groupId,
        name: row.name,
        encryptKeyId: row.encryptKeyId,
        owner: row.owner,
        usersWithAccess: (await fileService.findUsersWithAccess(row.id)).map(
          access => ({
            ...access,
            owner: access.userId === row.owner,
          }),
        ),
      })),
    ),
  });
});

app.get('/get-user-file-info', async (req, res) => {
  const fileId = req.headers['x-actual-file-id'];

  // TODO: Return 422 if fileId is not provided. Need to make sure frontend can handle it
  // if (!fileId) {
  //   return res.status(422).send({
  //     details: 'fileId-required',
  //     reason: 'unprocessable-entity',
  //     status: 'error',
  //   });
  // }

  const fileService = new FilesService(getAccountDb());

  const file = await verifyFileExists(fileId, fileService, res, {
    status: 'error',
    reason: 'file-not-found',
  });

  if (!file) {
    return;
  }

  const fileAccessError = await requireFileAccess(file, res.locals.user_id);
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  res.send({
    status: 'ok',
    data: {
      deleted: boolToInt(file.deleted), //   FIXME: convert to boolean, make sure it works in the frontend
      fileId: file.id,
      groupId: file.groupId,
      name: file.name,
      encryptMeta: file.encryptMeta ? JSON.parse(file.encryptMeta) : null,
      usersWithAccess: (await fileService.findUsersWithAccess(file.id)).map(
        access => ({
          ...access,
          owner: access.userId === file.owner,
        }),
      ),
    },
  });
});

app.post('/delete-user-file', async (req, res) => {
  const { fileId } = req.body || {};

  if (!fileId) {
    res.status(422).send({
      details: 'fileId-required',
      reason: 'unprocessable-entity',
      status: 'error',
    });
    return;
  }

  const accountDb = getAccountDb();
  const filesService = new FilesService(accountDb);
  const file = await verifyFileExists(
    fileId,
    filesService,
    res,
    'file-not-found',
  );
  if (!file) {
    return;
  }

  const fileAccessError = requireFileOwner(file, res.locals.user_id);
  if (fileAccessError) {
    res.status(403);
    res.send(fileAccessError);
    return;
  }

  accountDb.transaction(() => {
    void filesService.update(file.id, new FileUpdate({ deleted: true }));
    UserService.revokeApiKeysWithoutBudgetAccess();
    for (const name of Object.values(SecretName)) {
      secretsService.reset(name, file.id);
    }
  });

  res.send(OK_RESPONSE);
});
