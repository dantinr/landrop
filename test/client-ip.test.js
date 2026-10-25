'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { remoteAddress } = require('../src/client-ip');

test('仅明确启用的本机代理可以提供访问者 IP', () => {
  const request = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  const forwarded = { 'x-real-ip': '203.0.113.42', 'x-forwarded-for': '198.51.100.99' };

  assert.equal(remoteAddress(request('127.0.0.1', forwarded)), '127.0.0.1');
  assert.equal(remoteAddress(request('192.168.1.20', forwarded), true), '192.168.1.20');
  assert.equal(remoteAddress(request('::ffff:192.168.1.20', forwarded), true), '192.168.1.20');
  assert.equal(remoteAddress(request('2001:db8::20', forwarded), true), '2001:db8::20');
  for (const loopback of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    assert.equal(remoteAddress(request(loopback, forwarded), true), '203.0.113.42');
  }
  assert.equal(remoteAddress(request('fe80::1%eth0')), 'fe80::1');
});

test('代理 IP 支持 IPv4 和 IPv6，非法或缺失的标头回退到连接地址', () => {
  const resolve = (value, headers = {}) => remoteAddress({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...headers, 'x-real-ip': value },
  }, true);

  assert.equal(resolve(' 203.0.113.42 '), '203.0.113.42');
  assert.equal(resolve('2001:db8::42'), '2001:db8::42');
  assert.equal(resolve('::ffff:203.0.113.42'), '203.0.113.42');
  for (const invalid of [undefined, '', 'unknown', '203.0.113.42:80', '[2001:db8::42]',
    '203.0.113.42, 198.51.100.99', '999.0.0.1', ['203.0.113.42']]) {
    assert.equal(resolve(invalid, { 'x-forwarded-for': '198.51.100.99' }), '127.0.0.1');
  }
});
