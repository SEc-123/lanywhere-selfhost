'use strict';

// Export a fixed list of aggregated gauges. The underlying dashboard includes
// operational details, so never proxy or print its JSON response as metrics.
const statsPort = Number(process.env.LANYWHERE_STATS_PORT || 11461);
const opsPort = Number(process.env.LANYWHERE_OPS_PORT || 11462);

async function main() {
    const [statsResponse, readiness] = await Promise.all([
        fetch(`http://127.0.0.1:${statsPort}/api/stats`, { signal: AbortSignal.timeout(2000) }),
        fetch(`http://127.0.0.1:${opsPort}/api/ready`, { signal: AbortSignal.timeout(2000) }),
    ]);
    if (!statsResponse.ok || ![200, 503].includes(readiness.status))
        throw new Error('Dashboard or readiness returned an unexpected HTTP status');
    await readiness.body?.cancel();
    const { now, traffic } = await statsResponse.json();
    const metrics = {
        ready: readiness.ok ? 1 : 0,
        traffic_paused: now.paused ? 1 : 0,
        players: now.online,
        rooms: now.rooms,
        public_groups: now.groups,
        monthly_egress_bytes: traffic.bytes,
        monthly_egress_limit_bytes: traffic.cap,
    };
    const output = Object.entries(metrics).map(([name, value]) => {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} gauge`);
        return `# TYPE switch_online_${name} gauge\nswitch_online_${name} ${value}`;
    });
    console.log(output.join('\n'));
}

main().catch((error) => {
    console.error(`Switch Online metrics: ${error.message}`);
    process.exitCode = 1;
});
