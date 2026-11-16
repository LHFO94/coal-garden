export type RunMode = 'paused' | 'running' | 'budget_paused' | 'quota_paused' | 'capacity_paused' | 'stopped';
export type MinerState = 'provisioning' | 'queued' | 'thinking' | 'walking' | 'mining' | 'idle' | 'paused' | 'error' | 'retired';
export type ResourceKind = 'coal' | 'diamond';
export type TileKind = 'floor' | 'rock' | ResourceKind;
export const RESOURCE_VALUES = { coal: 1, diamond: 10 } as const;
export const INVENTORY_CAPACITY = 3;
export const HOPPER = { x: 44, y: 28 } as const;
export type ToolName = 'walk_to' | 'mine' | 'deposit' | 'discover' | 'talk';
export type ToolError = 'INVALID_ARGUMENT' | 'STALE_GENERATION' | 'RUN_PAUSED' | 'RETIRED' | 'BUSY' | 'UNKNOWN_TILE' | 'BLOCKED' | 'UNREACHABLE' | 'TOO_FAR' | 'CLAIMED' | 'DEPLETED' | 'INVENTORY_FULL' | 'EMPTY_INVENTORY' | 'NO_SUCH_AGENT' | 'RATE_LIMITED' | 'NO_CHANGE';
export type NoticeReason = 'initialize' | 'world_changed' | 'action_completed' | 'control_changed' | 'grant_available';
export type ProviderMode = 'live' | 'synthetic';
export interface RuntimePolicy { providerMode: ProviderMode; defaultRPM: number; maxInFlight: number; reservationMicroUSD: number }
export const MODEL_ID = '@cf/qwen/qwen3.8-27b';
export const WORLD_WIDTH = 96;
export const WORLD_HEIGHT = 64;
export const ALLOWANCE_MICRO_USD = 5_000_000;
export const MAX_IN_FLIGHT = 32;
export const RESERVATION_MICRO_USD = 121_242;
export const VERSIONS = { app: '1.0.0', agents: '0.33.0', pi: '1.5.2', react: '19.2.7', vite: '8.1.6', typescript: '6.0.3', wrangler: '4.145.0', vitest: '4.1.11', workersPool: '0.19.1', workerd: '1.20261115.1' } as const;
export type JsonValue = null | boolean | number | string | number[] | string[] | Coordinate[];
export interface ToolArguments { x?: number; y?: number; audience?: 'mine' | 'agent'; agentId?: string; message?: string; at?: Coordinate }
export interface Coordinate { x: number; y: number }
export interface Inventory { coal: number; diamonds: number }
export interface Hopper extends Coordinate, Inventory {}
export interface Tile extends Coordinate { key: number; terrain: TileKind; visible: boolean; available: number; reserved: number; claimant?: string }
export interface MinerMemory { goal?: Coordinate; lastTools: { tool: ToolName; args: ToolArguments; result: ToolResult; at: number }[]; messageCursor: number }
export interface PublicMiner extends Coordinate {
  agentId: string; crewId: string; doId: string; state: MinerState; generation: number; retired: boolean;
  activeAction?: string; coal: number; diamonds: number; inventory: Inventory; lastAppliedRevision: number; lastContact: number;
  provisioned: boolean; error?: string; goal?: Coordinate; queuedAt?: number; inputTokens: number; outputTokens: number;
  realResponses: number; validatedTools: number; lastTools: MinerMemory['lastTools']; blocked?: boolean;
  messageCursor?: number; nextEligibleAt?: number;
}
export interface PhysicalAction {
  actionId: string; effectId: string; agentId: string; kind: 'walk_to' | 'mine'; generation: number;
  origin: Coordinate; path: Coordinate[]; target: Coordinate; quantity: number; startedAt: number; endsAt: number;
  resource?: ResourceKind;
  status: 'accepted' | 'completed' | 'cancelled'; result?: { position?: Coordinate; mined?: number; resource?: ResourceKind; cancelled?: boolean };
}
export interface RunRecord {
  runId: string; seed: number; mode: RunMode; revision: number; generation: number; createdAt: number; pausedAt?: number;
  runningSince?: number; elapsedRunningMs: number; initialCoal: number; minedCoal: number; availableCoal: number; reservedCoal: number;
  initialDiamonds: number; minedDiamonds: number; availableDiamonds: number; reservedDiamonds: number;
  hopper: Hopper;
  allowanceMicroUSD: number; observedMicroUSD: number; reservedMicroUSD: number; unknownMicroUSD: number;
  effectiveRPM: number; verifiedModelRPM?: number; maxInFlight: number; nextStartAt: number; exhausted: boolean;
  providerMode: ProviderMode; cause?: string; flushAt?: number; sweepAt?: number; nextAlarmAt?: number; nextAgentOrdinal: number;
}
export interface CoordinationMessage { sequence: number; sender: string; audience: 'mine' | 'agent'; agentId?: string; body: string; at?: Coordinate; revision: number; timestamp: number }
export interface RunSnapshot { runId: string; revision: number; serverTime: number; width: number; height: number; run: RunRecord; tiles: Tile[]; miners: PublicMiner[]; actions: PhysicalAction[]; messages: CoordinationMessage[] }
export type WorldChange = { kind: 'tile_upsert'; tile: Tile } | { kind: 'miner_upsert'; miner: PublicMiner } | { kind: 'action_upsert'; action: PhysicalAction } | { kind: 'message_append'; message: CoordinationMessage } | { kind: 'run_update'; run: RunRecord };
export interface WorldEvent { revision: number; timestamp: number; type: 'message' | 'action' | 'conflict' | 'error' | 'control' | 'inference' | 'observation' | 'discovery' | 'miner'; agentId?: string; summary: string; at?: Coordinate; detail?: Record<string, JsonValue>; changes: WorldChange[]; invalidation?: boolean }
export interface EventPage { events: WorldEvent[]; nextBefore?: number; oldestAvailableRevision: number }
export interface ResourceTarget extends Coordinate { resource: ResourceKind; unitValue: number; available: number; reserved: number; claimant?: string; destination: Coordinate; distance: number }
export interface Frontier extends Coordinate { distance: number }
export interface Observation {
  runId: string; revision: number; generation: number; mode: RunMode; exhausted: boolean; serverTime: number;
  self: PublicMiner; hopper: Hopper; action?: PhysicalAction; localTiles: Tile[]; resourceTargets: ResourceTarget[]; frontiers: Frontier[];
  nearbyMiners: PublicMiner[]; messages: CoordinationMessage[]; messageCursor: number; nextMessageCursor?: number;
  truncated: { localTiles: boolean; resourceTargets: boolean; frontiers: boolean; miners: boolean; messages: boolean };
}
export type ToolResult = ({ ok: true; revision: number; action?: PhysicalAction; acceptedAmount?: number; endpoint?: Coordinate; cells?: Tile[]; resourceTargets?: ResourceTarget[]; frontiers?: Frontier[]; sequence?: number; inventory?: Inventory; deposited?: Inventory; hopper?: Hopper } | { ok: false; code: ToolError | 'OPERATION_CONFLICT'; revision: number; claimant?: string; nearestFloor?: Coordinate; frontiers?: Frontier[]; retryAt?: number });
export interface ToolEnvelope { runId: string; agentId: string; generation: number; operationId: string; observedRevision: number; tool: ToolName; args: unknown }
export type OperatorCommand = { operationId: string } & ({ type: 'spawn'; count: number } | { type: 'pause' | 'resume' | 'stop' } | { type: 'retire' | 'retry_provisioning'; agentId: string } | { type: 'set_quota'; verifiedModelRPM: number; maxInFlight: number });
export interface CommandReceipt { ok: true; operationId: string; revision: number; mode: RunMode; crewId?: string; requested?: number }
export interface DecisionRequest { agentId: string; generation: number; burstId: string; eligibleAt?: number }
export interface DecisionQueueReceipt { status: 'queued' | 'paused' | 'retired' | 'exhausted'; mode: RunMode; generation: number }
export interface InferenceGrant { grantId: string; burstId: string; generation: number; expiresAt: number }
export interface InferenceClaim { runId: string; agentId: string; generation: number; burstId: string; grantId: string; invocationId: string }
export type InferenceClaimResult = { ok: true; claimedAt: number; expiresAt: number } | { ok: false; code: 'ADMISSION_REQUIRED'; mode: RunMode; generation: number };
export interface InferenceSettlement { invocationId: string; agentId: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; error?: string; status?: number; completedAt: number; durationMs?: number; outbound?: { model: string; reasoningEffort: string; maxTokens: number; noFallback: boolean; maxAttempts: number } }
export interface MinerNotice { runId: string; agentId: string; generation: number; revision: number; mode: RunMode; reasons: NoticeReason[]; grant?: InferenceGrant; retired?: boolean; exhausted?: boolean }
export interface MinerReport { agentId: string; generation: number; state?: MinerState; memory?: MinerMemory; observedRevision?: number; error?: string; durationMs?: number; tool?: ToolName; blocked?: boolean; settledBurst?: string; observation?: { revision: number; messageSequences: number[]; resourceTargets: Coordinate[] }; restart?: boolean }
export interface PublicTraceEntry { id: string; kind: 'input' | 'text' | 'tool_call' | 'tool_result' | 'status'; timestamp?: number; text?: string; tool?: string; args?: ToolArguments; result?: string; durationMs?: number; usage?: { input: number; output: number }; status?: string }
export interface PublicTranscriptPage { entries: PublicTraceEntry[]; nextCursor?: string; busy: boolean; operationId?: string; phase: string; memory: MinerMemory; blocked: boolean }
export interface HistogramSummary { count: number; p50: number | null; p95: number | null; p99: number | null; buckets: number[] }
export interface MetricBucket { second: number; calls: number; coal: number; diamonds: number; value: number; errors: number; toolRPCs: number; deliveryMs: number }
export interface MetricsSnapshot {
  runId: string; serverTime: number; providerMode: ProviderMode; model: string; seed: number; mode: RunMode; cause?: string;
  retained: number; provisioned: number; retired: number; agentsWithRealInference: number; agentsWithValidatedTools: number;
  states: Record<MinerState, number>; modelCallsPerMinute: number; modelCallsTotal: number; inFlight: number; unclaimed: number;
  effectiveRPM: number; verifiedModelRPM?: number; maxInFlight: number; coal: number; initialCoal: number; availableCoal: number; reservedCoal: number; coalPerMinute: number;
  diamonds: number; initialDiamonds: number; availableDiamonds: number; reservedDiamonds: number; value: number; valuePerMinute: number;
  inputTokens: number; outputTokens: number; observedMicroUSD: number; reservedMicroUSD: number; unknownMicroUSD: number; allowanceMicroUSD: number;
  deliveryBacklog: number; oldestDeliveryAgeMs: number; viewerLag: number; oldestViewerAckMs: number; viewerResyncs: number;
  receiptReplays: number; rejectedClaims: number; actionCancellations: number; restarts: number; invariantFailures: number;
  dueActions: number; oldestActionLatenessMs: number; sqlDatabaseSize: number; sqlRowsRead: number; sqlRowsWritten: number;
  worldRPC: HistogramSummary; queueWait: HistogramSummary; inferenceLatency: HistogramSummary; actionLateness: HistogramSummary; deliverySweep: HistogramSummary;
  errors: Record<string, number>; cumulative: Record<string, number>; buckets: MetricBucket[]; cpu: 'unavailable'; memory: 'unavailable';
}
export interface MeasurementExport { versions: typeof VERSIONS; limits: { allowanceMicroUSD: number; effectiveRPM: number; verifiedModelRPM?: number; maxInFlight: number; maxMiners: number }; snapshot: RunSnapshot; metrics: MetricsSnapshot; recordedAt: number; history: EventPage; caveats: string[] }
export interface MineRPC {
  initialize(input: { runId: string; seed: number }): Promise<RunSnapshot>;
  command(input: OperatorCommand): Promise<CommandReceipt>;
  observe(agentId: string): Promise<Observation>;
  applyTool(input: ToolEnvelope): Promise<ToolResult>;
  enqueueDecision(input: DecisionRequest): Promise<DecisionQueueReceipt>;
  claimInference(input: InferenceClaim): Promise<InferenceClaimResult>;
  settleInference(input: InferenceSettlement): Promise<void>;
  reportMiner(input: MinerReport): Promise<void>;
  getSnapshot(): Promise<RunSnapshot>;
  getMetrics(): Promise<MetricsSnapshot>;
  getEvents(input: { before?: number; limit: number }): Promise<EventPage>;
}
export interface MinerRPC { synchronize(input: MinerNotice): Promise<{ revision: number }>; inspect(input: { cursor?: string; limit: number }): Promise<PublicTranscriptPage> }
export interface DeltaFrame { type: 'delta'; runId: string; fromRevision: number; toRevision: number; serverTime: number; changes: WorldChange[] }
export type SnapshotRecord = { kind: 'run'; run: RunRecord; runId: string; serverTime: number; width: number; height: number } | { kind: 'tile'; tile: Tile } | { kind: 'miner'; miner: PublicMiner } | { kind: 'action'; action: PhysicalAction } | { kind: 'message'; message: CoordinationMessage };
export type ServerFrame = DeltaFrame | { type: 'invalidate'; runId: string; revision: number } | { type: 'snapshot_begin'; snapshotId: string; revision: number; partCount: number } | { type: 'snapshot_part'; snapshotId: string; index: number; payload: SnapshotRecord[] } | { type: 'snapshot_end'; snapshotId: string };
// Durable Object RPC preserves Error.message, not custom prototypes or properties.
export class PublicError extends Error { constructor(public code: string, message: string, public status = 400, public operationId?: string) { super(`${code}: ${message}`); this.name = 'PublicError'; } }
