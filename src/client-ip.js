'use strict';

const { isIP } = require('node:net');

function remoteAddress(request, trustLoopbackProxy = false) {
  const peer = normalizeAddress(request.socket?.remoteAddress || '');
  const isLoopback = isIP(peer) === 4 && peer.startsWith('127.');
  if (trustLoopbackProxy && isLoopback) {
    const header = request.headers?.['x-real-ip'];
    const address = typeof header === 'string' ? header.trim() : '';
    if (isIP(address)) return normalizeAddress(address);
  }
  return peer;
}

function normalizeAddress(address) {
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (address === '::1') return '127.0.0.1';
  const scopeIndex = address.indexOf('%');
  return scopeIndex === -1 ? address : address.slice(0, scopeIndex);
}

module.exports = { remoteAddress };
