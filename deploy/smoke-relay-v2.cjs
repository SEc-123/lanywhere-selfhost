'use strict';
// Run outside the VPS to test its public wire path; this is not Switch/game acceptance.
const assert = require('node:assert/strict');
const { lookup } = require('node:dns/promises');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { Peer } = require('./smoke-relay.cjs');
const { create } = require(existsSync(path.join(__dirname, 'udp-fragments.js')) ? './udp-fragments.js' : '../server/relay/udp-fragments.js');
let messageId = randomBytes(4).readUInt32LE();

class V2Peer extends Peer {
    constructor(...args) { super(...args); this.assembly = create({ maxTotal: 256 * 1024 }); this.senders = new Map(); }
    async capabilities() {
        this.send(0x0b); const body = await this.frame(0x89);
        if (body.length !== 4 || (body.readUInt32LE() & 12) !== 12) throw Error('Relay lacks V2 fragmentation/heartbeat capabilities');
    }
    async enter(code) {
        const nick = Buffer.alloc(32); nick.write(this.name);
        this.send(code ? 2 : 1, Buffer.concat(code ? [code,nick,Buffer.alloc(8),Buffer.from([1])] : [Buffer.alloc(8),nick,Buffer.from([1])]));
        const room = await this.frame(0x81);
        if (room.length < 24 || room.length !== 24 + 37 * room[23]) throw Error('Malformed room reply');
        this.code = room.subarray(0,6); this.ip = room.readUInt32LE(7); this.token = room.readUInt32LE(11);
        if (this.ip >>> 16 !== 0x0a0d || !this.token) throw Error('Relay did not allocate a NET13 member');
    }
    checkErrors() {
        if (this.failure) throw this.failure;
        const frame = this.frames.find(frame => frame[0] === 0x85);
        if (frame) throw Error(`Relay rejected ${this.name} with error ${frame[1]}`);
    }
    async packet(predicate, timeout = 3000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            this.checkErrors(); const index = this.packets.findIndex(predicate);
            if (index >= 0) return this.packets.splice(index,1)[0];
            await delay(10);
        }
        throw Error(`${this.name} timed out awaiting authenticated UDP response`);
    }
    async register() {
        // Connected UDP + the base rinfo check strictly pin server address/port.
        await super.register();
        const features = Buffer.alloc(4); features.writeUInt32LE(12);
        for (let attempt=0;attempt<3;attempt++) {
            this.sendUdp(4,features);
            try {
                const ack = await this.packet(packet => packet[4]===0x84,1000);
                if (ack.length!==9 || ack.readUInt32LE(5)!==12) throw Error('Invalid V2 negotiation reply');
                return;
            } catch (error) { if (attempt===2 || !error.message.includes('timed out')) throw error; }
        }
    }
    async heartbeat() {
        const nonce=randomBytes(4); this.sendUdp(6,nonce);
        await this.packet(packet => packet[4]===0x86 && packet.length===9 && packet.subarray(5).equals(nonce));
    }
    fragments(destination,payload,reverse=false) {
        const id=messageId=(messageId+1)>>>0;
        const offsets=Array.from({length:Math.ceil(payload.length/1100)},(_,i)=>i*1100);
        if(reverse) offsets.reverse();
        for(const offset of offsets) {
            const body=Buffer.alloc(16); body.writeUInt32LE(destination); body.writeUInt16LE(45601,4);
            body.writeUInt16LE(45602,6); body.writeUInt32LE(id,8); body.writeUInt16LE(payload.length,12); body.writeUInt16LE(offset,14);
            this.sendUdp(5,Buffer.concat([body,payload.subarray(offset,offset+1100)]));
        }
    }
    complete(packet) {
        if(packet[4]===0x82) {
            if(packet.length<13) throw Error('Short DATA_IN');
            return {source:packet.readUInt32LE(5),sport:packet.readUInt16LE(9),dport:packet.readUInt16LE(11),payload:packet.subarray(13)};
        }
        if(packet[4]!==0x85) return null;
        if(packet.length<=21 || packet.length>1121) throw Error('Invalid fragment size');
        const source=packet.readUInt32LE(5),sport=packet.readUInt16LE(9),dport=packet.readUInt16LE(11);
        if(!this.senders.has(source)) { if(this.senders.size>=8) throw Error('Unexpected fragment sender count'); this.senders.set(source,{}); }
        const payload=this.assembly.push(this.senders.get(source),packet.readUInt32LE(13),`${source}:${sport}:${dport}`,
            packet.readUInt16LE(17),packet.readUInt16LE(19),packet.subarray(21));
        return payload && {source,sport,dport,payload};
    }
    async transfer(receiver,size,reverse=false,destination=receiver.ip) {
        const payload=randomBytes(size);
        for(let attempt=0;attempt<3;attempt++) {
            this.checkErrors(); this.fragments(destination,payload,reverse);
            const deadline=Date.now()+2500;
            while(Date.now()<deadline) {
                this.checkErrors(); receiver.checkErrors();
                while(receiver.packets.length) {
                    const packet=receiver.complete(receiver.packets.shift());
                    if(packet && packet.source===this.ip && packet.payload.equals(payload)) {
                        assert.equal(packet.sport,45601); assert.equal(packet.dport,45602); return;
                    }
                }
                await delay(10);
            }
        }
        throw Error(`${size}-byte V2 datagram did not reach ${receiver.name} intact`);
    }
}

async function main() {
    const [host,portArg='11460',...extra]=process.argv.slice(2),port=Number(portArg);
    if(!host || !/^\d+$/.test(portArg) || port<1 || port>65535 || extra.length) throw Error('Usage: node deploy/smoke-relay-v2.cjs VPS_HOST [11460]');
    const {address}=await lookup(host,{family:4});
    const peers=['A','B','C','D'].map(name=>new V2Peer(`V2Smoke${name}`,address,port)),[a,b,c,d]=peers;
    try {
        await Promise.all(peers.map(peer=>peer.connect())); await Promise.all(peers.map(peer=>peer.capabilities()));
        await a.enter(); await b.enter(a.code); await c.enter(); await d.enter(c.code);
        if(a.code.equals(c.code) || new Set(peers.map(peer=>peer.ip)).size!==4) throw Error('Rooms lack distinct identities');
        await Promise.all(peers.map(peer=>peer.register())); await Promise.all(peers.map(peer=>peer.heartbeat()));
        for(const size of [1472,4096,65507]) { await a.transfer(b,size,true); await b.transfer(a,size); }
        await c.transfer(d,4096); await d.transfer(c,4096,true);
        const marker=randomBytes(32); a.fragments(c.ip,marker); await delay(300);
        for(const peer of peers) if(peer.packets.some(packet=>packet.includes(marker))) throw Error('Cross-room unicast leaked');
        await a.transfer(b,4096,false,0xffffffff); await delay(100);
        if([c,d].some(peer=>peer.packets.some(packet=>[0x82,0x85].includes(packet[4])))) throw Error('Broadcast leaked into another room');
        await Promise.all(peers.map(peer=>peer.heartbeat()));
        await b.leave(); await a.leave(); await d.leave(); await c.leave();
        console.log('Switch Online V2 smoke passed: negotiated UDP, bidirectional 1472/4096/65507-byte datagrams, reversed fragments, nonce heartbeats, two-room unicast/broadcast isolation, leave');
    } finally { for(const peer of peers) peer.close(); }
}
if(require.main===module) main().catch(error=>{console.error(`Switch Online V2 smoke: ${error.message}`);process.exitCode=1;});
module.exports={V2Peer};
