'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const dgram=require('node:dgram'),net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events'),{setTimeout:delay}=require('node:timers/promises');
const {create:gateway}=require('./upstream-gateway'),{create:realms}=require('./lanplay-realms');
const {run}=require('./smoke-lanplay-upstream.cjs');
const L=require('./lanplay');
const until=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await delay(10);}throw Error('condition timeout');};

// Minimal independent standard relay: learns virtual sources, relays opaque
// IPv4 by destination, echoes PING. It contains no LANywhere/LDN room code.
async function standard(t,{echo='node'}={}) {
 const sock=dgram.createSocket('udp4'),clients=new Map(),ips=new Map();let forwarded=0,maxWire=0;
 sock.on('message',(m,r)=>{ const key=r.address+':'+r.port;clients.set(key,r);
  if(m[0]===2) { if(echo==='rust' && m.length!==5)return; return sock.send(echo==='rust'?m:m.subarray(0,4),r.port,r.address); }
  if(m[0]!==1)return;const p=L.parseIpv4(m.subarray(1));if(!p)return;
  ips.set(p.src,r);maxWire=Math.max(maxWire,m.length);
  const targets=(p.dst===L.BCAST||p.dst===0xffffffff)?[...clients.values()]:(ips.has(p.dst)?[ips.get(p.dst)]:[...clients.values()]);
  for(const x of targets)if(x&&(x.port!==r.port||x.address!==r.address)){forwarded++;sock.send(m,x.port,x.address);}
 });
 await new Promise(r=>sock.bind(0,'127.0.0.1',r));t.after(()=>sock.close());
 return {host:'127.0.0.1',port:sock.address().port,stats:()=>({forwarded,maxWire,clients:clients.size})};
}
function wire(s,type,b=Buffer.alloc(0)){const h=Buffer.alloc(3);h.writeUInt16LE(b.length+1);h[2]=type;s.write(Buffer.concat([h,b]));}
async function setup(t,up) {
 const configs=Array.isArray(up)?up:[{id:'lanplay-test',host:up.host,port:up.port}];
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lanplay-upstream-test-'));
 // Test-only bootstrap overrides the fixed registry in this child alone.
 const wrapper=path.join(dir,'child.cjs');
 fs.writeFileSync(wrapper,`require.cache[require.resolve(${JSON.stringify(path.join(__dirname,'lanplay-providers.js'))})]={exports:[${configs.map(x=>JSON.stringify({...x,allowPrivate:true})).join(',')}]};require(${JSON.stringify(path.join(__dirname,'server.js'))});`);
 const manager=realms({providers:configs,serverFile:wrapper,idleMs:100, startupMs:4000});
 const sockets=new Set(),udp=dgram.createSocket('udp4');let gw;
 const tcp=net.createServer(s=>{sockets.add(s);let p=Buffer.alloc(0);s.on('error',()=>{});s.on('data',b=>{p=Buffer.concat([p,b]);while(p.length>=3&&p.length>=p.readUInt16LE()+2){const n=p.readUInt16LE();gw.handleFrame(s,p[2],p.subarray(3,n+2));p=p.subarray(n+2);}});s.on('close',()=>{gw.onClose(s);sockets.delete(s);});});
 await new Promise(r=>tcp.listen(0,'127.0.0.1',r));const port=tcp.address().port;
 await new Promise(r=>udp.bind(port,'127.0.0.1',r));
 gw=gateway({providers:manager.providers,send:wire,sendUdp:(b,p,a)=>udp.send(b,p,a),graceMs:50});
 udp.on('message',(b,r)=>gw.handleDatagram(b,r));
 t.after(async()=>{gw.shutdown();for(const s of sockets)s.destroy();udp.close();await new Promise(r=>tcp.close(r));await manager.shutdown();assert.deepEqual(manager.snapshot(),[]);fs.rmSync(dir,{recursive:true,force:true});});
 return {port,manager,gw};
}
test('isolated LAN Play realm traverses an independent standard relay for discovery, LDN TCP and reversed 64..65507-byte UDP', {timeout:30000},async t=>{
 const up=await standard(t),g=await setup(t,up);
 assert.deepEqual(g.manager.snapshot(),[],'lazy startup');
 const report=await run({host:'127.0.0.1',port:g.port,provider:'lanplay-test',endpoint:up});
 assert.equal(report.status,'passed');assert(up.stats().forwarded>100);assert(up.stats().maxWire<=1401);
 await until(()=>g.manager.snapshot().length===0);
 assert.equal(g.gw.snapshot().connections,0);assert.equal(g.gw.snapshot().activeMembers,0);
});

