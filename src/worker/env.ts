import type { Mine } from './mine';
import type { Miner } from './miner';
export interface Env {
  MINES: DurableObjectNamespace<Mine>;
  MINERS: DurableObjectNamespace<Miner>;
  AI: Ai;
  ASSETS: Fetcher;
}
