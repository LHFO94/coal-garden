import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, reset, evictDurableObject } from 'cloudflare:test';
import { initializeSchema, MetricsStore } from '../src/worker/storage';
import { generateWorld, manhattan } from '../src/shared/world';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const make = () => { const runId=crypto.randomUUID(); return {runId,mine:env.MINES.getByName('mine:'+runId)}; };
describe('durable mine identity and controls',()=>{
 it('never creates a mine on a read, and preserves its seed across eviction',async()=>{
  const {runId,mine}=make();
  await expect(Promise.resolve(mine.getSnapshot())).rejects.toMatchObject({code:'RUN_NOT_FOUND',status:404});
  const first=await mine.initialize({runId,seed:42});
  expect(first.miners).toEqual([]);expect(first.run.mode).toBe('paused');
  expect(first.tiles).toHaveLength(96*64);
  expect(first.run.availableCoal).toBe(first.run.initialCoal);
  expect(first.run.availableDiamonds).toBe(first.run.initialDiamonds);expect(first.run.initialDiamonds).toBeGreaterThan(0);
  await evictDurableObject(mine);
  expect((await mine.getSnapshot()).run).toMatchObject({runId,seed:42,initialCoal:first.run.initialCoal,initialDiamonds:first.run.initialDiamonds});
  await expect(Promise.resolve(mine.initialize({runId,seed:43}))).rejects.toMatchObject({code:'OPERATION_CONFLICT',status:409});
 });
 it('replays exact commands after generation changes and rejects operation conflicts',async()=>{
  const {runId,mine}=make();await mine.initialize({runId,seed:42});
  const spawn={type:'spawn' as const,count:2,operationId:crypto.randomUUID()};
  const receipt=await mine.command(spawn);
  await mine.command({type:'resume',operationId:crypto.randomUUID()});
  await mine.command({type:'pause',operationId:crypto.randomUUID()});
  expect(await mine.command(spawn)).toEqual(receipt);
  expect((await mine.getSnapshot()).miners).toHaveLength(2);
  await expect(Promise.resolve(mine.command({...spawn,count:3}))).rejects.toMatchObject({code:'OPERATION_CONFLICT',status:409});
  const snap=await mine.getSnapshot();expect(snap.run.generation).toBe(2);
  expect(snap.run.initialCoal).toBe(snap.run.availableCoal+snap.run.reservedCoal+snap.run.minedCoal);
  expect(snap.run.initialDiamonds).toBe(snap.run.availableDiamonds+snap.run.reservedDiamonds+snap.run.minedDiamonds);
 });
 it('spawns on floor across the map, reveals only local areas, and preserves positions on replay and eviction',async()=>{
  const {runId,mine}=make();const initial=await mine.initialize({runId,seed:42});
  const terrain=generateWorld(42);const floors=terrain.filter(tile=>tile.terrain==='floor');
  const first={type:'spawn' as const,count:1,operationId:crypto.randomUUID()};
  const second={type:'spawn' as const,count:1,operationId:crypto.randomUUID()};
  const random=vi.spyOn(Math,'random').mockReturnValue(0);
  const receipt=await mine.command(first);
  random.mockReturnValue(1-Number.EPSILON);
  await mine.command(second);
  const snapshot=await mine.getSnapshot();
  expect(snapshot.miners[0]).toMatchObject({x:floors[0]!.x,y:floors[0]!.y});
  expect(snapshot.miners[1]).toMatchObject({x:floors.at(-1)!.x,y:floors.at(-1)!.y});
  for(const tile of snapshot.tiles){
   const visible=initial.tiles[tile.key]!.visible||snapshot.miners.some(miner=>manhattan(tile,miner)<=3);
   expect(tile.visible).toBe(visible);
   if(visible) expect(tile.terrain).toBe(terrain[tile.key]!.terrain);
  }
  expect(snapshot.run.initialCoal).toBe(snapshot.run.availableCoal+snapshot.run.reservedCoal+snapshot.run.minedCoal);
  expect(snapshot.run.initialDiamonds).toBe(snapshot.run.availableDiamonds+snapshot.run.reservedDiamonds+snapshot.run.minedDiamonds);
  await evictDurableObject(mine);
  expect(await mine.command(first)).toEqual(receipt);
  const replay=await mine.getSnapshot();
  expect(replay.miners.map(({agentId,x,y})=>({agentId,x,y}))).toEqual(snapshot.miners.map(({agentId,x,y})=>({agentId,x,y})));
  expect(replay.tiles).toEqual(snapshot.tiles);
 });
 it('keeps retired identities and treats stop as terminal without fencing peers',async()=>{
  const {runId,mine}=make();await mine.initialize({runId,seed:42});
  await mine.command({type:'spawn',count:2,operationId:crypto.randomUUID()});
  await mine.command({type:'resume',operationId:crypto.randomUUID()});
  const generation=(await mine.getSnapshot()).run.generation;
  await mine.command({type:'retire',agentId:'1',operationId:crypto.randomUUID()});
  const s=await mine.getSnapshot();expect(s.run.generation).toBe(generation);expect(s.miners.map(m=>m.retired)).toEqual([true,false]);
  const stop={type:'stop' as const,operationId:crypto.randomUUID()};const receipt=await mine.command(stop);
  expect(await mine.command(stop)).toEqual(receipt);
  await expect(Promise.resolve(mine.command({type:'resume',operationId:crypto.randomUUID()}))).rejects.toMatchObject({code:'RUN_STOPPED',status:409});
 });
 it('enforces exclusive physical actions and nonnegative resources in SQLite',async()=>{
  const {runId,mine}=make();await mine.initialize({runId,seed:42});
  await runInDurableObject(mine,(_instance,state)=>{
   initializeSchema(state.storage.sql);
   const sql=state.storage.sql;
   const add=(id:string,miner:string,target:number)=>sql.exec("INSERT INTO cg_actions(action_id,effect_id,agent_id,kind,generation,target_key,ends_at,status,data) VALUES(?,?,?,'mine',0,?,100,'accepted','{}')",id,id,miner,target).toArray();
   add('a','1',50);expect(()=>add('b','2',50)).toThrow();expect(()=>add('c','1',51)).toThrow();
   expect(()=>sql.exec('UPDATE cg_tiles SET available=-1 WHERE key=1').toArray()).toThrow();
   sql.exec("UPDATE cg_tiles SET terrain='diamond',reserved=50 WHERE key=1").toArray();
   expect(()=>sql.exec('UPDATE cg_tiles SET reserved=-1 WHERE key=1').toArray()).toThrow();
   sql.exec("UPDATE cg_actions SET status='cancelled' WHERE action_id='a'").toArray();add('b','2',50);
  });
 });
 it('bounds one-second storage and preserves cumulative distributions',async()=>{
  const {runId,mine}=make();await mine.initialize({runId,seed:42});
  await runInDurableObject(mine,(_instance,state)=>{
   const metrics=new MetricsStore(state.storage.sql);
   metrics.sample({calls:2},0);metrics.sample({calls:3},3_601_000);
   expect(metrics.recentSamples(3_601_000)).toEqual([{second:3601,calls:3,coal:0,diamonds:0,value:0,errors:0,toolRPCs:0,deliveryMs:0}]);
   [1,2,3,250].forEach(n=>metrics.histogram('rpc',n));
   expect(metrics.summary('rpc')).toMatchObject({count:4,p50:2,p95:256,p99:256});
  });
 });
});