test('two provider realms keep virtual addresses, discovered rooms and datagrams isolated', {timeout:30000}, async t=>{
 const a=await standard(t),b=await standard(t,{echo:'rust'});
 const g=await setup(t,[{id:'lanplay-one',host:a.host,port:a.port},{id:'lanplay-two',host:b.host,port:b.port}]);
 const results=await Promise.all([
  run({host:'127.0.0.1',port:g.port,provider:'lanplay-one',endpoint:a}),
  run({host:'127.0.0.1',port:g.port,provider:'lanplay-two',endpoint:b})]);
 assert(results.every(r=>r.status==='passed'));assert(a.stats().forwarded>100);assert(b.stats().forwarded>100);
 await until(()=>g.manager.snapshot().length===0);
});

test('LAN Play explicitly rejects private-room CREATE instead of pretending it is externally federated', {timeout:10000},async t=>{
 const up=await standard(t),g=await setup(t,up);const s=net.connect(g.port,'127.0.0.1');
 const frames=[];let pending=Buffer.alloc(0);s.on('data',b=>{pending=Buffer.concat([pending,b]);while(pending.length>=3&&pending.length>=pending.readUInt16LE()+2){const n=pending.readUInt16LE();frames.push(pending.subarray(2,n+2));pending=pending.subarray(n+2);}});s.on('error',()=>{});t.after(()=>s.destroy());await once(s,'connect');
 wire(s,0x20,Buffer.from('lanplay-test'));await until(()=>frames.some(f=>f[0]===0xa0));
 wire(s,1,Buffer.concat([Buffer.alloc(40),Buffer.from([1])]));await until(()=>frames.some(f=>f[0]===0x85));
 assert.equal(frames.find(f=>f[0]===0x85)[1],4);assert(!frames.some(f=>f[0]===0x81));
});

test('realm pages retain native host metadata while external LDN hosts have no fabricated title', {timeout:20000},async t=>{
 const up=await standard(t),g=await setup(t,up);
 const {Peer}=require('../../deploy/smoke-relay.cjs');const {Emu,networkInfo}=require('./lanplay-probe-peer');
 const native=new Peer('NativeMetadataHost','127.0.0.1',g.port),viewer=new Peer('MetadataViewer','127.0.0.1',g.port);
 const emu=new Emu(0x0a0d4444,'ExternalLegacyHost',up,0x7f00000000000112n);t.after(()=>{native.close();viewer.close();emu.close();});
 await emu.start();emu.host();
 for(const p of[native,viewer]){await p.connect();p.send(0x20,Buffer.from('lanplay-test'));const selected=await p.frame(0xa0);assert.equal(selected.readUInt32LE(),462);p.send(11);assert.equal((await p.frame(0x89)).readUInt32LE(),462);}
 const game=0x7f00000000000111n,gb=Buffer.alloc(8),nick=Buffer.alloc(32);gb.writeBigUInt64LE(game);nick.write('NativeMetadataHost');
 native.send(1,Buffer.concat([gb,nick,Buffer.from([1])]));const room=await native.frame(0x81);native.code=room.subarray(0,6);native.ip=room.readUInt32LE(7);
 const info=networkInfo(native.ip,'NativeMetadataHost');info.writeBigUInt64LE(game);native.send(7,info);
 const metadata=Buffer.alloc(272);metadata.writeBigUInt64LE(0x0100abcd12345000n);metadata.writeBigUInt64LE(0x0100abcd12345000n,8);metadata.write('Verified local host title',16);metadata.write('主机提供标题',144);native.send(0x21,metadata);native.send(5);await native.frame(0x86);
 let page;
 for(let i=0;i<10;i++){viewer.send(0x22,Buffer.alloc(12));page=await viewer.frame(0xa2);if(page[4]===2)break;await delay(400);}
 assert.equal(page[4],2);const records=[page.subarray(5,341),page.subarray(341,677)];
 const own=records.find(r=>r.readBigUInt64LE(8)===game),foreign=records.find(r=>r.readBigUInt64LE(8)===emu.game);
 assert(own&&foreign);assert.equal(own[34],1);assert.equal(own.readBigUInt64LE(16),0x0100abcd12345000n);assert.equal(own.subarray(80,208).toString().replace(/\0.*$/,''),'Verified local host title');
 assert.equal(foreign[34],0);assert.equal(foreign.readBigUInt64LE(16),0n);assert(foreign.subarray(80).equals(Buffer.alloc(256)));
 viewer.send(0x0c,Buffer.alloc(12));const oldPage=await viewer.frame(0x8a);assert.equal(oldPage[4],2);assert.equal(oldPage.length,5+2*(6+0x480));
 viewer.send(9,Buffer.alloc(0));const error=await until(()=>viewer.frames.some(f=>f[0]===0x85));void error;assert.equal(viewer.frames.find(f=>f[0]===0x85)[1],4);
 await native.leave();
});


