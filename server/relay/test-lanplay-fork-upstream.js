'use strict';
// Same fork-format peer as the direct test, through independent public relay and per-provider realms.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const {setTimeout:delay}=require('node:timers/promises'),{ForkPeer}=require('./test-lanplay-fork');
const {Peer}=require('../../deploy/smoke-relay.cjs'), P=require('./tcp-stream-protocol');
function legacy(t,o,id,port=0,data=Buffer.alloc(0)){const h=Buffer.alloc(8);h[0]=t;h[1]=o;h.writeUInt16LE(id,2);h.writeUInt16LE(port,4);h.writeUInt16LE(data.length,6);return Buffer.concat([h,data]);}
const base=fs.readFileSync(path.join(__dirname,'test-lanplay-upstream.js'),'utf8').split("test('isolated LAN Play realm")[0].replace('assert.deepEqual(manager.snapshot(),[]);','assert.equal(manager.snapshot().length,0);');
const ctx={require,process,Buffer,__dirname,console,setTimeout,clearTimeout};vm.createContext(ctx);
vm.runInContext(base+'\nthis.fixture={standard,setup,until};',ctx);const {standard,setup,until}=ctx.fixture;
const game=0x0100000000abc000n,NI=0x480,NODES=0x68;
const groupPage=async(peer)=>{const g=Buffer.alloc(8);g.writeBigUInt64LE(game);peer.send(8,g);return peer.frame(0x87)};
test('fork room passes through its own upstream realm without leaking to a second provider', {timeout:25000}, async t=>{
 const a=await standard(t), b=await standard(t);const g=await setup(t,[{id:'fork-a',host:a.host,port:a.port},{id:'fork-b',host:b.host,port:b.port}]);
 const viewer=new Peer('NativeGuest','127.0.0.1',g.port),other=new Peer('OtherRealm','127.0.0.1',g.port);
 const host=new ForkPeer(0x0a0d0666,0xc0a80233,'ForkHost',a);t.after(()=>{viewer.close();other.close();if(host.sock)host.close();});
 try {
 for(const [p,id] of [[viewer,'fork-a'],[other,'fork-b']]){await p.connect();p.send(0x20,Buffer.from(id));const selected=await p.frame(0xa0);assert.equal(selected.readUInt32LE(),462)}
 await host.start();host.host();let room;
 for(let i=0;i<40&&!room;i++){const page=await groupPage(viewer);for(let k=0;k<page[0];k++){const r=page.subarray(1+k*(6+NI),1+(k+1)*(6+NI));if(r.subarray(6+NODES+12,6+NODES+20).toString()==='ForkHost')room=r;}if(!room)await delay(150);}
 assert(room,'fork broadcast host must appear after provider gateway');assert.equal(room.readUInt32LE(6+NODES),host.virt);
 const foreign=await groupPage(other);assert.equal(foreign[0],0,'provider B must not expose provider A room');
 const nick=Buffer.alloc(32),gid=Buffer.alloc(8);nick.write('NativeGuest');gid.writeBigUInt64LE(game);
 viewer.send(2,Buffer.concat([room.subarray(0,6),nick,gid,Buffer.from([3])]));const joined=await viewer.frame(0x81);viewer.ip=joined.readUInt32LE(7);viewer.token=joined.readUInt32LE(11);await viewer.register();
 const node=Buffer.alloc(64);node.writeUInt32LE(viewer.ip);node[11]=1;node.write('NativeGuest',12);viewer.send(4,Buffer.concat([Buffer.from([0,3]),node]));
 const sync=await viewer.frame(0x84);assert.equal(sync[1],4);assert.equal(sync.readUInt32LE(2+NODES),host.virt);
 host.game(viewer.ip,viewer.ip,Buffer.from('through-realm'));await until(()=>viewer.packets.some(p=>p[4]===0x82&&p.subarray(13).toString()==='through-realm'));
 const dest=Buffer.alloc(8);dest.writeUInt32LE(host.virt);dest.writeUInt16LE(12345,4);dest.writeUInt16LE(12345,6);viewer.sendUdp(2,Buffer.concat([dest,Buffer.from('back-through-realm')]));await until(()=>host.received.some(p=>p.body.toString()==='back-through-realm'&&p.dst===host.real));
 // Route 0x24/A4 through the real frontend gateway and isolated realm to the legacy fork adapter.
 host.received.length=0;const cmd=(op,owner,id,nonce,fields={},payload=Buffer.alloc(0))=>P.encode(host.virt,{op,owner,id,nonce,...fields},payload);
 viewer.send(0x24,cmd(P.OP.OPEN,0,1,123n,{srcPort:50100,dstPort:6500,aux:8192},room.subarray(6,38)));
 let stream=P.parse(await viewer.frame(0xa4));assert.equal(stream.op,P.OP.LEGACY_READY);
 await until(()=>host.received.length>0);let raw=host.received.shift().body;assert.equal(raw[0],1);const legacyId=raw.readUInt16LE(2);assert.equal(raw.readUInt16LE(4),6500);
 viewer.send(0x24,cmd(P.OP.DATA,0,1,123n,{seq:0n},Buffer.from('native-stream')));await until(()=>host.received.length>0);raw=host.received.shift().body;assert.equal(raw.subarray(8).toString(),'native-stream');stream=P.parse(await viewer.frame(0xa4));assert.equal(stream.op,P.OP.WINDOW);
 host.game(viewer.ip,viewer.ip,legacy(2,1,legacyId,0,Buffer.from('fork-stream')),11453);stream=P.parse(await viewer.frame(0xa4));assert.equal(stream.op,P.OP.DATA);assert.equal(stream.payload.toString(),'fork-stream');viewer.send(0x24,cmd(P.OP.WINDOW,0,1,123n,{seq:11n,aux:8192}));
 viewer.send(0x24,cmd(P.OP.FIN,0,1,123n,{seq:13n}));stream=P.parse(await viewer.frame(0xa4));assert.equal(stream.op,P.OP.RST);assert.equal(stream.aux,P.REASON.UNSUPPORTED);await until(()=>host.received.some(p=>p.body[0]===3));
 host.received.length=0;host.game(viewer.ip,viewer.ip,legacy(1,0,55,6600),11453);stream=P.parse(await viewer.frame(0xa4));assert.equal(stream.op,P.OP.OPEN);assert(stream.srcPort>=49152);assert.equal(stream.dstPort,6600);const sid=stream.id,snonce=stream.nonce;
 host.game(viewer.ip,viewer.ip,legacy(2,0,55,0,Buffer.from('early')),11453);await delay(80);assert(!viewer.frames.some(f=>f[0]===0xa4&&P.parse(f.subarray(1))?.op===P.OP.DATA));viewer.send(0x24,cmd(P.OP.OPEN_OK,1,sid,snonce,{aux:8192}));stream=P.parse(await viewer.frame(0xa4));assert.equal(stream.op,P.OP.DATA);assert.equal(stream.payload.toString(),'early');
 viewer.send(0x24,cmd(P.OP.WINDOW,1,sid,snonce,{seq:5n,aux:8192}));viewer.send(0x24,cmd(P.OP.DATA,1,sid,snonce,{seq:0n},Buffer.from('reply')));await until(()=>host.received.some(p=>p.body[0]===2&&p.body.subarray(8).toString()==='reply'));stream=P.parse(await viewer.frame(0xa4));assert.equal(stream.op,P.OP.WINDOW);
 host.game(viewer.ip,viewer.ip,legacy(3,0,55),11453);stream=P.parse(await viewer.frame(0xa4));assert.equal(stream.op,P.OP.RST);


 } catch(e) { console.error(e.stack);viewer.close();other.close();if(host.sock)host.close();throw e; }
});

