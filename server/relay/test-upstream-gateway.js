'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('node:net'),dgram=require('node:dgram');
const {once}=require('node:events'),{setTimeout:delay}=require('node:timers/promises');
const {create}=require('./upstream-gateway');
const MAGIC=0x594e414c;
async function until(fn,label='condition'){const end=Date.now()+3000;while(Date.now()<end){const v=fn();if(v)return v;await delay(5);}throw Error('timeout: '+label);}
function frame(socket,type,body=Buffer.alloc(0)){const h=Buffer.alloc(3);h.writeUInt16LE(body.length+1);h[2]=type;socket.write(Buffer.concat([h,body]));}
function parse(socket,callback){let pending=Buffer.alloc(0);socket.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=3&&pending.length>=pending.readUInt16LE()+2){const n=pending.readUInt16LE();callback(pending[2],pending.subarray(3,n+2));pending=pending.subarray(n+2);}});socket.on('error',()=>{});}

// Port 0 reserves a port for one transport only. An unrelated UDP socket can
// already own the TCP-selected port; fail/clean up that attempt instead of
// leaving an unresolved bind Promise and a live TCP listener behind.
async function listening(socket, start) {
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{socket.off('error',failed);socket.off('listening',ready);};
  const failed=error=>{cleanup();reject(error);},ready=()=>{cleanup();resolve();};
  socket.once('error',failed);socket.once('listening',ready);
  try{start();}catch(error){failed(error);}
 });
}
async function listenPair(tcp,udp,firstPort=0) {
 for(let attempt=0;attempt<16;attempt++) {
  try {
   await listening(tcp,()=>tcp.listen(attempt===0?firstPort:0,'127.0.0.1'));
   const port=tcp.address().port;await listening(udp,()=>udp.bind(port,'127.0.0.1'));return port;
  } catch(error) {
   if(tcp.listening)await new Promise(resolve=>tcp.close(resolve));
   if(error.code!=='EADDRINUSE'||attempt===15)throw error;
  }
 }
}

