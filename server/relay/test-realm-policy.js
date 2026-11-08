'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create}=require('./lanplay-realms');
const {setTimeout:delay}=require('node:timers/promises');
async function until(fn){const end=Date.now()+3000;while(Date.now()<end){if(fn())return;await delay(10);}throw Error('timeout');}
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'realm-policy-')),file=path.join(dir,'child.cjs'),started=path.join(dir,'started');
 fs.writeFileSync(file,`require('fs').appendFileSync(${JSON.stringify(started)},process.env.LANYWHERE_LANPLAY_REALM+'\\n');process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),30));process.send({type:'ready',port:1234});setInterval(()=>{},1000);`);
 const manager=create({providers:['one','two','three','four','five'].map(id=>({id})),serverFile:file,idleMs:65000,maxRealms:3,...options});
 t.after(async()=>{await manager.shutdown();assert.deepEqual(manager.snapshot(),[]);fs.rmSync(dir,{recursive:true,force:true});});return{manager,started};
}
test('rapid directory-only browsing reclaims idle caches without exceeding three realms',async t=>{
 const events=[],{manager:m}=fixture(t,{onEvent:e=>events.push(e)});
 for(const provider of m.providers){const lease=await provider.acquire();lease.release();assert(m.snapshot().length<=3);}
 assert(events.filter(e=>e.reason==='query_cache_recycled').length===2);assert(m.snapshot().every(r=>r.refs===0));
});
test('simultaneous requests for a new community reserve before another allocator can evict it',async t=>{
 const {manager:m,started}=fixture(t);const held=await m.providers[0].acquire();
 for(const p of m.providers.slice(1,3)){const lease=await p.acquire();lease.release();}
 const [a,b]=await Promise.all([m.providers[3].acquire(),m.providers[3].acquire()]);
 const state=m.snapshot();assert.equal(state.length,3);assert.equal(state.find(r=>r.id==='four').refs,2);assert.equal(state.find(r=>r.id==='one').refs,1);
 assert.equal(fs.readFileSync(started,'utf8').trim().split('\n').filter(s=>s==='four').length,1);
 a.release();b.release();held.release();
});
test('three held leases reject capacity and shutdown does not start a waiting replacement',async t=>{
 const {manager:m}=fixture(t,{idleMs:10});const leases=await Promise.all(m.providers.slice(0,3).map(p=>p.acquire()));
 const ids=m.snapshot().map(r=>r.pid);await assert.rejects(m.providers[3].acquire(),e=>e.code==='REALM_CAPACITY');assert.deepEqual(m.snapshot().map(r=>r.pid),ids);
 leases[0].release();await until(()=>m.snapshot().find(r=>r.id==='one')?.stopping);
 const waiting=assert.rejects(m.providers[0].acquire(),/unavailable/);await m.shutdown();await waiting;
 for(const lease of leases)lease.release();assert.deepEqual(m.snapshot(),[]);
});
