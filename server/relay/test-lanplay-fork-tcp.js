'use strict';
const assert=require('node:assert/strict'), A=require('./lanplay-fork-tcp'), W=require('./tcp-stream-protocol');
let clock=0;const peer=0x0a0d0011, ni=Buffer.alloc(32,7),pool=A.portPool(), controls=[],legacy=[];
let accept=true,allowed=true;
const a=A.create({room:'fixture',ports:pool,networkId:()=>ni,hasPeer:p=>allowed&&p===peer,now:()=>clock,
 sendControl:(_peer,b)=>controls.push(W.parse(b)),sendLegacy:(_peer,b)=>{legacy.push(A.parseLegacy(b));return accept;}});
const control=(op,owner,id,nonce,fields={},data=Buffer.alloc(0))=>W.encode(peer,{op,owner,id,nonce,...fields},data);
const take=()=>controls.shift(),old=()=>legacy.shift();
// Native opens: legacy packet carries only destination, and success is explicitly unconfirmed.
assert(a.receiveControl(control(W.OP.OPEN,0,10,11n,{srcPort:50000,dstPort:3333,aux:1},ni)));
let x=old();assert.equal(x.type,A.LT.OPEN);assert.equal(x.port,3333);const oldId=x.id;
x=take();assert.equal(x.op,W.OP.LEGACY_READY);assert.notEqual(x.op,W.OP.OPEN_OK);
assert(a.receiveLegacy(peer,A.wire(A.LT.DATA,1,oldId,0,Buffer.from('abc'))));x=take();assert.equal(x.op,W.OP.DATA);assert.equal(x.seq,0n);assert.equal(x.payload.toString(),'a');
assert(a.receiveControl(control(W.OP.WINDOW,0,10,11n,{seq:1n,aux:2})));x=take();assert.equal(x.seq,1n);assert.equal(x.payload.toString(),'bc');
assert(a.receiveControl(control(W.OP.DATA,0,10,11n,{seq:0n},Buffer.from('hello'))));x=old();assert.equal(x.type,A.LT.DATA);assert.equal(x.owner,0);assert.equal(x.payload.toString(),'hello');x=take();assert.equal(x.op,W.OP.WINDOW);assert.equal(x.seq,5n);
assert(a.receiveControl(control(W.OP.FIN,0,10,11n,{seq:5n})));assert.equal(old().type,A.LT.CLOSE);x=take();assert.equal(x.op,W.OP.RST);assert.equal(x.aux,W.REASON.UNSUPPORTED);assert.equal(a.snapshot().streams,0);
// Legacy opens: nonzero source port is gateway-assigned, not inferred from legacy wire.
assert(a.receiveLegacy(peer,A.wire(A.LT.OPEN,0,7,4444)));x=take();assert.equal(x.op,W.OP.OPEN);assert(x.srcPort>=49152);assert.equal(x.dstPort,4444);assert(x.payload.equals(ni));const id=x.id,nonce=x.nonce;
assert(a.receiveLegacy(peer,A.wire(A.LT.OPEN,0,7,4444)));assert.equal(controls.length,0);assert.equal(a.snapshot().streams,1);
assert(a.receiveLegacy(peer,A.wire(A.LT.DATA,0,7,0,Buffer.from('early'))));assert.equal(controls.length,0);assert.equal(a.snapshot().pendingBytes,5);
assert(a.receiveControl(control(W.OP.OPEN_OK,1,id,nonce,{aux:8192})));x=take();assert.equal(x.op,W.OP.DATA);assert.equal(x.owner,0);assert.equal(x.seq,0n);assert.equal(x.payload.toString(),'early');
assert(a.receiveControl(control(W.OP.DATA,1,id,nonce,{seq:0n},Buffer.from('return'))));x=old();assert.equal(x.owner,1);assert.equal(x.payload.toString(),'return');assert.equal(take().op,W.OP.WINDOW);
assert(a.receiveLegacy(peer,A.wire(A.LT.CLOSE,0,7)));assert.equal(take().op,W.OP.RST);assert.equal(a.snapshot().streams,0);
// Buffer and stream quotas fail closed and close both sides.
assert(a.receiveLegacy(peer,A.wire(A.LT.OPEN,0,8,4444)));take();for(let i=0;i<8;i++)assert(a.receiveLegacy(peer,A.wire(A.LT.DATA,0,8,0,Buffer.alloc(1024))));
assert(!a.receiveLegacy(peer,A.wire(A.LT.DATA,0,8,0,Buffer.alloc(1))));assert.equal(old().type,A.LT.CLOSE);x=take();assert.equal(x.op,W.OP.RST);assert.equal(x.aux,W.REASON.BACKPRESSURE);
assert(a.receiveLegacy(peer,A.wire(A.LT.OPEN,0,88,4444)));take();for(let i=0;i<A.MAX_PENDING_CHUNKS;i++)assert(a.receiveLegacy(peer,A.wire(A.LT.DATA,0,88,0,Buffer.alloc(1))));
assert(!a.receiveLegacy(peer,A.wire(A.LT.DATA,0,88,0,Buffer.alloc(1))));assert.equal(old().type,A.LT.CLOSE);assert.equal(take().aux,W.REASON.BACKPRESSURE);
for(let i=0;i<8;i++){assert(a.receiveLegacy(peer,A.wire(A.LT.OPEN,0,100+i,4444)));take();}assert.equal(a.snapshot().streams,8);
assert(!a.receiveLegacy(peer,A.wire(A.LT.OPEN,0,999,4444)));assert.equal(old().type,A.LT.CLOSE);
clock=5001;a.sweep();assert.equal(a.snapshot().streams,0);assert.equal(controls.length,8);assert.equal(legacy.length,8);controls.length=legacy.length=0;
// Session and disconnected peers cannot open a stream; invalid and truncated legacy frames fail closed.
assert(!a.receiveControl(control(W.OP.OPEN,0,20,22n,{srcPort:50001,dstPort:3333,aux:3},Buffer.alloc(32))));assert.equal(take().aux,W.REASON.SESSION);
allowed=false;assert(!a.receiveLegacy(peer,A.wire(A.LT.OPEN,0,9,3333)));assert(!a.receiveControl(control(W.OP.OPEN,0,21,22n,{srcPort:50001,dstPort:3333,aux:3},ni)));
allowed=true;assert.equal(A.parseLegacy(Buffer.from('0100000001000100','hex')),null);
a.shutdown();console.log('Legacy TCP adapter: origin namespaces, unconfirmed readiness, credits, bounded buffers, timeout and cleanup passed');
