#!/usr/bin/env python3
"""Host-only checks for destination validation, bounded metadata and exact PING."""
import importlib.util
import http.server
import json
from pathlib import Path
import socket
import subprocess
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('catalog_checker', Path(__file__).with_name('check-public-network-catalog.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def row(host='relay.example.org', port=11451):
    return {'host': host, 'port': port, 'protocol': 'switch-lan-play', 'source': 'https://example.org/catalog', 'region_hint': 'test'}


class CatalogChecks(unittest.TestCase):
    def test_only_public_ipv4(self):
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.2', '0.0.0.0',
                        '224.0.0.1', '255.255.255.255', '203.0.113.10', '100.64.0.1', '::1'):
            self.assertFalse(checker.public_ipv4(address), address)
        self.assertTrue(checker.public_ipv4('8.8.8.8'))

    def test_host_and_port_input(self):
        for host in ('localhost', '127.0.0.1', 'relay/path', 'user@relay.test', 'relay\nHost:evil.test', '::1', '-bad.test'):
            with self.assertRaises(ValueError): checker.targets_from_catalog({'servers': [row(host)]})
        for port in (True, 0, 65536, '11451'):
            with self.assertRaises(ValueError): checker.targets_from_catalog({'servers': [row(port=port)]})
        r = row();r['protocol'] = 'arbitrary'
        with self.assertRaises(ValueError): checker.targets_from_catalog({'servers': [r]})

    def test_dedup_and_one_http_per_host(self):
        targets = checker.targets_from_catalog({'servers': [row(), row(), row(port=11452), row('two.example.org')]}, True)
        self.assertEqual(len(targets), 3)
        self.assertEqual([x['http_selected'] for x in targets], [True, False, True])
        self.assertTrue(all(x['udp_selected'] for x in targets))

    def test_private_dns_stops_before_request(self):
        target = checker.targets_from_catalog({'servers': [row()]}, True)[0]
        requests = []
        def resolver(*args):
            return [(None, None, None, None, ('8.8.8.8', 11451)), (None, None, None, None, ('10.0.0.1', 11451))]
        result = checker.check_endpoint(target, 5, resolver=resolver,
                                        http_check=lambda *args: requests.append(args), udp_check=lambda *args: requests.append(args))
        self.assertEqual(result['status'], 'non_public_resolution_rejected')
        self.assertEqual(requests, [])

    def test_public_address_is_pinned_and_failures_separate(self):
        target = checker.targets_from_catalog({'servers': [row()]}, True)[0]
        calls = []
        def resolver(*args):return [(None, None, None, None, ('8.8.8.8', 11451))]
        def http(host, port, address, timeout):
            calls.append((host, port, address, timeout));return {'status': 'request_failed'}
        result = checker.check_endpoint(target, 5, resolver=resolver, http_check=http,
                                        udp_check=lambda address, port, timeout: {'status': 'ping_echo_verified'})
        self.assertEqual(calls[0][:3], ('relay.example.org', 11451, '8.8.8.8'))
        self.assertLessEqual(calls[0][3], 2)
        self.assertEqual(result['http']['status'], 'request_failed')
        self.assertEqual(result['udp']['status'], 'ping_echo_verified')
        self.assertEqual(result['game_interoperability'], 'not_tested')

    def test_metadata_is_counts_only(self):
        self.assertEqual(checker.extract_metadata({'online': 3, 'idle': 1, 'playerNames': ['private']}),
                         {'online_reported': 3, 'idle_reported': 1})
        self.assertEqual(checker.extract_metadata({'data': {'serverInfo': {'online': 0}}}), {'online_reported': 0})
        for value in (None, True, -1, 1.2, '3', 1000001):
            self.assertIsNone(checker.extract_metadata({'online': value}))

    def test_nonce_ping_packet_and_echo_variants(self):
        for variant in ('exact5', 'prefix4', 'wrong_nonce', 'extra_byte', 'short', 'wrong_type'):
            received = []
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
                server.bind(('127.0.0.1', 0))
                def echo():
                    data, addr = server.recvfrom(64);received.append(data)
                    replies = {
                        'exact5': data, 'prefix4': data[:4],
                        'wrong_nonce': data[:4] + bytes([data[4] ^ 1]),
                        'extra_byte': data + b'x', 'short': data[:3],
                        'wrong_type': bytes([3]) + data[1:],
                    }
                    server.sendto(replies[variant], addr)
                thread = threading.Thread(target=echo);thread.start()
                result = checker.check_udp('127.0.0.1', server.getsockname()[1], 1)
                thread.join(2)
            self.assertEqual(len(received), 1)
            self.assertEqual(len(received[0]), 5)
            self.assertEqual(received[0][0], 2)
            accepted = variant in ('exact5', 'prefix4')
            self.assertEqual(result['status'], 'ping_echo_verified' if accepted else 'unexpected_reply')
            self.assertEqual(result['echo_variant'], variant if accepted else None)

    def test_nonce_response_from_another_source_is_not_accepted(self):
        received = []
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as other:
            server.bind(('127.0.0.1', 0));other.bind(('127.0.0.1', 0))
            def respond_from_wrong_port():
                data, addr = server.recvfrom(64);received.append(data)
                other.sendto(data, addr)
            thread = threading.Thread(target=respond_from_wrong_port);thread.start()
            result = checker.check_udp('127.0.0.1', server.getsockname()[1], 0.1)
            thread.join(2)
        self.assertEqual(len(received), 1)
        self.assertEqual(result['status'], 'ping_no_verified_reply')

    def test_global_probe_deadline(self):
        target = checker.targets_from_catalog({'servers': [row()]}, True)[0]
        with mock.patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('probe', 5)) as run:
            result = checker.run_one(target, 5)
        self.assertEqual(run.call_args.kwargs['timeout'], 5)
        self.assertEqual(result['status'], 'hard_deadline')
        self.assertEqual(result['game_interoperability'], 'not_tested')

    def test_http_is_one_pinned_request_and_redirect_is_not_followed(self):
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append((self.path, self.headers.get('Host')))
                self.send_response(302)
                self.send_header('Location', 'http://127.0.0.1/private')
                self.end_headers()
            def log_message(self, *args): pass
        with http.server.HTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.handle_request);thread.start()
            port = server.server_address[1]
            result = checker.check_http('catalog.example.org', port, '127.0.0.1', 1)
            thread.join(2)
        self.assertEqual(result['status'], 'redirect_not_followed')
        self.assertEqual(calls, [('/info', 'catalog.example.org:' + str(port))])

    def test_http_response_bound(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200);self.end_headers()
                self.wfile.write(b' ' * (checker.BODY_LIMIT + 1))
            def log_message(self, *args): pass
        with http.server.HTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.handle_request);thread.start()
            result = checker.check_http('catalog.example.org', server.server_address[1], '127.0.0.1', 1)
            thread.join(2)
        self.assertEqual(result['status'], 'body_limit_exceeded')

    def test_region_summary_does_not_claim_games(self):
        report = checker.summarize([{'region_hint': 'jp', 'udp': {'status': 'ping_echo_verified'}},
                                    {'region_hint': 'jp', 'http': {'status': 'metadata_readable'}}])
        self.assertEqual(report['jp'], {'catalog_endpoints': 2, 'http_metadata_readable': 1,
                                      'udp_ping_verified': 1, 'game_interoperability_verified': 0})


if __name__ == '__main__':
    unittest.main()