// An independent, intentionally legacy-only relay fixture. Two instances reuse
// token/IP values, proving the gateway cannot identify sessions by upstream token
// or public source IP alone. No public upstream is contacted by this suite.
async function legacy(t,{silent=false,firstPort=0}={}){
 const rooms=new Map(),tokens=new Map(),sockets=new Set(),udp=dgram.createSocket('udp4');let counter=0,closing=false;
 const control={findMode:'normal',findDelay:0,finds:[],rawGroups:null,delayDepartures:0,pendingFinds:[],resumeDelay:0};
 const error=(s,c)=>frame(s,0x85,Buffer.from([c]));
 function room(m){const peers=[...m.room.members.values()],b=Buffer.alloc(24+37*peers.length);b.write(m.room.code);b[6]=m.index;b.writeUInt32LE(m.ip,7);b.writeUInt32LE(m.token,11);b.writeBigUInt64LE(m.room.game,15);b[23]=peers.length;peers.forEach((p,i)=>{b[24+37*i]=p.index;b.writeUInt32LE(p.ip,25+37*i);});frame(m.socket,0x81,b);}
 function leave(m){if(!m)return;m.room.members.delete(m.index);tokens.delete(m.token);m.socket.member=null;for(const p of m.room.members.values())if(p.socket){const socket=p.socket;if(control.delayDepartures)setTimeout(()=>{if(!socket.destroyed)frame(socket,0x83,Buffer.from([m.index]));},control.delayDepartures);else frame(socket,0x83,Buffer.from([m.index]));}}
 const tcp=net.createServer(s=>{if(closing){s.destroy();return;}sockets.add(s);s.on('close',()=>{sockets.delete(s);if(s.member)s.member.socket=null;});parse(s,(type,b)=>{
  if(type===11){if(!silent)error(s,4);return;}
  if(type===5){frame(s,0x86);return;}
  if(type===8){
   control.finds.push(Buffer.from(b));if(control.findMode==='silent')return;if(control.findMode==='error')return error(s,7);
   const game=b.length>=8?b.readBigUInt64LE():0n;
   const entries=[...rooms.values()].filter(r=>r.info&&r.members.get(0)?.socket&&(!game||r.game===game)).slice(0,6);
   const out=control.rawGroups||Buffer.concat([Buffer.from([entries.length]),...entries.map(r=>Buffer.concat([Buffer.from(r.code),r.info]))]);
   if(control.findMode==='hold'){control.pendingFinds.push(()=>{if(!s.destroyed)frame(s,0x87,out);});return;}
   if(control.findDelay)setTimeout(()=>{if(!s.destroyed)frame(s,0x87,out);},control.findDelay);else frame(s,0x87,out);return;
  }
  if(type===7){if(!s.member||s.member.index!==0||b.length!==0x480)return error(s,4);s.member.room.info=Buffer.from(b);return;}
  if(type===3){leave(s.member);return;}
  if(type===6){const old=tokens.get(b.readUInt32LE());if(!old||old.room.code!==b.subarray(4).toString()||old.socket)return error(s,5);old.socket=s;s.member=old;if(control.resumeDelay)setTimeout(()=>{if(!s.destroyed)room(old);},control.resumeDelay);else room(old);return;}
  let r;
  if(type===1){r={code:'AAAAA'+String(counter+2),game:b.readBigUInt64LE(),members:new Map()};rooms.set(r.code,r);}
  else if(type===2)r=rooms.get(b.subarray(0,6).toString().toUpperCase());
  else return error(s,4);
  if(!r)return error(s,1);
  const index=[0,1,2,3,4,5,6,7].find(i=>!r.members.has(i));if(index===undefined)return error(s,2);
  const m={index,ip:0x0a0d0001+counter,token:1001+counter++,room:r,socket:s,udp:null};tokens.set(m.token,m);r.members.set(index,m);s.member=m;room(m);
  for(const p of r.members.values())if(p!==m&&p.socket){const z=Buffer.alloc(37);z[0]=m.index;z.writeUInt32LE(m.ip,1);frame(p.socket,0x82,z);}
 });});
 t.after(async()=>{closing=true;for(const s of sockets)s.destroy();try{udp.close();}catch{}if(tcp.listening)await new Promise(r=>tcp.close(r));});
 const port=await listenPair(tcp,udp,firstPort);
 udp.on('message',(b,from)=>{if(b.length<9||b.readUInt32LE()!==MAGIC)return;const m=tokens.get(b.readUInt32LE(5));if(!m?.socket)return;if(b[4]===1){m.udp=from;const a=Buffer.alloc(5);a.writeUInt32LE(MAGIC);a[4]=0x81;udp.send(a,from.port,from.address);return;}
  if(b[4]!==2||!m.udp)return;const dst=b.readUInt32LE(9);for(const p of m.room.members.values())if(p!==m&&p.udp&&(p.ip===dst||dst===0xffffffff)){const out=Buffer.alloc(b.length-4);out.writeUInt32LE(MAGIC);out[4]=0x82;out.writeUInt32LE(m.ip,5);b.copy(out,9,13);udp.send(out,p.udp.port,p.udp.address);}
 });
 return {host:'127.0.0.1',port,tokens,rooms,control};
}
async function gateway(t,providers,opts={}){
 const sockets=new Set(),udp=dgram.createSocket('udp4');let paused=false,closing=false;let gw;
 const tcp=net.createServer(s=>{if(closing){s.destroy();return;}sockets.add(s);parse(s,(type,b)=>{if(!gw.handleFrame(s,type,b))frame(s,type===11?0x89:0x86,type===11?Buffer.from([63,0,0,0]):Buffer.alloc(0));});s.on('close',()=>{gw.onClose(s);sockets.delete(s);});});
 t.after(async()=>{closing=true;gw?.shutdown();for(const s of sockets)s.destroy();try{udp.close();}catch{}if(tcp.listening)await new Promise(r=>tcp.close(r));});
 const port=await listenPair(tcp,udp);
 gw=create({providers,send:frame,sendUdp:(b,p,a)=>udp.send(b,p,a),paused:()=>paused,graceMs:250,...opts});
 udp.on('message',(b,r)=>gw.handleDatagram(b,r));
 return {port,gw,setPaused:p=>paused=p};
}
async function peer(t,port){const s=net.connect(port,'127.0.0.1'),u=dgram.createSocket('udp4'),frames=[],packets=[];parse(s,(type,body)=>frames.push({type,body}));await once(s,'connect');await new Promise(r=>u.bind(0,'127.0.0.1',r));u.on('message',b=>packets.push(b));t.after(()=>{s.destroy();try{u.close();}catch{}});
 const p={s,u,frames,packets,send:(type,b)=>frame(s,type,b),next:type=>until(()=>{const i=frames.findIndex(f=>f.type===type);return i<0?null:frames.splice(i,1)[0].body;},'frame '+type)};
 p.select=async (id,caps=id==='self'?63:0)=>{p.send(0x20,Buffer.from(id));const a=await p.next(0xa0);assert.equal(a.readUInt32LE(),caps);assert.equal(a[4],id.length);assert.equal(a.subarray(5).toString(),id);};
 p.enter=async (code,game=0n)=>{const id=Buffer.alloc(8);id.writeBigUInt64LE(game);p.send(code?2:1,code?Buffer.concat([Buffer.from(code),Buffer.alloc(32),id,Buffer.from([1])]):Buffer.concat([id,Buffer.alloc(32),Buffer.from([1])]));const b=await p.next(0x81);p.code=b.subarray(0,6).toString();p.index=b[6];p.ip=b.readUInt32LE(7);p.token=b.readUInt32LE(11);};
 p.datagram=(type,body=Buffer.alloc(0),token=p.token)=>{const h=Buffer.alloc(9);h.writeUInt32LE(MAGIC);h[4]=type;h.writeUInt32LE(token,5);u.send(Buffer.concat([h,body]),port,'127.0.0.1');};
 p.register=async()=>{for(let i=0;i<10;i++){p.datagram(1);await delay(10);if(packets.some(b=>b[4]===0x81))return;}throw Error('no registration');};
 p.data=(dst,data)=>{const h=Buffer.alloc(8);h.writeUInt32LE(dst);h.writeUInt16LE(1200,4);h.writeUInt16LE(1300,6);p.datagram(2,Buffer.concat([h,data]));};
 return p;
}

