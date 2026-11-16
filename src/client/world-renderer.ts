import type { Coordinate, CoordinationMessage, PhysicalAction, PublicMiner, RunSnapshot, Tile } from '../shared/protocol';
import { HOPPER } from '../shared/protocol';

const TILE = 16;
const CHUNK = 16;
const CHUNK_PIXELS = TILE * CHUNK;
const CREW_COLORS = ['#86b8bd', '#8abf88', '#b8a4cf', '#d9a36b'] as const;
const PATH_DASH = [4, 3];
const NO_DASH: number[] = [];
const FONT = '11px "IBM Plex Mono", monospace';
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

interface Atlases { terrain: HTMLImageElement; crews: HTMLCanvasElement[] }
interface TerrainChunk { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; x: number; y: number; dirty: boolean }
interface RenderMiner {
  miner: PublicMiner; action?: PhysicalAction; x: number; y: number; offsetX: number; offsetY: number;
  direction: number; crew: number; ordinal: number; sortId: number; visible: boolean;
  label: string; labelWidth: number; stateLabel: string; stateLabelWidth: number;
}
interface Cluster { x: number; y: number; count: number; label: string; first: RenderMiner }
interface MessageMarker { message: CoordinationMessage; title: string; lines: string[]; x: number; y: number; shown: boolean }
interface PointerRecord { x: number; y: number; startX: number; startY: number; moved: boolean; miner?: string }

function context2d(canvas: HTMLCanvasElement, readFrequently = false): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: readFrequently });
  if (!context) throw new Error('Coal Garden requires Canvas 2D.');
  context.imageSmoothingEnabled = false;
  return context;
}

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

let atlasPromise: Promise<Atlases> | undefined;
function loadAtlases(): Promise<Atlases> {
  // One decode per original atlas, and one recoloring pass per crew, shared by renderer instances.
  return atlasPromise ??= (async () => {
    const terrain = new Image();
    const miners = new Image();
    terrain.src = '/sprites/terrain.svg';
    miners.src = '/sprites/miners.svg';
    await Promise.all([terrain.decode(), miners.decode()]);
    const crews = CREW_COLORS.map(color => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 72;
      const context = context2d(canvas, true);
      context.drawImage(miners, 0, 0);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const red = Number.parseInt(color.slice(1, 3), 16);
      const green = Number.parseInt(color.slice(3, 5), 16);
      const blue = Number.parseInt(color.slice(5, 7), 16);
      for (let index = 0; index < image.data.length; index += 4) {
        if (image.data[index] !== 208 || image.data[index + 1] !== 91 || image.data[index + 2] !== 170) continue;
        image.data[index] = red;
        image.data[index + 1] = green;
        image.data[index + 2] = blue;
      }
      context.putImageData(image, 0, 0);
      return canvas;
    });
    return { terrain, crews };
  })();
}

