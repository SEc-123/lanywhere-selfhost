'use strict';
const assert = require('node:assert/strict');
const { create } = require('./udp-fragments');
let time = 10000;
const clock = () => time;
const owner = {}, other = {}, meta = '167772161:1234:5678';
const payload = Buffer.alloc(2205); for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
{
    const r = create({ now: clock });
    assert.equal(r.push(owner, 1, meta, payload.length, 1100, payload.subarray(1100,2200)), null);
    assert.equal(r.bytes, payload.length);
    assert.equal(r.push(owner, 1, meta, payload.length, 1100, payload.subarray(1100,2200)), null);
    assert.equal(r.push(owner, 1, meta, payload.length, 2200, payload.subarray(2200)), null);
    assert.deepEqual(r.push(owner, 1, meta, payload.length, 0, payload.subarray(0,1100)), payload);
    assert.equal(r.bytes, 0);
    assert.equal(r.push(owner, 1, meta, 1, 0, Buffer.from([9])), null, 'completed ID cannot be replayed with changed total');
    assert.deepEqual(r.push(other, 1, meta, 1, 0, Buffer.from([9])), Buffer.from([9]), 'different member objects do not collide');
    r.clear(owner);
    assert.deepEqual(r.push(owner, 1, meta, 1, 0, Buffer.from([8])), Buffer.from([8]), 'new session clears replay state');
}
{
    const r = create({ now: clock });
    r.push(owner, 2, meta, 32, 0, Buffer.alloc(16,1));
    assert.equal(r.push(owner, 2, meta, 32, 8, Buffer.alloc(16,2)), null);
    assert.equal(r.bytes, 0, 'overlap invalidates and frees allocation');
    assert.equal(r.push(owner, 2, meta, 32, 16, Buffer.alloc(16,1)), null, 'invalidated ID cannot restart');
    r.push(owner, 3, meta, 32, 0, Buffer.alloc(16,1));
    assert.equal(r.push(owner, 3, 'changed destination/ports', 32, 16, Buffer.alloc(16,1)), null);
    assert.equal(r.bytes, 0);
    r.push(owner, 4, meta, 32, 0, Buffer.alloc(16,1));
    assert.equal(r.push(owner, 4, meta, 33, 16, Buffer.alloc(16,1)), null);
    assert.equal(r.bytes, 0);
    r.push(owner, 5, meta, 32, 0, Buffer.alloc(16,1));
    assert.equal(r.push(owner, 5, meta, 32, 0, Buffer.alloc(16,2)), null);
    assert.equal(r.bytes, 0, 'conflicting duplicate invalidates');
}
{
    const r = create({ maxTotal: 64, perMember: 2, ttlMs: 2000, now: clock });
    r.push(owner, 1, meta, 32, 0, Buffer.from([1])); r.push(owner, 2, meta, 32, 0, Buffer.from([1]));
    assert.equal(r.bytes,64);
    assert.equal(r.push(owner,3,meta,1,0,Buffer.from([1])),null,'per-member cap applies before allocation');
    assert.equal(r.push(other,1,meta,32,0,Buffer.from([1])),null,'global bytes cannot exceed limit');
    time+=1900; r.push(owner,1,meta,32,1,Buffer.from([1])); time+=101; r.sweep();
    assert.equal(r.bytes,0,'receiving more fragments does not extend the first-fragment deadline');
    r.push(owner,1,meta,32,0,Buffer.from([1])); r.clear(owner); assert.equal(r.bytes,0);
}
{
    const r=create({now:clock});
    for(const [id,total,offset,chunk] of [[-1,1,0,Buffer.from([1])],[2**32,1,0,Buffer.from([1])],[1,0,0,Buffer.from([1])],[1,65508,0,Buffer.from([1])],[1,4,-1,Buffer.from([1])],[1,4,3,Buffer.from([1,2])],[1,4,0,Buffer.alloc(0)],[1,2000,0,Buffer.alloc(1101)],[1,1,0,'x']])
        assert.equal(r.push(owner,id,meta,total,offset,chunk),null);
    assert.equal(r.bytes,0,'invalid frames allocate nothing');
    const max=Buffer.alloc(65507,0x5a);let result;
    for(let off=0;off<max.length;off+=1100)result=r.push(owner,0xffffffff,meta,max.length,off,max.subarray(off,off+1100));
    assert.deepEqual(result,max);assert.equal(r.bytes,0);
}
{
    const r=create({now:clock});
    for(let id=0;id<2048;id++)assert.deepEqual(r.push(owner,id,meta,1,0,Buffer.from([id])),Buffer.from([id]));
    assert.equal(r.push(owner,2048,meta,1,0,Buffer.from([0])),null,'bounded replay table does not evict a live marker');
    assert.equal(r.push(owner,0,meta,1,0,Buffer.from([0])),null);
    time+=2000;r.sweep();assert.deepEqual(r.push(owner,2048,meta,1,0,Buffer.from([7])),Buffer.from([7]));
}

{
    const r=create({now:clock,maxRecentTotal:3});
    const a={},b={};
    r.push(a,1,meta,1,0,Buffer.from([1]));
    r.push(a,2,meta,32,0,Buffer.from([1]));
    r.push(b,1,meta,32,0,Buffer.from([1]));
    assert.equal(r.push(b,2,meta,1,0,Buffer.from([1])),null,'pending messages reserve bounded global replay slots');
    r.clear(a);
    assert.deepEqual(r.push(b,2,meta,1,0,Buffer.from([2])),Buffer.from([2]),'clearing owner releases completed and pending global slots');
    r.clear(b);assert.equal(r.bytes,0);
}

{
    const r = create({ now: clock });
    for (let offset = 0; offset < 128; offset++)
        assert.equal(r.push(owner, 99, meta, 129, offset, Buffer.from([1])), null);
    assert.equal(r.bytes, 129);
    assert.equal(r.push(owner, 99, meta, 129, 0, Buffer.from([1])), null, 'exact duplicates do not consume extra range slots');
    assert.equal(r.bytes, 129);
    assert.equal(r.push(owner, 99, meta, 129, 128, Buffer.from([1])), null, '129th unique fragment invalidates');
    assert.equal(r.bytes, 0, 'range-budget invalidation frees its payload allocation');
}
console.log('UDP fragments: reordered/duplicate coverage, strict invalidation, owner isolation, deadlines, byte/message limits, replay and max datagram passed');
