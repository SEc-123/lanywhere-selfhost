'use strict';
// Adapter ↔ actual reliable router using in-memory admitted members; no network or native ABI claims.
const assert=require('node:assert/strict'), P=require('./tcp-stream-protocol'), R=require('./tcp-streams'), A=require('./lanplay-fork-tcp');
const room={gameId:1n,members:[]};const ni=Buffer.alloc(32,9), info=Buffer.alloc(0x480);ni.copy(info);
const native={ip:0x0a0d1111,index:0,token:11,features:3,room,socket:{destroyed:false,writableEnded:false}};
const fork={ip:0x0a0d2222,index:1,token:22,features:3,room,socket:{virtual:true,legacyTcp:true,destroyed:false,writableEnded:false}};
room.members=[native,fork];room.published={info,connected:new Set([native,fork])};const nativeIn=[],legacyOut=[];let adapter, queueAccept=true;
const router=R.create({send:(member,body)=>{if(member===fork)return adapter.receiveControl(body);nativeIn.push(P.parse(body));return true;}});
adapter=A.create({room:'room',ports:A.portPool(),networkId:()=>ni,hasPeer:ip=>ip===native.ip,
 sendControl:(_peer,body)=>router.handle(fork,body),sendLegacy:(_peer,body)=>{if(!queueAccept)return false;legacyOut.push(A.parseLegacy(body));return true;}});
const c=(op,owner,id,nonce,fields={},data=Buffer.alloc(0))=>P.encode(fork.ip,{op,owner,id,nonce,...fields},data);
// Native initiated: router only accepts LEGACY_READY from marked virtual peer.
assert(router.handle(native,c(P.OP.OPEN,0,1,101n,{srcPort:50010,dstPort:9999,aux:4096},ni)).ok);
assert.equal(legacyOut[0].type,A.LT.OPEN);const oldId=legacyOut.shift().id;
assert.equal(nativeIn.shift().op,P.OP.LEGACY_READY);assert.equal(router.snapshot().legacy,1);
assert(router.handle(native,c(P.OP.DATA,0,1,101n,{seq:0n},Buffer.from('native'))).ok);
assert.equal(legacyOut.shift().payload.toString(),'native');let q=nativeIn.shift();assert.equal(q.op,P.OP.WINDOW);assert.equal(q.seq,6n);
assert(adapter.receiveLegacy(native.ip,A.wire(A.LT.DATA,1,oldId,0,Buffer.from('fork'))));q=nativeIn.shift();assert.equal(q.op,P.OP.DATA);assert.equal(q.seq,0n);assert.equal(q.payload.toString(),'fork');
assert(router.handle(native,c(P.OP.WINDOW,0,1,101n,{seq:4n,aux:4096})).ok);
assert(router.handle(native,c(P.OP.RST,0,1,101n,{aux:P.REASON.CLOSED})).ok);assert.equal(legacyOut.shift().type,A.LT.CLOSE);assert.equal(router.snapshot().streams,0);
// A full UDP queue must propagate false and an explicit reset, never pretend OPEN succeeded.
queueAccept=false;assert(!router.handle(native,c(P.OP.OPEN,0,2,101n,{srcPort:50010,dstPort:9999,aux:4096},ni)).ok);q=nativeIn.shift();assert.equal(q.op,P.OP.RST);assert.equal(q.aux,P.REASON.BACKPRESSURE);assert.equal(router.snapshot().streams,0);queueAccept=true;

// Legacy initiated: pending payload waits for native OPEN_OK and uses stable nonce namespace.
assert(adapter.receiveLegacy(native.ip,A.wire(A.LT.OPEN,0,7,3333)));q=nativeIn.shift();assert.equal(q.op,P.OP.OPEN);assert(q.srcPort>=49152);const id=q.id,nonce=q.nonce;
assert(adapter.receiveLegacy(native.ip,A.wire(A.LT.DATA,0,7,0,Buffer.from('early'))));assert.equal(nativeIn.length,0);
assert(router.handle(native,c(P.OP.OPEN_OK,1,id,nonce,{aux:4096})).ok);q=nativeIn.shift();assert.equal(q.op,P.OP.DATA);assert.equal(q.payload.toString(),'early');
assert(router.handle(native,c(P.OP.WINDOW,1,id,nonce,{seq:5n,aux:4096})).ok);
assert(adapter.receiveLegacy(native.ip,A.wire(A.LT.CLOSE,0,7)));q=nativeIn.shift();assert.equal(q.op,P.OP.RST);assert.equal(router.snapshot().streams,0);
// A second fork-originated stream shares the member session nonce with increasing IDs.
assert(adapter.receiveLegacy(native.ip,A.wire(A.LT.OPEN,0,8,3333)));q=nativeIn.shift();assert(q.id>id);assert.equal(q.nonce,nonce);
router.closeMember(native);adapter.shutdown();assert.equal(router.snapshot().streams,0);assert.equal(adapter.snapshot().streams,0);
console.log('Actual TCP router + fork adapter: both initiators, no fake OPEN_OK, bounded credit and cleanup passed');