test('concurrent acquire during idle teardown starts one replacement and shutdown cannot restart it', {timeout:10000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'realm-race-test-')),file=path.join(dir,'child.cjs'),started=path.join(dir,'starts');
 fs.writeFileSync(file,`require('fs').appendFileSync(${JSON.stringify(started)},String(process.pid)+'\\n');process.send({type:'ready',port:1234});process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),120));setInterval(()=>{},1000);`);
 const m=realms({providers:[{id:'race'}],serverFile:file,idleMs:10});t.after(async()=>{await m.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
 const acquire=m.providers[0].acquire,first=await acquire();first.release();await until(()=>m.snapshot()[0]?.stopping);
 const [a,b]=await Promise.all([acquire(),acquire()]);assert.equal(m.snapshot().length,1);assert.equal(m.snapshot()[0].refs,2);assert.equal(fs.readFileSync(started,'utf8').trim().split('\n').length,2);
 a.release();b.release();await until(()=>m.snapshot()[0]?.stopping);
 const waiting=assert.rejects(acquire(),/unavailable/);await m.shutdown();await waiting;assert.deepEqual(m.snapshot(),[]);
});

for (const variant of ['node','rust']) test(`upstream readiness accepts only pinned ${variant} nonce echo`, {timeout:10000}, async t=>{
 const socket=dgram.createSocket('udp4'),stranger=dgram.createSocket('udp4');
 await new Promise(r=>socket.bind(0,'127.0.0.1',r));await new Promise(r=>stranger.bind(0,'127.0.0.1',r));
 t.after(()=>{socket.close();stranger.close();});let ready=0,validSent=false,wireLength=0;
 socket.on('message',(m,r)=>{if(m[0]!==2)return;wireLength=m.length;
  const response=variant==='node'?m.subarray(0,4):m;
  stranger.send(response,r.port,r.address); // Correct nonce from the wrong endpoint must not authorize readiness.
  const wrong=Buffer.from(response);wrong[1]^=255;socket.send(wrong,r.port,r.address);
  socket.send(Buffer.concat([response,Buffer.from([variant==='node'?(m[4]^255):0])]),r.port,r.address); // Invalid length or suffix.
  setTimeout(()=>{assert.equal(ready,0);validSent=true;socket.send(response,r.port,r.address);},60);
 });
 const relay=L.create({port:0,upstream:{id:'probe',host:'127.0.0.1',port:socket.address().port,allowPrivate:true},
  rooms:new Map(),log:()=>{},count:()=>{},paused:()=>false,frame:()=>{},forwardData:()=>{},memberAt:()=>null,isOpen:()=>false,
  onReady:()=>{assert(validSent);ready++;}});
 t.after(()=>relay.close());await until(()=>ready===1);assert.equal(wireLength,5);
});

