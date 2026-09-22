import assert from 'node:assert/strict';
import test from 'node:test';

import { describeProbe, parseCandidate, summarize, type Candidate } from './ice.ts';

const srflx = (address: string, port: number) =>
  parseCandidate(
    `candidate:1 1 udp 1677729535 ${address} ${port} typ srflx raddr 0.0.0.0 rport 0 generation 0`,
  )!;

test('parses reflexive candidates in either family', () => {
  assert.deepEqual(srflx('203.0.113.7', 40000), {
    address: '203.0.113.7',
    port: 40000,
    type: 'srflx',
    family: 'v4',
  });
  assert.equal(
    parseCandidate('a=candidate:2 1 udp 1677729535 2001:db8::1 51000 typ srflx raddr :: rport 0')
      ?.family,
    'v6',
  );
});

test('drops mDNS hosts and lines that are not candidates', () => {
  assert.equal(
    parseCandidate('candidate:3 1 udp 2122260223 4f1c2d3e-aaaa.local 55000 typ host generation 0'),
    null,
  );
  assert.equal(parseCandidate('a=end-of-candidates'), null);
});

test('one mapping per public address is an ordinary NAT', () => {
  // Two STUN servers agreeing collapse into a single candidate in practice.
  assert.deepEqual(summarize([srflx('203.0.113.7', 40000)]), { v6: false, v4: 'nat' });
});

test('a new port per STUN server is a symmetric NAT', () => {
  const found = [srflx('203.0.113.7', 40000), srflx('203.0.113.7', 40017)];
  assert.equal(summarize(found).v4, 'symmetric');
});

test('two interfaces with one mapping each are not mistaken for symmetric', () => {
  const found = [srflx('203.0.113.7', 40000), srflx('198.51.100.2', 61000)];
  assert.equal(summarize(found).v4, 'nat');
});

test('a reflexive IPv6 address is what lets symmetric IPv4 peers meet', () => {
  const found: Candidate[] = [
    srflx('203.0.113.7', 40000),
    srflx('203.0.113.7', 40017),
    srflx('2001:db8::1', 51000),
  ];
  const probe = summarize(found);
  assert.deepEqual(probe, { v6: true, v4: 'symmetric' });
  assert.equal(describeProbe(probe), 'ipv6 ok  ·  ipv4 symmetric');
});

test('no STUN answers reads as none', () => {
  assert.deepEqual(summarize([]), { v6: false, v4: 'none' });
});
