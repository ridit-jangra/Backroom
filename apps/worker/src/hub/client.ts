import type { Env } from '../env';
import type { WorkspaceHub } from './WorkspaceHub';

/** One hub per workspace, keyed by workspace ID (never the slug). */
export function hubFor(env: Env, workspaceId: string): DurableObjectStub<WorkspaceHub> {
  return env.HUB.getByName(workspaceId);
}