test('explicit providers isolate tokens and UDP for four players behind the same source IP',async t=>{
 const one=await legacy(t),two=await legacy(t),g=await gateway(t,[{id:'one',...one,maxConnections:8},{id:'two',...two,maxConnections:8}]);
 const a=await peer(t,g.port),b=await peer(t,g.port),c=await peer(t,g.port),d=await peer(t,g.port);
 await a.select('one');await b.select('one');await c.select('two');await d.select('two');
 await a.enter();await b.enter(a.code);await c.enter();await d.enter(c.code);
 assert.equal(a.ip,c.ip);assert.equal(b.ip,d.ip);assert.equal(one.tokens.keys().next().value,two.tokens.keys().next().value);
 assert.equal(new Set([a.token,b.token,c.token,d.token]).size,4);
 for(const p of [a,b,c,d])await p.register();
 a.data(b.ip,Buffer.from('one-only'));await until(()=>b.packets.some(x=>x.subarray(13).toString()==='one-only'));
 c.data(d.ip,Buffer.from('two-only'));await until(()=>d.packets.some(x=>x.subarray(13).toString()==='two-only'));
 assert(!d.packets.some(x=>x.subarray(13).toString()==='one-only'));assert(!b.packets.some(x=>x.subarray(13).toString()==='two-only'));
 a.send(0x20,Buffer.from('two'));assert.equal((await a.next(0x85))[0],4);
 a.send(11,Buffer.alloc(0));assert.equal((await a.next(0x89)).readUInt32LE(),0);
 a.data(b.ip,Buffer.alloc(1456));assert.equal((await a.next(0x85))[0],10);
 a.datagram(4,Buffer.from([12,0,0,0]));assert.equal((await a.next(0x85))[0],4);
 g.setPaused(true);const before=b.packets.length;a.data(b.ip,Buffer.from('paused'));await delay(40);assert.equal(b.packets.length,before);
});

