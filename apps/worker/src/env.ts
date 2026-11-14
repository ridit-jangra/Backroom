import type { WorkspaceHub } from './hub/WorkspaceHub';
import type { BlobStore } from './lib/blobs';

export interface Env {
  HUB: DurableObjectNamespace<WorkspaceHub>;
  DB: D1Database;
  /** Blob storage (files, thumbnails, custom emoji): Workers KV, free without a payment card. */
  BLOBS: KVNamespace;
  /** Optional R2 alternative, used only when BLOBS is not bound (see lib/blobs.ts). */
  BUCKET?: R2Bucket;
  /** A ready blob store injected by a non-Workers host (the Node server's filesystem store); wins over BLOBS/BUCKET. */
  BLOB_STORE?: BlobStore;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  OWNER_EMAIL: string;
  APP_ORIGIN: string;
  EMAIL_FROM: string;
  /** Optional overrides of the protocol constants (set by the Node server; unset on Workers). See lib/quota.ts. */
  FILES_QUOTA_BYTES?: number | string;
  FILE_MAX_BYTES?: number | string;
}
