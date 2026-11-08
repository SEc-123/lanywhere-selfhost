'use strict';
// Interoperability format described by jieluojun/ldn_mitm commit
// 1014c70d5f82b19bf774b00c851c237d805531ae (GPL-2.0, see upstream LICENSE).
// Wire-only transformations; caller owns per-realm/session peer validation.
const NI = 0x480, NODES = 0x68, NODE_SIZE = 0x40, MAX_NODES = 8;
const CONTROL = 0x4243, GAME = 0x474d, GAME_V2 = 0x474e, MAX_PAYLOAD = 1472;
const BCAST = 0x0a0dffff;
function identity(info) {
    if (!Buffer.isBuffer(info) || info.length !== NI || !info[NODES + 11] ||
        info[0x66] < 1 || info[0x66] > MAX_NODES || info[0x67] < 1 || info[0x67] > info[0x66]) return null;
    const seen = new Set(); let count = 0;
    for (let i = 0; i < MAX_NODES; i++) {
        const p = NODES + i * NODE_SIZE, state = info[p + 11];
        if (!state) continue;
        const address = info.readUInt32LE(p);
        if (state !== 1 || info[p + 10] !== i || !address || seen.has(address)) return null;
        seen.add(address); count++;
    }
    if (count !== info[0x67] || count > info[0x66]) return null;
    const bssid = info.subarray(0x20, 0x26), session = info.subarray(0x10, 0x20);
    const real = info.readUInt32LE(NODES);
    if (!real || !bssid.some(Boolean) || !session.some(Boolean)) return null;
    return { key: Buffer.concat([session, bssid]).toString('hex'), bssid: Buffer.from(bssid), real };
}
function hasNode(info, real) {
    for (let i=0;i<MAX_NODES;i++) { const p=NODES+i*NODE_SIZE; if(info[p+11] && info.readUInt32LE(p)===real) return true; }
    return false;
}
function nodeInfo(info, real) {
    for (let i=0;i<MAX_NODES;i++) { const p=NODES+i*NODE_SIZE; if(info[p+11] && info.readUInt32LE(p)===real) return info.subarray(p,p+NODE_SIZE); }
    return null;
}
// Fail closed until every connected node has a room-bound virtual address;
// lowering the count would falsely advertise spare capacity.
function normalize(info, realToVirtual) {
    if (!identity(info)) return null;
    const out=Buffer.from(info); let connected=0, seenVirtual=new Set();
    for(let i=0;i<MAX_NODES;i++) {
        const p=NODES+i*NODE_SIZE; if(!out[p+11]) continue;
        const real=out.readUInt32LE(p), virt=realToVirtual(real);
        if (!virt || seenVirtual.has(virt)) return null;
        seenVirtual.add(virt); out.writeUInt32LE(virt,p); connected++;
    }
    if(!out[NODES+11] || !connected) return null;
    out[0x67]=connected;return out;
}
function forPeer(info, virtualToReal) {
    const out=Buffer.from(info);
    for(let i=0;i<MAX_NODES;i++) { const p=NODES+i*NODE_SIZE;if(!out[p+11])continue;
        const real=virtualToReal(out.readUInt32LE(p));if(real)out.writeUInt32LE(real,p);
    }
    return out;
}
function addIpId(pkt,id) {
    const out=Buffer.from(pkt);out.writeUInt16BE(id,4);out.writeUInt16BE(0,10);
    let sum=0;const ihl=(out[0]&15)*4;for(let i=0;i<ihl;i+=2)sum+=out.readUInt16BE(i);
    while(sum>>>16)sum=(sum&0xffff)+(sum>>>16);out.writeUInt16BE((~sum)&0xffff,10);return out;
}
function unwrap(id,data) {
    if(id===GAME_V2) { if(data.length<8)return null;return {realSrc:data.readUInt32BE(0),realDst:data.readUInt32BE(4),data:data.subarray(8)}; }
    if(id===GAME) return {realSrc:0,realDst:0,data};
    return null;
}
function wrap(src,dst,data) {
    if(!src||!dst||data.length>MAX_PAYLOAD)return null;
    const shim=Buffer.alloc(8);shim.writeUInt32BE(src,0);shim.writeUInt32BE(dst,4);return Buffer.concat([shim,data]);
}
module.exports={NI,NODES,NODE_SIZE,MAX_NODES,CONTROL,GAME,GAME_V2,MAX_PAYLOAD,BCAST,identity,hasNode,nodeInfo,normalize,forPeer,addIpId,unwrap,wrap};
