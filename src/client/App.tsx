import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { Coordinate, MeasurementExport, MetricsSnapshot, PublicMiner, PublicTraceEntry, PublicTranscriptPage, RunSnapshot, WorldEvent } from '../shared/protocol';
import { HOPPER, INVENTORY_CAPACITY, MAX_IN_FLIGHT, RESOURCE_VALUES } from '../shared/protocol';
import { mineStore, request, type CommandInput } from './store';
import { WorldRenderer } from './world-renderer';
import './styles.css';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 });
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const modeLabels = { paused: 'Paused', running: 'Running', budget_paused: 'Inference allowance reached', quota_paused: 'Quota paused', capacity_paused: 'Mine overloaded', stopped: 'Stopped' };
const stateGlyphs = { provisioning: '◇', queued: '◷', thinking: '◉', walking: '→', mining: '⚒', idle: '·', paused: 'Ⅱ', error: '!', retired: '×' };
const money = (value: number) => usd.format(value / 1_000_000);
const elapsed = (value?: number) => value === undefined ? 'Unavailable' : value < 1000 ? `${Math.round(value)} ms` : `${number.format(value / 1000)} s`;
const time = (value?: number) => value ? clock.format(value) : 'Not yet';
const position = (value?: Coordinate) => value ? `${value.x}, ${value.y}` : 'None';
const recordedNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? number.format(value) : 'Unavailable';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Request failed.';
const carried = (miner: PublicMiner) => miner.inventory ? `${miner.inventory.coal + miner.inventory.diamonds}/${INVENTORY_CAPACITY}` : `—/${INVENTORY_CAPACITY}`;

function InventoryReadout({ miner }: { miner: PublicMiner }) {
  return <><span className="inventory-slots">Carried {carried(miner)}</span><small>{miner.inventory ? `${miner.inventory.coal} coal · ${miner.inventory.diamonds} diamonds` : 'Awaiting fresh inventory'}</small></>;
}

