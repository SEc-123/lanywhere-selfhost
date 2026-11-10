'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),dgram=require('node:dgram');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{setTimeout:delay}=require('node:timers/promises');
const {ConsolePeer,networkInfo,u64,until}=require('./test-public-e2e');
const {create:realms}=require('./lanplay-realms');
const {Emu}=require('./lanplay-probe-peer');
const F=0xffffffffffffffffn,UPDATE='actualiza LANywhere para entrar en esta sala';
// Actual inspected NACP[0] values for the user's two installed titles. Scarlet
// is only a synthetic peer using Violet's shared LCID here, not an SD finding.
const DYING=0x01008c8012920000n,SHARED_POKEMON=0x0100a3d008c5c000n;
async function unusedPort(udp=false){
 const s=udp?dgram.createSocket('udp4'):net.createServer();
 if(udp)await new Promise(r=>s.bind(0,'127.0.0.1',r));else await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const port=s.address().port;await new Promise(r=>s.close(r));return port;
}
async function launch(t,{prelude='',env:extra={}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'self-lcid-guard-')),statsPort=await unusedPort();
 const file=path.join(dir,'start.cjs');fs.writeFileSync(file,prelude+`\nrequire(${JSON.stringify(path.join(__dirname,'server.js'))});\n`);
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('LANYWHERE_')));
 Object.assign(env,{LANYWHERE_STATE_DIR:dir,LANYWHERE_STATS_PORT:String(statsPort),LANYWHERE_PUBLIC_PORT:'0',LANYWHERE_OPS_PORT:'0',
  LANYWHERE_LANPLAY_PORT:'0',LANYWHERE_ENABLE_LANPLAY_UPSTREAM:'0',LANYWHERE_ENABLE_PUBLIC_UPSTREAM:'0',
  LANYWHERE_CONTROL_BIND_ADDRESS:'127.0.0.1',LANYWHERE_UDP_BIND_ADDRESS:'127.0.0.1',LANYWHERE_SHUTDOWN_GRACE_MS:'0'},extra);
 const child=spawn(process.execPath,[file,'--port','0'],{env,stdio:['ignore','pipe','pipe']});const clients=[];let logs='';
 for(const s of [child.stdout,child.stderr])s.on('data',b=>{logs=(logs+b).slice(-16000);});
 t.after(async()=>{for(const p of clients)p.close();if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await Promise.race([done,delay(2000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}fs.rmSync(dir,{recursive:true,force:true});});
 const port=await until(()=>{if(child.exitCode!==null)throw Error(logs);return Number(/datos UDP en (\d+)/.exec(logs)?.[1])||null;},'isolated self relay');
 const open=async name=>{const p=new ConsolePeer(name,port);clients.push(p);await p.open({udp:false});return p;};
 return {open,port,stats:async()=>{const r=await fetch(`http://127.0.0.1:${statsPort}/api/stats`);assert(r.ok);return r.json();}};
}
async function rejected(peer,type,body,code=8){peer.send(type,body);const reply=await peer.frame(0x85);assert.equal(reply[0],code);if(code===8)assert.equal(reply.subarray(1).toString(),UPDATE);}
function admission(peer,game){return Buffer.concat([u64(game),peer.nickname(),Buffer.from([1])]);}
function page(game){return Buffer.concat([u64(game),Buffer.alloc(4)]);}
function filter(game){const b=Buffer.alloc(101);b.writeBigUInt64LE(game);b.writeUInt32LE(1,92);b[96]=1;return b;}
function reserve(game){const b=Buffer.alloc(122);b.fill(0x31,0,16);b.writeBigUInt64LE(game,16);b.writeUInt32LE(1,108);b[115]=1;return b;}

test('pure self rejects unresolved LCID before rooms, seats, tickets or search state are created',{timeout:15000},async t=>{
 const service=await launch(t),old=await service.open('OwnOldClient');
 old.send(0x20,Buffer.from('self'));assert.equal((await old.frame(0xa0)).readUInt32LE() & 255,255);
 for(let i=0;i<11;i++)await rejected(old,1,admission(old,F)); // Does not spend the default ten-CREATE quota.
 let state=await service.stats();assert.equal(state.now.rooms,0);assert.equal(state.now.online,0);assert.equal(state.counters.roomsCreated||0,0);
 await rejected(old,1,Buffer.alloc(39,0xff),4);await old.create(0n);old.send(3);await old.barrier();
 state=await service.stats();assert.equal(state.now.rooms,0);assert.equal(state.now.online,0,'same socket has no retained seat after rejected CREATE');
 for(const [type,body] of [[8,u64(F)],[0x0c,page(F)],[0x22,page(F)],[0x0d,filter(F)],[9,reserve(F)]])await rejected(old,type,body);
 const canonical=reserve(DYING);old.send(9,canonical);assert.equal((await old.frame(0x88))[0],0,'rejected sentinel ticket did not retain a conflicting signature');
 old.send(10,canonical.subarray(0,16));assert.equal((await old.frame(0x88))[0],2);
 old.send(8);assert.equal((await old.frame(0x87))[0],0,'empty global list remains valid');
 for(const [request,response] of [[0x0c,0x8a],[0x22,0xa2]]){old.send(request,page(0n));assert.equal((await old.frame(response))[4],0);}
 const host=await service.open('OwnResolvedHost');await host.create(DYING);await host.publish(networkInfo([host],8,DYING));
 await rejected(host,7,networkInfo([host],8,F));await rejected(host,7,Buffer.alloc(8,0xff),4);
 const rows=await old.find(DYING);assert.deepEqual(rows.map(r=>r.code),[host.code]);assert.equal(rows[0].info.readBigUInt64LE(),DYING,'failed PUBLISH cannot replace canonical information');
 await rejected(old,2,Buffer.concat([Buffer.from(host.code),old.nickname(),u64(F),Buffer.from([1])]));
 assert.equal((await service.stats()).now.online,1,'failed JOIN cannot create an admission seat');
});

test('canonical Dying Light separates from Pokemon while shared Scarlet/Violet fixture IDs can find and join',{timeout:15000},async t=>{
 const service=await launch(t),dying=await service.open('Dying fixture'),scarlet=await service.open('Scarlet fixture'),violet=await service.open('Violet fixture'),viewer=await service.open('OwnFinder');
 for(const [peer,id] of [[dying,DYING],[scarlet,SHARED_POKEMON],[violet,SHARED_POKEMON]]){await peer.create(id);await peer.publish(networkInfo([peer],8,id));}
 assert.deepEqual((await viewer.find(DYING)).map(r=>r.code),[dying.code]);
 assert.deepEqual(new Set((await viewer.find(SHARED_POKEMON)).map(r=>r.code)),new Set([scarlet.code,violet.code]));
 assert.equal((await viewer.find(0n)).length,3);
 await viewer.join(scarlet.code,{game:DYING,error:3});await viewer.join(scarlet.code,{game:SHARED_POKEMON});
 assert.equal((await service.stats()).now.online,4);
});

test('Scarlet/Violet-style Local Trade peers can take turns advertising and joining over TCP', { timeout: 15000 }, async t => {
    const service = await launch(t);
    const scarlet = await service.open('Scarlet fixture');
    const violet = await service.open('Violet fixture');
    const unrelated = await service.open('Other scene fixture');
    const game = SHARED_POKEMON;
    const tradeScene = 4;
    const tradeFilter = filter(game);
    tradeFilter.writeUInt16LE(tradeScene, 10);
    tradeFilter.writeUInt32LE(0x21, 92); // LocalCommunicationId and SceneId.

    function advertisement(peers, scene, sessionByte, data) {
        const info = networkInfo(peers, 2, game);
        info.writeUInt16LE(scene, 10);
        info.fill(sessionByte, 16, 32);
        info.writeUInt16LE(data.length, 0x26a);
        data.copy(info, 0x26c);
        return info;
    }

    async function scan(peer) {
        peer.send(0x0d, tradeFilter);
        const page = await peer.frame(0x8a);
        assert.equal(page.readUInt32LE(), 0xffffffff);
        assert.equal(page.length, 5 + page[4] * (6 + 0x480));
        return page;
    }

    function checkAdvertisement(info, sessionByte, data) {
        assert.equal(info.readBigUInt64LE(), game);
        assert.equal(info.readUInt16LE(10), tradeScene);
        assert.deepEqual(info.subarray(16, 32), Buffer.alloc(16, sessionByte));
        assert.equal(info.readUInt16LE(0x26a), 132);
        assert.deepEqual(info.subarray(0x26c, 0x26c + 132), data);
    }

    await unrelated.create(game);
    await unrelated.publish(advertisement([unrelated], 7, 0x30, Buffer.alloc(0)));
    assert.deepEqual((await scarlet.find(game)).map(row => row.code), [unrelated.code]);
    assert.equal((await scan(scarlet))[4], 0);
    assert.equal((await scan(violet))[4], 0);

    for (const [host, guest, sessionByte] of [[scarlet, violet, 0x41], [violet, scarlet, 0x42]]) {
        // Synthetic opaque game data. The relay must return all bytes unchanged.
        const data = Buffer.from(Array.from({ length: 132 }, (_, index) => (index * 73 + sessionByte) & 255));
        await host.create(game);
        await host.publish(advertisement([host], tradeScene, sessionByte, data));
        const page = await scan(guest);
        assert.equal(page[4], 1);
        const code = page.toString('ascii', 5, 11);
        assert.equal(code, host.code);
        checkAdvertisement(page.subarray(11), sessionByte, data);

        assert.equal(await guest.join(code, { game }), 2);
        const guestNode = networkInfo([guest], 2, game).subarray(0x68, 0xa8);
        guest.relay(host.index, 3, guestNode); // LDN CONNECT.
        assert.equal((await host.ldn(guest, 3)).readUInt32LE(), guest.ip);
        const connected = advertisement([host, guest], tradeScene, sessionByte, data);
        await host.publish(connected);
        host.relay(guest.index, 4, connected); // LDN SYNC.
        const synced = await guest.ldn(host, 4);
        assert.equal(synced[0x67], 2);
        assert.equal(synced.readUInt32LE(0xa8), guest.ip);
        checkAdvertisement(synced, sessionByte, data);

        guest.send(3); // LEAVE releases this socket for the next host phase.
        await guest.barrier();
        await host.publish(); // Withdraw before closing this transient host session.
        assert.equal((await scan(guest))[4], 0);
        host.send(3);
        await host.barrier();
        await guest.join(code, { game, error: 1 });
    }

    assert.equal((await service.stats()).now.rooms, 1, 'only the unrelated scene remains');
});

test('private CREATE0 survives while raw sentinel SCAN_RESP/SYNC cannot cross the self room',{timeout:12000},async t=>{
 const service=await launch(t),host=await service.open('OwnPrivateHost'),guest=await service.open('OwnPrivateGuest');
 await host.create(0n);await guest.join(host.code,{game:0n});
 for(const type of [2,4]){
  host.relay(guest.index,type,u64(F));await host.barrier();assert(!host.frames.some(f=>f.type===0x85),'short payload is rejected before reading LCID');
  host.relay(guest.index,type,networkInfo([host,guest],8,F));const error=await host.frame(0x85);assert.equal(error[0],8);assert.equal(error.subarray(1).toString(),UPDATE);
  await guest.barrier();assert(!guest.frames.some(f=>f.type===0x84),'unresolved network identity was not forwarded');
 }
 host.relay(guest.index,4,networkInfo([host,guest],8,DYING));assert.equal((await guest.ldn(host,4)).readBigUInt64LE(),DYING);
 guest.send(3);await guest.barrier();host.send(3);await host.barrier();assert.equal((await service.stats()).now.rooms,0);
});

test('selected external traffic and supervised child realms retain legacy sentinel interoperability',{timeout:15000},async t=>{
 const udp=dgram.createSocket('udp4');udp.on('message',(m,r)=>{if(m[0]===2)udp.send(m,r.port,r.address);});await new Promise(r=>udp.bind(0,'127.0.0.1',r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lcid-child-')),provider={id:'lanplay-lcid-fixture',host:'127.0.0.1',port:udp.address().port,allowPrivate:true};
 const childFile=path.join(dir,'child.cjs');fs.writeFileSync(childFile,`require.cache[require.resolve(${JSON.stringify(path.join(__dirname,'lanplay-providers.js'))})]={exports:[${JSON.stringify(provider)}]};require(${JSON.stringify(path.join(__dirname,'server.js'))});`);
 const manager=realms({providers:[provider],serverFile:childFile,startupMs:4000,idleMs:50});let lease;
 t.after(async()=>{lease?.release();await manager.shutdown();assert.deepEqual(manager.snapshot(),[]);udp.close();fs.rmSync(dir,{recursive:true,force:true});});
 lease=await manager.providers[0].acquire();
 const upstream={id:'lanplay-lcid-fixture',host:'127.0.0.1',port:lease.port,maxConnections:8,capabilities:462,udpCaps:12,lanplay:true,localTransport:true};
 const service=await launch(t,{prelude:`require(${JSON.stringify(path.join(__dirname,'upstream-gateway.js'))}).PUBLIC_PROVIDERS=[${JSON.stringify(upstream)}];`,env:{LANYWHERE_ENABLE_PUBLIC_UPSTREAM:'1'}});
 const host=await service.open('OwnExternalHost'),viewer=await service.open('OwnExternalFinder'),guest=await service.open('OwnExternalGuest');
 for(const p of [host,viewer,guest]){p.send(0x20,Buffer.from(provider.id));assert.equal((await p.frame(0xa0)).readUInt32LE(),462);}
 await host.create(F);await host.publish(networkInfo([host],8,F));assert.deepEqual((await viewer.find(F)).map(r=>r.code),[host.code]);
 for(const [request,response] of [[0x0c,0x8a],[0x22,0xa2]]){viewer.send(request,page(F));assert.equal((await viewer.frame(response))[4],1);}
 await guest.join(host.code,{game:F});guest.send(3);await guest.barrier();host.send(3);await host.barrier();
 assert.equal((await service.stats()).now.upstream.members,0);assert.equal((await service.stats()).now.upstream.rooms,0);
 const own=await service.open('OwnSelfGuard');await rejected(own,1,admission(own,F));
});

test('optional parent LAN Play virtual peers may still publish a raw sentinel room',{timeout:12000},async t=>{
 const lanplayPort=await unusedPort(true),service=await launch(t,{env:{LANYWHERE_LANPLAY_PORT:String(lanplayPort)}});
 const emu=new Emu(0x0a0d4444,'OwnLegacyVirtual',{host:'127.0.0.1',port:lanplayPort},F);await emu.start();emu.host();t.after(()=>emu.close());
 const viewer=await service.open('OwnBridgeViewer');let rows=[];
 await until(async()=>{rows=await viewer.find(0n);return rows.some(r=>r.info.readBigUInt64LE()===F);},'own virtual legacy publication',6000);
 const legacy=rows.find(r=>r.info.readBigUInt64LE()===F);assert(legacy);await rejected(viewer,8,u64(F));
 await rejected(viewer,2,Buffer.concat([Buffer.from(legacy.code),viewer.nickname(),u64(0n),Buffer.from([1])]));
 assert.equal((await service.stats()).now.online,1,'JOIN with omitted game identity cannot enter an unresolved self room');
});
