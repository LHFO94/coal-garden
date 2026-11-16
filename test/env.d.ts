/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { RecoveryEnv } from '../src/testing/test-worker';
declare global { namespace Cloudflare { interface Env extends RecoveryEnv {} } }
