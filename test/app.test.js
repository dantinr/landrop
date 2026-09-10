'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');
const { createLanDropServer } = require('../src/app');
const { decodeFileName, parseByteRange } = require('../src/validation');

test('聊天、上传、文件广播和下载可以完整工作', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-test-'));
  const app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir });
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sockets = [];

  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /邻传/u);

  const alice = await connectClient(baseUrl, '小林', 'device-alice-test');
  const bob = await connectClient(baseUrl, '书房电脑', 'device-bob-test');
  sockets.push(alice.socket, bob.socket);
  assert.equal(alice.clientId, 'device-alice-test');
  assert.equal(bob.clientId, 'device-bob-test');

  await alice.inbox.waitFor((message) => message.type === 'presence' && message.count === 2);
  await bob.inbox.waitFor((message) => message.type === 'presence' && message.count === 2);

  alice.socket.send(JSON.stringify({ type: 'chat', text: '文件发给你了' }));
  const chat = await bob.inbox.waitFor((message) => (
    message.type === 'message' && message.message?.kind === 'text'
  ));
  assert.equal(chat.message.sender.name, '小林');
  assert.equal(chat.message.sender.ip, '127.0.0.1');
  assert.equal(chat.message.text, '文件发给你了');

  const payload = Buffer.from('hello from landrop', 'utf8');
  const fileName = '家庭资料 测试.txt';
  const upload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': Buffer.from(fileName, 'utf8').toString('base64url'),
      'X-File-Type': 'text/plain',
      'X-Client-Id': alice.clientId,
    },
    body: payload,
  });
  assert.equal(upload.status, 201);
  const uploadResult = await upload.json();
  assert.equal(uploadResult.file.name, fileName);
  assert.equal(uploadResult.file.size, payload.length);

  const fileNotice = await bob.inbox.waitFor((message) => (
    message.type === 'message' && message.message?.kind === 'file'
  ));
  assert.equal(fileNotice.message.file.name, fileName);
  assert.equal(fileNotice.message.sender.name, '小林');
  assert.equal(fileNotice.message.sender.ip, '127.0.0.1');

  const download = await fetch(`${baseUrl}${uploadResult.file.downloadUrl}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload);

  const partialDownload = await fetch(`${baseUrl}${uploadResult.file.downloadUrl}`, {
    headers: { Range: 'bytes=0-4' },
  });
  assert.equal(partialDownload.status, 206);
  assert.equal(await partialDownload.text(), 'hello');
  assert.equal(partialDownload.headers.get('content-range'), `bytes 0-4/${payload.length}`);

  const invalidRange = await fetch(`${baseUrl}${uploadResult.file.downloadUrl}`, {
    headers: { Range: 'not-a-range' },
  });
  assert.equal(invalidRange.status, 416);
  assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);

  const unsafeUpload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': Buffer.from('../escape.txt', 'utf8').toString('base64url'),
    },
    body: 'blocked',
  });
  assert.equal(unsafeUpload.status, 400);
});

test('文件名和下载范围校验', () => {
  assert.equal(decodeFileName(Buffer.from('照片 01.jpg').toString('base64url')), '照片 01.jpg');
  assert.deepEqual(parseByteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.throws(() => parseByteRange('bytes=10-12', 10), /范围无效/u);
});

function connectClient(baseUrl, name, deviceId = `device-${Date.now()}-${Math.random()}`) {
  return new Promise((resolve, reject) => {
    const socketUrl = new URL('/ws', baseUrl);
    socketUrl.protocol = 'ws:';
    socketUrl.searchParams.set('deviceId', deviceId);
    const socket = new WebSocket(socketUrl, { origin: baseUrl });
    const inbox = createInbox(socket);
    const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 3_000);

    inbox.waitFor((message) => message.type === 'welcome').then((welcome) => {
      clearTimeout(timeout);
      socket.send(JSON.stringify({ type: 'join', name }));
      resolve({ socket, inbox, clientId: welcome.clientId });
    }, reject);
    socket.once('error', reject);
  });
}

function createInbox(socket) {
  const messages = [];
  const waiters = new Set();

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    messages.push(message);
    for (const waiter of waiters) waiter();
  });

  return {
    waitFor(predicate, timeoutMs = 3_000) {
      return new Promise((resolve, reject) => {
        const findMatch = () => {
          const index = messages.findIndex(predicate);
          if (index === -1) return false;
          const [match] = messages.splice(index, 1);
          cleanup();
          resolve(match);
          return true;
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Timed out waiting for WebSocket message'));
        }, timeoutMs);
        const notify = () => findMatch();
        const cleanup = () => {
          clearTimeout(timeout);
          waiters.delete(notify);
        };
        waiters.add(notify);
        findMatch();
      });
    },
  };
}
