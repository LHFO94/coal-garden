import { describe, expect, it } from 'vitest';
import { HOPPER, WORLD_HEIGHT, WORLD_WIDTH, type Coordinate, type Tile } from '../src/shared/protocol';
import { coordinate, distances, findPath, generateWorld, isExhausted, manhattan, neighbors, projectKnowledge, reveal, tileKey } from '../src/shared/world';

const cell = (x: number, y: number, terrain: Tile['terrain'] = 'floor', visible = true, available = terrain === 'coal' || terrain === 'diamond' ? 1 : 0): Tile => ({ x, y, key: tileKey(x, y), terrain, visible, available, reserved: 0 });
const at = (tiles: Tile[], x: number, y: number): Tile => tiles[tileKey(x, y)]!;

describe('seeded world', () => {
  it('is reproducible, normalizes zero, and produces row-major coordinate keys', () => {
    const tiles = generateWorld(42);
    expect(tiles).toEqual(generateWorld(42));
    expect(generateWorld(0)).toEqual(generateWorld(1));
    expect(tiles).not.toEqual(generateWorld(43));
    expect(tiles).toHaveLength(96 * 64);
    for (const [key, tile] of tiles.entries()) {
      expect(tile.key).toBe(key);
      expect(coordinate(key)).toEqual({ x: tile.x, y: tile.y });
    }
  });

  it('keeps border/corridor topology and generates single-unit edge deposits with rarer diamonds', () => {
    const tiles = generateWorld(42);
    let coalCells = 0;
    let diamondCells = 0;
    for (const tile of tiles) {
      const border = tile.x === 0 || tile.y === 0 || tile.x === WORLD_WIDTH - 1 || tile.y === WORLD_HEIGHT - 1;
      const corridor = [3, 4, 5].includes(tile.x % 8) || [3, 4, 5].includes(tile.y % 8);
      if (border) expect(tile.terrain).toBe('rock');
      else if (corridor) expect(tile.terrain).toBe('floor');
      if (tile.terrain === 'coal' || tile.terrain === 'diamond') {
        if (tile.terrain === 'coal') coalCells++; else diamondCells++;
        expect(neighbors(tile).some(p => at(tiles, p.x, p.y).terrain === 'floor')).toBe(true);
        expect(tile.available).toBe(1);
      } else expect(tile.available).toBe(0);
      expect(tile.reserved).toBe(0);
    }
    expect(diamondCells).toBeGreaterThan(0);
    expect(coalCells).toBeGreaterThan(diamondCells);
    expect(diamondCells / (coalCells + diamondCells)).toBeGreaterThan(0.05);
    expect(diamondCells / (coalCells + diamondCells)).toBeLessThan(0.15);
  });

  it('matches one independent row-major xorshift draw per eligible cell for both resources', () => {
    const tiles = generateWorld(42);
    let state = 42;
    for (const tile of tiles) {
      const interior = tile.x > 0 && tile.y > 0 && tile.x < 95 && tile.y < 63;
      const originalRock = !([3, 4, 5].includes(tile.x % 8) || [3, 4, 5].includes(tile.y % 8));
      if (!interior || !originalRock || !neighbors(tile).some(p => at(tiles, p.x, p.y).terrain === 'floor')) continue;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const draw = (state >>> 0) / 4294967296;
      expect(tile.terrain).toBe(draw < 0.035 ? 'diamond' : draw < 0.35 ? 'coal' : 'rock');
    }
  });

  it('reveals the spawn region and global hopper without exposing distant ore', () => {
    const tiles = generateWorld(42);
    expect(tiles.filter(tile => tile.visible)).toHaveLength(26);
    for (const tile of tiles) expect(tile.visible).toBe(manhattan(tile, { x: 4, y: 4 }) <= 3 || tile.x === HOPPER.x && tile.y === HOPPER.y);
    expect(at(tiles, HOPPER.x, HOPPER.y).terrain).toBe('floor');
  });
});