type Tab = 'Crew' | 'Agent' | 'Feed' | 'Metrics';
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); close(); }}><div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={close}>×</button></div>{children}</dialog>;
}
function Instrument({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return <div className="instrument"><span className="eyebrow">{label}</span><strong>{children}</strong>{note && <small>{note}</small>}</div>;
}
function Blueprint() {
  return <div className="blueprint" aria-label="Static blueprint of a mine, not live data"><svg viewBox="0 0 900 600" role="img" aria-label="Conceptual mine corridors, no live miners"><defs><pattern id="blueprint-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="currentColor" strokeWidth=".5" /></pattern></defs><rect width="900" height="600" fill="url(#blueprint-grid)"/><g fill="none" stroke="currentColor"><path d="M0 156H900M0 348H900M156 0V600M348 0V600M540 0V600M732 0V600" strokeWidth="64" opacity=".1"/><path d="M0 124H900M0 188H900M0 316H900M0 380H900M124 0V600M188 0V600M316 0V600M380 0V600M508 0V600M572 0V600M700 0V600M764 0V600" strokeDasharray="3 5"/><path d="M212 220H292V292H212ZM404 412H484V484H404ZM596 220H676V292H596Z" strokeWidth="2"/><path d="M144 156H360V348H552" strokeWidth="2" strokeDasharray="8 8"/><circle cx="156" cy="156" r="12"/><path d="M144 156H168M156 144V168"/><path d="M32 548H224M32 540V556M224 540V556"/></g><g fill="currentColor" fontFamily="monospace" fontSize="12"><text x="32" y="46">CG—01 / WORLD BLUEPRINT</text><text x="32" y="570">96 × 64 TILES / 16 PX</text><text x="224" y="250">SEAM</text><text x="416" y="442">SEAM</text><text x="608" y="250">SEAM</text><text x="178" y="145">SPAWN 04:04</text><text x="670" y="570">NOT LIVE DATA</text></g></svg><div className="blueprint-stamp"><span className="eyebrow">Awaiting initialization</span><h2>A small mine.<br/>Independent minds.</h2><p>One shared world. Durable agents.<br/>Every pickaxe starts with a real decision.</p><span className="blueprint-label">STATIC BLUEPRINT / NO LIVE DATA</span></div></div>;
}

export default function App() {
  const state = useSyncExternalStore(mineStore.subscribe, mineStore.getState);
  const [runId, setRunId] = useState(() => new URL(location.href).searchParams.get('run') ?? '');
  const [online, setOnline] = useState(navigator.onLine);
  const [seed, setSeed] = useState('42');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [follow, setFollow] = useState(false);
  const [tab, setTab] = useState<Tab>('Crew');
  const [rosterOpen, setRosterOpen] = useState(() => window.matchMedia('(max-width: 899px)').matches);
  const [spawnCount, setSpawnCount] = useState<number>();
  const [confirmation, setConfirmation] = useState<'stop' | 'new'>();
  const [recovery, setRecovery] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [viewMetrics, setViewMetrics] = useState(false);
  const [fps, setFPS] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const createOperation = useRef<{ runId: string; operationId: string; seed: number } | undefined>(undefined);
  const recoveryPaused = useRef(false);
  const snapshot = state.snapshot?.runId === runId ? state.snapshot : undefined;
  const run = snapshot?.run;
  const metrics = state.metrics?.runId === runId ? state.metrics : undefined;
  const live = state.connection === 'Live' && online;
  const selectedMiner = snapshot?.miners.find(miner => miner.agentId === selected);
  const active = !!run && run.mode !== 'stopped';
  const spent = run ? run.observedMicroUSD + run.reservedMicroUSD + run.unknownMicroUSD : 0;
  useEffect(() => {
    if (runId) mineStore.start(runId);
    recoveryPaused.current = false; setRecoveryError('');
    return () => mineStore.stop();
  }, [runId]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    const pop = () => { setRunId(new URL(location.href).searchParams.get('run') ?? ''); setSelected(undefined); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (!active || run?.mode !== 'running') return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [active, run?.mode]);
  useEffect(() => {
    if (!canvas.current || !snapshot) return;
    const world = new WorldRenderer(canvas.current, agentId => { setSelected(agentId); if (agentId) setTab('Agent'); }); renderer.current = world;
    const unsubscribe = mineStore.subscribeWorld((next, connected) => world.setSnapshot(next, connected));
    const timer = window.setInterval(() => { setFPS(Math.round(world.fps)); setFollow(world.isFollowing); }, 1000);
    return () => { clearInterval(timer); unsubscribe(); world.destroy(); renderer.current = null; };
  }, [!!snapshot, runId]);
  useEffect(() => { renderer.current?.select(selected); }, [selected, !!snapshot]);
  useEffect(() => { renderer.current?.follow(follow); }, [follow, !!snapshot]);
  const chooseMiner = (agentId: string) => { setSelected(agentId); setTab('Agent'); requestAnimationFrame(() => document.getElementById('agent-inspector')?.focus()); };
  const command = (key: string, input: CommandInput) => { void mineStore.command(key, input).catch(() => undefined); };
  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    if (creating || !online) return;
    setCreating(true); setCreateError('');
    try {
      let input = createOperation.current;
      try { const saved = sessionStorage.getItem('coal-garden:create'); if (!input && saved) input = JSON.parse(saved); } catch { /* Browser storage can be unavailable. */ }
      const value = Number(seed);
      if (!input) {
        if (!Number.isInteger(value) || value < 0 || value > 4294967295) throw new Error('Seed must be an unsigned 32-bit integer.');
        input = { runId: crypto.randomUUID(), operationId: crypto.randomUUID(), seed: value };
        try { sessionStorage.setItem('coal-garden:create', JSON.stringify(input)); } catch { /* Retry identity is also retained in the current form. */ }
      }
      createOperation.current = input;
      const created = await request<RunSnapshot>('/api/runs', { method: 'POST', body: JSON.stringify(input) });
      try { sessionStorage.removeItem('coal-garden:create'); } catch { /* Storage is optional. */ }
      createOperation.current = undefined;
      const url = new URL(location.href); url.searchParams.set('run', created.runId); history.pushState({}, '', url);
      setRunId(created.runId); setSelected(undefined); setFollow(false); setConfirmation(undefined); setViewMetrics(false); setTab('Crew');
    } catch (error) { setCreateError(`${errorMessage(error)} Retry uses the original run and command IDs.`); }
    finally { setCreating(false); }
  };
  const recover = async () => {
    if (recovery) return;
    setRecovery(true); setRecoveryError('');
    const key = `coal-garden:recovery:${runId}`;
    try {
      let paused = recoveryPaused.current; try { paused ||= sessionStorage.getItem(key) === 'paused'; } catch { /* The in-memory phase remains authoritative. */ }
      if (!paused) { await mineStore.command('recover-pause', { type: 'pause' }); recoveryPaused.current = true; try { sessionStorage.setItem(key, 'paused'); } catch { /* No persistent storage. */ } }
      await mineStore.command('recover-resume', { type: 'resume' }); recoveryPaused.current = false; try { sessionStorage.removeItem(key); } catch { /* No persistent storage. */ }
    } catch (error) { setRecoveryError(errorMessage(error)); }
    finally { setRecovery(false); }
  };
  const exportRun = async () => {
    setExporting(true); setExportError('');
    try {
      const data = await request<MeasurementExport>(`/api/runs/${runId}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `coal-garden-${runId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setExportError(errorMessage(error)); }
    finally { setExporting(false); }
  };
  return <div className="application">
    <a href="#main-content" className="skip-link">Skip to mine controls</a>
    <header className="masthead"><div className="brand"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M4 9H28V15H4ZM9 4H23V9H9ZM8 19H24V27H8Z"/><path d="M14 10H19V14H14Z" className="lamp"/></svg></span><div><h1>COAL GARDEN</h1><p>PI DURABLE / LIVE AGENT MINE</p></div></div><div className={`run-status ${run?.mode ?? ''}`} role="status" aria-live="polite"><span className="status-dot"/>{run ? modeLabels[run.mode] : 'No mine initialized'}</div><div className="header-actions">{run && run.mode !== 'stopped' && <button className={run.mode === 'running' ? '' : 'primary'} disabled={!live || !!state.pending.control || run.exhausted || run.mode === 'budget_paused' || run.mode === 'capacity_paused' || state.overloaded} onClick={() => command('control', { type: run.mode === 'running' ? 'pause' : 'resume' })}>{state.pending.control ? 'Sending…' : run.mode === 'running' ? 'Ⅱ Pause' : run.elapsedRunningMs === 0 ? '▶ Start' : '▶ Resume'}</button>}<button className="accent-outline" disabled={creating || (!!runId && !run && !state.notFound) || (!!run && !live)} onClick={() => { if (active) setConfirmation('new'); else if (run) void create(); else if (state.notFound) { const url = new URL(location.href); url.searchParams.delete('run'); history.pushState({}, '', url); setRunId(''); } else document.getElementById('seed')?.focus(); }}>New run <span aria-hidden="true">↗</span></button></div></header>
    <div className="announcement sr-only" role="status" aria-live="polite">{state.announcement}</div>
    {run?.providerMode === 'synthetic' && <div className="synthetic-banner">SYNTHETIC / NO MODEL INFERENCE <span>Infrastructure exercise — not Qwen evidence</span></div>}
    {!runId ? <main id="main-content" className="first-load" tabIndex={-1}><Blueprint/><section className="initialization"><span className="eyebrow">Operator station / 01</span><h2>Open the garden.</h2><p>Give a crew of independent Qwen agents a shared coal mine. Watch them explore, coordinate, and extract — one durable tool call at a time.</p><div className="initial-facts"><span><b>96 × 64</b>seeded world</span><span><b>QWEN 3.8</b>27B / fixed model</span><span><b>$5.00</b>inference allowance</span></div><form onSubmit={create}><label htmlFor="seed">World seed <small>Unsigned 32-bit integer</small></label><input id="seed" inputMode="numeric" type="number" min="0" max="4294967295" step="1" value={seed} disabled={creating || !!createError} onChange={event => setSeed(event.target.value)} required/><button className="primary create-button" disabled={creating || !online}>{creating ? 'Creating mine…' : createError ? 'Retry create mine ↗' : 'Create mine ↗'}</button>{createError && <p role="alert" className="error-text">{createError}</p>}</form><p className="fine-print">Starts paused. No agents and no model calls until you provision a crew and start the run. The run URL is shareable, not an authentication secret.</p><div className="initial-footer"><span className="status-dot"/> AUTHORITATIVE WORLD / DURABLE EXECUTION</div></section></main> : <>
      <section className="metric-strip" aria-label="Live mine instruments"><Instrument label="Miners / thinking / queued" note={metrics ? `${metrics.provisioned} provisioned · ${metrics.retired} retired` : 'Awaiting measured counters'}>{metrics ? `${metrics.retained} / ${metrics.states.thinking} / ${metrics.states.queued}` : '— / — / —'}</Instrument><Instrument label="Resource points / min" note={run ? `${number.format(run.minedCoal)} coal · ${number.format(run.minedDiamonds)} diamonds · ${number.format(run.minedCoal * RESOURCE_VALUES.coal + run.minedDiamonds * RESOURCE_VALUES.diamond)} points` : undefined}>{metrics ? number.format(metrics.valuePerMinute) : '—'}</Instrument><Instrument label="World RPC p95" note="Miner-observed tool latency">{metrics?.worldRPC.p95 != null ? elapsed(metrics.worldRPC.p95) : '—'}</Instrument><Instrument label="Inference allowance" note={run ? `${money(run.allowanceMicroUSD)} cap · observed + reserved + unknown` : undefined}>{run ? `${money(spent)} / ${money(run.allowanceMicroUSD)}` : '—'}</Instrument></section>
      {(state.error || state.commandErrors.control) && <div className="notice error-notice" role="alert">{state.error ?? state.commandErrors.control}{!snapshot && <button onClick={() => mineStore.retryConnection()}>Reconnect</button>}</div>}
      {run && (run.mode.endsWith('_paused') || state.overloaded || run.exhausted || !!recoveryError) && <section className="cause-strip" role="status"><div><strong>{state.overloaded ? 'Mine overloaded' : recoveryError ? 'Recovery acknowledgment pending' : run.exhausted ? 'Mine exhausted' : modeLabels[run.mode]}</strong><p>{run.exhausted ? 'No reachable resources or accessible frontier remains. Miners are idle; no further paid decisions.' : `Cause: ${run.cause ?? run.mode}. ${money(run.observedMicroUSD)} observed · ${money(run.unknownMicroUSD)} unknown liabilities · ${metrics?.states.queued ?? '—'} queued miners.`}</p></div>{(state.overloaded || run.mode === 'capacity_paused' || !!recoveryError) ? <button className="primary" disabled={!live || recovery} onClick={() => void recover()}>{recovery ? 'Recovering…' : recoveryError ? 'Retry Recover' : 'Recover'}</button> : (run.mode === 'budget_paused' || run.exhausted) ? <button className="accent-outline" disabled={!live} onClick={() => setConfirmation('new')}>New run ↗</button> : <button onClick={() => { setTab('Crew'); document.getElementById('verified-quota')?.focus(); }}>Review quota ↓</button>}{recoveryError && <p role="alert" className="error-text">{recoveryError} Retry Recover preserves the unfinished command ID.</p>}</section>}
      <main id="main-content" className={`control-room mobile-${tab.toLowerCase()} ${viewMetrics ? 'show-metrics' : ''}`} tabIndex={-1}><section className="world-column">
        <div className="viewport-heading"><span className="eyebrow"><span className="live-square"/> SHARED WORLD <span className="subtle">/ {run ? `SEED ${run.seed}` : 'CONNECTING'}</span></span><span className="viewport-readout">{snapshot ? `${fps} FPS · ${snapshot.width} × ${snapshot.height}` : 'WAITING FOR SNAPSHOT'}</span></div>
        <div className="viewport">{snapshot ? <canvas ref={canvas} tabIndex={0} aria-label={`Mine map. ${snapshot.miners.length} miners. Hopper at ${position(HOPPER)}, globally known. Drag empty terrain to pan, wheel to zoom. Arrow keys pan; plus and minus zoom; F follows selection; Escape clears selection.`}/> : <div className="loading-world"><span className="eyebrow">{state.connection}</span><p>{state.error ?? 'Loading the authoritative world…'}</p></div>}{snapshot && state.connection !== 'Live' && <div className="connection-overlay"><span aria-hidden="true">⌁</span><strong>{state.connection}</strong><p>Last authoritative snapshot retained. Motion is frozen.</p></div>}<div className="map-corner"><span>CG / {run?.seed ?? '—'}</span><span>{run?.mode === 'running' ? 'WORLD CLOCK RUNNING' : 'WORLD CLOCK HELD'}</span></div></div>
        <div className="camera-bar"><div className="camera-buttons"><button className="icon-button" aria-label="Pan left" onClick={() => renderer.current?.pan(-96, 0)}>←</button><button className="icon-button" aria-label="Pan up" onClick={() => renderer.current?.pan(0, -96)}>↑</button><button className="icon-button" aria-label="Pan down" onClick={() => renderer.current?.pan(0, 96)}>↓</button><button className="icon-button" aria-label="Pan right" onClick={() => renderer.current?.pan(96, 0)}>→</button><span className="camera-divider"/><button className="icon-button" aria-label="Zoom out" onClick={() => renderer.current?.zoomBy(0.8)}>−</button><button className="icon-button" aria-label="Zoom in" onClick={() => renderer.current?.zoomBy(1.25)}>+</button><button onClick={() => renderer.current?.center()}>Center</button><button className="hopper-camera" disabled={!snapshot} aria-label={`Center camera on Hopper at ${position(HOPPER)}`} onClick={() => { setFollow(false); renderer.current?.center(HOPPER); }}>Hopper <small>{position(HOPPER)}</small></button></div><span className="camera-hint">DRAG / PAN · SCROLL / ZOOM · CLICK / SELECT</span></div>
        <section className="hopper-ledger" aria-label="Hopper deposited resources"><div><span className="eyebrow">Hopper / deposited</span><strong>{run?.hopper ? `${number.format(run.hopper.coal)} coal · ${number.format(run.hopper.diamonds)} diamonds` : 'Awaiting fresh hopper totals'}</strong></div><span className="subtle">KNOWN {position(HOPPER)} · {INVENTORY_CAPACITY} CARRIED SLOTS</span></section>
        <div className="resource-legend" aria-label="Mine resource legend"><span><i className="coal-key" aria-hidden="true"/>Coal · {RESOURCE_VALUES.coal} point</span><span><i className="diamond-key" aria-hidden="true"/>Diamond · {RESOURCE_VALUES.diamond} points</span><small>Carry at most {INVENTORY_CAPACITY} rocks total, then return to the hopper to deposit. Seams can require several trips. Extraction points are lifetime totals, not deposited ore, USD, or inference allowance.</small></div>
        <p className="selection-summary" aria-live="off">{selectedMiner ? `Selected: miner ${selectedMiner.agentId}, ${selectedMiner.state}, position ${position(selectedMiner)}, carried ${carried(selectedMiner)} slots${selectedMiner.inventory ? ` (${selectedMiner.inventory.coal} coal, ${selectedMiner.inventory.diamonds} diamonds)` : ' (awaiting fresh inventory)'}. Lifetime extracted: ${selectedMiner.coal} coal, ${selectedMiner.diamonds} diamonds, ${selectedMiner.coal * RESOURCE_VALUES.coal + selectedMiner.diamonds * RESOURCE_VALUES.diamond} points.` : 'No miner selected. Choose a sprite or use the accessible crew table.'}</p><Feed key={runId} events={state.events} nextBefore={state.nextBefore} select={chooseMiner} locate={at => renderer.current?.center(at)}/></section>
      <nav className="mobile-tabs" aria-label="Operator sections">{(['Crew', 'Agent', 'Feed', 'Metrics'] as Tab[]).map(item => <button key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item}</button>)}</nav>
      <aside className="operator-pane"><section className="crew-section"><div className="section-heading"><h2>Crew control</h2><span className="section-index">01</span></div><div className="model-line"><span className="model-indicator"/>Qwen 3.8 27B <span className="subtle">/ fixed</span></div><div className="preset-row">{[1, 10, 100].map(count => <button key={count} disabled={!live || run?.mode === 'stopped' || (snapshot?.miners.length ?? 1000) >= 1000} onClick={() => setSpawnCount(count)}>+{count}</button>)}</div><button className="primary full-width" disabled={!live || run?.mode === 'stopped' || (snapshot?.miners.length ?? 1000) >= 1000} onClick={() => setSpawnCount(10)}>Spawn crew <span aria-hidden="true">↗</span></button><dl className="ledger"><div><dt>Model calls / min</dt><dd>{metrics ? `${metrics.modelCallsPerMinute} / ${metrics.effectiveRPM}` : '—'}</dd></div><div><dt>In flight / cap</dt><dd>{metrics ? `${metrics.inFlight} / ${metrics.maxInFlight}` : '—'}</dd></div><div><dt>State delivery</dt><dd>{metrics ? `${metrics.deliveryBacklog} / ${elapsed(metrics.oldestDeliveryAgeMs)}` : '—'}</dd></div><div><dt>Remaining identities</dt><dd>{snapshot ? 1000 - snapshot.miners.length : '—'}</dd></div></dl><details className="quota-details" open={run?.mode === 'quota_paused'}><summary>Verified model quota</summary><Quota key={snapshot?.runId ?? 'uninitialized'} run={snapshot} disabled={!live || run?.mode === 'stopped'}/></details><details className="roster-details" open={rosterOpen} onToggle={event => setRosterOpen(event.currentTarget.open)}><summary>Search miner roster / {snapshot?.miners.length ?? '—'} identities</summary>{rosterOpen && <MinerTable snapshot={snapshot} selected={selected} select={chooseMiner} disabled={!live}/>}</details></section>
        <section className="agent-section" id="agent-inspector" tabIndex={-1}><div className="section-heading"><h2>Selected miner</h2><span className="section-index">02</span></div><Inspector miner={selectedMiner} snapshot={snapshot} live={live} following={follow} onFollow={() => { setFollow(value => !value); if (selectedMiner) renderer.current?.center(selectedMiner); }}/></section>
        <section className="run-tools"><button aria-pressed={viewMetrics} onClick={() => { setViewMetrics(value => !value); setTab('Metrics'); }}>Measured performance {viewMetrics ? '↑' : '↓'}</button><button disabled={!snapshot || exporting} onClick={() => void exportRun()}>{exporting ? 'Exporting…' : 'Export run JSON ↗'}</button><button className="danger" disabled={!live || !active || !!state.pending.stop} onClick={() => setConfirmation('stop')}>Stop run</button>{exportError && <p className="error-text" role="alert">{exportError}</p>}{state.commandErrors.stop && <p className="error-text" role="alert">{state.commandErrors.stop}</p>}</section>
      </aside>
      <section className="metrics-panel"><Metrics metrics={metrics} fps={fps}/></section></main><footer className="connection-bar"><span className={`connection-state ${state.connection.toLowerCase()}`}><span aria-hidden="true">{live ? '●' : '⌁'}</span> {state.connection}{state.stale ? ' · STALE — awaiting expected update' : ''}</span><span>REV {snapshot?.revision ?? '—'}{state.stale && state.lastFrameAt ? ` · event age ${elapsed(Date.now() - state.lastFrameAt)}` : ''}</span><span>SEED {run?.seed ?? '—'}</span><span className="run-id" title={runId}>RUN {runId}</span></footer>
    </>}
    {spawnCount !== undefined && snapshot && <SpawnDialog initialCount={spawnCount} snapshot={snapshot} live={live} close={() => setSpawnCount(undefined)}/>}
    {confirmation && <Modal title={confirmation === 'stop' ? 'Stop this run?' : 'Stop and create a new mine?'} close={() => setConfirmation(undefined)}><p>{confirmation === 'stop' ? 'Stopping is terminal. Unfinished physical actions are cancelled, and miners cannot resume this run.' : 'The current run must stop before a new world is created. This prevents autonomous agents from continuing behind a discarded tab.'}</p><p className="fine-print">The current transcript and measurement record remain available at this run URL.</p><div className="dialog-actions"><button onClick={() => setConfirmation(undefined)}>Keep current run</button><button className="danger" disabled={!live || !!state.pending.stop || creating} onClick={async () => { try { if (run?.mode !== 'stopped') await mineStore.command('stop', { type: 'stop' }); if (confirmation === 'new') await create(); else setConfirmation(undefined); } catch { /* The original command remains available for retry. */ } }}>{state.pending.stop ? 'Stopping…' : creating ? 'Creating…' : confirmation === 'new' ? 'Stop & create mine' : 'Stop permanently'}</button></div>{(state.commandErrors.stop || createError) && <p className="error-text" role="alert">{state.commandErrors.stop || createError}</p>}</Modal>}
  </div>;
}

function SpawnDialog({ initialCount, snapshot, live, close }: { initialCount: number; snapshot: RunSnapshot; live: boolean; close: () => void }) {
  const state = useSyncExternalStore(mineStore.subscribe, mineStore.getState);
  const existingSpawn = mineStore.pendingCommand('spawn');
  const [count, setCount] = useState(String(existingSpawn?.type === 'spawn' ? existingSpawn.count : Math.min(initialCount, 1000 - snapshot.miners.length)));
  const [receipt, setReceipt] = useState<{ crewId?: string; requested?: number }>();
  const remaining = 1000 - snapshot.miners.length;
  const crew = receipt?.crewId ? snapshot.miners.filter(miner => miner.crewId === receipt.crewId) : [];
  const provisioned = crew.filter(miner => miner.provisioned).length;
  const busy = !!state.pending.spawn;
  const submit = async (event: FormEvent) => { event.preventDefault(); try { setReceipt(await mineStore.command('spawn', { type: 'spawn', count: Number(count) })); } catch { /* Stable command retry is displayed below. */ } };
  return <Modal title="Provision a mining crew" close={close}><span className="eyebrow">Independent objects / shared world</span><p>Each identity gets its own durable Pi session. Miners share the application inference rate; <strong>100 miners does not mean 100 concurrent model calls.</strong></p><form onSubmit={submit}><label htmlFor="spawn-count">Miner identities <small>{remaining} of 1,000 remaining, including retired identities</small></label><div className="preset-row">{[1, 10, 100].map(value => <button type="button" key={value} disabled={busy || !!receipt || !!existingSpawn || remaining === 0} onClick={() => setCount(String(Math.min(value, remaining)))}>+{value}</button>)}</div><input id="spawn-count" type="number" min="1" max={Math.max(1, remaining)} step="1" required value={count} disabled={busy || !!receipt || !!existingSpawn} onChange={event => setCount(event.target.value)}/><dl className="ledger"><div><dt>Fixed model</dt><dd>Qwen 3.8 27B</dd></div><div><dt>Inference allowance</dt><dd>{money(snapshot.run.allowanceMicroUSD)}</dd></div><div><dt>Application RPM</dt><dd>{snapshot.run.effectiveRPM}</dd></div><div><dt>Model concurrency</dt><dd>{snapshot.run.maxInFlight}</dd></div></dl>{receipt ? <div className="provisioning-result" role="status"><strong>Provisioning {provisioned} / {receipt.requested}</strong><progress value={provisioned} max={receipt.requested ?? 1}/><small>Crew {receipt.crewId} · no optimistic agents</small>{crew.filter(miner => !miner.provisioned && miner.error).map(miner => <div key={miner.agentId} className="provisioning-failure"><p>Miner {miner.agentId}: {miner.error}</p><button type="button" disabled={!live || !!state.pending[`retry:${miner.agentId}`]} onClick={() => void mineStore.command(`retry:${miner.agentId}`, { type: 'retry_provisioning', agentId: miner.agentId }).catch(() => undefined)}>Retry provisioning</button>{state.commandErrors[`retry:${miner.agentId}`] && <p className="error-text">{state.commandErrors[`retry:${miner.agentId}`]}</p>}</div>)}</div> : <button className="primary full-width" disabled={!live || busy || (!existingSpawn && (remaining < 1 || snapshot.run.mode === 'stopped'))}>{busy ? 'Provisioning request…' : state.commandErrors.spawn ? 'Retry same spawn command' : `Spawn ${count} miner${count === '1' ? '' : 's'} ↗`}</button>}{state.commandErrors.spawn && <p className="error-text" role="alert">{state.commandErrors.spawn}</p>}</form><div className="dialog-actions"><button onClick={close}>{receipt ? 'Done' : 'Cancel'}</button></div></Modal>;
}

function Quota({ run, disabled }: { run?: RunSnapshot; disabled: boolean }) {
  const state = useSyncExternalStore(mineStore.subscribe, mineStore.getState);
  const existingQuota = mineStore.pendingCommand('quota');
  const [rpm, setRPM] = useState(existingQuota?.type === 'set_quota' ? String(existingQuota.verifiedModelRPM) : run?.run.verifiedModelRPM?.toString() ?? '');
  const [cap, setCap] = useState(String(existingQuota?.type === 'set_quota' ? existingQuota.maxInFlight : Math.min(run?.run.maxInFlight ?? MAX_IN_FLIGHT, MAX_IN_FLIGHT)));
  const [confirmed, setConfirmed] = useState(false);
  return <form className="quota-form" onSubmit={event => { event.preventDefault(); void mineStore.command('quota', { type: 'set_quota', verifiedModelRPM: Number(rpm), maxInFlight: Number(cap) }).then(() => setConfirmed(false)).catch(() => undefined); }}><p>Enter only an independently verified account/model quota. Published billing tiers are not interchangeable.</p><label htmlFor="verified-quota">Verified model requests / min</label><input id="verified-quota" type="number" min="1" max="1000" step="1" required value={rpm} disabled={!!state.pending.quota || !!existingQuota} onChange={event => setRPM(event.target.value)}/><label htmlFor="inflight-cap">Maximum in flight</label><input id="inflight-cap" type="number" min="1" max={MAX_IN_FLIGHT} step="1" required value={cap} disabled={!!state.pending.quota || !!existingQuota} onChange={event => setCap(event.target.value)}/><label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I have verified this model quota.</label><p className="fine-print">Effective rate: {rpm ? Math.max(1, Math.floor(Number(rpm) * 0.8)) : run?.run.effectiveRPM ?? '—'} RPM (80% of quota). Saving does not resume the mine.</p><button disabled={disabled || !confirmed || !!state.pending.quota}>{state.pending.quota ? 'Saving…' : state.commandErrors.quota ? 'Retry quota command' : 'Save verified quota'}</button>{state.commandErrors.quota && <p className="error-text" role="alert">{state.commandErrors.quota}</p>}</form>;
}

function MinerTable({ snapshot, selected, select, disabled }: { snapshot?: RunSnapshot; selected?: string; select: (id: string) => void; disabled: boolean }) {
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [page, setPage] = useState(0);
  const state = useSyncExternalStore(mineStore.subscribe, mineStore.getState);
  const miners = snapshot?.miners.filter(miner => (`${miner.agentId} ${miner.crewId} ${miner.state}`).toLowerCase().includes(search.toLowerCase()) && (stateFilter === 'all' || miner.state === stateFilter)) ?? [];
  const pageCount = Math.max(1, Math.ceil(miners.length / 50));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleMiners = miners.slice(currentPage * 50, (currentPage + 1) * 50);
  return <div className="miner-roster">
    <div className="roster-heading"><h3>Miner roster</h3><span>{snapshot?.miners.length ?? '—'} retained</span></div>
    <label className="sr-only" htmlFor="miner-search">Search miners by ID, crew, or state</label><input id="miner-search" type="search" placeholder="Find ID, crew, state…" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }}/>
    <label className="sr-only" htmlFor="miner-state">Filter miner state</label><select id="miner-state" value={stateFilter} onChange={event => { setStateFilter(event.target.value); setPage(0); }}><option value="all">All states</option>{Object.keys(stateGlyphs).map(value => <option key={value} value={value}>{value}</option>)}</select>
    <div className="roster-scroll"><table className="miner-table"><caption className="sr-only">Authoritative miner identities, states, carried inventory, and lifetime extracted resources</caption><thead><tr><th scope="col">Agent</th><th scope="col">State</th><th scope="col" className="numeric">Carried / lifetime</th></tr></thead>
      <tbody>{visibleMiners.map(miner => <tr key={miner.agentId} aria-selected={selected === miner.agentId}>
        <th scope="row"><button onClick={() => select(miner.agentId)} aria-label={`Select miner ${miner.agentId}, ${miner.state}`} aria-pressed={selected === miner.agentId}>#{miner.agentId}</button></th>
        <td><span className={`miner-state ${miner.state}`}><span aria-hidden="true">{stateGlyphs[miner.state]}</span> {miner.state}</span>
          {!miner.provisioned && miner.error && <><span className="error-text">{miner.error}</span><button disabled={disabled || !!state.pending[`retry:${miner.agentId}`]} onClick={() => void mineStore.command(`retry:${miner.agentId}`, { type: 'retry_provisioning', agentId: miner.agentId }).catch(() => undefined)}>Retry provisioning</button>{state.commandErrors[`retry:${miner.agentId}`] && <span className="error-text">{state.commandErrors[`retry:${miner.agentId}`]}</span>}</>}
        </td><td className="numeric resource-totals"><InventoryReadout miner={miner}/><span className="lifetime-resources">Lifetime: {miner.coal} C · {miner.diamonds} D</span><small>{number.format(miner.coal * RESOURCE_VALUES.coal + miner.diamonds * RESOURCE_VALUES.diamond)} extraction pts</small><span className="sr-only">C is coal; D is diamonds.</span></td>
      </tr>)}</tbody></table>{miners.length === 0 && <p className="empty-note">{snapshot?.miners.length ? 'No matching miners.' : 'No miners provisioned. Spawn the first crew.'}</p>}
    </div>
    <nav className="roster-pagination" aria-label="Miner roster pages"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← Previous</button><span>{currentPage + 1} / {pageCount}<small>{miners.length} matching identities</small></span><button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next →</button></nav>
  </div>;
}

function Inspector({ miner, snapshot, live, following, onFollow }: { miner?: PublicMiner; snapshot?: RunSnapshot; live: boolean; following: boolean; onFollow: () => void }) {
  const state = useSyncExternalStore(mineStore.subscribe, mineStore.getState);
  const [confirmRetire, setConfirmRetire] = useState(false);
  useEffect(() => setConfirmRetire(false), [miner?.agentId]);
  if (!miner) return <div className="empty-inspector"><span className="target-icon" aria-hidden="true">⌖</span><h3>Select a miner</h3><p>Click a sprite or choose an identity from the crew roster to inspect its durable work.</p><span className="eyebrow">PUBLIC TOOLS / NO PRIVATE THINKING</span></div>;
  const action = snapshot?.actions.find(item => item.actionId === miner.activeAction);
  return <><div className="selected-identity"><strong>AGENT / {miner.agentId.padStart(3, '0')}</strong><span className={`miner-state ${miner.state}`}>{stateGlyphs[miner.state]} {miner.state}</span></div>
    <dl className="ledger inspector-ledger"><div><dt>Crew</dt><dd>{miner.crewId}</dd></div><div><dt>Model</dt><dd>Qwen 3.8 27B</dd></div><div><dt>Durable Object ID</dt><dd className="break-all">{miner.doId}</dd></div><div><dt>Goal coordinate</dt><dd>{position(miner.goal)}</dd></div><div><dt>Position</dt><dd>{position(miner)}</dd></div><div><dt>Carried slots / {INVENTORY_CAPACITY}</dt><dd className="inventory-detail"><InventoryReadout miner={miner}/></dd></div><div><dt>Lifetime extracted</dt><dd>{miner.coal} coal / {miner.diamonds} diamonds</dd></div><div><dt>Lifetime extraction points</dt><dd>{number.format(miner.coal * RESOURCE_VALUES.coal + miner.diamonds * RESOURCE_VALUES.diamond)}</dd></div><div><dt>Last contact</dt><dd>{time(miner.lastContact)}</dd></div><div><dt>Current action</dt><dd>{action ? `${action.kind}${action.kind === 'mine' ? ` ${action.resource ?? 'coal'}` : ''} → ${position(action.target)} (${action.status})` : 'None'}</dd></div>{action?.status === 'accepted' && <div><dt>Action deadline</dt><dd>{snapshot?.run.pausedAt ? 'Frozen while paused' : time(action.endsAt)}</dd></div>}<div><dt>Queued since</dt><dd>{time(miner.queuedAt)}</dd></div><div><dt>Observed tokens in / out</dt><dd>{number.format(miner.inputTokens)} / {number.format(miner.outputTokens)}</dd></div><div><dt>Validated tools</dt><dd>{miner.validatedTools}</dd></div></dl>
    {miner.error && <p className="error-text" role="status">{miner.error}</p>}{miner.blocked && <p className="warning-text">Locally blocked by overload. This is not confirmation of the Mine's mode. Use Recover.</p>}
    <div className="inspector-actions"><button aria-pressed={following} onClick={onFollow}>{following ? '◉ Following' : '⌖ Follow'}</button><button className="danger" disabled={!live || miner.retired || !!state.pending[`retire:${miner.agentId}`]} onClick={() => setConfirmRetire(true)}>{miner.retired ? 'Retired' : 'Retire'}</button></div>{state.commandErrors[`retire:${miner.agentId}`] && <p className="error-text" role="alert">{state.commandErrors[`retire:${miner.agentId}`]}</p>}
    <Trace key={miner.agentId} runId={snapshot!.runId} agentId={miner.agentId}/>
    {confirmRetire && <Modal title={`Retire miner ${miner.agentId}?`} close={() => setConfirmRetire(false)}><p>This cancels the miner's unfinished action and prevents future inference. The identity and transcript are retained.</p><div className="dialog-actions"><button onClick={() => setConfirmRetire(false)}>Keep miner</button><button className="danger" disabled={!live || !!state.pending[`retire:${miner.agentId}`]} onClick={() => void mineStore.command(`retire:${miner.agentId}`, { type: 'retire', agentId: miner.agentId }).then(() => setConfirmRetire(false)).catch(() => undefined)}>Retire miner</button></div>{state.commandErrors[`retire:${miner.agentId}`] && <p className="error-text">{state.commandErrors[`retire:${miner.agentId}`]}</p>}</Modal>}
  </>;
}

function Trace({ runId, agentId }: { runId: string; agentId: string }) {
  const [page, setPage] = useState<PublicTranscriptPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string>();
  useEffect(() => { setCursor(undefined); setPage(undefined); setError(''); }, [agentId]);
  useEffect(() => {
    let alive = true; let busy = false;
    const controller = new AbortController();
    const load = async () => {
      if (busy) return; busy = true; setLoading(true);
      try {
        const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const result = await request<PublicTranscriptPage>(`/api/runs/${runId}/miners/${agentId}/trace${suffix}`, { signal: controller.signal });
        if (alive) { setPage({ ...result, entries: result.entries.filter(entry => ['text', 'tool_call', 'tool_result', 'status'].includes(entry.kind)).slice(0, 50) }); setError(''); }
      } catch (failure) { if (alive) setError(errorMessage(failure)); }
      finally { busy = false; if (alive) setLoading(false); }
    };
    void load(); const timer = window.setInterval(() => { if (!cursor) void load(); }, 2000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
  }, [runId, agentId, cursor]);
  return <section className="trace"><div className="roster-heading"><h3>Public tool trace</h3><span>{page?.busy ? 'DECIDING' : page?.phase ?? '—'}</span></div><p className="fine-print">Final text, validated tools, receipts, and usage only. Private model thinking is never displayed.</p>{error && <p className="error-text" role="alert">Trace unavailable: {error} The world connection is unaffected.</p>}<><details className="last-tools"><summary>Last committed tools ({page?.memory.lastTools.length ?? 0})</summary>{page?.memory.lastTools.slice(-8).reverse().map((tool, index) => <div className="tool-record" key={`${tool.at}:${index}`}><span>{tool.tool} · {time(tool.at)}</span><pre>{JSON.stringify(tool.args, null, 2)}</pre><pre>{JSON.stringify(tool.result, null, 2)}</pre></div>)}</details><div className="trace-scroll">{page?.entries.map(entry => <TraceEntry key={entry.id} entry={entry}/>)}{!page?.entries.length && <p className="empty-note">{loading ? 'Reading durable transcript…' : 'No public decisions recorded yet.'}</p>}</div></><div className="trace-pagination"><button disabled={!page?.nextCursor || loading} onClick={() => setCursor(page?.nextCursor)}>Older entries</button>{cursor && <button onClick={() => setCursor(undefined)}>Latest entries</button>}</div></section>;
}
function TraceEntry({ entry }: { entry: PublicTraceEntry }) {
  return <article className={`trace-entry ${entry.kind}`}><div><span>{entry.tool ?? entry.kind.replaceAll('_', ' ')}</span><time>{time(entry.timestamp)}</time></div>{entry.text && <p>{entry.text}</p>}{entry.args && <pre>{JSON.stringify(entry.args, null, 2)}</pre>}{entry.result && <pre>{entry.result}</pre>}{entry.status && <p className="trace-status">{entry.status}</p>}{(entry.usage || entry.durationMs !== undefined) && <small>{entry.durationMs !== undefined ? elapsed(entry.durationMs) : ''}{entry.usage ? ` · ${entry.usage.input} in / ${entry.usage.output} out` : ''}</small>}</article>;
}

function Feed({ events, nextBefore, select, locate }: { events: WorldEvent[]; nextBefore?: number; select: (id: string) => void; locate: (at: Coordinate) => void }) {
  const [filter, setFilter] = useState('All');
  const [live, setLive] = useState(true);
  const [historical, setHistorical] = useState<{ events: WorldEvent[]; nextBefore?: number }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const localScroll = useRef(false);
  const source = historical?.events ?? events;
  const before = historical ? historical.nextBefore : nextBefore;
  const filterTypes: Record<string, string> = { Messages: 'message', Actions: 'action', Conflicts: 'conflict', Errors: 'error' };
  const filtered = source.filter(event => filter === 'All' || event.type === filterTypes[filter]);
  useEffect(() => {
    if (live && scroll.current) {
      localScroll.current = true; scroll.current.scrollTop = scroll.current.scrollHeight;
      requestAnimationFrame(() => { localScroll.current = false; });
    }
  }, [events, live, filtered.length]);
  const older = async () => {
    if (before === undefined) return;
    setLoading(true); setError(''); setLive(false);
    try {
      const page = await mineStore.olderEvents(before);
      const merged = new Map(source.map(event => [event.revision, event]));
      for (const event of page.events) merged.set(event.revision, event);
      setHistorical({ events: [...merged.values()].sort((a, b) => b.revision - a.revision).slice(-200), nextBefore: page.nextBefore });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  };
  return <section className="coordination-feed">
    <div className="feed-heading"><h2>Coordination feed</h2><span className="section-index">03 / SHARED KNOWLEDGE</span><details className="feed-drawer"><summary>Toggle feed</summary><span>Use filters below to inspect world events.</span></details></div>
    <div className="feed-filters" aria-label="Filter coordination feed">
      {['All', 'Messages', 'Actions', 'Conflicts', 'Errors'].map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}
      {!live && <button className="return-live" onClick={() => { setHistorical(undefined); setLive(true); void mineStore.poll(); }}>Return to live ↓</button>}
      <button disabled={before === undefined || loading} onClick={() => void older()}>{loading ? 'Loading…' : 'Load older ↑'}</button>
    </div>
    {error && <p role="alert" className="error-text">{error}</p>}
    <div className="feed-scroll" ref={scroll} onScroll={() => {
      const element = scroll.current;
      if (!localScroll.current && element && element.scrollHeight - element.scrollTop - element.clientHeight > 40) {
        setLive(false); if (!historical) setHistorical({ events, nextBefore });
      }
    }}>
      <ol>{[...filtered].reverse().map(event => <li key={event.revision} className={`feed-event ${event.type}`}>
        <time>{time(event.timestamp)}</time><span className="event-type">{event.type}</span>
        <div>{event.agentId && <button className="text-button" onClick={() => select(event.agentId!)}>#{event.agentId}</button>}<span>{event.summary}</span>{event.at && <button className="coordinate-link" aria-label={`Center map at ${position(event.at)}`} onClick={() => locate(event.at!)}>⌖ {position(event.at)}</button>}</div>
        <span className="event-revision">r{event.revision}</span>
      </li>)}</ol>
      {!filtered.length && <p className="empty-note">{events.length ? 'No events match this filter.' : 'The mine is quiet. Authoritative events will appear here.'}</p>}
    </div>
  </section>;
}

interface Comparison { name: string; metrics: MetricsSnapshot; duration?: number; versions?: unknown }
function Metrics({ metrics, fps }: { metrics?: MetricsSnapshot; fps: number }) {
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [importError, setImportError] = useState('');
  const importFile = async (file?: File) => {
    if (!file) return;
    setImportError('');
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('Measurement import exceeds 16 MiB.');
      const raw: unknown = JSON.parse(await file.text());
      const root = raw as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') throw new Error('Expected a measurement JSON object or array.');
      const values: unknown[] = Array.isArray(raw) ? raw : Array.isArray(root.rows) ? root.rows : Array.isArray(root.results) ? root.results : [raw];
      const rows: Comparison[] = [];
      for (const value of values) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        const exported = (row.export ?? row.measurement ?? row) as Record<string, unknown>;
        const measured = (row.metrics ?? exported.metrics) as MetricsSnapshot | undefined;
        if (!measured || !['live', 'synthetic'].includes(measured.providerMode) || typeof measured.runId !== 'string' || !measured.worldRPC || !measured.errors) continue;
        const measuredNumbers = [measured.seed, measured.retained, measured.provisioned, measured.agentsWithRealInference, measured.agentsWithValidatedTools, measured.effectiveRPM, measured.maxInFlight, measured.coal, measured.observedMicroUSD, measured.unknownMicroUSD, ...Object.values(measured.errors)];
        if (measuredNumbers.some(value => typeof value !== 'number' || !Number.isFinite(value)) || (measured.worldRPC.p95 !== null && typeof measured.worldRPC.p95 !== 'number')) continue;
        rows.push({ name: typeof row.name === 'string' ? row.name : `${typeof row.requested === 'number' ? row.requested : measured.retained} miners / ${measured.runId.slice(0, 8)}`, metrics: measured, duration: typeof row.durationMs === 'number' ? row.durationMs : typeof row.seconds === 'number' ? row.seconds * 1000 : undefined, versions: exported.versions ?? row.versions ?? root.versions });
      }
      if (!rows.length) throw new Error('No measured run exports found. Import a server export or a scale runner results file.');
      setComparisons(previous => [...previous, ...rows].slice(-32));
    } catch (failure) { setImportError(errorMessage(failure)); }
  };
  const groups: { title: string; rows: [string, ReactNode][] }[] = metrics ? [
    { title: 'Agent population', rows: [['Provisioned / retained / retired', `${metrics.provisioned} / ${metrics.retained} / ${metrics.retired}`], ['Agents with real inference', metrics.agentsWithRealInference], ['Agents with validated Pi tools', metrics.agentsWithValidatedTools], ...Object.entries(metrics.states).map(([key, value]): [string, ReactNode] => [key, value])] },
    { title: 'Inference & allowance', rows: [['Mode / model', `${metrics.providerMode} / ${metrics.model}`], ['Actual calls / minute', `${metrics.modelCallsPerMinute} / ${metrics.effectiveRPM}`], ['Verified model RPM', metrics.verifiedModelRPM ?? 'Not entered — default cap'], ['In flight / cap / unclaimed', `${metrics.inFlight} / ${metrics.maxInFlight} / ${metrics.unclaimed}`], ['Total outbound calls', metrics.modelCallsTotal], ['Observed input / output tokens', `${number.format(metrics.inputTokens)} / ${number.format(metrics.outputTokens)}`], ['Observed application charge', money(metrics.observedMicroUSD)], ['Reserved allowance', money(metrics.reservedMicroUSD)], ['Unknown liabilities', money(metrics.unknownMicroUSD)], ['Fixed run allowance', money(metrics.allowanceMicroUSD)]] },
    { title: 'World & delivery', rows: [['Coal / running minute', number.format(metrics.coalPerMinute)], ['Coal: mined / available / reserved', `${metrics.coal} / ${metrics.availableCoal} / ${metrics.reservedCoal}`], ['Initial coal', metrics.initialCoal], ['Diamonds: mined / available / reserved', `${metrics.diamonds} / ${metrics.availableDiamonds} / ${metrics.reservedDiamonds}`], ['Initial diamonds', metrics.initialDiamonds], ['Resource points / running minute', number.format(metrics.valuePerMinute)], ['Total resource points (not USD)', number.format(metrics.value)], ['Delivery backlog / oldest age', `${metrics.deliveryBacklog} / ${elapsed(metrics.oldestDeliveryAgeMs)}`], ['Viewer revision lag / ack age', `${metrics.viewerLag} / ${elapsed(metrics.oldestViewerAckMs)}`], ['Viewer resyncs', metrics.viewerResyncs], ['Due actions / deadline lateness', `${metrics.dueActions} / ${elapsed(metrics.oldestActionLatenessMs)}`], ['Browser FPS (not platform CPU)', fps]] },
    { title: 'Recovery & storage health', rows: [['Receipt replays', metrics.receiptReplays], ['Rejected claims', metrics.rejectedClaims], ['Action cancellations', metrics.actionCancellations], ['Application restarts observed', metrics.restarts], ['Invariant failures', metrics.invariantFailures], ['SQLite size', `${number.format(metrics.sqlDatabaseSize / 1024)} KiB`], ['SQL cursor rows read / written', `${number.format(metrics.sqlRowsRead)} / ${number.format(metrics.sqlRowsWritten)}`], ['Platform CPU / memory', 'Unavailable / unavailable'], ...Object.entries(metrics.errors).map(([key, value]): [string, ReactNode] => [`Error: ${key}`, value])] },
  ] : [];
  return <><div className="section-heading"><h2>Measured performance</h2><span className="section-index">04 / NO ESTIMATED COUNTS</span></div>{!metrics ? <p className="empty-note">Waiting for server measurements.</p> : <><div className="measurement-groups">{groups.map(group => <section key={group.title}><h3>{group.title}</h3><dl className="ledger">{group.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>)}</div><div className="table-scroll"><table className="measurement-table"><caption>Measured latency distributions / milliseconds</caption><thead><tr><th>Distribution</th><th>Samples</th><th>p50</th><th>p95</th><th>p99</th></tr></thead><tbody>{(['worldRPC', 'queueWait', 'inferenceLatency', 'actionLateness', 'deliverySweep'] as const).map(key => <tr key={key}><th scope="row">{{ worldRPC: 'World tool RPC', queueWait: 'Admission queue wait', inferenceLatency: 'Provider request', actionLateness: 'Action deadline lateness', deliverySweep: 'Notice sweep' }[key]}</th><td>{metrics[key].count}</td><td>{metrics[key].p50 ?? '—'}</td><td>{metrics[key].p95 ?? '—'}</td><td>{metrics[key].p99 ?? '—'}</td></tr>)}</tbody></table></div></>}
    <section className="comparison"><div className="roster-heading"><h3>Recorded scale comparison</h3><label className="file-button">Import measurement JSON<input type="file" accept="application/json,.json" onChange={event => { void importFile(event.target.files?.[0]); event.currentTarget.value = ''; }}/></label></div><p className="fine-print">Only imported, recorded server measurements appear here. Synthetic runs do not prove remote Cloudflare or Qwen scale.</p>{importError && <p role="alert" className="error-text">{importError}</p>}{comparisons.length ? <div className="table-scroll"><table className="measurement-table"><caption>Imported evidence — not a benchmark running in this browser</caption><thead><tr><th>Run / mode / seed</th><th>Sample</th><th>Provisioned / retained</th><th>Real agents / tools</th><th>RPM / cap</th><th>RPC p95</th><th>Coal / diamonds</th><th>Points / points per min</th><th>Errors</th><th>Observed / unknown</th></tr></thead><tbody>{comparisons.map((row, index) => <tr key={`${row.metrics.runId}:${index}`}><th scope="row">{row.name}<small>{row.metrics.providerMode === 'synthetic' ? 'SYNTHETIC / NO MODEL INFERENCE' : 'LIVE QWEN'} · seed {row.metrics.seed}</small><details><summary>Recorded versions</summary><pre>{row.versions ? JSON.stringify(row.versions, null, 2) : 'Unavailable in imported record'}</pre></details></th><td>{row.duration === undefined ? 'Unavailable' : elapsed(row.duration)}</td><td>{row.metrics.provisioned} / {row.metrics.retained}</td><td>{row.metrics.agentsWithRealInference} / {row.metrics.agentsWithValidatedTools}</td><td>{row.metrics.effectiveRPM} / {row.metrics.maxInFlight}</td><td>{row.metrics.worldRPC.p95 ?? '—'} ms</td><td>{row.metrics.coal} / {recordedNumber(row.metrics.diamonds)}</td><td>{recordedNumber(row.metrics.value)} / {recordedNumber(row.metrics.valuePerMinute)}</td><td>{Object.values(row.metrics.errors).reduce((sum, value) => sum + value, 0)}</td><td>{money(row.metrics.observedMicroUSD)} / {money(row.metrics.unknownMicroUSD)}</td></tr>)}</tbody></table></div> : <div className="empty-comparison">NO SCALE RECORDS IMPORTED<span>Import the finite runner's JSON or an exported run to compare observed results.</span></div>}</section>
    <details className="measurement-help"><summary>What these measurements do — and do not — prove</summary><p>The inference allowance bounds application admission using Qwen's recorded price basis ($0.45/M input tokens, $3.20/M output tokens). It excludes Worker, Durable Object, storage, and network charges. Unknown provider-internal executions and the final invoice cannot be proven by this telemetry.</p><p>Miner identities are durable application records, not a count of warm isolates. Model concurrency and admission RPM are separate limits. Resource rates exclude paused time. Coal is worth 1 point; diamonds are worth 10 points. Points are not money and do not change the USD inference allowance. Missing historical resource measurements are unavailable, not inferred. Browser FPS is renderer telemetry, never platform CPU or memory.</p><p>One Mine serializes shared world mutations, admission, viewer updates, and notices. The documented 1,000 requests/second Durable Object soft limit is not a throughput guarantee; isolate memory is shared at 128 MB, not reserved per miner. Paid SQLite storage is 10 GB per object.</p><p>World RPC percentiles are measured at the miner making a tool RPC. Queue wait and inference latency are separate distributions; browser/server clock differences are not used for latency claims. Platform CPU and memory are unavailable unless independently measured. Targets of 250 ms world RPC p95, one-second viewer event age, and 30 overview FPS are targets, not guarantees.</p></details>
  </>;
}