test('realm budget protects held member leases and recycles only released query caches', {timeout:10000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'realm-budget-')),file=path.join(dir,'child.cjs');
 fs.writeFileSync(file,`process.send({type:'ready',port:1234});setInterval(()=>{},1000);`);
 const m=realms({providers:[{id:'one'},{id:'two'},{id:'three'},{id:'four'}],serverFile:file,maxRealms:3,idleMs:10000});
 t.after(async()=>{await m.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
 const leases=await Promise.all(m.providers.slice(0,3).map(p=>p.acquire()));const pids=m.snapshot().map(r=>r.pid);
 await assert.rejects(m.providers[3].acquire(),e=>e.code==='REALM_CAPACITY');
 assert.deepEqual(m.snapshot().map(r=>r.pid),pids,'held member/resume leases cannot be evicted');
 leases[0].release();const fourth=await m.providers[3].acquire();
 assert.equal(m.snapshot().length,3);assert(m.snapshot().some(r=>r.pid===pids[1])&&m.snapshot().some(r=>r.pid===pids[2]));
 assert(!m.snapshot().some(r=>r.pid===pids[0]),'released query cache can be reclaimed under pressure');
 for(const l of leases)l.release();fourth.release();
});


test('foreground room entry reclaims a cold discovery-only realm without touching a player lease', {timeout:10000}, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'realm-discovery-priority-')),file=path.join(dir,'child.cjs');
 fs.writeFileSync(file,`const delay = process.env.LANYWHERE_LANPLAY_REALM === 'discovery' ? 2000 : 0;
setTimeout(() => process.send({type:'ready',port:1234}), delay);
setInterval(()=>{},1000);`);
 const manager=realms({providers:[{id:'existing'},{id:'discovery'},{id:'joining'}],serverFile:file,maxRealms:2});
 t.after(async()=>{await manager.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
 const [existing,discovery,joining]=manager.providers;
 const player=await existing.acquire();
 const playerPid=manager.snapshot().find(r=>r.id==='existing').pid;
 const preempted=assert.rejects(discovery.acquire({discoveryOnly:true}),e=>e.code==='UPSTREAM_UNAVAILABLE');
 await until(()=>manager.snapshot().some(r=>r.id==='discovery'&&!r.ready));
 await assert.rejects(joining.acquire({discoveryOnly:true}),e=>e.code==='REALM_CAPACITY');
 const admitted=await joining.acquire();
 await preempted;
 assert.deepEqual(manager.snapshot().map(r=>r.id).sort(),['existing','joining']);
 assert.equal(manager.snapshot().find(r=>r.id==='existing').pid,playerPid);
 player.release();admitted.release();
});

test('explicit provider registry preserves original destinations and excludes the failed candidate',()=>{
 const catalog=require('./lanplay-providers');const byId=new Map(catalog.map(p=>[p.id,p]));
 assert.equal(byId.size,catalog.length);assert(catalog.every(p=>p.id.length<=32));
 for(const [id,host,port] of [['lanplay-nl','switch.jayseateam.nl',11453],['lanplay-br','muitxobem-lanplay.ddns.net',11451],['lanplay-id','switch.mainbareng.web.id',11451],['lanplay-nl-jaysea-rust','switch.jayseateam.nl',11451],['lanplay-nl-r3ps4j-rust','switch.r3ps4j.nl',11451],['lanplay-nl-r3ps4j-11452','switch.r3ps4j.nl',11452]])
  assert.deepEqual(byId.get(id),{id,host,port});
 assert.equal(byId.size,11);assert(!byId.has('lanplay-nl-r3ps4j-11453'));
 for(const [id,host] of [['lanplay-cn-jax','srv.jaxlewis.top'],['lanplay-cn-gugu','gugu.mulaosi.cn'],['lanplay-cn-olunira','olunira.fun'],['lanplay-cn-shanghai','47.102.121.212']])
  assert.deepEqual(byId.get(id),{id,host,port:11451});
 assert.deepEqual(byId.get('lanplay-de-servegame'),{id:'lanplay-de-servegame',host:'switch.servegame.com',port:11451});
 assert(!byId.has('lanplay-de-erdbeer'));
});