/** A read-only projection: animation and camera never mutate authoritative world state. */
export class WorldRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly minimap = document.createElement('canvas');
  private readonly minimapContext = context2d(this.minimap);
  private readonly miners = new Map<string, RenderMiner>();
  private readonly actions = new Map<string, PhysicalAction>();
  private readonly depleted = new Set<number>();
  private readonly pointers = new Map<number, PointerRecord>();
  private readonly clusterIndex = new Map<number, Cluster>();
  private readonly clusterPool: Cluster[] = [];
  private readonly tiles: (Tile | undefined)[] = [];
  private readonly chunks: TerrainChunk[] = [];
  private readonly ordered: RenderMiner[] = [];
  private readonly seams: Tile[] = [];
  private readonly messages: MessageMarker[] = [];
  private snapshot?: RunSnapshot;
  private atlases?: Atlases;
  private assetError = false;
  private destroyed = false;
  private connected = true;
  private interpolating = false;
  private selected?: string;
  private hovered?: string;
  private hoveredMessage?: number;
  private following = false;
  private reducedMotion = this.motion.matches;
  private cameraX = 4.5 * TILE;
  private cameraY = 4.5 * TILE;
  private scale = 2;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private columns = 0;
  private worldWidth = 0;
  private worldHeight = 0;
  private serverAnchor = 0;
  private localAnchor = 0;
  private messageClockAnchor = 0;
  private messageClockLocal = 0;
  private animationFrame = 0;
  private frameCount = 0;
  private fpsStarted = performance.now();
  private measuredFPS = 0;
  private sortDirty = false;
  private clustersDirty = true;
  private clusterCount = 0;
  private minimapDirty = true;
  private mapX = 16;
  private mapY = 32;
  private mapWidth = 0;
  private mapHeight = 0;
  private pinchDistance = 0;
  private pinchX = 0;
  private pinchY = 0;
  private previousTouchAction: string;
  private previousTabIndex: number;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onSelect: (agentId: string | undefined) => void) {
    this.context = context2d(canvas);
    this.previousTouchAction = canvas.style.touchAction;
    this.previousTabIndex = canvas.tabIndex;
    canvas.style.touchAction = 'none';
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    canvas.addEventListener('lostpointercapture', this.pointerCancel);
    canvas.addEventListener('pointerleave', this.pointerLeave);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('keydown', this.keyDown);
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.visibilityChanged);
    this.motion.addEventListener('change', this.motionChanged);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas);
    this.resize();
    void loadAtlases().then(atlases => {
      if (this.destroyed) return;
      this.atlases = atlases;
      for (const chunk of this.chunks) chunk.dirty = true;
    }).catch(() => { if (!this.destroyed) this.assetError = true; });
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  get fps(): number { return this.measuredFPS; }
  get zoom(): number { return this.scale; }
  get isFollowing(): boolean { return this.following; }

  setSnapshot(snapshot: RunSnapshot, connected = true): void {
    if (this.destroyed) return;
    const now = performance.now();
    const previousTime = this.time(now);
    const previous = this.snapshot;
    const sameClock = previous?.runId === snapshot.runId && previous.revision === snapshot.revision && previous.serverTime === snapshot.serverTime;
    const newRun = previous?.runId !== snapshot.runId;
    this.serverAnchor = sameClock ? previousTime : snapshot.serverTime;
    this.localAnchor = now;
    this.interpolating = connected && (!sameClock || this.interpolating);
    if (!sameClock) {
      this.messageClockAnchor = snapshot.serverTime;
      this.messageClockLocal = now;
    }
    this.connected = connected;
    this.snapshot = snapshot;

    if (newRun || this.worldWidth !== snapshot.width || this.worldHeight !== snapshot.height) {
      this.miners.clear();
      this.ordered.length = 0;
      this.tiles.length = 0;
      this.depleted.clear();
      this.chunks.length = 0;
      this.worldWidth = snapshot.width;
      this.worldHeight = snapshot.height;
      this.columns = Math.ceil(snapshot.width / CHUNK);
      for (let y = 0; y < snapshot.height; y += CHUNK) {
        for (let x = 0; x < snapshot.width; x += CHUNK) {
          const canvas = document.createElement('canvas');
          canvas.width = CHUNK_PIXELS;
          canvas.height = CHUNK_PIXELS;
          this.chunks.push({ canvas, context: context2d(canvas), x, y, dirty: true });
        }
      }
      this.minimap.width = snapshot.width * 2;
      this.minimap.height = snapshot.height * 2;
      this.minimapDirty = true;
      this.following = false;
      this.center();
    }

    this.seams.length = 0;
    for (const tile of snapshot.tiles) {
      const index = tile.y * this.worldWidth + tile.x;
      const old = this.tiles[index];
      if (!old || old.visible !== tile.visible || old.terrain !== tile.terrain) {
        if ((old?.terrain === 'coal' || old?.terrain === 'diamond') && tile.terrain === 'floor') this.depleted.add(index);
        const chunk = this.chunks[Math.floor(tile.y / CHUNK) * this.columns + Math.floor(tile.x / CHUNK)];
        if (chunk) chunk.dirty = true;
        this.minimapDirty = true;
      }
      this.tiles[index] = tile;
      if (tile.visible && (tile.terrain === 'coal' || tile.terrain === 'diamond')) this.seams.push(tile);
    }
    this.actions.clear();
    for (const action of snapshot.actions) {
      if (action.status === 'accepted') this.actions.set(action.actionId, action);
    }
    for (const miner of snapshot.miners) {
      let record = this.miners.get(miner.agentId);
      if (!record) {
        const ordinal = hash(miner.agentId);
        this.context.font = FONT;
        const label = `#${miner.agentId}`;
        const stateLabel = `${label} / ${miner.state}`;
        record = {
          miner, x: Number.NaN, y: Number.NaN, offsetX: ((ordinal % 5) - 2) * 0.7,
          offsetY: ((Math.floor(ordinal / 5) % 5) - 2) * 0.5, ordinal, sortId: Number(miner.agentId),
          direction: 0, crew: hash(miner.crewId) % CREW_COLORS.length, visible: false,
          label, stateLabel, labelWidth: this.context.measureText(label).width + 10,
          stateLabelWidth: this.context.measureText(stateLabel).width + 10,
        };
        this.miners.set(miner.agentId, record);
        this.ordered.push(record);
        this.sortDirty = true;
      }
      if (record.miner.state !== miner.state) {
        this.context.font = FONT;
        record.stateLabel = `${record.label} / ${miner.state}`;
        record.stateLabelWidth = this.context.measureText(record.stateLabel).width + 10;
      }
      record.miner = miner;
      record.action = miner.activeAction ? this.actions.get(miner.activeAction) : undefined;
      record.visible = miner.provisioned && !miner.retired;
    }
    this.messages.length = 0;
    const first = Math.max(0, snapshot.messages.length - 8);
    for (let index = first; index < snapshot.messages.length; index++) {
      const message = snapshot.messages[index]!;
      this.messages.push({ message, title: `#${message.sender} → ${message.audience === 'mine' ? 'mine' : '#' + message.agentId}`, lines: this.wrapMessage(message.body), x: 0, y: 0, shown: false });
    }
    this.clustersDirty = true;
    this.updatePositions(this.time(now));
  }

  select(agentId?: string): void {
    this.selected = agentId;
    this.clustersDirty = true;
  }

  follow(enabled: boolean): void {
    this.following = enabled;
    if (enabled) {
      const miner = this.selected ? this.miners.get(this.selected) : undefined;
      if (miner) { this.cameraX = miner.x; this.cameraY = miner.y; }
    }
  }

  /** Pan in CSS screen pixels; positive values move the camera east/south. */
  pan(dx: number, dy: number): void {
    this.following = false;
    this.cameraX += dx / this.scale;
    this.cameraY += dy / this.scale;
    this.clampCamera();
  }

  zoomBy(factor: number): void { this.zoomAt(factor, this.width / 2, this.height / 2); }

  center(coordinate: Coordinate = { x: 4, y: 4 }): void {
    this.following = false;
    this.cameraX = (coordinate.x + 0.5) * TILE;
    this.cameraY = (coordinate.y + 0.5) * TILE;
    this.clampCamera();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this.pointerCancel);
    this.canvas.removeEventListener('pointerleave', this.pointerLeave);
    this.canvas.removeEventListener('wheel', this.wheel);
    this.canvas.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.motion.removeEventListener('change', this.motionChanged);
    for (const pointer of this.pointers.keys()) {
      if (this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer);
    }
    this.pointers.clear();
    this.canvas.style.touchAction = this.previousTouchAction;
    this.canvas.tabIndex = this.previousTabIndex;
    this.canvas.style.cursor = '';
    this.measuredFPS = 0;
  }

  private time(now: number): number {
    if (!this.snapshot) return 0;
    if (this.snapshot.run.mode !== 'running') return this.snapshot.run.pausedAt ?? this.snapshot.serverTime;
    return this.serverAnchor + (this.interpolating ? Math.max(0, now - this.localAnchor) : 0);
  }

  private readonly resize = (): void => {
    if (this.destroyed) return;
    const bounds = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.context.imageSmoothingEnabled = false;
    for (const marker of this.messages) marker.lines = this.wrapMessage(marker.message.body);
  };

  private readonly motionChanged = (event: MediaQueryListEvent): void => { this.reducedMotion = event.matches; };
  private readonly visibilityChanged = (): void => {
    this.measuredFPS = 0;
    this.frameCount = 0;
    this.fpsStarted = performance.now();
  };

  private readonly frame = (now: number): void => {
    if (this.destroyed) return;
    if (!document.hidden) {
      this.frameCount++;
      const interval = now - this.fpsStarted;
      if (interval >= 1000) {
        this.measuredFPS = Math.round(this.frameCount * 1000 / interval);
        this.frameCount = 0;
        this.fpsStarted = now;
      }
      this.draw(this.time(now), this.messageClockAnchor + Math.max(0, now - this.messageClockLocal));
    }
    this.animationFrame = requestAnimationFrame(this.frame);
  };

  private updatePositions(time: number): void {
    for (const record of this.ordered) {
      const miner = record.miner;
      const action = record.action;
      let x = miner.x;
      let y = miner.y;
      if (action?.kind === 'walk_to' && action.path.length > 0) {
        const progress = clamp((time - action.startedAt) / Math.max(1, action.endsAt - action.startedAt), 0, 1) * action.path.length;
        const index = Math.min(Math.floor(progress), action.path.length - 1);
        const from = index === 0 ? action.origin : action.path[index - 1]!;
        const to = action.path[index]!;
        const fraction = progress >= action.path.length ? 1 : progress - index;
        x = from.x + (to.x - from.x) * fraction;
        y = from.y + (to.y - from.y) * fraction;
        record.direction = this.direction(to.x - from.x, to.y - from.y, record.direction);
      } else if (action?.kind === 'mine') {
        record.direction = this.direction(action.target.x - miner.x, action.target.y - miner.y, record.direction);
      }
      x = (x + 0.5) * TILE + record.offsetX;
      y = (y + 0.5) * TILE + record.offsetY;
      if (record.x !== x || record.y !== y) {
        if (record.y !== y) this.sortDirty = true;
        this.clustersDirty = true;
        record.x = x;
        record.y = y;
      }
    }
    if (this.sortDirty) {
      this.ordered.sort(compareMiners);
      this.sortDirty = false;
    }
  }

  private direction(dx: number, dy: number, fallback: number): number {
    if (dx > 0) return 1;
    if (dx < 0) return 3;
    if (dy < 0) return 2;
    if (dy > 0) return 0;
    return fallback;
  }

  private draw(time: number, messageTime: number): void {
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.fillStyle = '#11140f';
    context.fillRect(0, 0, this.width, this.height);
    if (!this.snapshot || !this.atlases) {
      if (this.snapshot) {
        context.font = FONT;
        context.fillStyle = this.assetError ? '#dc735e' : '#9d9f8d';
        context.fillText(this.assetError ? 'Sprite atlas unavailable. Reload to retry.' : 'Loading mine sprite atlases…', 20, 32);
      }
      return;
    }
    this.updatePositions(time);
    const selected = this.selected ? this.miners.get(this.selected) : undefined;
    if (this.following && selected) { this.cameraX = selected.x; this.cameraY = selected.y; }
    const left = this.cameraX - this.width / (2 * this.scale);
    const top = this.cameraY - this.height / (2 * this.scale);
    const right = left + this.width / this.scale;
    const bottom = top + this.height / this.scale;
    context.save();
    context.translate(this.width / 2, this.height / 2);
    context.scale(this.scale, this.scale);
    context.translate(-this.cameraX, -this.cameraY);
    this.drawTerrain(left, top, right, bottom);
    for (const tile of this.seams) {
      const x = tile.x * TILE;
      const y = tile.y * TILE;
      if (x + TILE < left || x > right || y + TILE < top || y > bottom) continue;
      if (tile.terrain === 'coal') context.drawImage(this.atlases.terrain, 80, 0, TILE, TILE, x, y, TILE, TILE);
      if (tile.terrain === 'diamond') {
        context.fillStyle = '#b5f5f0';
        context.fillRect(x + 1, y + 1, 4, 1);
        context.fillRect(x + 1, y + 2, 1, 3);
        context.fillRect(x + 11, y + 14, 4, 1);
        context.fillRect(x + 14, y + 11, 1, 3);
      }
      if (tile.claimant || tile.reserved > 0) context.drawImage(this.atlases.terrain, 96, 0, TILE, TILE, x, y, TILE, TILE);
    }
    const spawn = this.tiles[4 * this.worldWidth + 4];
    if (spawn?.visible) context.drawImage(this.atlases.terrain, 112, 0, TILE, TILE, 4 * TILE, 4 * TILE, TILE, TILE);
    this.drawHopper(left, top, right, bottom);
    if (this.scale < 0.75) {
      this.drawClusters(time, left, top, right, bottom);
      if (selected?.visible) this.drawMiner(selected, time);
    } else {
      for (const record of this.ordered) {
        if (!record.visible || record.x + 10 < left || record.x - 10 > right || record.y + 5 < top || record.y - 24 > bottom) continue;
        this.drawMiner(record, time);
      }
    }
    if (selected?.visible) this.drawSelection(selected, time);
    context.restore();
    this.drawLabels(selected);
    this.drawMessages(messageTime);
    this.drawMinimap(left, top, right, bottom);
    if (!this.connected) this.drawConnectionOverlay();
  }

  private drawHopper(left: number, top: number, right: number, bottom: number): void {
    const x = HOPPER.x * TILE;
    const y = HOPPER.y * TILE;
    if (x + 32 < left || x - 16 > right || y + 24 < top || y - 32 > bottom) return;
    const context = this.context;
    context.save();
    context.translate(x, y);
    // A fixed landmark above fog, not a reveal of the surrounding terrain.
    context.fillStyle = '#171a15';
    context.fillRect(-13, 12, 43, 7);
    context.fillStyle = '#605b48';
    context.fillRect(-12, 16, 42, 2);
    context.fillRect(-12, 21, 42, 2);
    context.fillStyle = '#393c32';
    for (let rail = -9; rail < 30; rail += 8) context.fillRect(rail, 15, 3, 10);
    context.fillStyle = '#60472d';
    context.fillRect(-10, -21, 5, 37);
    context.fillRect(21, -21, 5, 37);
    context.fillRect(-12, -15, 40, 4);
    context.fillStyle = '#a27c49';
    context.fillRect(-10, -21, 2, 36);
    context.fillRect(21, -21, 2, 36);
    context.fillRect(-9, 7, 33, 3);
    context.fillStyle = '#697060';
    context.beginPath();
    context.moveTo(-14, -19); context.lineTo(30, -19);
    context.lineTo(19, 4); context.lineTo(-3, 4); context.closePath(); context.fill();
    context.fillStyle = '#343c32';
    context.beginPath();
    context.moveTo(-11, -16); context.lineTo(27, -16);
    context.lineTo(17, 1); context.lineTo(-1, 1); context.closePath(); context.fill();
    context.fillStyle = '#101814';
    context.fillRect(-10, -20, 36, 7);
    context.fillRect(-5, -24, 11, 6);
    context.fillRect(9, -26, 9, 8);
    context.fillRect(20, -23, 6, 5);
    context.fillStyle = '#526053';
    context.fillRect(-4, -23, 5, 2);
    context.fillRect(10, -25, 4, 2);
    context.fillRect(19, -19, 4, 2);
    context.fillStyle = '#92937b';
    context.fillRect(-14, -17, 44, 2);
    context.fillRect(3, 3, 11, 11);
    context.fillStyle = '#30382f';
    context.fillRect(6, 4, 5, 11);
    context.fillStyle = '#eeb94b';
    context.fillRect(-10, -12, 2, 2);
    context.fillRect(24, -12, 2, 2);
    context.restore();
    const labelX = this.screenX(x + 8);
    const labelY = this.screenY(y - 31);
    context.save();
    // Screen-sized lettering remains legible at overview zoom.
    context.translate(this.cameraX, this.cameraY);
    context.scale(1 / this.scale, 1 / this.scale);
    context.translate(-this.width / 2, -this.height / 2);
    context.font = FONT;
    context.textAlign = 'center';
    context.fillStyle = '#11140f';
    context.fillRect(Math.round(labelX - 31), Math.round(labelY - 12), 62, 17);
    context.fillStyle = '#eeb94b';
    context.fillText('HOPPER', Math.round(labelX), Math.round(labelY));
    context.restore();
  }

  private drawTerrain(left: number, top: number, right: number, bottom: number): void {
    for (const chunk of this.chunks) {
      const x = chunk.x * TILE;
      const y = chunk.y * TILE;
      if (x + CHUNK_PIXELS < left || x > right || y + CHUNK_PIXELS < top || y > bottom) continue;
      if (chunk.dirty) {
        for (let localY = 0; localY < CHUNK; localY++) {
          for (let localX = 0; localX < CHUNK; localX++) {
            const index = (chunk.y + localY) * this.worldWidth + chunk.x + localX;
            const tile = this.tiles[index];
            let source = 4;
            if (tile?.visible) source = tile.terrain === 'rock' ? 1 : tile.terrain === 'coal' ? 2 : tile.terrain === 'diamond' ? 8 : this.depleted.has(index) ? 3 : 0;
            chunk.context.drawImage(this.atlases!.terrain, source * TILE, 0, TILE, TILE, localX * TILE, localY * TILE, TILE, TILE);
          }
        }
        chunk.dirty = false;
      }
      this.context.drawImage(chunk.canvas, x, y);
    }
    this.context.strokeStyle = '#3b4032';
    this.context.lineWidth = 1 / this.scale;
    this.context.strokeRect(0, 0, this.worldWidth * TILE, this.worldHeight * TILE);
  }

  private drawMiner(record: RenderMiner, time: number): void {
    const context = this.context;
    const action = record.action;
    const row = action?.kind === 'walk_to' ? 1 : action?.kind === 'mine' ? 2 : 0;
    const elapsed = action ? clamp(time - action.startedAt, 0, Math.max(0, action.endsAt - action.startedAt)) : Math.max(0, time - this.snapshot!.run.createdAt) + record.ordinal % 500;
    const frame = this.reducedMotion ? 0 : Math.floor(elapsed / 1000 * (row === 1 ? 8 : row === 2 ? 6 : 2)) % 4;
    const x = Math.round(record.x);
    const y = Math.round(record.y);
    context.fillStyle = '#10150f';
    context.fillRect(x - 5, y + 1, 10, 3);
    context.drawImage(this.atlases!.crews[record.crew]!, (record.direction * 4 + frame) * 16, row * 24, 16, 24, x - 8, y - 20, 16, 24);
    if (record.miner.state === 'queued') {
      // A small hourglass remains legible without relying on crew color.
      context.fillStyle = '#eeb94b';
      context.fillRect(x - 2, y - 26, 5, 1);
      context.fillRect(x - 1, y - 25, 3, 1);
      context.fillRect(x, y - 24, 1, 1);
      context.fillRect(x - 1, y - 23, 3, 1);
      context.fillRect(x - 2, y - 22, 5, 1);
    } else if (record.miner.state === 'thinking') {
      context.strokeStyle = '#86b8bd';
      context.lineWidth = 1 / this.scale;
      context.beginPath();
      context.arc(x, y - 25, 2, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = '#86b8bd';
      context.fillRect(x + 4, y - 25, 1, 1);
    } else if (record.miner.state === 'error' || record.miner.blocked) {
      context.strokeStyle = '#dc735e';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x - 3, y - 27); context.lineTo(x + 3, y - 21);
      context.moveTo(x + 3, y - 27); context.lineTo(x - 3, y - 21);
      context.stroke();
    }
  }

  private drawClusters(time: number, left: number, top: number, right: number, bottom: number): void {
    if (this.clustersDirty) {
      this.clusterIndex.clear();
      this.clusterCount = 0;
      const cell = 24 / this.scale;
      const stride = Math.ceil(this.worldWidth * TILE / cell) + 2;
      for (const record of this.ordered) {
        if (!record.visible || record.miner.agentId === this.selected) continue;
        const key = Math.floor(record.y / cell) * stride + Math.floor(record.x / cell);
        let cluster = this.clusterIndex.get(key);
        if (!cluster) {
          cluster = this.clusterPool[this.clusterCount];
          if (!cluster) {
            cluster = { x: 0, y: 0, count: 0, label: '', first: record };
            this.clusterPool.push(cluster);
          }
          cluster.x = 0; cluster.y = 0; cluster.count = 0; cluster.first = record;
          this.clusterCount++;
          this.clusterIndex.set(key, cluster);
        }
        cluster.x += record.x;
        cluster.y += record.y;
        cluster.count++;
      }
      for (let index = 0; index < this.clusterCount; index++) {
        const cluster = this.clusterPool[index]!;
        cluster.x /= cluster.count;
        cluster.y /= cluster.count;
        cluster.label = String(cluster.count);
      }
      this.clustersDirty = false;
    }
    const context = this.context;
    for (let index = 0; index < this.clusterCount; index++) {
      const cluster = this.clusterPool[index]!;
      if (cluster.x + 20 < left || cluster.x - 20 > right || cluster.y + 10 < top || cluster.y - 25 > bottom) continue;
      this.drawMiner(cluster.first, time);
      if (cluster.count < 2) continue;
      const x = cluster.first.x + 5;
      const y = cluster.first.y - 21;
      // Counts, not individual name labels, are the overview's density instrument.
      context.fillStyle = '#1c1e18';
      context.fillRect(x, y, 25 / this.scale, 14 / this.scale);
      context.strokeStyle = '#eeb94b';
      context.lineWidth = 1 / this.scale;
      context.strokeRect(x, y, 25 / this.scale, 14 / this.scale);
      context.save();
      context.translate(x + 3 / this.scale, y + 10 / this.scale);
      context.scale(1 / this.scale, 1 / this.scale);
      context.font = '10px "IBM Plex Mono", monospace';
      context.fillStyle = '#eee6cc';
      context.fillText(cluster.label, 0, 0);
      context.restore();
    }
  }

  private drawSelection(record: RenderMiner, time: number): void {
    const context = this.context;
    const action = record.action;
    context.lineWidth = 1 / this.scale;
    if (action) {
      context.strokeStyle = '#86b8bd';
      context.setLineDash(PATH_DASH);
      context.beginPath();
      context.moveTo((action.origin.x + 0.5) * TILE, (action.origin.y + 0.5) * TILE);
      if (action.kind === 'walk_to') {
        for (const step of action.path) context.lineTo((step.x + 0.5) * TILE, (step.y + 0.5) * TILE);
      } else context.lineTo((action.target.x + 0.5) * TILE, (action.target.y + 0.5) * TILE);
      context.stroke();
      context.setLineDash(NO_DASH);
      if (action.kind === 'mine' && action.resource === 'diamond') context.strokeStyle = '#b5f5f0';
      context.strokeRect(action.target.x * TILE + 1, action.target.y * TILE + 1, TILE - 2, TILE - 2);
      const fraction = clamp((time - action.startedAt) / Math.max(1, action.endsAt - action.startedAt), 0, 1);
      context.fillStyle = '#11140f';
      context.fillRect(record.x - 8, record.y + 7, 16, 3);
      context.fillStyle = action.kind === 'mine' ? action.resource === 'diamond' ? '#b5f5f0' : '#eeb94b' : '#86b8bd';
      context.fillRect(record.x - 8, record.y + 7, 16 * fraction, 2);
    }
    context.strokeStyle = '#eeb94b';
    context.beginPath();
    context.ellipse(record.x, record.y + 1, 10, 5, 0, 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = '#eeb94b';
    context.fillRect(record.x - 1, record.y - 32, 3, 2);
    context.fillRect(record.x, record.y - 30, 1, 2);
  }

  private drawLabels(selected: RenderMiner | undefined): void {
    const context = this.context;
    context.font = FONT;
    for (const record of this.ordered) {
      if (!record.visible) continue;
      const chosen = record === selected;
      if (!chosen && (this.scale < 0.75 || (this.scale < 1.6 && record.miner.agentId !== this.hovered))) continue;
      const x = this.screenX(record.x);
      const y = this.screenY(record.y) + 22 * this.scale;
      if (x < -80 || x > this.width + 80 || y < 0 || y > this.height + 20) continue;
      const text = chosen ? record.stateLabel : record.label;
      const width = chosen ? record.stateLabelWidth : record.labelWidth;
      context.fillStyle = '#11140f';
      context.fillRect(Math.round(x - width / 2), Math.round(y - 12), width, 17);
      context.fillStyle = chosen ? '#eeb94b' : '#eee6cc';
      context.fillText(text, Math.round(x - width / 2 + 5), Math.round(y));
    }
  }

  private wrapMessage(body: string): string[] {
    const width = Math.min(250, Math.max(100, this.width - 52));
    this.context.font = FONT;
    const lines: string[] = [];
    let line = '';
    for (const character of body) {
      if (character === '\n' || (line && this.context.measureText(line + character).width > width)) {
        lines.push(line);
        line = character === '\n' ? '' : character;
      } else line += character;
    }
    if (line) lines.push(line);
    return lines;
  }

  private drawMessages(time: number): void {
    const context = this.context;
    context.font = FONT;
    for (const marker of this.messages) {
      marker.shown = false;
      const message = marker.message;
      if (time < message.timestamp || time >= message.timestamp + 4000) continue;
      const sender = this.miners.get(message.sender);
      if (!message.at && !sender?.visible) continue;
      const worldX = message.at ? (message.at.x + 0.5) * TILE : sender!.x;
      const worldY = message.at ? (message.at.y + 0.5) * TILE : sender!.y;
      const x = this.screenX(worldX);
      const y = this.screenY(worldY) - (message.at ? 8 : 25) * this.scale;
      if (x < 0 || x > this.width || y < 0 || y > this.height) continue;
      marker.x = x; marker.y = y; marker.shown = true;
      context.fillStyle = '#eeb94b';
      context.fillRect(Math.round(x - 7), Math.round(y - 10), 14, 10);
      context.fillRect(Math.round(x - 4), Math.round(y), 3, 3);
      context.fillStyle = '#1c1e18';
      context.fillRect(Math.round(x - 4), Math.round(y - 6), 2, 2);
      context.fillRect(Math.round(x + 1), Math.round(y - 6), 2, 2);
      if (message.sender !== this.selected && message.sequence !== this.hoveredMessage && message.sender !== this.hovered) continue;
      const width = Math.min(270, Math.max(120, this.width - 32));
      const height = 32 + marker.lines.length * 15;
      const left = clamp(x + 12, 8, Math.max(8, this.width - width - 8));
      const top = clamp(y - height - 8, 8, Math.max(8, this.height - height - 8));
      context.fillStyle = '#1c1e18';
      context.fillRect(left, top, width, height);
      context.strokeStyle = '#eeb94b';
      context.lineWidth = 1;
      context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
      context.fillStyle = '#eeb94b';
      context.fillText(marker.title, left + 9, top + 16);
      context.fillStyle = '#eee6cc';
      for (let index = 0; index < marker.lines.length; index++) context.fillText(marker.lines[index]!, left + 9, top + 33 + index * 15);
    }
  }

  private drawMinimap(left: number, top: number, right: number, bottom: number): void {
    if (this.minimapDirty) {
      const context = this.minimapContext;
      for (const tile of this.tiles) {
        if (!tile) continue;
        context.fillStyle = !tile.visible ? '#171a15' : tile.terrain === 'diamond' ? '#b5f5f0' : tile.terrain === 'coal' ? '#eeb94b' : tile.terrain === 'floor' ? '#626950' : '#363d2f';
        context.fillRect(tile.x * 2, tile.y * 2, 2, 2);
      }
      this.minimapDirty = false;
    }
    const context = this.context;
    this.mapWidth = Math.min(144, this.width * 0.34);
    this.mapHeight = this.mapWidth * this.worldHeight / this.worldWidth;
    context.fillStyle = '#11140f';
    context.fillRect(this.mapX - 5, this.mapY - 21, this.mapWidth + 10, this.mapHeight + 26);
    context.strokeStyle = '#3b4032';
    context.lineWidth = 1;
    context.strokeRect(this.mapX - 5.5, this.mapY - 21.5, this.mapWidth + 11, this.mapHeight + 27);
    context.font = '9px "IBM Plex Mono", monospace';
    context.fillStyle = '#9d9f8d';
    context.fillText('SURVEY / SHARED', this.mapX, this.mapY - 8);
    context.drawImage(this.minimap, this.mapX, this.mapY, this.mapWidth, this.mapHeight);
    context.fillStyle = '#11140f';
    const hopperX = this.mapX + (HOPPER.x + 0.5) / this.worldWidth * this.mapWidth;
    const hopperY = this.mapY + (HOPPER.y + 0.5) / this.worldHeight * this.mapHeight;
    context.fillRect(Math.round(hopperX) - 4, Math.round(hopperY) - 4, 9, 9);
    context.fillStyle = '#eeb94b';
    context.fillRect(Math.round(hopperX) - 2, Math.round(hopperY) - 2, 5, 5);
    const scale = this.mapWidth / (this.worldWidth * TILE);
    context.save();
    context.beginPath();
    context.rect(this.mapX, this.mapY, this.mapWidth, this.mapHeight);
    context.clip();
    context.fillStyle = '#eee6cc';
    for (const record of this.ordered) {
      if (!record.visible) continue;
      context.fillRect(Math.round(this.mapX + record.x * scale), Math.round(this.mapY + record.y * scale), 1.5, 1.5);
    }
    const selected = this.selected ? this.miners.get(this.selected) : undefined;
    if (selected?.visible) {
      context.fillStyle = '#eeb94b';
      context.fillRect(this.mapX + selected.x * scale - 2, this.mapY + selected.y * scale - 2, 4, 4);
    }
    context.strokeStyle = '#86b8bd';
    context.strokeRect(this.mapX + left * scale, this.mapY + top * scale, (right - left) * scale, (bottom - top) * scale);
    context.restore();
  }

  private drawConnectionOverlay(): void {
    const context = this.context;
    const text = 'CONNECTION LOST / LAST KNOWN WORLD';
    context.font = FONT;
    const width = Math.min(this.width - 24, context.measureText(text).width + 24);
    context.fillStyle = '#1c1e18';
    context.fillRect((this.width - width) / 2, this.height - 42, width, 28);
    context.strokeStyle = '#dc735e';
    context.lineWidth = 1;
    context.strokeRect((this.width - width) / 2 + 0.5, this.height - 41.5, width - 1, 27);
    context.fillStyle = '#dc735e';
    context.fillText(text, (this.width - width) / 2 + 10, this.height - 24, Math.max(1, width - 20));
  }

  private screenX(x: number): number { return (x - this.cameraX) * this.scale + this.width / 2; }
  private screenY(y: number): number { return (y - this.cameraY) * this.scale + this.height / 2; }

  private clampCamera(): void {
    if (!this.snapshot) return;
    this.cameraX = clamp(this.cameraX, 0, this.worldWidth * TILE);
    this.cameraY = clamp(this.cameraY, 0, this.worldHeight * TILE);
  }

  private zoomAt(factor: number, x: number, y: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const before = this.scale;
    const next = clamp(before * factor, 0.5, 4);
    if (next === before) return;
    this.following = false;
    this.cameraX += (x - this.width / 2) * (1 / before - 1 / next);
    this.cameraY += (y - this.height / 2) * (1 / before - 1 / next);
    this.scale = next;
    this.clustersDirty = true;
    this.clampCamera();
  }

  private hitMiner(x: number, y: number): RenderMiner | undefined {
    const worldX = (x - this.width / 2) / this.scale + this.cameraX;
    const worldY = (y - this.height / 2) / this.scale + this.cameraY;
    const halfWidth = Math.max(8, 10 / this.scale);
    if (this.scale < 0.75) {
      const selected = this.selected ? this.miners.get(this.selected) : undefined;
      if (selected?.visible && Math.abs(worldX - selected.x) <= halfWidth && worldY >= selected.y - 24 && worldY <= selected.y + 8) return selected;
      for (let index = this.clusterCount - 1; index >= 0; index--) {
        const cluster = this.clusterPool[index]!;
        const record = cluster.first;
        const right = record.x + (cluster.count > 1 ? 30 / this.scale : halfWidth);
        if (worldX >= record.x - halfWidth && worldX <= right && worldY >= record.y - Math.max(24, 12 / this.scale) && worldY <= record.y + 8) return record;
      }
      return undefined;
    }
    for (let index = this.ordered.length - 1; index >= 0; index--) {
      const record = this.ordered[index]!;
      if (record.visible && Math.abs(worldX - record.x) <= halfWidth && worldY >= record.y - Math.max(20, 12 / this.scale) && worldY <= record.y + Math.max(5, 8 / this.scale)) return record;
    }
    return undefined;
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.snapshot) return;
    const bounds = this.canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    this.canvas.focus({ preventScroll: true });
    event.preventDefault();
    if (x >= this.mapX && x <= this.mapX + this.mapWidth && y >= this.mapY && y <= this.mapY + this.mapHeight) {
      this.following = false;
      this.cameraX = (x - this.mapX) / this.mapWidth * this.worldWidth * TILE;
      this.cameraY = (y - this.mapY) / this.mapHeight * this.worldHeight * TILE;
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x, y, startX: x, startY: y, moved: false, miner: this.hitMiner(x, y)?.miner.agentId });
    if (this.pointers.size === 2) {
      const values = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(values[0]!.x - values[1]!.x, values[0]!.y - values[1]!.y);
      this.pinchX = (values[0]!.x + values[1]!.x) / 2;
      this.pinchY = (values[0]!.y + values[1]!.y) / 2;
      for (const pointer of values) pointer.moved = true;
    }
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    const bounds = this.canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const pointer = this.pointers.get(event.pointerId);
    if (pointer) {
      const dx = x - pointer.x;
      const dy = y - pointer.y;
      pointer.x = x; pointer.y = y;
      if (Math.hypot(x - pointer.startX, y - pointer.startY) > 5) pointer.moved = true;
      if (this.pointers.size === 2) {
        const values = [...this.pointers.values()];
        const distance = Math.hypot(values[0]!.x - values[1]!.x, values[0]!.y - values[1]!.y);
        const midX = (values[0]!.x + values[1]!.x) / 2;
        const midY = (values[0]!.y + values[1]!.y) / 2;
        this.pan(this.pinchX - midX, this.pinchY - midY);
        if (this.pinchDistance > 0) this.zoomAt(distance / this.pinchDistance, midX, midY);
        this.pinchDistance = distance; this.pinchX = midX; this.pinchY = midY;
      } else if (this.pointers.size === 1 && !pointer.miner && pointer.moved) {
        this.pan(-dx, -dy);
        this.canvas.style.cursor = 'grabbing';
      }
      return;
    }
    this.hovered = this.hitMiner(x, y)?.miner.agentId;
    this.hoveredMessage = undefined;
    for (const marker of this.messages) {
      if (marker.shown && Math.abs(x - marker.x) <= 10 && y >= marker.y - 13 && y <= marker.y + 4) this.hoveredMessage = marker.message.sequence;
    }
    this.canvas.style.cursor = this.hovered || this.hoveredMessage !== undefined ? 'pointer' : 'grab';
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    this.pointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (!pointer.moved) {
      this.select(pointer.miner);
      this.onSelect(pointer.miner);
    }
    this.pinchDistance = 0;
    this.canvas.style.cursor = 'grab';
  };

  private readonly pointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    this.pinchDistance = 0;
    this.canvas.style.cursor = 'grab';
  };

  private readonly pointerLeave = (): void => { this.hovered = undefined; this.hoveredMessage = undefined; };

  private readonly wheel = (event: WheelEvent): void => {
    if (!this.snapshot) return;
    event.preventDefault();
    const bounds = this.canvas.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
    this.zoomAt(Math.exp(-delta * 0.0015), event.clientX - bounds.left, event.clientY - bounds.top);
  };

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.target !== this.canvas || document.activeElement !== this.canvas || event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 128 : 48;
    switch (event.key) {
      case 'ArrowLeft': this.pan(-step, 0); break;
      case 'ArrowRight': this.pan(step, 0); break;
      case 'ArrowUp': this.pan(0, -step); break;
      case 'ArrowDown': this.pan(0, step); break;
      case '+': case '=': this.zoomBy(1.25); break;
      case '-': case '_': this.zoomBy(0.8); break;
      case 'f': case 'F': this.follow(!this.following); break;
      case 'Escape': this.select(undefined); this.onSelect(undefined); break;
      default: return;
    }
    event.preventDefault();
  };
}

function compareMiners(left: RenderMiner, right: RenderMiner): number {
  return left.y - right.y || left.sortId - right.sortId;
}
