'use strict';
// Wire adapter for jieluojun/ldn_mitm@1014c70d (GPLv2). Its UDP tunnel is
// inherently best effort; local WINDOW means accepted into our send queue only.
const crypto = require('crypto'), W = require('./tcp-stream-protocol');
const MAX_STREAMS = 8, MAX_BUFFER = 8192, MAX_PENDING_CHUNKS = 128, OPEN_TIMEOUT = 5000;
const LT = Object.freeze({ OPEN:1, DATA:2, CLOSE:3 });
function portPool() {
    const used = new Set(); let next = 49152;
    return {
        take(room, peer) { for (let i=0;i<16384;i++) { const port=next; next=next===65535?49152:next+1;
            const key=`${room}:${peer}:${port}`; if(!used.has(key)){used.add(key);return port;} } return 0; },
        release(room,peer,port) { used.delete(`${room}:${peer}:${port}`); },
    };
}
function wire(type, owner, id, port=0, payload=Buffer.alloc(0)) {
    if(!Number.isInteger(id)||id<0||id>65535||payload.length>W.MAX_CHUNK) throw Error('invalid legacy stream');
    const h=Buffer.alloc(8); h[0]=type;h[1]=owner;h.writeUInt16LE(id,2);h.writeUInt16LE(port,4);
    h.writeUInt16LE(payload.length,6);return Buffer.concat([h,payload]);
}
function parseLegacy(data) {
    if(!Buffer.isBuffer(data)||data.length<8)return null;
    const type=data[0],owner=data[1],id=data.readUInt16LE(2),port=data.readUInt16LE(4),n=data.readUInt16LE(6);
    if(owner>1||n>W.MAX_CHUNK||data.length!==8+n)return null;
    if(type===LT.OPEN && (owner!==0||!port||n))return null;
    if(type===LT.DATA && (!n||port))return null;
    if(type===LT.CLOSE && (n||port))return null;
    if(!Object.values(LT).includes(type))return null;
    return {type,owner,id,port,payload:data.subarray(8)};
}
function create({room, networkId, hasPeer, sendControl, sendLegacy, ports, now=Date.now}) {
    if(!room||typeof networkId!=='function'||typeof hasPeer!=='function'||typeof sendControl!=='function'||
        typeof sendLegacy!=='function'||!ports) throw TypeError('missing legacy adapter dependency');
    const streams=new Map(), legacy=new Map(); let nextOwnId=1,nextLegacyId=1;
    const generation=()=>{let x=crypto.randomBytes(8).readBigUInt64LE();return x||1n;};
    const originNonce = generation(); // one monotonic id namespace per virtual-member session
    const fullKey=(peer,owner,id,nonce)=>`${peer}:${owner}:${id}:${nonce}`;
    const legacyKey=(peer,origin,id)=>`${peer}:${origin}:${id}`;
    function send(s,op,fields={},payload=Buffer.alloc(0)) {
        const owner=s.origin==='fork'?0:1;
        sendControl(s.peer,W.encode(s.peer,{op,owner,id:s.id,nonce:s.nonce,...fields},payload));
    }
    function close(s,reason=W.REASON.CLOSED,notifyControl=true,notifyLegacy=true) {
        if(!streams.has(s.key))return;
        streams.delete(s.key);legacy.delete(s.lkey);
        if(s.assignedPort)ports.release(room,s.peer,s.assignedPort);
        if(notifyLegacy)sendLegacy(s.peer,wire(LT.CLOSE,s.origin==='fork'?1:0,s.legacyId));
        if(notifyControl)send(s,W.OP.RST,{aux:reason});
    }
    function reserveLegacyId(peer) {
        for(let i=0;i<65535;i++){const id=nextLegacyId;nextLegacyId=nextLegacyId===65535?1:nextLegacyId+1;
            if(!legacy.has(legacyKey(peer,'native',id)))return id;}return 0;
    }
    function flush(s) {
        while(s.ready && s.pending.length) {
            const avail=s.peerAck+BigInt(s.peerWindow)-s.toNative;
            if(avail<=0n)return;
            const head=s.pending[0],n=Math.min(head.length,Number(avail),W.MAX_CHUNK);
            if(!n)return;const chunk=head.subarray(0,n);
            send(s,W.OP.DATA,{seq:s.toNative},chunk);
            if (!streams.has(s.key)) return; // router may synchronously reject and reset
            s.toNative+=BigInt(n);s.pendingBytes-=n;
            if(n===head.length)s.pending.shift();else s.pending[0]=head.subarray(n);
        }
    }
    function receiveLegacy(peer,data) {
        if(!hasPeer(peer))return false;
        const f=parseLegacy(data);if(!f)return false;
        const origin=f.owner===0?'fork':'native';const lk=legacyKey(peer,origin,f.id);
        let s=legacy.get(lk);
        if(f.type===LT.OPEN) {
            if(s) { // An exact duplicate is idempotent; a changed destination is ambiguous.
                if (s.destinationPort !== f.port) { close(s,W.REASON.PROTOCOL); return false; }
                return true;
            }
            if(streams.size>=MAX_STREAMS)return sendLegacy(peer,wire(LT.CLOSE,1,f.id)),false;
            const ni=networkId();if(!Buffer.isBuffer(ni)||ni.length!==32)return false;
            const assignedPort=ports.take(room,peer);if(!assignedPort)return sendLegacy(peer,wire(LT.CLOSE,1,f.id)),false;
            if(nextOwnId>0xffffffff){ports.release(room,peer,assignedPort);sendLegacy(peer,wire(LT.CLOSE,1,f.id));return false;}
            const id=nextOwnId++,nonce=originNonce,key=fullKey(peer,'fork',id,nonce);
            s={key,lkey:lk,origin:'fork',peer,id,nonce,legacyId:f.id,destinationPort:f.port,assignedPort,started:now(),ready:false,
                pending:[],pendingBytes:0,toNative:0n,fromNative:0n,peerAck:0n,peerWindow:0};
            streams.set(key,s);legacy.set(lk,s);
            send(s,W.OP.OPEN,{srcPort:assignedPort,dstPort:f.port,aux:MAX_BUFFER},Buffer.from(ni));return true;
        }
        if(!s)return false;
        if(f.type===LT.CLOSE){close(s,W.REASON.CLOSED,true,false);return true;}
        if(s.pending.length>=MAX_PENDING_CHUNKS||s.pendingBytes+f.payload.length>MAX_BUFFER){close(s,W.REASON.BACKPRESSURE);return false;}
        s.pending.push(Buffer.from(f.payload));s.pendingBytes+=f.payload.length;flush(s);return true;
    }
    function receiveControl(body) {
        const f=W.parse(body);if(!f||!hasPeer(f.peer))return false;
        const origin=f.owner===0?'native':'fork';const key=fullKey(f.peer,origin,f.id,f.nonce);
        let s=streams.get(key);
        if(f.op===W.OP.OPEN) {
            if(s)return false;
            const ni=networkId();
            if(!Buffer.isBuffer(ni)||ni.length!==32||!ni.equals(f.payload)||streams.size>=MAX_STREAMS) {
                const reason=streams.size>=MAX_STREAMS?W.REASON.CAPACITY:W.REASON.SESSION;
                sendControl(f.peer,W.encode(f.peer,{op:W.OP.RST,owner:1,id:f.id,nonce:f.nonce,aux:reason}));return false;
            }
            const id=reserveLegacyId(f.peer);if(!id){sendControl(f.peer,W.encode(f.peer,{op:W.OP.RST,owner:1,id:f.id,nonce:f.nonce,aux:W.REASON.CAPACITY}));return false;}
            const lk=legacyKey(f.peer,'native',id);
            s={key,lkey:lk,origin:'native',peer:f.peer,id:f.id,nonce:f.nonce,legacyId:id,assignedPort:0,started:now(),ready:true,
                pending:[],pendingBytes:0,toNative:0n,fromNative:0n,peerAck:0n,peerWindow:f.aux};
            streams.set(key,s);legacy.set(lk,s);
            if(!sendLegacy(f.peer,wire(LT.OPEN,0,id,f.dstPort))){close(s,W.REASON.BACKPRESSURE,true,false);return false;}
            send(s,W.OP.LEGACY_READY,{aux:MAX_BUFFER});return true;
        }
        if(!s)return false;
        switch(f.op) {
            case W.OP.OPEN_OK:
                if(s.origin!=='fork'||s.ready){close(s,W.REASON.PROTOCOL);return false;}
                s.ready=true;s.peerWindow=f.aux;flush(s);return true;
            case W.OP.DATA:
                if(!s.ready||f.seq!==s.fromNative||f.payload.length>MAX_BUFFER){close(s,W.REASON.PROTOCOL);return false;}
                if(!sendLegacy(s.peer,wire(LT.DATA,s.origin==='native'?0:1,s.legacyId,0,f.payload))){close(s,W.REASON.BACKPRESSURE,true,false);return false;}
                s.fromNative+=BigInt(f.payload.length);send(s,W.OP.WINDOW,{seq:s.fromNative,aux:MAX_BUFFER});return true;
            case W.OP.WINDOW:
                if(!s.ready||f.seq<s.peerAck||f.seq>s.toNative){close(s,W.REASON.PROTOCOL);return false;}
                s.peerAck=f.seq;s.peerWindow=f.aux;flush(s);return true;
            case W.OP.FIN:
                // The legacy format has no half-close; report whole-close explicitly.
                close(s,W.REASON.UNSUPPORTED,true,true);return true;
            case W.OP.RST:
                close(s,W.REASON.CLOSED,false,true);return true;
            default:close(s,W.REASON.PROTOCOL);return false;
        }
    }
    function sweep() { for(const s of streams.values()) {
        if(!hasPeer(s.peer))close(s,W.REASON.CLOSED);
        else if(!s.ready&&now()-s.started>=OPEN_TIMEOUT)close(s,W.REASON.TIMEOUT);
    } }
    function dropPeer(peer) { for(const s of [...streams.values()])if(s.peer===peer)close(s,W.REASON.CLOSED,false,true); }
    function shutdown() { for(const s of [...streams.values()])close(s,W.REASON.SESSION); }
    return {receiveLegacy,receiveControl,sweep,dropPeer,shutdown,snapshot:()=>({streams:streams.size,pendingBytes:[...streams.values()].reduce((n,s)=>n+s.pendingBytes,0)})};
}
module.exports={create,portPool,wire,parseLegacy,LT,MAX_STREAMS,MAX_BUFFER,MAX_PENDING_CHUNKS,OPEN_TIMEOUT};