test('resume retains local identity only within its provider and expires on a bounded deadline',async t=>{
 const up=await legacy(t),g=await gateway(t,[{id:'one',...up,maxConnections:8},{id:'two',...up,maxConnections:8}],{graceMs:220});
 const a=await peer(t,g.port);await a.select('one');await a.enter();const original={token:a.token,code:a.code,ip:a.ip};a.s.destroy();
 await until(()=>g.gw.activeMembers()===0);await delay(20);
 const foreign=await peer(t,g.port);await foreign.select('two');const resume=Buffer.alloc(10);resume.writeUInt32LE(original.token);resume.write(original.code,4);
 foreign.send(6,resume);assert.equal((await foreign.next(0x85))[0],5);
 const restored=await peer(t,g.port);await restored.select('one');restored.send(6,resume);const body=await restored.next(0x81);assert.equal(body.readUInt32LE(11),original.token);assert.equal(body.readUInt32LE(7),original.ip);
 restored.s.destroy();await until(()=>g.gw.activeMembers()===0);await delay(260);
 const late=await peer(t,g.port);await late.select('one');late.send(6,resume);assert.equal((await late.next(0x85))[0],5);
});

test('resume reports busy for an active or in-flight seat, then resumes after detach and expires',async t=>{
 const up=await legacy(t),g=await gateway(t,[{id:'one',...up,maxConnections:8}],{graceMs:600});
 const original=await peer(t,g.port), contender=await peer(t,g.port);
 await original.select('one');await contender.select('one');await original.enter();
 const resume=Buffer.alloc(10);resume.writeUInt32LE(original.token);resume.write(original.code,4);
 contender.send(6,resume);assert.equal((await contender.next(0x85))[0],7,'active route is retryable busy');
 original.send(5);await original.next(0x86); // Contention cannot close or alter the original route.
 original.s.destroy();await until(()=>g.gw.activeMembers()===0);await delay(20);
 up.control.resumeDelay=150;contender.send(6,resume);
 await until(()=>[...up.tokens.values()].some(m=>m.socket),'resume has reached the upstream');
 const racing=await peer(t,g.port);await racing.select('one');racing.send(6,resume);
 assert.equal((await racing.next(0x85))[0],7,'in-flight claim is retryable busy');
 const room=await contender.next(0x81);assert.equal(room.readUInt32LE(11),original.token);assert.equal(room.readUInt32LE(7),original.ip);
 contender.s.destroy();await until(()=>g.gw.activeMembers()===0);await delay(650);
 const late=await peer(t,g.port);await late.select('one');late.send(6,resume);
 assert.equal((await late.next(0x85))[0],5,'expired token is no longer resumable');
});

test('unknown destinations, shared capacity and failed handshakes fail closed without changing self routing',async t=>{
 const up=await legacy(t),g=await gateway(t,[{id:'one',...up,maxConnections:1}],{connectTimeoutMs:70});
 const a=await peer(t,g.port),b=await peer(t,g.port);a.send(0x20,Buffer.from('127.0.0.1:22'));assert.equal((await a.next(0x85))[0],4);assert.equal(g.gw.snapshot().connections,0);
 await a.select('one');b.send(0x20,Buffer.from('one'));assert.equal((await b.next(0x85))[0],7);a.s.destroy();await until(()=>g.gw.snapshot().connections===0);await b.select('self');b.send(5,Buffer.alloc(0));await b.next(0x86);
 const occupied=dgram.createSocket('udp4');t.after(()=>occupied.close());await listening(occupied,()=>occupied.bind(0,'127.0.0.1'));
 const occupiedPort=occupied.address().port;
 const silent=await legacy(t,{silent:true,firstPort:occupiedPort});assert.notEqual(silent.port,occupiedPort,'a UDP-occupied candidate must be retried');
 const dead=await gateway(t,[{id:'silent',...silent,maxConnections:1}],{connectTimeoutMs:50});
 const p=await peer(t,dead.port);p.send(0x20,Buffer.from('silent'));assert.equal((await p.next(0x85))[0],13);await until(()=>dead.gw.snapshot().connections===0);
});

