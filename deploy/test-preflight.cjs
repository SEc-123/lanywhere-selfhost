'use strict';
// Tests a copied, rebased preflight with an isolated PATH. No real systemd,
// firewall, network inventory or host /etc/os-release is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const run = promisify(execFile);
async function preflight(t, options = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'switch-online-preflight-test-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin'); await fs.mkdir(bin);
    let source = await fs.readFile(path.join(__dirname, 'handoff-tools/preflight-vps.sh'), 'utf8');
    assert(source.includes('if (( EUID != 0 )); then'));
    source = source.replace('if (( EUID != 0 )); then', 'if (( 0 )); then');
    const required = source.match(/for tool in ([^;]+); do/)[1].trim().split(/\s+/);
    const shim = `#!${process.execPath}\n` + String.raw`
const fs=require('fs'),path=require('path'),vm=require('vm');
const name=path.basename(process.argv[1]),args=process.argv.slice(2);
fs.appendFileSync(process.env.CAP_LOG,name+' '+JSON.stringify(args)+'\n');
if(name==='uname'){console.log(process.env.CAP_KERNEL);process.exit(0);}
if(name==='systemctl'&&args.includes('--property=Version')){process.exit(Number(process.env.CAP_MANAGER_FAIL));}
if(name==='python3'){
 if(args[0]!=='-c'||!args[1].includes('sys.version_info >= (3, 8)'))throw Error('unexpected Python capability check');
 const [major,minor]=process.env.CAP_PYTHON_VERSION.split('.').map(Number);process.exit(major>3||(major===3&&minor>=8)?0:1);
}
if(name==='readlink'){if(process.env.CAP_READLINK_FAIL==='1')process.exit(1);console.log(fs.realpathSync(args.at(-1)));process.exit(0);}
if(name==='dedicated-node'){
 if(args[0]==='--version'){console.log('v'+process.env.CAP_NODE_VERSION);process.exit(0);}
 if(args[0]!=='-e')throw Error('unexpected runtime invocation');
 let code=null;vm.runInNewContext(args[1],{process:{versions:{node:process.env.CAP_NODE_VERSION},exit:c=>{code=c;}}});
 if(code===null)throw Error('Node preflight did not check runtime version');process.exit(code);
}
process.exit(0);
`;
    for (const command of new Set(['uname', ...required])) {
        if (command !== options.missingCommand) await fs.writeFile(path.join(bin, command), shim, { mode: 0o755 });
    }
    const runtime = path.join(root, 'dedicated-node'); await fs.writeFile(runtime, shim, { mode: 0o755 });
    const osRelease = path.join(root, 'os-release');
    await fs.writeFile(osRelease, 'ID="opencloudos"\nVERSION_ID="9.2"\nPRETTY_NAME="OpenCloudOS 9.2"\n');
    const systemd = path.join(root, 'run/systemd/system');
    if (!options.noSystemd) await fs.mkdir(systemd, { recursive: true });
    source = source.split('/etc/os-release').join(osRelease)
        .split('/run/systemd/system').join(systemd)
        .split('/opt/switch-online/current').join(path.join(root, 'absent-current'));
    const script=path.join(root,'preflight.sh');await fs.writeFile(script,source);
    const env={...process.env,PATH:bin,PRETTY_NAME:'',SWITCH_ONLINE_NODE:options.runtime || runtime,
        CAP_KERNEL:options.kernel || 'Linux',CAP_MANAGER_FAIL:options.managerFail?'1':'0',
        CAP_NODE_VERSION:options.nodeVersion || '22.22.0',CAP_PYTHON_VERSION:options.pythonVersion || '3.8',
        CAP_READLINK_FAIL:options.readlinkFail?'1':'0',CAP_LOG:path.join(root,'commands.log')};
    let result;try{result={...(await run('/bin/bash',[script],{env,timeout:10000})),code:0};}catch(e){result=e;}
    return {...result,runtime,log:await fs.readFile(path.join(root,'commands.log'),'utf8')};
}
test('OpenCloudOS 9.2 passes capability checks with a dedicated Node22 runtime',async t=>{
    const r=await preflight(t);assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/System: OpenCloudOS 9.2/);
    assert(r.stdout.includes(`Dedicated runtime: ${r.runtime}`));assert.match(r.stdout,/Read-only preflight complete/);
    assert.match(r.log,/systemctl \["show","--property=Version","--value"\]/);
});
test('rejects non-Linux before probing service manager',async t=>{
    const r=await preflight(t,{kernel:'Darwin'});assert.equal(r.code,1);assert.match(r.stderr,/requires Linux/);
    assert(!r.log.includes('systemctl'));
});
test('rejects absent running-systemd directory',async t=>{
    const r=await preflight(t,{noSystemd:true});assert.equal(r.code,1);assert.match(r.stderr,/systemd is not running/);
});
test('rejects a missing required tool even when host PATH supplies it',async t=>{
    const r=await preflight(t,{missingCommand:'ss'});assert.equal(r.code,1);assert.match(r.stderr,/Missing dependency: ss/);
});
test('rejects an unresponsive systemd service manager',async t=>{
    const r=await preflight(t,{managerFail:true});assert.equal(r.code,1);assert.match(r.stderr,/Cannot contact/);
});
test('rejects Node18 and relative runtime paths',async t=>{
    const old=await preflight(t,{nodeVersion:'18.20.8'});assert.equal(old.code,1);assert.match(old.stderr,/Node.js >=22/);
    const relative=await preflight(t,{runtime:'bin/node'});assert.equal(relative.code,1);assert.match(relative.stderr,/absolute executable/);
});

test('rejects Python3.7 before state backup can be used',async t=>{
    const r=await preflight(t,{pythonVersion:'3.7'});assert.equal(r.code,1);assert.match(r.stderr,/Python 3.8 or later/);
});
test('rejects readlink without canonical -f support',async t=>{
    const r=await preflight(t,{readlinkFail:true});assert.equal(r.code,1);assert.match(r.stderr,/readlink must support canonical/);
});
