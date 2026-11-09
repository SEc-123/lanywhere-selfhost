'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const A=require('./appointments');
const user=Buffer.from('01010101010101010101010101010101','hex');
function req(op,{who=user,offset=0,id=0n,starts=0n,game=0n,app=0n}={}) {const b=Buffer.alloc(56);b[0]=op;b.writeUInt32LE(offset,4);who.copy(b,8);b.writeBigUInt64LE(id,24);b.writeBigUInt64LE(starts,32);b.writeBigUInt64LE(game,40);b.writeBigUInt64LE(app,48);return b;}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'appointment-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'appointments.json');}
const status=b=>b.readUInt32LE(0),count=b=>b.readUInt32LE(4),id=b=>b.readBigUInt64LE(24);
test('readiness window, five-minute renewal and event expiry',async t=>{
 const f=fixture(t);let now=1000000;const s=A.create({filename:f,now:()=>now});
 for(const delta of [-1,604801])assert.equal(status(await s.handle(req(2,{starts:BigInt(now+delta),game:1n}))),2);
 assert.equal(status(await s.handle(req(2,{starts:BigInt(now+1),game:0xffffffffffffffffn}))),2);
 assert.equal(status(await s.handle(Buffer.alloc(55))),2);const invalid=req(1);invalid[1]=1;assert.equal(status(await s.handle(invalid)),2);
 const created=await s.handle(req(2,{starts:BigInt(now+1801),game:1n})),event=id(created);assert.equal(count(created),1);assert.equal(created.readUInt32LE(56),0);assert.equal(created[60],0);
 assert.equal(status(await s.handle(req(3,{id:event}))),2,'too early');now++;
 let ready=await s.handle(req(3,{id:event}));assert.equal(ready.readUInt32LE(56),1);assert.equal(ready[60],1);
 now+=299;assert.equal((await s.handle(req(1)))[60],1);now++;assert.equal((await s.handle(req(1)))[60],0,'lease expires after five minutes');
 ready=await s.handle(req(3,{id:event}));assert.equal(ready[60],1);now+=1800+7200;assert.equal(count(await s.handle(req(1))),0);assert.equal(status(await s.handle(req(3,{id:event}))),4);
});
test('events deduplicate by both app and LCID; readiness is exclusive and never persisted',async t=>{
 const f=fixture(t),now=1000000,s=A.create({filename:f,now:()=>now});const other=Buffer.alloc(16,2);
 const a=await s.handle(req(2,{who:other,starts:BigInt(now+100),game:42n,app:8n}));const aid=id(a);
 const again=await s.handle(req(2,{starts:BigInt(now+100),game:42n,app:8n}));assert.equal(id(again),aid);assert.equal(again.readUInt32LE(56),0);
 const b=await s.handle(req(2,{starts:BigInt(now+101),game:42n,app:9n}));const bid=b.readBigUInt64LE(64);assert.notEqual(aid,bid);
 await s.handle(req(3,{id:bid}));let page=await s.handle(req(1));assert.equal(id(page),bid);assert.equal(page[60],1);
 page=await s.handle(req(3,{id:aid}));assert.equal(id(page),aid);assert.equal(page[60],1);assert.equal(page.readUInt32LE(64+32),0);
 await s.handle(req(4,{id:bid}));page=await s.handle(req(4,{id:aid}));assert.equal(page[60],0);assert.equal(count(page),2,'cancel never deletes event');
 await s.handle(req(3,{id:aid}));const saved=JSON.parse(fs.readFileSync(f));assert.equal(saved.version,2);
 for(const row of saved.events)assert.deepEqual(Object.keys(row).sort(),['app','game','id','starts']);
 assert(!JSON.stringify(saved).includes(user.toString('hex')));
 const reopened=A.create({filename:f,now:()=>now}),list=await reopened.handle(req(1));assert.equal(count(list),2);assert.equal(list.readUInt32LE(56),0);assert.equal(list[60],0);
});
test('create retry after start preserves the existing event without creating a past event',async t=>{
 const f=fixture(t);let now=1000000;const s=A.create({filename:f,now:()=>now}),start=1000001n;
 const first=await s.handle(req(2,{starts:start,game:42n,app:9n}));now+=2;
 const retry=await s.handle(req(2,{starts:start,game:42n,app:9n}));assert.equal(status(retry),0);assert.equal(id(retry),id(first));
 assert.equal(status(await s.handle(req(2,{starts:start,game:43n,app:9n}))),2);
});
test('legacy v1 state migrates atomically without participant records; failures retain evidence',async t=>{
 const f=fixture(t),legacy={version:1,events:[{id:'7',starts:'1000100',game:'42',app:'9',followers:['01010101010101010101010101010101']}]};fs.writeFileSync(f,JSON.stringify(legacy));
 const s=A.create({filename:f,now:()=>1000000}),list=await s.handle(req(1));assert.equal(status(list),0);assert.equal(id(list),7n);assert.equal(list.readUInt32LE(56),0);
 const state=JSON.parse(fs.readFileSync(f));assert.equal(state.version,2);assert.deepEqual(Object.keys(state.events[0]).sort(),['app','game','id','starts']);
 fs.writeFileSync(f,JSON.stringify(legacy));const before=fs.readFileSync(f),rename=fs.promises.rename;
 try {fs.promises.rename=()=>{throw Error('injected migration failure');};const failed=A.create({filename:f,now:()=>1000000});assert.equal(status(await failed.handle(req(1))),5);}
 finally {fs.promises.rename=rename;}
 assert.deepEqual(fs.readFileSync(f),before);assert.deepEqual(fs.readdirSync(path.dirname(f)),['appointments.json']);
});
test('corrupt and unwritable persistent data fail closed without replacing evidence',async t=>{
 const f=fixture(t);fs.writeFileSync(f,'bad-json');const s=A.create({filename:f,now:()=>1000000});assert.equal(status(await s.handle(req(1))),5);assert.equal(status(await s.handle(req(2,{starts:1000100n,game:1n}))),5);assert.equal(fs.readFileSync(f,'utf8'),'bad-json');
 const broken=A.create({filename:path.join(path.dirname(f),'missing','state.json'),now:()=>1000000});assert.equal(status(await broken.handle(req(1))),5);
});
test('failed atomic rename does not acknowledge or mutate last committed state',async t=>{
 const f=fixture(t),s=A.create({filename:f,now:()=>1000000});assert.equal(status(await s.handle(req(2,{starts:1000100n,game:1n}))),0);
 const before=fs.readFileSync(f),rename=fs.promises.rename;
 try {fs.promises.rename=()=>{throw Error('simulated write failure');};assert.equal(status(await s.handle(req(2,{starts:1000200n,game:2n}))),5);}
 finally {fs.promises.rename=rename;}
 assert.deepEqual(fs.readFileSync(f),before);assert.deepEqual(fs.readdirSync(path.dirname(f)),['appointments.json']);
 assert.equal(count(await A.create({filename:f,now:()=>1000000}).handle(req(1))),1);
});
test('slow writes leave loop responsive, expose committed snapshot and cap queue',async t=>{
 const f=fixture(t),s=A.create({filename:f,now:()=>1000000}),rename=fs.promises.rename;
 let release,entered;const gate=new Promise(r=>release=r),atRename=new Promise(r=>entered=r);
 try {
  fs.promises.rename=async (...args)=>{entered();await gate;return rename(...args);};
  const first=s.handle(req(2,{starts:1000100n,game:1n}));await atRename;
  assert(await new Promise(resolve=>setTimeout(()=>resolve(true),10)));assert.equal(count(await s.handle(req(1))),0);
  const same=Array.from({length:63},()=>s.handle(req(2,{starts:1000100n,game:1n})));
  assert.equal(status(await s.handle(req(2,{starts:1000200n,game:2n}))),3);
  release();assert((await Promise.all([first,...same])).every(x=>status(x)===0));assert.equal(count(await s.handle(req(1))),1);
 } finally {release();fs.promises.rename=rename;}
});
test('queued request disconnected before execution is discarded',async t=>{
 const f=fixture(t),s=A.create({filename:f,now:()=>1000000}),rename=fs.promises.rename;
 let release,entered,connected=true;const gate=new Promise(r=>release=r),atRename=new Promise(r=>entered=r);
 try {fs.promises.rename=async (...args)=>{entered();await gate;return rename(...args);};
  const first=s.handle(req(2,{starts:1000100n,game:1n}));await atRename;
  const cancelled=s.handle(req(2,{starts:1000200n,game:2n}),true,()=>connected);connected=false;release();
  assert.equal(status(await first),0);assert.equal(await cancelled,null);assert.equal(count(await s.handle(req(1))),1);
 } finally {release();fs.promises.rename=rename;}
});
test('disconnect before atomic rename cancels and removes temporary file',async t=>{
 const f=fixture(t),s=A.create({filename:f,now:()=>1000000}),open=fs.promises.open;
 let release,entered,connected=true;const gate=new Promise(r=>release=r),atSync=new Promise(r=>entered=r);
 try {fs.promises.open=async (...args)=>{const fd=await open(...args);if(String(args[0]).endsWith('.tmp')) {const sync=fd.sync.bind(fd);fd.sync=async()=>{entered();await gate;return sync();};}return fd;};
  const action=s.handle(req(2,{starts:1000100n,game:1n}),true,()=>connected);await atSync;connected=false;release();
  assert.equal(await action,null);assert.deepEqual(fs.readdirSync(path.dirname(f)),[]);assert.equal(count(await s.handle(req(1))),0);
 } finally {release();fs.promises.open=open;}
});
