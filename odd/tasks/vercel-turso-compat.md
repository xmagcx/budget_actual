# Feature: Vercel + Turso compatibility
Status: in_progress
Scope: Full Turso backend compatibility for deploy on Vercel.

## Specs
1. S1 — "necesito que el actual proyecto que tenemos (https://github.com/xmagcx/budget_actual) lo podamos subir a vercel, por el import, tambien que sea compatible con turso."
2. S2 — "Turso completo" (incluyendo almacenamiento de grupos y blobs, no solo auth).

## Tasks
- T1 [S1,S2] Discover current storage/runtime coupling (Express runtime, sqlite files, blob files) and define minimal viable migration architecture. Commit: n/a (analysis)
- T2 [S1,S2] Define migration architecture/order for Vercel runtime + Turso full storage (account DB, group sync store, blob store, async DB API). Commit: n/a (design)
- T3 [S1,S2] Implement server runtime shape for Vercel (serverless entrypoint + config) without breaking local Node runtime. Commit: pending
- T4 [S1,S2] Implement Turso adapters for account/group/blob persistence and remove hard dependency on local sqlite/blob filesystem paths in sync path. Commit: pending
- T5 [S1,S2] Refactor sync-server data access from sync SQLite wrapper to async-compatible storage API. Commit: pending
- T6 [S1,S2] Add migration/config docs and env variables for Turso + Vercel deployment. Commit: pending
- T7 [S1,S2] Run focused tests/checks and report remaining gaps/risks. Commit: pending

## Architecture decisions
1. Runtime split
   - Keep Express app factory reusable for both Node process and Vercel handler.
   - Add Vercel API entrypoint that reuses same handlers; avoid local-only server boot in Vercel path.
2. Storage split
   - Replace direct `better-sqlite3` dependency path (`WrappedDatabase`) with async storage interface.
   - Implement `sqlite-local` adapter (current behavior) and `libsql-turso` adapter (new behavior).
3. Group sync persistence
   - Replace per-group sqlite files (`group-<id>.sqlite`) with logical group rows in Turso-backed tables.
   - Keep same sync contract (`since`, merkle, messages), only storage backend changes.
4. User blobs
   - Replace filesystem `file-<id>.blob` writes/reads with storage provider abstraction.
   - Start with DB-backed blob records in Turso for compatibility path.
5. Migration order
   - First runtime + abstraction scaffolding.
   - Then async DB call refactor.
   - Then Turso adapters + tests.

## Log
- L1 — "necesito que el actual proyecto que tenemos (https://github.com/xmagcx/budget_actual) lo podamos subir a vercel, por el import, tambien que sea compatible con turso."
- L2 — User decision: "Compatibilidad real con Turso".
- L3 — User decision: "Turso completo".
- L4 — User decision: "Refactor completo ahora".
- L5 — Discovery: `sync-server` currently relies on sync `better-sqlite3`, filesystem group sqlite files, and filesystem user blobs; this is incompatible with Vercel runtime constraints.
- L6 — Discovery: `.transaction()` and sync DB wrapper usage is spread across account/auth, sync endpoints, API keys, and user-service; async migration is mandatory for Turso compatibility.

