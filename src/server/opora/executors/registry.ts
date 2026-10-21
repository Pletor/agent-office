import { ExecutorUnavailable, type ExecutorRequirements, type RemoteExecutor } from './types.js';

/** Explicit capability selection. A missing remote executor never selects a host CLI instead. */
export class ExecutorRegistry {
  private executors = new Map<string, RemoteExecutor>();
  register(executor: RemoteExecutor) {
    if (this.executors.has(executor.provider)) throw new ExecutorUnavailable();
    this.executors.set(executor.provider, executor);
    return () => { if (this.executors.get(executor.provider) === executor) this.executors.delete(executor.provider); };
  }
  async require(provider: string, requirements: ExecutorRequirements): Promise<RemoteExecutor> {
    const executor = this.executors.get(provider);
    if (!executor || !await executor.available(requirements)) throw new ExecutorUnavailable();
    return executor;
  }
}