test('closing during asynchronous realm startup releases its eventual lease exactly once',async t=>{
 let resolve,released=0;
 const pending=new Promise(r=>{resolve=r;});
 const g=await gateway(t,[{id:'realm',maxConnections:1,acquire:()=>pending}],{connectTimeoutMs:200});
 const p=await peer(t,g.port);p.send(0x20,Buffer.from('realm'));
 await until(()=>g.gw.snapshot().connections===1);p.s.destroy();
 await until(()=>g.gw.snapshot().connections===0);
 resolve({host:'127.0.0.1',port:1,release:()=>released++});
 await until(()=>released===1);assert.equal(g.gw.snapshot().connections,0);
});

function metadata(app,name){const b=Buffer.alloc(272);b.writeBigUInt64LE(app);b.writeBigUInt64LE(app,8);b.write(name,16,127);return b;}
function infoFor(p,game){const b=Buffer.alloc(0x480);b.writeBigUInt64LE(game);b[0x66]=8;b[0x67]=1;b.writeUInt32LE(p.ip,0x68);b[0x73]=1;b.write('Actual upstream host',0x74);return b;}
async function barrier(p){p.send(5);await p.next(0x86);}
async function page(p,game=0n,offset=0){const b=Buffer.alloc(12);b.writeBigUInt64LE(game);b.writeUInt32LE(offset,8);p.send(0x22,b);return p.next(0xa2);}
function rows(p){assert.equal(p.readUInt32LE(),0xffffffff);assert.equal(p.length,5+p[4]*336);return Array.from({length:p[4]},(_,i)=>p.subarray(5+i*336,5+(i+1)*336));}

test('legacy adapter supplies exact host metadata for identical LCIDs without inventing external titles or upstream capabilities',async t=>{
 const up=await legacy(t),g=await gateway(t,[{id:'public',...up,maxConnections:8,adapterMetadata:true},{id:'other',...up,maxConnections:8,adapterMetadata:true}]);
 const a=await peer(t,g.port),b=await peer(t,g.port),finder=await peer(t,g.port),foreign=await peer(t,up.port),guest=await peer(t,g.port),other=await peer(t,g.port);
 for(const p of[a,b,finder,guest])await p.select('public',64);await other.select('other',64);
 const game=0x0100000000001234n;await a.enter(null,game);await b.enter(null,game);await foreign.enter(null,game);
 for(const p of[a,b,foreign]){p.send(7,infoFor(p,game));await barrier(p);}
 a.send(0x21,metadata(0x0100aaa000000000n,'Actual title A'));b.send(0x21,metadata(0x0100bbb000000000n,'Actual title B'));await barrier(a);await barrier(b);
 const records=rows(await page(finder,game)),byCode=new Map(records.map(r=>[r.subarray(0,6).toString(),r]));
 assert.equal(byCode.get(a.code).readBigUInt64LE(16),0x0100aaa000000000n);assert.equal(byCode.get(b.code).readBigUInt64LE(16),0x0100bbb000000000n);
 assert(byCode.get(a.code).subarray(80,208).toString().startsWith('Actual title A\0'));assert(byCode.get(b.code).subarray(80,208).toString().startsWith('Actual title B\0'));
 assert.equal(byCode.get(foreign.code)[34],0);assert(byCode.get(foreign.code).subarray(80).equals(Buffer.alloc(256)));
 assert(rows(await page(other,game)).every(r=>r[34]===0),'same endpoint under another provider cannot borrow declarations');
 await guest.enter(a.code,game);guest.send(0x21,metadata(9n,'Guest forgery'));assert.equal((await guest.next(0x85))[0],4);
 finder.send(0x21,metadata(9n,'No room'));assert.equal((await finder.next(0x85))[0],4);
 a.send(0x21,metadata(9n,'Hidden\u200btitle'));assert.equal((await a.next(0x85))[0],4);
 finder.send(11);assert.equal((await finder.next(0x89)).readUInt32LE(),64);finder.send(9,Buffer.alloc(0));assert.equal((await finder.next(0x85))[0],4);
 finder.send(8,Buffer.alloc(0));const legacyReply=await finder.next(0x87);assert.equal(legacyReply.length,1+3*(6+0x480));assert.equal(legacyReply[0],3);
 assert.equal(up.control.finds[0].length,15);assert.equal(up.control.finds[0][14],1);
 a.send(3);await barrier(a);up.control.rawGroups=Buffer.concat([Buffer.from([1]),Buffer.from(a.code),infoFor(a,game)]);
 assert.equal(rows(await page(finder,game))[0][34],0,'reused remote code/IP/LCID does not retain a departed token declaration');
});