describe('legal movement', () => {
  it('returns N/E/S/W neighbors and stable shortest A* ties without the origin', () => {
    expect(neighbors({ x: 4, y: 4 })).toEqual([{ x: 4, y: 3 }, { x: 5, y: 4 }, { x: 4, y: 5 }, { x: 3, y: 4 }]);
    const tiles = [cell(4, 4), cell(4, 3), cell(5, 4), cell(5, 3)];
    expect(findPath(tiles, { x: 4, y: 4 }, { x: 5, y: 3 })).toEqual([{ x: 4, y: 3 }, { x: 5, y: 3 }]);
    expect(findPath(tiles, { x: 4, y: 4 }, { x: 4, y: 4 })).toEqual([]);
    expect(distances(tiles, { x: 4, y: 4 }).get(tileKey(5, 3))).toBe(2);
  });

  it('never crosses fog, resource deposits, rock, missing cells, or diagonal gaps', () => {
    const origin = { x: 4, y: 4 };
    const destination = { x: 6, y: 4 };
    for (const middle of [cell(5, 4, 'floor', false), cell(5, 4, 'coal'), cell(5, 4, 'diamond'), cell(5, 4, 'rock')]) {
      expect(findPath([cell(4, 4), middle, cell(6, 4)], origin, destination)).toBeNull();
    }
    expect(findPath([cell(4, 4), cell(6, 4)], origin, destination)).toBeNull();
    expect(findPath([cell(4, 4), cell(5, 3)], origin, { x: 5, y: 3 })).toBeNull();
    expect(findPath([cell(4, 4)], origin, { x: 4, y: 4.5 })).toBeNull();
  });

  it('returns a complete long route so authority can accept a 32-step prefix', () => {
    const tiles = Array.from({ length: 51 }, (_, x) => cell(x + 1, 4));
    const path = findPath(tiles, { x: 1, y: 4 }, { x: 51, y: 4 })!;
    expect(path).toHaveLength(50);
    expect(path.slice(0, 32).at(-1)).toEqual({ x: 33, y: 4 });
    expect(path.at(-1)).toEqual({ x: 51, y: 4 });
    let previous: Coordinate = { x: 1, y: 4 };
    for (const next of path) {
      expect(manhattan(previous, next)).toBe(1);
      previous = next;
    }
  });
});

describe('shared knowledge', () => {
  it('reveals exactly radius six and returns new complete records without mutating input', () => {
    const tiles = generateWorld(42).map(tile => ({ ...tile, visible: false }));
    const before = tiles.map(tile => ({ ...tile }));
    const changed = reveal(tiles, { x: 40, y: 30 }, 6);
    expect(changed).toHaveLength(85);
    expect(changed.every(tile => tile.visible && manhattan(tile, { x: 40, y: 30 }) <= 6)).toBe(true);
    expect(tiles).toEqual(before);
    const updates = new Map(changed.map(tile => [tile.key, tile]));
    const applied = tiles.map(tile => updates.get(tile.key) ?? tile);
    expect(reveal(applied, { x: 40, y: 30 }, 6)).toEqual([]);
  });

  it('keeps fog and unreachable seams secret and supplies a legal nearest approach and claim owner', () => {
    const seam = { ...cell(6, 4, 'coal'), reserved: 5, available: 45, claimant: '2' };
    const tiles = [cell(4, 4), cell(5, 4), seam, cell(4, 3, 'diamond', false), cell(20, 20, 'diamond')];
    const knowledge = projectKnowledge(tiles, { x: 4, y: 4 });
    expect(knowledge.resourceTargets).toEqual([{ x: 6, y: 4, resource: 'coal', unitValue: 1, available: 45, reserved: 5, claimant: '2', destination: { x: 5, y: 4 }, distance: 1 }]);
    expect(knowledge.localTiles.some(tile => !tile.visible)).toBe(false);
    expect(knowledge.localTiles.every(tile => manhattan(tile, { x: 4, y: 4 }) <= 8)).toBe(true);
    expect(knowledge.frontiers).toEqual([{ x: 4, y: 4, distance: 0 }]);
  });

  it('bounds targets with diamonds first, then path distance and spatial ties; frontiers remain distance-first', () => {
    const tiles: Tile[] = [];
    for (let x = 1; x <= 12; x++) tiles.push(cell(x, 4), cell(x, 3, x >= 11 ? 'diamond' : 'coal'), cell(x, 5, 'rock', false));
    const result = projectKnowledge(tiles, { x: 1, y: 4 });
    expect(result.resourceTargets.map(tile => tile.x)).toEqual([11, 12, 1, 2, 3, 4, 5, 6]);
    expect(result.resourceTargets.slice(0, 2).every(target => target.resource === 'diamond' && target.unitValue === 10)).toBe(true);
    expect(result.frontiers.map(tile => tile.x)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.truncated).toEqual({ localTiles: false, resourceTargets: true, frontiers: true });
    const tie = projectKnowledge([cell(4, 4), cell(3, 4), cell(5, 4), cell(3, 3, 'diamond'), cell(5, 3, 'diamond')], { x: 4, y: 4 });
    expect(tie.resourceTargets.map(tile => tile.x)).toEqual([3, 5]);
  });

  it('exhausts only when both reachable resource kinds, reservations, and accessible frontiers are absent', () => {
    const origin = { x: 4, y: 4 };
    for (const resource of ['coal', 'diamond'] as const) {
      expect(isExhausted([cell(4, 4), cell(20, 20, resource)], origin)).toBe(true);
      expect(isExhausted([cell(4, 4), cell(5, 4, resource, true, 0)], origin)).toBe(true);
      expect(isExhausted([cell(4, 4), { ...cell(5, 4, resource, true, 0), reserved: 1 }], origin)).toBe(false);
      expect(isExhausted([cell(4, 4), cell(5, 4, resource)], origin)).toBe(false);
    }
    expect(isExhausted([cell(4, 4), cell(5, 4, 'rock', false)], origin)).toBe(false);
    expect(isExhausted([cell(4, 4), cell(20, 20), cell(20, 21, 'rock', false)], origin)).toBe(true);
  });
});
