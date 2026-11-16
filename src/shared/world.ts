import { HOPPER, RESOURCE_VALUES, WORLD_HEIGHT, WORLD_WIDTH, type ResourceTarget, type Coordinate, type Frontier, type Tile } from './protocol';

export const tileKey = (x: number, y: number): number => y * WORLD_WIDTH + x;
export const coordinate = (key: number): Coordinate => ({ x: key % WORLD_WIDTH, y: Math.floor(key / WORLD_WIDTH) });
export const manhattan = (a: Coordinate, b: Coordinate): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const inside = (p: Coordinate): boolean => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < WORLD_WIDTH && p.y >= 0 && p.y < WORLD_HEIGHT;
/** World-bounded neighbors, in the authoritative N/E/S/W order. */
export function neighbors(p: Coordinate): Coordinate[] {
  return [{ x: p.x, y: p.y - 1 }, { x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }].filter(inside);
}
const floor = (tile: Tile | undefined, allowUnseenFloor = false): tile is Tile => tile?.terrain === 'floor' && (tile.visible || allowUnseenFloor);
const indexTiles = (tiles: ReadonlyArray<Tile>): Map<number, Tile> => new Map(tiles.map(tile => [tile.key, tile]));
const spatialOrder = (a: Coordinate, b: Coordinate): number => a.y - b.y || a.x - b.x;

export function generateWorld(seed: number): Tile[] {
  let state = (seed >>> 0) || 1;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const tiles: Tile[] = [];
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let x = 0; x < WORLD_WIDTH; x++) {
      const border = x === 0 || y === 0 || x === WORLD_WIDTH - 1 || y === WORLD_HEIGHT - 1;
      const corridor = [3, 4, 5].includes(x % 8) || [3, 4, 5].includes(y % 8);
      tiles.push({ key: tileKey(x, y), x, y, terrain: !border && corridor ? 'floor' : 'rock', visible: manhattan({ x, y }, { x: 4, y: 4 }) <= 3 || x === HOPPER.x && y === HOPPER.y, available: 0, reserved: 0 });
    }
  }
  // Only original floor participates: generated resources never change eligibility.
  for (const tile of tiles) {
    if (tile.terrain !== 'rock' || tile.x === 0 || tile.y === 0 || tile.x === WORLD_WIDTH - 1 || tile.y === WORLD_HEIGHT - 1) continue;
    if (!neighbors(tile).some(p => tiles[tileKey(p.x, p.y)]!.terrain === 'floor')) continue;
    const draw = random();
    if (draw < 0.35) {
      tile.terrain = draw < 0.035 ? 'diamond' : 'coal';
      tile.available = 1;
    }
  }
  return tiles;
}

/** Newly revealed complete records; neither the array nor its records are mutated. */
export function reveal(tiles: ReadonlyArray<Tile>, origin: Coordinate, radius: number): Tile[] {
  return tiles.filter(tile => !tile.visible && manhattan(tile, origin) <= radius).map(tile => ({ ...tile, visible: true }));
}

export function distances(tiles: ReadonlyArray<Tile>, origin: Coordinate): Map<number, number> {
  const index = indexTiles(tiles);
  const start = tileKey(origin.x, origin.y);
  const result = new Map<number, number>();
  if (!inside(origin) || !floor(index.get(start))) return result;
  const queue = [start];
  result.set(start, 0);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const key = queue[cursor]!;
    for (const p of neighbors(coordinate(key))) {
      const next = tileKey(p.x, p.y);
      if (!result.has(next) && floor(index.get(next))) {
        result.set(next, result.get(key)! + 1);
        queue.push(next);
      }
    }
  }
  return result;
}

