'use strict';
// Independent protocol peer modelled on jieluojun/ldn_mitm@1014c70d; no Switch code is executed.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {spawn}=require('child_process'),dgram=require('dgram');const L=require('./lanplay');
// Reuse only the existing native relay test client; fork packets below are encoded independently.
const testPort=25000+2*(process.pid%10000), testLpPort=testPort+1;
const common=fs.readFileSync(path.join(__dirname,'test-lanplay.js'),'utf8').split('async function main()')[0]
 .replace('const PORT = 22460, LP_PORT = 22451;', `const PORT = ${testPort}, LP_PORT = ${testLpPort};`);
const context={require,Buffer,process,console,__dirname,setTimeout,clearTimeout};vm.createContext(context);
vm.runInContext(common+'\nthis.fixture={Console,networkInfo,nodeInfo,until,sleep,PORT,LP_PORT,GAME,NI,NODES,NS,LDN,NET13};',context);
const {Console,networkInfo,nodeInfo,until,sleep,PORT,LP_PORT,GAME,NI,NODES,NS,LDN,NET13}=context.fixture;
const MAGIC=0x11451400, CONTROL=0x4243, GAME_V2=0x474e, BROADCAST=0x0a0dffff;
function ldn(type,body=Buffer.alloc(0),seq=17) { // stock-compatible stamped frame with zero-run compression
 const z=[];for(let i=0;i<body.length;){const x=body[i++];z.push(x);if(!x){let n=0;while(i<body.length&&!body[i]&&n<255){n++;i++;}z.push(n)}}
 const compressed=z.length<=body.length&&body.length>0, data=compressed?Buffer.from(z):body;
 const h=Buffer.alloc(12);h.writeUInt32LE(MAGIC);h[4]=type;h[5]=compressed?1:0;h.writeUInt16LE(data.length,6);if(compressed)h.writeUInt16LE(body.length,8);h.writeUInt16LE(seq,10);return Buffer.concat([h,data]);
}
function withId(p,id){p=Buffer.from(p);p.writeUInt16BE(id,4);p.writeUInt16BE(0,10);let n=0;for(let i=0;i<20;i+=2)n+=p.readUInt16BE(i);while(n>>>16)n=(n&65535)+(n>>>16);p.writeUInt16BE((~n)&65535,10);return p;}
class ForkPeer {
 constructor(virt,real,name,endpoint={host:'127.0.0.1',port:LP_PORT}){this.virt=virt;this.real=real;this.name=name;this.endpoint=endpoint;this.scan=[];this.sync=[];this.received=[];this.frags=new Map();this.wires=[];}
 async start(){this.sock=dgram.createSocket('udp4');this.sock.on('message',m=>this.receive(m));await new Promise(r=>this.sock.bind(0,'127.0.0.1',r));this.raw(Buffer.from([0]));}
 raw(data){this.sock.send(data,this.endpoint.port,this.endpoint.host);}
 ip(dst,id,port,data){const packet=withId(L.udpPacket(this.virt,port,dst,port,data),id);if(packet.length<=1400)return this.raw(Buffer.concat([Buffer.from([1]),packet]));
  const size=1024,total=Math.ceil(packet.length/size),seq=(this.fragSeq=(this.fragSeq||0)+1);for(let i=0;i<total;i++){const chunk=packet.subarray(i*size,(i+1)*size),h=Buffer.alloc(16);h.writeUInt32BE(this.virt,0);h.writeUInt32BE(dst,4);h.writeUInt16BE(seq,8);h[10]=i;h[11]=total;h.writeUInt16BE(chunk.length,12);h.writeUInt16BE(size,14);this.raw(Buffer.concat([Buffer.from([3]),h,chunk]));}}
 control(type,body=Buffer.alloc(0)){this.seq=((this.seq||0)+1)&65535;if(!this.seq)this.seq=1;this.ip(BROADCAST,CONTROL,11452,ldn(type,body,this.seq));}
 game(dst,realDst,payload,port=12345){const shim=Buffer.alloc(8);shim.writeUInt32BE(this.real);shim.writeUInt32BE(realDst,4);this.ip(dst,GAME_V2,port,Buffer.concat([shim,payload]));}
 receive(m){if(m[0]===3){this.wires.push(Buffer.from(m));const p=m.subarray(1),id=p.readUInt16BE(8),num=p[10],total=p[11],n=p.readUInt16BE(12),size=p.readUInt16BE(14),key=p.subarray(0,10).toString('hex');let f=this.frags.get(key);if(!f)this.frags.set(key,f={parts:Array(total),size});f.parts[num]=p.subarray(16,16+n);if(f.parts.filter(Boolean).length<total)return;this.frags.delete(key);return this.ipIn(Buffer.concat(f.parts));}if(m[0]===1)this.ipIn(m.subarray(1));}
 ipIn(packet){const p=L.parseIpv4(packet);if(!p||p.proto!==17)return;const port=p.body.readUInt16BE(2),data=p.body.subarray(8);if(port===11452){for(const f of L.ldnRead({},data)){
  if(f.type===0&&this.info)this.control(1,this.info);
  if(f.type===1)this.scan.push({from:p.src,info:f.data});
  if(f.type===2&&this.info&&f.data.length===70&&f.data.subarray(64).equals(this.info.subarray(0x20,0x26))){this.connectSeen=(this.connectSeen||0)+1;if(this.dropConnect>0){this.dropConnect--;continue;}const node=f.data.subarray(0,64);let slot=1;while(slot<8&&this.info[NODES+slot*NS+11]){if(this.info.readUInt32LE(NODES+slot*NS)===node.readUInt32LE(0))break;slot++;}if(slot<8&&!this.info[NODES+slot*NS+11]){node.copy(this.info,NODES+slot*NS);this.info[NODES+slot*NS+10]=slot;this.info[0x67]++;}if(this.dropSync>0)this.dropSync--;else this.control(3,this.info);}
  if(f.type===3)this.sync.push(f.data);
 }}else if(p.id===GAME_V2&&data.length>=8)this.received.push({src:data.readUInt32BE(0),dst:data.readUInt32BE(4),body:Buffer.from(data.subarray(8))});}
 host(){this.info=networkInfo(this.real,this.name);this.info[0x10]=0x91;this.control(1,this.info);}
 close(){this.sock.close();}
}
async function run(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lany-fork-'));const server=spawn(process.execPath,[path.join(__dirname,'server.js'),'--port',String(PORT)],{stdio:['ignore','pipe','inherit'],env:{...process.env,LANYWHERE_STATE_DIR:dir,LANYWHERE_STATS_PORT:'0',LANYWHERE_PUBLIC_PORT:'0',LANYWHERE_LANPLAY_PORT:String(LP_PORT),LANYWHERE_SHUTDOWN_GRACE_MS:'0'}});let logs='';server.stdout.on('data',b=>logs+=b);
 const all=[];try{await until(()=>logs.includes('lan play en UDP'),5000,'server');
 // A: native host, fork station: broadcast SCAN/CONNECT and normalized SYNC.
 const native=new Console('NativeHost');all.push(native);await native.connect();const g=Buffer.alloc(8);g.writeBigUInt64LE(GAME);const nick=Buffer.alloc(32);nick.write('NativeHost');native.send(1,Buffer.concat([g,nick,NET13]));native.onRoom(await native.frame(0x81));await native.register();const ni=networkInfo(native.ip,'NativeHost');ni[0x10]=1;native.send(7,ni);await sleep(80);
 const guest=new ForkPeer(0x0a0d0555,0xc0a8012a,'ForkGuest');all.push(guest);await guest.start();guest.control(0);const seen=await until(()=>guest.scan.find(x=>x.from===native.ip),4000,'fork scan');
 const wrong=Buffer.from(seen.info.subarray(0x20,0x26));wrong[0]^=0x80;guest.control(2,Buffer.concat([nodeInfo(guest.real,guest.name),wrong]));await sleep(80);assert(!native.frames.some(f=>f.type===0x84&&f.body[1]===LDN.CONNECT),'wrong BSSID must not join');guest.control(2,Buffer.concat([nodeInfo(guest.real,guest.name),seen.info.subarray(0x20,0x26)]));const relay=await native.frame(0x84,b=>b[1]===LDN.CONNECT);const index=relay[0],node=relay.subarray(2);assert.equal(node.readUInt32LE(0),guest.virt);guest.control(2,Buffer.concat([nodeInfo(guest.real,guest.name),seen.info.subarray(0x20,0x26)]));const duplicate=await native.frame(0x84,b=>b[1]===LDN.CONNECT);assert.equal(duplicate[0],index,'repeated fork CONNECT keeps same room seat');
 const sync=networkInfo(native.ip,'NativeHost',2);sync[0x10]=1;node.copy(sync,NODES+NS);sync[NODES+NS+10]=1;native.send(7,sync);native.send(4,Buffer.concat([Buffer.from([index,LDN.SYNC]),sync]));const received=await until(()=>guest.sync[0],3000,'fork sync');assert.equal(received.readUInt32LE(NODES+NS),guest.real);
 guest.game(native.ip,native.ip,Buffer.from('fork-to-native'));assert.equal((await until(()=>native.data.shift(),3000,'native data')).subarray(13).toString(),'fork-to-native');native.sendData(guest.virt,12345,12345,'native-to-fork');const out=await until(()=>guest.received.shift(),3000,'fork data');assert.equal(out.dst,guest.real);assert.equal(out.body.toString(),'native-to-fork');
 for(const size of [64,1400,1472]) {const payload=Buffer.alloc(size, size&255);guest.game(native.ip,native.ip,payload);const incoming=await until(()=>native.data.shift(),3000,'fork payload '+size);assert(incoming.subarray(13).equals(payload));native.sendData(guest.virt,12345,12345,payload);const outgoing=await until(()=>guest.received.shift(),3000,'native payload '+size);assert(outgoing.body.equals(payload));}
 const fragments=guest.wires.map(m=>m.subarray(1));assert(fragments.some(h=>h.readUInt32BE(0)===native.ip&&h.readUInt32BE(4)===guest.virt&&h[10]===0&&h[11]===2&&h.readUInt16BE(12)===1024&&h.readUInt16BE(14)===1024),'real outbound fragment header follows reference geometry');assert(fragments.some(h=>h[10]===1&&h[11]===2&&h.readUInt16BE(12)===484&&h.readUInt16BE(14)===1024),'1472-byte game payload has correct final fragment length');
 const forged=Buffer.alloc(9);forged.writeUInt32BE(0xc0a801ff);forged.writeUInt32BE(native.ip,4);forged[8]=88;guest.ip(native.ip,GAME_V2,12345,forged);await sleep(100);assert.equal(native.data.length,0,'mismatched claimed real source must be dropped');guest.game(native.ip,native.ip,Buffer.alloc(1473));await sleep(100);assert.equal(native.data.length,0,'fork UDP >1472 must not be delivered or truncated');native.sendData(guest.virt,12345,12345,Buffer.alloc(1473));const unsupported=await native.frame(0x85,b=>b[0]===10);assert.match(unsupported.subarray(1).toString(),/1472/);await sleep(100);assert.equal(guest.received.length,0,'oversized native UDP reports unsupported and is never truncated');

 // B: fork host, native station: broadcast advertisement and targeted broadcast CONNECT/SYNC.
 const host=new ForkPeer(0x0a0d0666,0xc0a80233,'ForkHost');all.push(host);await host.start();
 const station=new ForkPeer(0x0a0d0777,0xc0a80244,'ExistingStation');all.push(station);await station.start();
 host.dropConnect=1;host.dropSync=1;host.info=networkInfo(host.real,host.name,2);host.info[0x10]=0x91;nodeInfo(station.real,station.name).copy(host.info,NODES+NS);host.info[NODES+NS+10]=1;host.control(1,host.info);
 await sleep(100);const viewer=new Console('NativeGuest');all.push(viewer);await viewer.connect();viewer.send(8,g);const before=await viewer.frame(0x87);let unsafe=false;for(let k=0;k<before[0];k++)if(before.subarray(1+k*(6+NI)+6+NODES+12,1+k*(6+NI)+6+NODES+20).toString()==='ForkHost')unsafe=true;assert(!unsafe,'unknown station must not reduce announced occupancy');
 const heartbeat=Buffer.alloc(12);host.info.copy(heartbeat,0,0x20,0x26);heartbeat.writeUInt32LE(station.real,8);station.control(4,heartbeat);
 let room;
 for(let i=0;i<30&&!room;i++){viewer.send(8,g);const page=await viewer.frame(0x87);for(let k=0;k<page[0];k++){const r=page.subarray(1+k*(6+NI),1+(k+1)*(6+NI));if(r.subarray(6+NODES+12,6+NODES+20).toString()==='ForkHost')room=r;}if(!room)await sleep(100);}
 assert(room,'fork broadcast host must appear in native list');assert.equal(room.readUInt32LE(6+NODES),host.virt);
 const n2=Buffer.alloc(32);n2.write('NativeGuest');viewer.send(2,Buffer.concat([room.subarray(0,6),n2,g,NET13]));viewer.onRoom(await viewer.frame(0x81));await viewer.register();viewer.send(4,Buffer.concat([Buffer.from([0,LDN.CONNECT]),nodeInfo(viewer.ip,'NativeGuest')]));const r2=await viewer.frame(0x84,b=>b[1]===LDN.SYNC,5000);assert.equal(r2.readUInt32LE(2+NODES),host.virt);assert.equal(host.connectSeen,3,'first CONNECT and first SYNC losses must retry');assert.equal(host.info[0x67],3,'duplicate CONNECT must not create extra station');await sleep(800);assert.equal(host.connectSeen,3,'retries stop after successful SYNC');
 host.game(viewer.ip,viewer.ip,Buffer.from('host-to-guest'));assert.equal((await until(()=>viewer.data.shift(),3000,'guest data')).subarray(13).toString(),'host-to-guest');viewer.sendData(host.virt,12345,12345,'guest-to-host');const d=await until(()=>host.received.shift(),3000,'host data');assert.equal(d.dst,host.real);assert.equal(d.body.toString(),'guest-to-host');
 station.game(viewer.ip,viewer.ip,Buffer.from('station-to-native'));assert.equal((await until(()=>viewer.data.shift(),3000,'existing station data')).subarray(13).toString(),'station-to-native');viewer.sendData(station.virt,12345,12345,'native-to-station');const sd=await until(()=>station.received.shift(),3000,'existing station return');assert.equal(sd.dst,station.real);assert.equal(sd.body.toString(),'native-to-station');guest.game(viewer.ip,viewer.ip,Buffer.from('wrong-room'));await sleep(100);assert.equal(viewer.data.length,0,'same-provider peer must not send to another room');
 // A newly advertised, unresolved external node withdraws the stale listing until its own heartbeat.
 const late=new ForkPeer(0x0a0d0999,0xc0a80444,'LateStation');all.push(late);await late.start();nodeInfo(late.real,late.name).copy(host.info,NODES+3*NS);host.info[NODES+3*NS+10]=3;host.info[0x67]=4;host.control(1,host.info);await sleep(100);
 viewer.send(8,g);let changed=await viewer.frame(0x87);let stale=false;for(let k=0;k<changed[0];k++)if(changed.subarray(1+k*(6+NI)+6+NODES+12,1+k*(6+NI)+6+NODES+20).toString()==='ForkHost')stale=true;assert(!stale,'unknown newly joined station must withdraw stale room listing');
 const hbLate=Buffer.alloc(12);host.info.copy(hbLate,0,0x20,0x26);hbLate.writeUInt32LE(late.real,8);late.control(4,hbLate);let restored=false;for(let i=0;i<20&&!restored;i++){viewer.send(8,g);changed=await viewer.frame(0x87);for(let k=0;k<changed[0];k++)if(changed.subarray(1+k*(6+NI)+6+NODES+12,1+k*(6+NI)+6+NODES+20).toString()==='ForkHost')restored=true;if(!restored)await sleep(100);}assert(restored,'new member heartbeat restores room after mapping');


 const bye=Buffer.alloc(12);seen.info.copy(bye,0,0x20,0x26);bye.writeUInt32LE(guest.real,8);guest.control(5,bye);await native.frame(0x84,b=>b[1]===LDN.DISCONNECT);assert(true,'fork BYE relayed to native room host');
 // C: a permanently lost CONNECT expires once, without unbounded retransmission.
 const dead=new ForkPeer(0x0a0d0888,0xc0a80355,'NoReply');all.push(dead);await dead.start();dead.host();dead.dropConnect=100;
 const waiting=new Console('Waiting');all.push(waiting);await waiting.connect();let deadRoom;
 for(let i=0;i<30&&!deadRoom;i++){waiting.send(8,g);const page=await waiting.frame(0x87);for(let k=0;k<page[0];k++){const r=page.subarray(1+k*(6+NI),1+(k+1)*(6+NI));if(r.subarray(6+NODES+12,6+NODES+19).toString()==='NoReply')deadRoom=r;}if(!deadRoom)await sleep(100);}
 assert(deadRoom);const nw=Buffer.alloc(32);nw.write('Waiting');waiting.send(2,Buffer.concat([deadRoom.subarray(0,6),nw,g,NET13]));waiting.onRoom(await waiting.frame(0x81));
 waiting.send(4,Buffer.concat([Buffer.from([0,LDN.CONNECT]),nodeInfo(waiting.ip,'Waiting')]));await waiting.frame(0x84,b=>b[1]===LDN.DISCONNECT,6000);assert.equal(dead.connectSeen,6,'connect retry budget');await sleep(650);assert.equal(dead.connectSeen,6,'expired join must not keep flooding');

 console.log('Fork format: native↔fork discovery, targeted join, SYNC and UDP passed in both host directions (simulated)');
 }finally{for(const p of all)try{p.close()}catch{}server.kill('SIGTERM');await sleep(150);fs.rmSync(dir,{recursive:true,force:true});}}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={ForkPeer,ldn,withId,Console,networkInfo,nodeInfo,until,sleep,PORT,LP_PORT,GAME,NI,NODES,NS,LDN,NET13};
