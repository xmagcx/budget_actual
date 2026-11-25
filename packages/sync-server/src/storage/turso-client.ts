import { createClient, type Client } from '@libsql/client';

type TursoRuntimeEnv = 'prd' | 'dev';

let client: Client | null = null;

function getTursoRuntimeEnv(): TursoRuntimeEnv {
  const env = (process.env.ACTUAL_TURSO_ENV || 'prd').toLowerCase();
  return env === 'dev' ? 'dev' : 'prd';
}

function getTursoConnection() {
  // Backward-compatible single connection variables
  if (process.env.ACTUAL_TURSO_URL) {
    return {
      url: process.env.ACTUAL_TURSO_URL,
      authToken: process.env.ACTUAL_TURSO_AUTH_TOKEN,
    };
  }

  // Environment-scoped variables
  const env = getTursoRuntimeEnv();
  const isDev = env === 'dev';

  const url = isDev
    ? process.env.ACTUAL_TURSO_DEV_URL
    : process.env.ACTUAL_TURSO_PRD_URL;
  const authToken = isDev
    ? process.env.ACTUAL_TURSO_DEV_AUTH_TOKEN
    : process.env.ACTUAL_TURSO_PRD_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      `Missing Turso URL for ACTUAL_TURSO_ENV=${env}. Set ACTUAL_TURSO_URL or ${isDev ? 'ACTUAL_TURSO_DEV_URL' : 'ACTUAL_TURSO_PRD_URL'}.`,
    );
  }

  return { url, authToken };
}

export function getTursoClient(): Client {
  if (client) {
    return client;
  }

  const { url, authToken } = getTursoConnection();

  client = createClient({
    url,
    authToken,
  });

  return client;
}

export function isTursoStorageEnabled(): boolean {
  return process.env.ACTUAL_STORAGE_BACKEND === 'turso';
}
