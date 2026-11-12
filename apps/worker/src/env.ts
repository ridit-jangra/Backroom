import type { WorkspaceHub } from './hub/WorkspaceHub';

export interface Env {
  HUB: DurableObjectNamespace<WorkspaceHub>;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  OWNER_EMAIL: string;
  APP_ORIGIN: string;
  EMAIL_FROM: string;
}
