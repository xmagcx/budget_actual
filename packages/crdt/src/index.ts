export {
  merkle,
  getClock,
  setClock,
  makeClock,
  makeClientId,
  serializeClock,
  deserializeClock,
  type Clock,
  Timestamp,
} from './crdt/index.js';

export {
  type EncryptedData,
  type Message,
  type MessageEnvelope,
  type SyncRequest,
  type SyncResponse,
  EncryptedDataSchema,
  MessageSchema,
  MessageEnvelopeSchema,
  SyncRequestSchema,
  SyncResponseSchema,
} from './proto/sync_pb.js';

export { create, fromBinary, toBinary } from '@bufbuild/protobuf';
