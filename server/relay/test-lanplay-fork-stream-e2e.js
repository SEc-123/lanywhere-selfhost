'use strict';
// Real relay server + independent fork-format UDP peer; no Switch device is emulated.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
const P=require('./tcp-stream-protocol');
const {ForkPeer,Console,networkInfo,nodeInfo,until,sleep,PORT,LP_PORT,GAME,NODES,NS,LDN}=require('./test-lanplay-fork');
function legacy(type,owner,id,port=0,data=Buffer.alloc(0)){const h=Buffer.alloc(8);h[0]=type;h[1]=owner;h.writeUInt16LE(id,2);h.writeUInt16LE(port,4);h.writeUInt16LE(data.length,6);return Buffer.concat([h,data]);}
function cmd(peer,op,owner,id,nonce,fields={},data=Buffer.alloc(0)){return P.encode(peer,{op,owner,id,nonce,...fields},data);}
async function run(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lany-fork-stream-'));const server=spawn(process.execPath,[path.join(__dirname,'server.js'),'--port',String(PORT)],{stdio:['ignore','pipe','inherit'],env:{...process.env,LANYWHERE_STATE_DIR:dir,LANYWHERE_STATS_PORT:'0',LANYWHERE_PUBLIC_PORT:'0',LANYWHERE_LANPLAY_PORT:String(LP_PORT),LANYWHERE_SHUTDOWN_GRACE_MS:'0'}});let logs='';server.stdout.on('data',b=>logs+=b);const all=[];
 try {await until(()=>logs.includes('lan play en UDP'),5000,'server');
 const host=new Console('NativeHost');all.push(host);await host.connect();host.send(11);const caps=await host.frame(0x89);assert(caps.readUInt32LE()&128);assert(caps.readUInt32LE()&256);
 const game=Buffer.alloc(8);game.writeBigUInt64LE(GAME);const nick=Buffer.alloc(32);nick.write('NativeHost');host.send(1,Buffer.concat([game,nick,Buffer.from([3])]));host.onRoom(await host.frame(0x81));await host.register();const info=networkInfo(host.ip,'NativeHost');info[0x10]=1;host.send(7,info);await sleep(100);
 const guest=new ForkPeer(0x0a0d0555,0xc0a8012a,'ForkGuest');all.push(guest);await guest.start();guest.control(0);const seen=await until(()=>guest.scan.find(x=>x.from===host.ip),4000,'scan');guest.control(2,Buffer.concat([nodeInfo(guest.real,guest.name),seen.info.subarray(0x20,0x26)]));
 const relay=await host.frame(0x84,b=>b[1]===LDN.CONNECT);const index=relay[0],node=relay.subarray(2);const sync=networkInfo(host.ip,'NativeHost',2);sync[0x10]=1;node.copy(sync,NODES+NS);sync[NODES+NS+10]=1;host.send(7,sync);host.send(4,Buffer.concat([Buffer.from([index,LDN.SYNC]),sync]));await until(()=>guest.sync[0],3000,'sync');
 // Native-initiated: peer receives only legacy-unconfirmed readiness.
 host.send(0x24,cmd(guest.virt,P.OP.OPEN,0,1,123n,{srcPort:50100,dstPort:6500,aux:8192},sync.subarray(0,32)));let h=P.parse(await host.frame(0xa4));assert.equal(h.op,P.OP.LEGACY_READY);
 let raw=(await until(()=>guest.received.shift(),3000,'legacy open')).body;assert.equal(raw[0],1);assert.equal(raw[1],0);assert.equal(raw.readUInt16LE(4),6500);const oldId=raw.readUInt16LE(2);
 host.send(0x24,cmd(guest.virt,P.OP.DATA,0,1,123n,{seq:0n},Buffer.from('hello fork')));raw=(await until(()=>guest.received.shift(),3000,'legacy data')).body;assert.equal(raw[0],2);assert.equal(raw.subarray(8).toString(),'hello fork');h=P.parse(await host.frame(0xa4));assert.equal(h.op,P.OP.WINDOW);assert.equal(h.seq,10n);
 guest.game(host.ip,host.ip,legacy(2,1,oldId,0,Buffer.from('hello native')),11453);h=P.parse(await host.frame(0xa4));assert.equal(h.op,P.OP.DATA);assert.equal(h.payload.toString(),'hello native');host.send(0x24,cmd(guest.virt,P.OP.WINDOW,0,1,123n,{seq:12n,aux:8192}));
 host.send(0x24,cmd(guest.virt,P.OP.FIN,0,1,123n,{seq:10n}));raw=(await until(()=>guest.received.shift(),3000,'legacy close')).body;assert.equal(raw[0],3);h=P.parse(await host.frame(0xa4));assert.equal(h.op,P.OP.RST);assert.equal(h.aux,P.REASON.UNSUPPORTED);
 // Fork-initiated: early legacy data is buffered until native actually OPEN_OK.
 guest.game(host.ip,host.ip,legacy(1,0,55,6600),11453);h=P.parse(await host.frame(0xa4));assert.equal(h.op,P.OP.OPEN);assert(h.srcPort>=49152);assert.equal(h.dstPort,6600);const id=h.id,nonce=h.nonce;
 guest.game(host.ip,host.ip,legacy(2,0,55,0,Buffer.from('early')),11453);await sleep(100);assert(!host.frames.some(f=>f.type===0xa4&&P.parse(f.body)?.op===P.OP.DATA));
 host.send(0x24,cmd(guest.virt,P.OP.OPEN_OK,1,id,nonce,{aux:8192}));h=P.parse(await host.frame(0xa4));assert.equal(h.op,P.OP.DATA);assert.equal(h.payload.toString(),'early');host.send(0x24,cmd(guest.virt,P.OP.WINDOW,1,id,nonce,{seq:5n,aux:8192}));
 host.send(0x24,cmd(guest.virt,P.OP.DATA,1,id,nonce,{seq:0n},Buffer.from('response')));raw=(await until(()=>guest.received.shift(),3000,'legacy return')).body;assert.equal(raw[0],2);assert.equal(raw[1],1);assert.equal(raw.readUInt16LE(2),55);assert.equal(raw.subarray(8).toString(),'response');h=P.parse(await host.frame(0xa4));assert.equal(h.op,P.OP.WINDOW);
 guest.game(host.ip,host.ip,legacy(3,0,55),11453);h=P.parse(await host.frame(0xa4));assert.equal(h.op,P.OP.RST);
 console.log('Actual server + fork wire: both TCP origins, legacy readiness, early-data buffering, credit and whole-close passed (UDP best effort)');
 }finally{for(const x of all)try{x.close()}catch{}server.kill('SIGTERM');await sleep(150);fs.rmSync(dir,{recursive:true,force:true});}}
run().catch(e=>{console.error(e);process.exitCode=1;});