test('adapter owner declaration survives only same-identity resume and expires with its lease',async t=>{
 const up=await legacy(t),g=await gateway(t,[{id:'public',...up,maxConnections:8,adapterMetadata:true}],{graceMs:200});
 const host=await peer(t,g.port),finder=await peer(t,g.port);await host.select('public',64);await finder.select('public',64);
 const game=100n;await host.enter(null,game);host.send(7,infoFor(host,game));host.send(0x21,metadata(9n,'Persistent owner'));await barrier(host);
 const q=Buffer.alloc(10);q.writeUInt32LE(host.token);q.write(host.code,4);host.s.destroy();await until(()=>g.gw.activeMembers()===0);await delay(10);
 const resumed=await peer(t,g.port);await resumed.select('public',64);resumed.send(6,q);await resumed.next(0x81);
 assert.equal(rows(await page(finder,game))[0][34],1);
 resumed.s.destroy();await until(()=>g.gw.activeMembers()===0);await delay(240);
 up.control.rawGroups=Buffer.concat([Buffer.from([1]),Buffer.from(host.code),infoFor(host,game)]);
 assert.equal(rows(await page(finder,game))[0][34],0);
 const late=await peer(t,g.port);await late.select('public',64);late.send(6,q);assert.equal((await late.next(0x85))[0],5);
});

test('metadata discovery serializes legacy replies, propagates errors and closes timed out queries before late replies',async t=>{
 const up=await legacy(t),provider={id:'public',...up,maxConnections:8,adapterMetadata:true},g=await gateway(t,[provider]);
 const p=await peer(t,g.port);await p.select('public',64);up.control.findMode='hold';
 p.send(8,Buffer.alloc(0));await until(()=>up.control.pendingFinds.length===1);
 p.send(0x22,Buffer.alloc(12));assert.equal((await p.next(0x85))[0],7);
 up.control.pendingFinds.shift()();assert.equal((await p.next(0x87))[0],0);assert(!p.frames.some(f=>f.type===0xa2));
 up.control.findMode='normal';assert.equal(rows(await page(p)).length,0);up.control.findMode='error';p.send(0x22,Buffer.alloc(12));assert.equal((await p.next(0x85))[0],7);
 up.control.findMode='normal';assert.equal(rows(await page(p)).length,0);
 const invalid=Buffer.alloc(12);invalid.writeUInt32LE(6,8);p.send(0x22,invalid);assert.equal((await p.next(0x85))[0],4);
 // Shorten only the deliberately timed-out query. Hold its reply until after
 // the observed close instead of racing two wall-clock timers under host load.
 const short=await gateway(t,[provider],{queryTimeoutMs:80}),late=await peer(t,short.port);await late.select('public',64);
 up.control.findMode='hold';late.send(0x22,Buffer.alloc(12));await until(()=>up.control.pendingFinds.length===1);
 assert.equal((await late.next(0x85))[0],13);await until(()=>late.s.destroyed);up.control.pendingFinds.shift()();await delay(10);assert(!late.frames.some(f=>f.type===0xa2));
});


