'use strict';
// Creates only this probe's private room and randomized public test groups. Never joins a third-party group.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs/promises');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { Peer } = require(existsSync(path.join(__dirname, '../../deploy/smoke-relay.cjs')) ? '../../deploy/smoke-relay.cjs' : './smoke-relay.cjs');
class ProviderPeer extends Peer {
    async frame(type) {
        const deadline=Date.now()+3000;
        while(Date.now()<deadline) {
            if(this.failure)throw this.failure;
            while(this.frames.length) { const frame=this.frames.shift();
                if(frame[0]===0x85)throw Error(`Relay rejected ${this.name} with protocol error ${frame[1]}: ${frame.subarray(2).toString('utf8').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,200)}`);
                if(frame[0]===type)return frame.subarray(1);
            }
            if(this.tcp.destroyed)throw Error(`${this.name} control connection closed`);
            await delay(20);
        }
        throw Error(`${this.name} timed out awaiting TCP frame 0x${type.toString(16)}`);
    }
    async enter(code) {
        const nick = Buffer.alloc(32); nick.write(this.name);
        this.send(code ? 2 : 1, Buffer.concat(code ? [code,nick,Buffer.alloc(8),Buffer.from([1])] : [Buffer.alloc(8),nick,Buffer.from([1])]));
        const room = await this.frame(0x81);
        assert(room.length >= 24 && room.length === 24 + room[23] * 37);
        this.code=room.subarray(0,6); this.ip=room.readUInt32LE(7); this.token=room.readUInt32LE(11);
        assert.equal(this.ip >>> 16, 0x0a0d); assert(this.token);
    }
    async select(id) {
        this.send(0x20, Buffer.from(id));
        const deadline=Date.now()+10000;
        while(Date.now()<deadline && !this.frames.some(f=>f[0]===0xa0||f[0]===0x85) && !this.tcp.destroyed)await delay(20);
        const reply = await this.frame(0xa0);
        assert.equal(reply.readUInt32LE(), 64, 'legacy public adapter supplies metadata only, never UDP/seat extensions');
        assert.equal(reply[4], id.length); assert.equal(reply.subarray(5).toString(), id);
        this.send(11); assert.equal((await this.frame(0x89)).readUInt32LE(), 64); this.keepaliveReady=true;
    }
    async payload(receiver, size) {
        const data = randomBytes(size), head = Buffer.alloc(8);
        head.writeUInt32LE(receiver.ip); head.writeUInt16LE(45601,4); head.writeUInt16LE(45602,6);
        for (let attempt=0;attempt<12;attempt++) {
            if(this.failure || receiver.failure) throw this.failure || receiver.failure;
            this.sendUdp(2,Buffer.concat([head,data])); await delay(150);
            if(receiver.packets.some(p=>p[4]===0x82 && p.length===13+size && p.readUInt32LE(5)===this.ip &&
                p.readUInt16LE(9)===45601 && p.readUInt16LE(11)===45602 && p.subarray(13).equals(data))) return;
        }
        throw Error(`Upstream ${size}-byte datagram did not arrive intact`);
    }
    async resume(original) {
        const request=Buffer.alloc(10);request.writeUInt32LE(original.token);original.code.copy(request,4);
        this.send(6,request);const reply=await this.frame(0x81);
        assert(reply.subarray(0,6).equals(original.code));assert.equal(reply.readUInt32LE(7),original.ip);
        assert.equal(reply.readUInt32LE(11),original.token);
        this.code=Buffer.from(original.code);this.ip=original.ip;this.token=original.token;
    }
}
async function publicMetadataSmoke(host,port,provider,report,peers,a,finder) {
    const destination=require('./upstream-gateway').PUBLIC_PROVIDERS.find(p=>p.id===provider);
    if(!destination?.adapterMetadata) throw Error('Metadata probe requires the fixed public adapter');
    const id=randomBytes(8);id[7]=0x7f;const game=id.readBigUInt64LE();
    async function barrier(p){p.send(5);await p.frame(0x86);}
    function info(p){const x=Buffer.alloc(0x480);x.writeBigUInt64LE(game);x[0x20]=2;x.writeUInt32LE(p.ip,0x22);x[0x66]=8;x[0x67]=1;x.writeUInt32LE(p.ip,0x68);x[0x6c]=2;x.writeUInt32LE(p.ip,0x6e);x[0x73]=1;x.write(p.name,0x74,32);x.writeUInt16LE(1,0x96);return x;}
    async function create(p){const nick=Buffer.alloc(32);nick.write(p.name);p.send(1,Buffer.concat([id,nick,Buffer.from([1])]));const r=await p.frame(0x81);p.code=r.subarray(0,6);p.ip=r.readUInt32LE(7);p.token=r.readUInt32LE(11);p.send(7,info(p));await barrier(p);}
    function metadata(app,title){const body=Buffer.alloc(272);body.writeBigUInt64LE(app);body.writeBigUInt64LE(app,8);body.write(title,16,127);return body;}
    async function query(){const request=Buffer.alloc(12);request.writeBigUInt64LE(game);finder.send(0x22,request);const body=await finder.frame(0xa2);assert.equal(body.readUInt32LE(),0xffffffff);assert.equal(body.length,5+336*body[4]);return new Map(Array.from({length:body[4]},(_,i)=>{const r=body.subarray(5+336*i,5+336*(i+1));return[r.subarray(0,6).toString(),r];}));}
    report.adapterCapabilities=64;
    for(const [app,title] of [[0x0100aaa000000000n,'Own actual title A'],[0x0100bbb000000000n,'Own actual title B']]) {
        report.phase='metadata own CREATE/PUBLISH';await create(a);
        a.send(0x21,metadata(app,title));await barrier(a);report.phase='metadata own summary';
        const records=await query();assert.equal(records.size,1);const row=records.get(a.code.toString());
        assert.equal(row.readBigUInt64LE(8),game);assert.equal(row.readBigUInt64LE(16),app);assert.equal(row[34],1);assert(row.subarray(80,208).toString().startsWith(title+'\0'));
        if(app===0x0100aaa000000000n) {await a.leave();assert.equal((await query()).size,0);}
    }
    report.tests.push('two successive actual upstream rooms share one LCID but return their own AppID/title to a visitor without a local game catalog');
    a.close();await delay(400);const restored=new ProviderPeer('OwnMetaResumed',host,port);peers.push(restored);report.phase='metadata host resume';await restored.connect();await restored.select(provider);await restored.resume(a);
    assert.equal((await query()).get(a.code.toString())?.[34],1);report.tests.push('host metadata retained only for same-identity public resume');
    await restored.leave();assert.equal((await query()).size,0);restored.close();report.tests.push('host LEAVE removes its real upstream group and local metadata');
    const external=new ProviderPeer('OwnLegacyHost',destination.host,destination.port);peers.push(external);report.phase='external native host';
    await external.connect();external.send(11);const deadline=Date.now()+3000;
    while(Date.now()<deadline&&!external.frames.length)await delay(20);const caps=external.frames.shift();
    assert(caps && ((caps[0]===0x85&&caps[1]===4)||(caps[0]===0x89&&caps.length===5&&caps.readUInt32LE(1)===0)),'real upstream must remain legacy');
    report.actualUpstreamCapabilities=0;external.keepaliveReady=true;await create(external);
    const unknown=(await query()).get(external.code.toString());assert(unknown);assert.equal(unknown[34],0);assert(unknown.subarray(80).equals(Buffer.alloc(256)));
    report.tests.push('actual upstream caps0 differs from adapter64; native external host has empty metadata');await external.leave();
}
async function main(){
    const [host,portArg,provider,reportPath,...extra]=process.argv.slice(2);
    if(!host || !/^\d+$/.test(portArg||'') || Number(portArg)<1 || Number(portArg)>65535 ||
        !/^[a-z0-9][a-z0-9-]{0,31}$/.test(provider||'') || !reportPath || extra.length)
        throw Error('Usage: node smoke-upstream.cjs GATEWAY_IP PORT PROVIDER_ID REPORT_JSON');
    const report={startedAt:new Date().toISOString(),gateway:{host,port:Number(portArg)},provider,
        scope:'simulated peers; only our new private room and randomized public test groups; no third-party room joined',
        realSwitchGameTest:false,tests:[],status:'running'};
    const a=new ProviderPeer('OwnBridgeTestA',host,Number(portArg)),b=new ProviderPeer('OwnBridgeTestB',host,Number(portArg));
    const peers=[a,b];let failure;
    const ping=setInterval(()=>{for(const p of peers)if(p.keepaliveReady&&p.tcp&&!p.tcp.destroyed&&!p.tcp.writableEnded)p.send(5);},5000);
    try{
        await a.connect();await a.select(provider);await a.enter();await a.register();
        await b.connect();await b.select(provider);await b.enter(a.code);await b.register();
        report.tests.push('explicit provider, separate TCP/UDP registration, own private room join');
        for(const size of[64,1400,1455]){await a.payload(b,size);await b.payload(a,size);report.tests.push(`bidirectional byte-exact ${size} bytes`);}
        b.close();await delay(500);
        const resumed=new ProviderPeer('OwnBridgeResume',host,Number(portArg));peers.push(resumed);
        await resumed.connect();await resumed.select(provider);await resumed.resume(b);await resumed.register();
        await a.payload(resumed,64);await resumed.payload(a,64);report.tests.push('disconnect/resume retains gateway token and virtual IP');
        await a.leave();await resumed.leave();
        await publicMetadataSmoke(host,Number(portArg),provider,report,peers,a,resumed);
        report.status='passed';
    }catch(error){failure=error;report.status='failed';report.error=error.message;}
    finally{
        clearInterval(ping);
        for(const p of [...peers].reverse()){try{if(p.tcp&&!p.tcp.destroyed)await p.leave();}catch{}p.close();}
        report.finishedAt=new Date().toISOString();await fs.mkdir(path.dirname(path.resolve(reportPath)),{recursive:true});
        await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    }
    if(failure)throw failure;
    console.log('Upstream gateway private-room smoke passed: selected provider, bidirectional legacy UDP and resume; no Switch game executed.');
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={ProviderPeer};