test('cold upstream emits first discovery scan immediately after validated PING and before readiness callback', {timeout:5000}, async t=>{
 const dgram=require('node:dgram'), L=require('./lanplay'),sock=dgram.createSocket('udp4');let scans=0;const events=[];
 await new Promise(r=>sock.bind(0,'127.0.0.1',r));t.after(()=>sock.close());
 sock.on('message',(m,r)=>{if(m[0]===2)return sock.send(m.subarray(0,4),r.port,r.address);if(m[0]===1){const p=L.parseIpv4(m.subarray(1));if(p?.proto===17&&p.body.readUInt16BE(2)===11452&&L.ldnRead({},p.body.subarray(8)).some(f=>f.type===0))scans++;}});
 const relay=L.create({port:0,upstream:{id:'warm',host:'127.0.0.1',port:sock.address().port,allowPrivate:true},rooms:new Map(),log:()=>{},count:()=>{},paused:()=>false,frame:()=>{},forwardData:()=>{},memberAt:()=>null,isOpen:()=>false,onReady:()=>events.push('ready'),onFirstScanSent:()=>events.push('sent'),onFailure:e=>{throw e;}});t.after(()=>relay.close());
 for(let i=0;i<100&&(!scans||events.length<2);i++)await delay(10);
 assert(scans,'upstream received first scan without waiting for the 3s periodic timer');assert.deepEqual(events,['ready','sent']);
});
