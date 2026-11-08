'use strict';
// Runs a rebased COPY of the real installer in an isolated fixture. Every system
// command is mocked; real /opt, /etc, /run and systemd are never accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { test } = require('node:test');
const run = promisify(execFile);
const installer = path.join(__dirname, 'install-systemd.sh');
async function fixture(t, { healthFail, rollbackFail }) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'switch-online-installer-test-')));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const project = path.join(dir, 'project'), system = path.join(dir, 'system'), bin = path.join(dir, 'bin');
    await fs.mkdir(path.join(project, 'deploy'), { recursive: true });
    await fs.mkdir(path.join(project, 'server/relay'), { recursive: true });
    await fs.mkdir(bin);
    let source = await fs.readFile(installer, 'utf8');
    const relayFiles = source.match(/^relay_files=\(([^)]+)\)/m)[1].split(/\s+/);
    const opsFiles = source.match(/^ops_files=\(([^)]+)\)/m)[1].split(/\s+/);
    for (const name of relayFiles) await fs.writeFile(path.join(project, 'server/relay', name), `fixture ${name}\n`);
    for (const name of opsFiles) await fs.writeFile(path.join(project, 'deploy', name), `fixture ${name}\n`);
    await fs.writeFile(path.join(project, 'LICENSE'), 'fixture license');
    await fs.writeFile(path.join(project, 'deploy/relay.env.example'), 'LANYWHERE_CAP_GB=100\n');
    await fs.copyFile(path.join(__dirname, 'switch-online.service'), path.join(project, 'deploy/switch-online.service'));
    const app = path.join(system, 'opt/switch-online'), old = path.join(app, 'releases/old');
    const unit = path.join(system, 'etc/systemd/system/switch-online.service');
    await fs.mkdir(old, { recursive: true });
    await fs.mkdir(path.dirname(unit), { recursive: true });
    await fs.mkdir(path.join(system, 'run/systemd/system'), { recursive: true });
    await fs.writeFile(unit, 'ORIGINAL UNIT\n');
    await fs.symlink(old, path.join(app, 'current'));
    const shim = `#!${process.execPath}\n` + String.raw`
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const command=path.basename(process.argv[1]), args=process.argv.slice(2);
const boundary=process.env.FIXTURE_ROOT;
const safe=p=>{if(!path.resolve(p).startsWith(boundary+path.sep))throw Error('fixture escaped: '+p);};
fs.appendFileSync(process.env.FIXTURE_LOG,command+' '+JSON.stringify(args)+'\n');
if(['node','node-mock','node-alias'].includes(command)) { process.exit(process.env.HEALTH_FAIL==='1' && args[0]?.endsWith('/healthcheck.cjs')?1:0); }
if(command==='systemctl'||command==='systemd-analyze'||command==='flock')process.exit(0);
if(command==='sha256sum'){
 let b=args.length?args.filter(x=>x!=='--').map(p=>{safe(path.resolve(p));return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')+'  '+p+'\n';}).join(''):crypto.createHash('sha256').update(fs.readFileSync(0)).digest('hex')+'  -\n';
 process.stdout.write(b);process.exit(0);
}
if(command==='readlink') {const p=args.filter(x=>!x.startsWith('-')).at(-1);safe(p);process.stdout.write((args.includes('-f')?fs.realpathSync(p):fs.readlinkSync(p))+'\n');process.exit(0);}
if(command==='mv') {const p=args.filter(x=>!x.startsWith('-'));p.forEach(safe);fs.renameSync(p[0],p[1]);process.exit(0);}
if(command==='install'){
 let mode=0o755,dir=false,paths=[];
 for(let i=0;i<args.length;i++){if(args[i]==='-d')dir=true;else if(args[i]==='-m')mode=parseInt(args[++i],8);else if(args[i]!=='--')paths.push(args[i]);}
 paths.forEach(safe);
 if(process.env.ROLLBACK_FAIL==='1'&&paths.some(p=>/\.rollback\.[^/]+\/unit$/.test(p)))process.exit(1);
 if(dir){for(const p of paths){fs.mkdirSync(p,{recursive:true});fs.chmodSync(p,mode);}}
 else{fs.copyFileSync(paths[0],paths[1]);fs.chmodSync(paths[1],mode);}process.exit(0);
}
throw Error('unknown mock '+command);
`;
    for (const name of ['node-mock','systemctl','systemd-analyze','flock','sha256sum','mv','install','readlink'])
        await fs.writeFile(path.join(bin, name), shim, { mode: 0o755 });
    assert(source.includes('if (( EUID != 0 )); then'));
    source = source.replace('if (( EUID != 0 )); then', 'if (( 0 )); then');
    for (const prefix of ['/opt/switch-online','/etc/switch-online','/etc/systemd/system','/run/systemd/system'])
        source = source.split(prefix).join(path.join(system,prefix));
    const nodeBin = path.join(system, 'opt/switch-online-node/bin/node');
    await fs.mkdir(path.dirname(nodeBin), { recursive: true });
    await fs.writeFile(nodeBin, shim, { mode: 0o755 });
    const nodeAlias = path.join(bin, 'node-alias');
    await fs.symlink(nodeBin, nodeAlias);
    const script = path.join(project,'deploy/install-systemd.sh'); await fs.writeFile(script,source);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: dir,
        SWITCH_ONLINE_NODE:nodeAlias, FIXTURE_LOG:path.join(dir,'commands.log'), HEALTH_FAIL:String(Number(healthFail)), ROLLBACK_FAIL:String(Number(rollbackFail)) };
    let result;
    try { result = { ...(await run('bash',[script],{env,timeout:30000})), code:0 }; }
    catch(error) { result = error; }
    return { dir, app, old, unit, result, relayFiles, opsFiles, nodeBin, nodeAlias };
}
test('failed rollback retains original unit and reports its recovery directory', async t=>{
    const f=await fixture(t,{healthFail:true,rollbackFail:true});assert.equal(f.result.code,1);assert.match(f.result.stderr,/Startup failed/);
    const dirs=(await fs.readdir(f.app)).filter(x=>x.startsWith('.rollback.'));assert.equal(dirs.length,1);
    const retained=path.join(f.app,dirs[0]);assert.equal(await fs.readFile(path.join(retained,'unit'),'utf8'),'ORIGINAL UNIT\n');
    assert(f.result.stderr.includes(`Recovery files retained at: ${retained}`));
});
test('successful rollback restores previous release/unit and clears transient backup',async t=>{
    const f=await fixture(t,{healthFail:true,rollbackFail:false});assert.equal(f.result.code,1);assert.match(f.result.stderr,/Startup failed/);
    assert.equal(await fs.readlink(path.join(f.app,'current')),f.old);assert.equal(await fs.readFile(f.unit,'utf8'),'ORIGINAL UNIT\n');
    assert(!(await fs.readdir(f.app)).some(x=>x.startsWith('.rollback.')));
});
test('successful install publishes UDP helper and v2 smoke and clears rollback backup',async t=>{
    const f=await fixture(t,{healthFail:false,rollbackFail:false});assert.equal(f.result.code,0,f.result.stderr);
    const current=await fs.readlink(path.join(f.app,'current'));assert.notEqual(current,f.old);
    for(const name of ['udp-fragments.js','smoke-relay-v2.cjs','upstream-gateway.js','room-metadata.js','lanplay-providers.js','lanplay-realms.js'])assert((await fs.stat(path.join(current,name))).isFile());
    const unitText=await fs.readFile(f.unit,'utf8');
    assert(unitText.includes(`ExecStart=${f.nodeBin} server.js --port 11460`));
    assert(unitText.includes(`ExecStartPost=${f.nodeBin} healthcheck.cjs --allow-paused`));
    assert(!unitText.includes(f.nodeAlias));assert(!unitText.includes('/usr/bin/node'));
    assert.match(unitText,/Environment=LANYWHERE_MAX_CONNECTIONS=256\n/);
    assert.match(unitText,/Environment=LANYWHERE_MAX_CONNECTIONS_PER_IP=16\n/);
    assert.match(unitText,/MemoryMax=256M\n/);
    assert.equal(await fs.readFile(path.join(current,'switch-online.service'),'utf8'),unitText);
    const log=await fs.readFile(path.join(f.dir,'commands.log'),'utf8');
    assert(log.includes(`systemd-analyze [\"verify\",\"${current}/switch-online.service\"]`));
    assert(!(await fs.readdir(f.app)).some(x=>x.startsWith('.rollback.')));
});
