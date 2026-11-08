'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs/promises'), dns = require('node:dns/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { V2Peer } = require('../../deploy/smoke-relay-v2.cjs');
const { Emu, nodeInfo } = require('./lanplay-probe-peer');
const L = require('./lanplay');
async function until(fn, what, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await delay(25); } throw Error('Timeout: '+what); }
async function run({ host, port, provider, endpoint, external = null, sizes = [64, 1400, 1455, 4096, 65507] }) {
    if (!Array.isArray(sizes) || !sizes.length || sizes.some(n=>!Number.isInteger(n)||n<1||n>65507)) throw Error('Invalid probe payload sizes');
    const nonce = crypto.randomBytes(8); nonce[7] = 0x7f; const game = external ? BigInt(external.game) : nonce.readBigUInt64LE();
    const emuIp = external ? external.ip : (0x0a0d0000 | (1 + crypto.randomInt(254)) << 8 | (1 + crypto.randomInt(254))) >>> 0;
    const emu = external ? null : new Emu(emuIp, 'OwnLANPlayProbe', endpoint, game);
    const peer = new V2Peer('OwnGatewayProbe', host, port);
    const report = { provider, upstream: endpoint, realSwitchGameTest: false,
        scope: 'own randomized LDN test group; independent standard LAN Play UDP peer; no third-party group joined', tests: [] };
    let ping;
    try {
        if (emu) { await emu.start(); emu.host(); }
        // Register its virtual source at the public relay before the gateway scans.
        emu?.udp(L.BCAST, 11452, 11452, L.ldnFrame(L.LT.SCAN));
        await peer.connect(); peer.send(0x20,Buffer.from(provider)); await until(()=>peer.frames.some(f=>f[0]===0xa0 || f[0]===0x85),'provider startup',14000); const caps=await peer.frame(0xa0); assert.equal(caps.readUInt32LE() & 78,78); assert.equal(caps.subarray(5).toString(),provider);
        ping = setInterval(() => { peer.send(5); emu?.raw(L.P.KEEPALIVE, Buffer.alloc(0)); }, 4000);
        const filter = Buffer.alloc(15); filter.writeBigUInt64LE(game); filter[14] = 1;
        let found;
        for (let attempt = 0; attempt < 8 && !found; attempt++) {
            peer.send(8, filter); const reply = await peer.frame(0x87);
            for (let i = 0; i < reply[0]; i++) { const at = 1 + i * (6 + 0x480);
                if (reply.readBigUInt64LE(at+6) === game && reply.readUInt32LE(at+6+0x68) === emuIp) found = Buffer.from(reply.subarray(at, at+6)); }
            if (!found) await delay(700);
        }
        assert(found, 'our external test group must be discovered through public LAN Play');
        report.tests.push('external LDN SCAN/SCAN_RESP through selected public relay');
        const nick = Buffer.alloc(32); nick.write(peer.name); const g = Buffer.alloc(8); g.writeBigUInt64LE(game);
        peer.send(2, Buffer.concat([found, nick, g, Buffer.from([1])]));
        const room = await peer.frame(0x81); peer.code = room.subarray(0,6); peer.index = room[6]; peer.ip = room.readUInt32LE(7); peer.token = room.readUInt32LE(11);
        await peer.register(); await peer.heartbeat(); peer.send(4, Buffer.concat([Buffer.from([0,3]), nodeInfo(peer.ip, peer.name)]));
        const sync = await peer.frame(0x84); assert.equal(sync[0],0); assert.equal(sync[1],4);
        if (emu) await until(() => emu.stations.includes(peer.ip), 'LDN TCP CONNECT/SYNC');
        report.tests.push('native JOIN translated to external IPv4 TCP LDN CONNECT/SYNC');
        for (const size of sizes) {
            const bytes = crypto.randomBytes(size), ports = Buffer.alloc(8); ports.writeUInt32LE(emuIp); ports.writeUInt16LE(45601,4); ports.writeUInt16LE(45602,6);
            if (emu) for (let n=0;n<3;n++) {
                peer.fragments(emuIp, bytes, true); const end=Date.now()+2200;
                while(Date.now()<end && !emu.udpIn.some(p=>p.src===peer.ip && p.dst===emuIp && p.sport===45601 && p.dport===45602 && p.data.equals(bytes))) await delay(20);
                if (emu.udpIn.some(p=>p.src===peer.ip && p.dst===emuIp && p.data.equals(bytes))) break;
            }
            if (emu) assert(emu.udpIn.some(p => p.src===peer.ip && p.dst===emuIp && p.data.equals(bytes)), `outbound ${size}`);
            let received = false;
            for (let n=0;n<3 && !received;n++) { if(emu) emu.udp(peer.ip,45602,45601,bytes); else peer.fragments(emuIp,bytes,true);
                const end=Date.now()+(external?4000:1800);
                while (Date.now()<end && !received) { while(peer.packets.length) { const p=peer.complete(peer.packets.shift());
                    if(p && p.source===emuIp && p.sport===45602 && p.dport===45601 && p.payload.equals(bytes)) received=true; }
                    if(!received) await delay(15); }
            }
            assert(received, `inbound ${size}`);
            report.tests.push(`bidirectional byte-exact ${size} bytes via public relay`);
        }
        if(emu) { assert(emu.received>0); assert(emu.maxMsg <= 1401, 'gateway fragments IPv4 to bounded wire MTU'); }
        await peer.heartbeat(); report.tests.push('pinned source endpoint, reversed native and IPv4 fragments, nonce heartbeat, independent external transport');
        report.status = 'passed'; return report;
    } catch (error) { error.report = {...report, diagnostics: emu && {received:emu.received, maxWire:emu.maxMsg, packets:emu.udpIn.map(p=>p.data.length), partial:[...(emu.frags||new Map()).values()].slice(-15).map(r=>({total:r.total, parts:r.parts.length, bytes:r.parts.reduce((n,p)=>n+p.body.length,0), offsets:r.parts.map(p=>p.off)}))}}; throw error;
    } finally { clearInterval(ping); try { await peer.leave(); } catch {} peer.close(); emu?.close(); }
}
if (require.main === module) (async () => {
    const [host, port, provider, output, externalArg, sizesArg, ...extra] = process.argv.slice(2);
    const config = require('./lanplay-providers').find(p => p.id === provider);
    if (!config || !host || !/^\d+$/.test(port||'') || Number(port)<1 || Number(port)>65535 || !output || extra.length) throw Error('Usage: HOST PORT PROVIDER_ID REPORT [EXTERNAL_PEER_JSON] [PAYLOAD_SIZES_CSV]');
    const { address } = await dns.lookup(config.host, {family:4}); let report;
    try { report = await run({host,port:Number(port),provider,endpoint:{host:address,port:config.port},external:externalArg?JSON.parse(externalArg):null,sizes:sizesArg?sizesArg.split(',').map(Number):undefined}); }
    catch (e) { report = {...e.report,provider,status:'failed',error:e.message,realSwitchGameTest:false}; process.exitCode=1; }
    await fs.writeFile(output, JSON.stringify({...report,finishedAt:new Date().toISOString()},null,2)+'\n');
    console.log(JSON.stringify(report));
})().catch(e => { console.error(e.message); process.exitCode=1; });
module.exports = { run };