interface SearchNode { key: number; cost: number; score: number; order: number }
/** A* with a stable priority queue; ties preserve N/E/S/W insertion order. */
export function findPath(tiles: ReadonlyArray<Tile>, origin: Coordinate, destination: Coordinate, allowUnseenFloor = false): Coordinate[] | null {
  const index = indexTiles(tiles);
  const start = tileKey(origin.x, origin.y);
  const goal = tileKey(destination.x, destination.y);
  if (!inside(origin) || !inside(destination) || !floor(index.get(start), allowUnseenFloor) || !floor(index.get(goal), allowUnseenFloor)) return null;
  const costs = new Map<number, number>([[start, 0]]);
  const previous = new Map<number, number>();
  const heap: SearchNode[] = [];
  let order = 0;
  const before = (a: SearchNode, b: SearchNode): boolean => a.score < b.score || (a.score === b.score && a.order < b.order);
  const push = (node: SearchNode): void => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (!before(node, heap[parent]!)) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = node;
  };
  const pop = (): SearchNode => {
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && before(heap[child + 1]!, heap[child]!)) child++;
        if (!before(heap[child]!, last)) break;
        heap[i] = heap[child]!;
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  push({ key: start, cost: 0, score: manhattan(origin, destination), order: order++ });
  while (heap.length) {
    const current = pop();
    if (current.cost !== costs.get(current.key)) continue;
    if (current.key === goal) {
      const path: Coordinate[] = [];
      for (let key = goal; key !== start; key = previous.get(key)!) path.push(coordinate(key));
      return path.reverse();
    }
    for (const p of neighbors(coordinate(current.key))) {
      const key = tileKey(p.x, p.y);
      const cost = current.cost + 1;
      if (!floor(index.get(key), allowUnseenFloor) || cost >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, cost);
      previous.set(key, current.key);
      push({ key, cost, score: cost + manhattan(p, destination), order: order++ });
    }
  }
  return null;
}

function reachableKnowledge(tiles: ReadonlyArray<Tile>, self: Coordinate): { resourceTargets: ResourceTarget[]; frontiers: Frontier[] } {
  const index = indexTiles(tiles);
  const reachable = distances(tiles, self);
  const resourceTargets: ResourceTarget[] = [];
  const frontiers: Frontier[] = [];
  for (const tile of tiles) {
    if (!tile.visible) continue;
    if ((tile.terrain === 'coal' || tile.terrain === 'diamond') && tile.available + tile.reserved > 0) {
      const approaches = neighbors(tile).filter(p => reachable.has(tileKey(p.x, p.y)));
      approaches.sort((a, b) => reachable.get(tileKey(a.x, a.y))! - reachable.get(tileKey(b.x, b.y))! || spatialOrder(a, b));
      const destination = approaches[0];
      if (destination) resourceTargets.push({ x: tile.x, y: tile.y, resource: tile.terrain, unitValue: RESOURCE_VALUES[tile.terrain], available: tile.available, reserved: tile.reserved, ...(tile.claimant === undefined ? {} : { claimant: tile.claimant }), destination, distance: reachable.get(tileKey(destination.x, destination.y))! });
    }
    const distance = reachable.get(tile.key);
    if (distance !== undefined && neighbors(tile).some(p => index.get(tileKey(p.x, p.y))?.visible === false)) frontiers.push({ x: tile.x, y: tile.y, distance });
  }
  resourceTargets.sort((a, b) => b.unitValue - a.unitValue || a.distance - b.distance || spatialOrder(a, b));
  frontiers.sort((a, b) => a.distance - b.distance || spatialOrder(a, b));
  return { resourceTargets, frontiers };
}

export function projectKnowledge(tiles: ReadonlyArray<Tile>, self: Coordinate): { localTiles: Tile[]; resourceTargets: ResourceTarget[]; frontiers: Frontier[]; truncated: { localTiles: boolean; resourceTargets: boolean; frontiers: boolean } } {
  const { resourceTargets, frontiers } = reachableKnowledge(tiles, self);
  return {
    localTiles: tiles.filter(tile => tile.visible && manhattan(tile, self) <= 8).sort(spatialOrder).map(tile => ({ ...tile })),
    resourceTargets: resourceTargets.slice(0, 8),
    frontiers: frontiers.slice(0, 8),
    truncated: { localTiles: false, resourceTargets: resourceTargets.length > 8, frontiers: frontiers.length > 8 },
  };
}

export function isExhausted(tiles: ReadonlyArray<Tile>, self: Coordinate): boolean {
  const knowledge = reachableKnowledge(tiles, self);
  return knowledge.resourceTargets.length === 0 && knowledge.frontiers.length === 0;
}
