#!/usr/bin/env python3
"""Bounded normal metadata checks for an explicitly supplied public LAN Play catalog.

This is not a port scanner or a game interoperability test. Every request uses
the single host/port published in a catalog row. HTTP is attempted once per
hostname. Optional UDP PING is type 2 plus a four-byte nonce. The documented
Rust implementation echoes five bytes; Node echoes the first four bytes.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import threading
import time

BODY_LIMIT = 65536
PING_SOURCE = 'https://github.com/spacemeowx2/switch-lan-play/blob/master/server/src/udpserver.ts'
RUST_PING_SOURCE = 'https://github.com/spacemeowx2/slp-server-rust/blob/master/src/slp/frame.rs'
RUST_ECHO_SOURCE = 'https://github.com/spacemeowx2/slp-server-rust/blob/master/src/slp/server.rs'
INFO_SOURCE = 'https://github.com/spacemeowx2/switch-lan-play#server'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def public_ipv4(value):
    try:
        address = ipaddress.ip_address(value)
        return address.version == 4 and address.is_global and not address.is_multicast and not address.is_reserved
    except ValueError:
        return False


def valid_host(host):
    if not isinstance(host, str) or len(host) > 253 or not host or host.endswith('.'):
        return False
    try:
        address = ipaddress.ip_address(host)
        return public_ipv4(str(address))
    except ValueError:
        labels = host.split('.')
        return len(labels) > 1 and all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in labels)


def targets_from_catalog(catalog, udp_ping=False):
    rows = catalog.get('servers') if isinstance(catalog, dict) else None
    if not isinstance(rows, list) or len(rows) > 1000:
        raise ValueError('Expected a bounded catalog.servers list')
    seen_hosts, seen_endpoints = set(), set()
    targets = []
    for row in rows:
        host, port = row.get('host'), row.get('port')
        if row.get('protocol') != 'switch-lan-play' or not valid_host(host):
            raise ValueError('Catalog contains an unsupported protocol or unsafe host')
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError('Invalid published port')
        if not isinstance(row.get('source'), str) or not row['source'].startswith('https://'):
            raise ValueError('Every endpoint must retain a public HTTPS source reference')
        host = host.lower()
        endpoint = (host, port)
        if endpoint in seen_endpoints:
            continue
        targets.append({
            'provider_id': row.get('provider_id', ''), 'host': host, 'port': port,
            'region_hint': row.get('region_hint', 'unknown'), 'source': row['source'],
            'http_selected': host not in seen_hosts, 'udp_selected': bool(udp_ping),
        })
        seen_hosts.add(host)
        seen_endpoints.add(endpoint)
    return targets


def extract_metadata(data):
    """Store only public count/version fields, never player names or payloads."""
    if not isinstance(data, dict):
        return None
    candidate = data
    if isinstance(data.get('data'), dict) and isinstance(data['data'].get('serverInfo'), dict):
        candidate = data['data']['serverInfo']
    value = candidate.get('online')
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1000000:
        return None
    result = {'online_reported': value}
    idle = candidate.get('idle')
    if isinstance(idle, int) and not isinstance(idle, bool) and 0 <= idle <= 1000000:
        result['idle_reported'] = idle
    version = candidate.get('version')
    if isinstance(version, str) and len(version) <= 80 and not any(ord(c) < 32 for c in version):
        result['version_reported'] = version
    return result


def check_http(host, port, address, timeout):
    class PinnedConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.create_connection((address, port), timeout=self.timeout)

    connection = PinnedConnection(host, port, timeout=timeout)
    try:
        connection.request('GET', '/info', headers={
            'Accept': 'application/json', 'Connection': 'close',
            'User-Agent': 'SwitchOnline-CatalogMetadata/1.0',
        })
        response = connection.getresponse()
        result = {'method': 'GET', 'path': '/info', 'http_status': response.status}
        if 300 <= response.status < 400:
            result['status'] = 'redirect_not_followed'
            return result
        if response.status in (401, 403):
            result['status'] = 'access_denied'
            return result
        if response.status != 200:
            result['status'] = 'http_error'
            return result
        body = response.read(BODY_LIMIT + 1)
        if len(body) > BODY_LIMIT:
            result['status'] = 'body_limit_exceeded'
            return result
        result['body_bytes'] = len(body)
        result['body_sha256'] = hashlib.sha256(body).hexdigest()
        try:
            metadata = extract_metadata(json.loads(body.decode('utf-8')))
        except (ValueError, UnicodeError):
            metadata = None
        result['status'] = 'metadata_readable' if metadata is not None else 'unexpected_response'
        if metadata is not None:
            result['metadata'] = metadata
        return result
    except (OSError, http.client.HTTPException) as error:
        return {'method': 'GET', 'path': '/info', 'status': 'request_failed',
                'error_type': type(error).__name__, 'error': str(error)[:200]}
    finally:
        connection.close()


def check_udp(address, port, timeout):
    request = b'\x02' + secrets.token_bytes(4)
    started = time.monotonic()
    datagrams_sent = 0
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        try:
            # Connected UDP accepts replies only from the exact selected endpoint.
            sock.connect((address, port))
            sent = sock.send(request)
            datagrams_sent = int(sent > 0)
            if sent != 5:
                return {'status': 'send_failed', 'datagrams_sent': 1}
            reply = sock.recv(64)
            variant = 'exact5' if reply == request else 'prefix4' if reply == request[:4] else None
            return {'status': 'ping_echo_verified' if variant is not None else 'unexpected_reply',
                    'echo_variant': variant, 'datagrams_sent': 1, 'request_bytes': 5, 'reply_bytes': len(reply),
                    'rtt_ms': round((time.monotonic() - started) * 1000, 2)}
        except OSError as error:
            return {'status': 'ping_no_verified_reply', 'datagrams_sent': datagrams_sent,
                    'error_type': type(error).__name__, 'error': str(error)[:200]}


def check_endpoint(target, timeout, resolver=socket.getaddrinfo, http_check=check_http, udp_check=check_udp):
    started = time.monotonic()
    result = dict(target, checked_at=now(), game_interoperability='not_tested')
    try:
        answers = resolver(target['host'], target['port'], socket.AF_INET, socket.SOCK_STREAM)
        addresses = sorted({answer[4][0] for answer in answers})
    except OSError as error:
        return dict(result, status='dns_failed', error_type=type(error).__name__, error=str(error)[:200])
    if not addresses or any(not public_ipv4(address) for address in addresses):
        return dict(result, status='non_public_resolution_rejected')
    address = addresses[0]
    result['resolved_public_ipv4'] = addresses
    result['selected_ipv4'] = address
    result['status'] = 'checked'
    remaining = timeout - (time.monotonic() - started)
    if target['http_selected'] and remaining > 0:
        # Leave a portion of the bounded target budget for a single optional ping.
        budget = min(2.0, remaining) if target['udp_selected'] else remaining
        result['http'] = http_check(target['host'], target['port'], address, budget)
    else:
        result['http'] = {'status': 'not_repeated_for_same_hostname'}
    remaining = timeout - (time.monotonic() - started)
    if target['udp_selected'] and remaining > 0:
        result['udp'] = udp_check(address, target['port'], remaining)
    else:
        result['udp'] = {'status': 'not_requested' if not target['udp_selected'] else 'budget_exhausted'}
    result['elapsed_ms'] = round((time.monotonic() - started) * 1000, 2)
    return result


def run_one(target, timeout):
    if not target['http_selected'] and not target['udp_selected']:
        return dict(target, checked_at=now(), status='duplicate_hostname_metadata_not_repeated', game_interoperability='not_tested')
    # A subprocess deadline also bounds DNS and a peer that slowly drips a body.
    try:
        process = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--probe'],
                                 input=json.dumps({'target': target, 'timeout': max(0.1, timeout - 0.15)}),
                                 text=True, capture_output=True, timeout=timeout, check=False)
        if process.returncode == 0:
            return json.loads(process.stdout)
        return dict(target, checked_at=now(), status='probe_failed', game_interoperability='not_tested',
                    error=process.stderr[-200:])
    except subprocess.TimeoutExpired:
        return dict(target, checked_at=now(), status='hard_deadline', timeout_seconds=timeout,
                    game_interoperability='not_tested')


def summarize(results):
    regions = {}
    for row in results:
        region = regions.setdefault(row['region_hint'], {'catalog_endpoints': 0, 'http_metadata_readable': 0,
                                                        'udp_ping_verified': 0, 'game_interoperability_verified': 0})
        region['catalog_endpoints'] += 1
        region['http_metadata_readable'] += row.get('http', {}).get('status') == 'metadata_readable'
        region['udp_ping_verified'] += row.get('udp', {}).get('status') == 'ping_echo_verified'
    return regions


def main():
    if sys.argv[1:] == ['--probe']:
        payload = json.load(sys.stdin)
        print(json.dumps(check_endpoint(payload['target'], payload['timeout'])))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--vantage', required=True, help='Name of the actual machine/network performing the check')
    parser.add_argument('--udp-ping', action='store_true', help='Also send one documented five-byte type-2 PING per endpoint; accept exact5 or prefix4 echoes')
    parser.add_argument('--workers', type=int, choices=(1, 2), default=2)
    parser.add_argument('--timeout', type=float, default=5.0)
    parser.add_argument('--interval', type=float, default=1.0, help='Minimum global seconds between endpoint starts; at least0.5')
    args = parser.parse_args()
    if not 0.25 <= args.timeout <= 5 or not 0.5 <= args.interval <= 60:
        parser.error('timeout must be0.25..5 seconds and interval0.5..60 seconds')
    payload = args.catalog.read_bytes()
    catalog = json.loads(payload)
    targets = targets_from_catalog(catalog, args.udp_ping)
    started = now()
    lock = threading.Lock()
    next_start = [0.0]

    def worker(target):
        with lock:
            delay = max(0, next_start[0] - time.monotonic())
            if delay:
                time.sleep(delay)
            next_start[0] = time.monotonic() + args.interval
        return run_one(target, args.timeout)

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        for result in executor.map(worker, targets):
            results.append(result)
            if len(results) % 10 == 0 or len(results) == len(targets):
                print('Checked {}/{} published endpoints'.format(len(results), len(targets)), flush=True)
    report = {
        'report_format': 2, 'started_at': started, 'finished_at': now(), 'vantage': args.vantage,
        'scope': 'Normal public service metadata and optional nonce PING only; no registrations, room joins or game packets',
        'catalog_sha256': hashlib.sha256(payload).hexdigest(), 'catalog_endpoints': len(targets),
        'unique_hosts': len({target['host'] for target in targets}), 'workers': args.workers,
        'target_hard_timeout_seconds': args.timeout, 'global_start_interval_seconds': args.interval,
        'transport': 'direct IPv4 to a validated resolved address; no redirects; no private destinations',
        'http_source': INFO_SOURCE, 'udp_ping_source': PING_SOURCE if args.udp_ping else None,
        'udp_rust_parser_source': RUST_PING_SOURCE if args.udp_ping else None,
        'udp_rust_echo_source': RUST_ECHO_SOURCE if args.udp_ping else None,
        'udp_probe_format': {'request_bytes': 5, 'type': 2, 'nonce_bytes': 4, 'accepted_echoes': ['exact5', 'prefix4']} if args.udp_ping else None,
        'limitations': ['Region labels are supplied by the directory, not measured geography.',
                        '/info may not be supported by every implementation; HTTP failure does not prove UDP failure.',
                        'A matching PING only proves an echo response, not authentication or game interoperability.',
                        'No source can establish that this list contains every server in every region.'],
        'regions': summarize(results), 'results': results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + '.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    os.replace(temporary, args.output)
    print(json.dumps({'output': str(args.output), 'http_readable': sum(v['http_metadata_readable'] for v in report['regions'].values()),
                      'udp_echo_verified': sum(v['udp_ping_verified'] for v in report['regions'].values()),
                      'regions': len(report['regions'])}))


if __name__ == '__main__':
    main()