test('a control connection can browse after LEAVE while prior-room departure frames are still in flight',async t=>{
 const up=await legacy(t),g=await gateway(t,[{id:'public',...up,maxConnections:8,adapterMetadata:true}]);
 const a=await peer(t,g.port),b=await peer(t,g.port);await a.select('public',64);await b.select('public',64);await a.enter();await b.enter(a.code);
 up.control.delayDepartures=35;a.send(3);b.send(3);await barrier(a);await barrier(b);up.control.findDelay=70;
 assert.equal(rows(await page(b)).length,0);assert(!b.frames.some(f=>f.type===0x85));assert(!b.s.destroyed);
 await b.enter();await barrier(b);assert(b.token); // A new ROOM restores normal member-event processing.
});


test('query-only leases release immediately but disconnected member tokens retain the same realm lease',async t=>{
 const up=await legacy(t);let acquired=0,released=0;
 const provider={id:'leased',maxConnections:8,acquire:async()=>{acquired++;let done=false;return {...up,release:()=>{assert(!done,'each acquisition released once');done=true;released++;}};}};
 const g=await gateway(t,[provider],{graceMs:180});
 const query=await peer(t,g.port);await query.select('leased');query.s.destroy();await until(()=>released===1);
 const host=await peer(t,g.port);await host.select('leased');await host.enter();
 const resume=Buffer.alloc(10);resume.writeUInt32LE(host.token);resume.write(host.code,4);
 host.s.destroy();await until(()=>g.gw.snapshot().retainedMembers===1);assert.equal(released,1,'member lease remains protected');
 const restored=await peer(t,g.port);await restored.select('leased');restored.send(6,resume);await restored.next(0x81);
 assert.equal(released,2,'old retained lease transferred after successful resume');
 restored.send(3);await barrier(restored);assert.equal(g.gw.snapshot().members,0);assert.equal(released,2,'connected route still owns its lease');
 restored.s.destroy();await until(()=>released===3);
 const expiring=await peer(t,g.port);await expiring.select('leased');await expiring.enter();expiring.s.destroy();
 await until(()=>g.gw.snapshot().retainedMembers===1);assert.equal(released,3);await until(()=>released===4);
 assert.equal(g.gw.snapshot().members,0);assert.equal(acquired,4);
});

test('provider diagnostics keep fixed reasons and known IDs with bounded redacted logs',()=>{
 const {createDiagnostics}=require('./upstream-gateway');let time=100,logs=[],counts=[];
 const diagnostics=createDiagnostics({providerIds:['one'],now:()=>time,emit:e=>logs.push(e),count:r=>counts.push(r)});
 for(let i=0;i<2000;i++)diagnostics.record({provider:'injected-'+i,reason:'token-'+i,code:7,room:'SECRET',ip:'192.0.2.1',token:'SECRET'});
 assert.equal(diagnostics.snapshot().length,1);assert.equal(logs.length,1);
 diagnostics.record({provider:'one',reason:'capacity',code:7});assert.equal(logs.length,2);
 time+=10000;diagnostics.record({provider:'one',reason:'capacity',code:7});assert.equal(logs.length,3);
 assert.equal(diagnostics.snapshot().find(r=>r.provider==='one').events,2);
 const serialized=JSON.stringify({logs,snapshot:diagnostics.snapshot()});assert(!serialized.includes('SECRET')&&!serialized.includes('192.0.2.1')&&!serialized.includes('injected-'));
 assert.equal(counts.length,2002);
});
