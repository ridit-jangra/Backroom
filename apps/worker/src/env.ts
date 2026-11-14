import type { WorkspaceHub } from './hub/WorkspaceHub';

export interface Env {
  HUB: DurableObjectNamespace<WorkspaceHub>;
  DB: D1Database;
  /** Blob storage (files, thumbnails, custom emoji): Workers KV, free without a payment card. */
  BLOBS: KVNamespace;
  /** Optional R2 alternative, used only when BLOBS is not bound (see lib/blobs.ts). */
  BUCKET?: R2Bucket;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  OWNER_EMAIL: string;
  APP_ORIGIN: string;
  EMAIL_FROM: string;
}
