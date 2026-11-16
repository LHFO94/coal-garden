import type { Env } from '../worker/env';
import { BenchmarkMine, BenchmarkMiner } from './synthetic-worker';
export { Mine } from '../worker/mine';
export { default } from '../worker/index';
export interface RecoveryEnv extends Env {
  RECOVERY_MINES: DurableObjectNamespace<RecoveryMine>;
  RECOVERY_MINERS: DurableObjectNamespace<RecoveryMiner>;
}
// Isolated namespaces keep authority tests non-live while recovery uses the actual Pi driver.
export class RecoveryMine extends BenchmarkMine {
  constructor(ctx: DurableObjectState, env: RecoveryEnv) { super(ctx, { ...env, MINES: env.RECOVERY_MINES, MINERS: env.RECOVERY_MINERS }); }
}
export class RecoveryMiner extends BenchmarkMiner {
  constructor(ctx: DurableObjectState, env: RecoveryEnv) { super(ctx, { ...env, MINES: env.RECOVERY_MINES, MINERS: env.RECOVERY_MINERS }); }
}
