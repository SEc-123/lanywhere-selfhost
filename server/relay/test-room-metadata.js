'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create,parse}=require('./room-metadata');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ConsolePeer,networkInfo,u64,until}=require('./test-public-e2e');
const GAME=0x0100000000abc000n,APP=0x0100000000abc800n,PROGRAM=0x0100000000abc801n;
function payload(en='Host title',zh='主机游戏名'){const b=Buffer.alloc(272);b.writeBigUInt64LE(PROGRAM);b.writeBigUInt64LE(APP,8);b.write(en,16,127);b.write(zh,144,127);return b;}
function fixture(){const host={socket:{destroyed:false},nick:'Host'},guest={socket:{destroyed:false}};const room={code:'ABC234',gameId:GAME,members:[host,guest],published:{info:Buffer.alloc(0x480)}};room.published.info[0x66]=8;room.published.info[0x67]=2;host.room=guest.room=room;return{host,guest,room};}

test('metadata rejects malformed UTF-8, hidden suffixes, controls and bidi while preserving canonical titles',()=>{
 assert(parse(payload()));assert(parse(payload('汉'.repeat(42),'')));
 const cases=[];
 let b=payload();b.fill(0x61,16,144);cases.push(b);
 b=payload();b[20]=0;b[21]=65;cases.push(b);
 b=payload();b.fill(0,16,144);b[16]=0xc0;b[17]=0xaf;cases.push(b);
 cases.push(payload('bad\nname'),payload('bad\u202ename'),payload('bad\u2066name'),payload('bad\u200fname'));
 for(const data of cases)assert.equal(parse(data),null);
 for(const cp of [0x061c,0x200b,0x200e,0x200f,0x2028,0x2029,0x202a,0x202b,0x202c,0x202d,0x202e,0x2066,0x2067,0x2068,0x2069,0x206a,0x206b,0x206c,0x206d,0x206e,0x206f,0xfeff])
  assert.equal(parse(payload('A'+String.fromCodePoint(cp)+'B')),null,`reject U+${cp.toString(16)}`);
 for(const cp of [0x061b,0x061d,0x200a,0x200c,0x200d,0x2010,0x2027,0x202f,0x2065,0x2070,0xfefe,0xff00])
  assert(parse(payload('A'+String.fromCodePoint(cp)+'B')),`allow U+${cp.toString(16)}`);
 assert.equal(parse(payload('   ','')),null);assert.equal(parse(payload('', '   ')),null);assert(parse(payload('', '')));
 assert.equal(parse(Buffer.alloc(271)),null);
});

test('only active room owner can declare metadata; record is display-only, rate limited and bound to the room lifetime',()=>{
 let now=1000;const m=create({now:()=>now}),{host,guest,room}=fixture();
 assert.equal(m.summary(room)[34],0);assert.equal(m.set(guest,payload()).error,'owner');
 assert.deepEqual(m.set(host,payload()),{ok:true});
 for(let i=0;i<10;i++)assert.deepEqual(m.set(host,payload()),{ok:true});
 const row=m.summary(room);assert.equal(row.length,336);assert.equal(row.readBigUInt64LE(8),GAME);assert.equal(row.readBigUInt64LE(16),APP);assert.equal(row.readBigUInt64LE(24),PROGRAM);assert.equal(row[34],1);assert(row.subarray(35,40).every(v=>v===0));assert.equal(room.gameId,GAME);
 for(let i=0;i<3;i++)assert.deepEqual(m.set(host,payload('Update'+i)),{ok:true});
 assert.equal(m.set(host,payload('too many')).error,'rate');now+=60000;assert(m.set(host,payload('next minute')).ok);
 room.members[0]=guest;assert.equal(m.summary(room)[34],0);host.socket.destroyed=true;assert.equal(m.set(host,payload()).error,'owner');
 const fresh=fixture();assert.equal(m.summary(fresh.room)[34],0);
});

test('live metadata page preserves old wire layouts and clears declarations when the host room ends',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'room-meta-')),peers=[];
 const child=spawn(process.execPath,[path.join(__dirname,'server.js'),'--port','0'],{env:{...process.env,LANYWHERE_STATE_DIR:dir,LANYWHERE_STATS_PORT:'0',LANYWHERE_PUBLIC_PORT:'0',LANYWHERE_OPS_PORT:'0',LANYWHERE_LANPLAY_PORT:'0',LANYWHERE_SHUTDOWN_GRACE_MS:'0'},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');t.after(async()=>{for(const p of peers)p.close();child.kill();await exited;await fs.rm(dir,{recursive:true,force:true});});
 let output='';for(const stream of[child.stdout,child.stderr])stream.on('data',d=>output+=d);
 const port=await until(()=>{if(child.exitCode!==null)throw Error(output);return Number(/datos UDP en (\d+)/.exec(output)?.[1]);},'metadata relay');
 for(const name of['Host','Guest','Finder']){const p=new ConsolePeer(name,port);peers.push(p);await p.open({udp:false});}
 const[host,guest,finder]=peers;
 finder.send(0x20,Buffer.from('self'));const selected=await finder.frame(0xa0);
 assert.equal(selected.readUInt32LE()&96,96);assert.equal(selected[4],4);assert.equal(selected.subarray(5).toString(),'self');
 await host.create(GAME);await host.publish(networkInfo([host],4,GAME));
 const query=Buffer.concat([u64(GAME),Buffer.alloc(4)]);
 finder.send(0x22,query);let page=await finder.frame(0xa2);assert.equal(page.length,341);assert.equal(page[5+34],0);
 host.send(0x21,payload());await host.barrier();
 finder.send(0x22,query);page=await finder.frame(0xa2);const row=page.subarray(5);assert.equal(page[4],1);assert.equal(row.readBigUInt64LE(8),GAME);assert.equal(row.readBigUInt64LE(16),APP);assert.equal(row.readBigUInt64LE(24),PROGRAM);assert.equal(row[34],1);assert(row.subarray(80,208).toString().startsWith('Host title\0'));
 finder.send(0x0c,query);const old=await finder.frame(0x8a);assert.equal(old.length,5+6+0x480);assert.equal(old.readBigUInt64LE(11),GAME);
 await guest.join(host.code);guest.send(0x21,payload('Forgery'));assert.equal((await guest.frame(0x85))[0],4);
 host.send(3);await host.barrier();finder.send(0x22,query);assert.equal((await finder.frame(0xa2))[4],0);
 finder.send(11);assert.equal((await finder.frame(0x89)).readUInt32LE()&64,64);
});
