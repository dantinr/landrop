'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
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

test('局域网设备可以看到进行中的上传', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-upload-test-'));
  const app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir });
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  let uploadRequest;

  context.after(async () => {
    uploadRequest?.destroy();
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const sender = await connectClient(baseUrl, '书房电脑', 'device-upload-sender');
  const observer = await connectClient(baseUrl, '客厅电脑', 'device-upload-observer');
  sockets.push(sender.socket, observer.socket);
  await observer.inbox.waitFor((message) => message.type === 'presence' && message.count === 2);

  const uploadId = 'upload-visible-test';
  const fileName = '正在上传.txt';
  const firstChunk = Buffer.from('hello', 'utf8');
  const secondChunk = Buffer.from(' world', 'utf8');
  const totalBytes = firstChunk.length + secondChunk.length;
  const responsePromise = new Promise((resolve, reject) => {
    uploadRequest = http.request(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        'Content-Length': totalBytes,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': Buffer.from(fileName, 'utf8').toString('base64url'),
        'X-File-Type': 'text/plain',
        'X-Client-Id': sender.clientId,
        'X-Upload-Id': uploadId,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    uploadRequest.on('error', reject);
  });

  uploadRequest.flushHeaders();
  uploadRequest.write(firstChunk);
  const progressSnapshot = await observer.inbox.waitFor((message) => (
    message.type === 'uploads'
    && message.uploads?.some((upload) => (
      upload.id === uploadId && upload.receivedBytes >= firstChunk.length
    ))
  ));
  const activeUpload = progressSnapshot.uploads.find((upload) => upload.id === uploadId);
  assert.equal(activeUpload.name, fileName);
  assert.equal(activeUpload.totalBytes, totalBytes);
  assert.equal(activeUpload.sender.name, '书房电脑');
  assert.equal(activeUpload.sender.ip, '127.0.0.1');

  const lateObserver = await connectClient(baseUrl, '卧室电脑', 'device-upload-late');
  sockets.push(lateObserver.socket);
  assert.equal(lateObserver.welcome.uploads.some((upload) => upload.id === uploadId), true);

  uploadRequest.end(secondChunk);
  const uploadResponse = await responsePromise;
  assert.equal(uploadResponse.status, 201);
  assert.equal(JSON.parse(uploadResponse.body).file.name, fileName);

  await observer.inbox.waitFor((message) => (
    message.type === 'uploads' && !message.uploads?.some((upload) => upload.id === uploadId)
  ));
  const fileMessage = await observer.inbox.waitFor((message) => (
    message.type === 'message'
    && message.message?.kind === 'file'
    && message.message.file?.name === fileName
  ));
  assert.equal(fileMessage.message.sender.ip, '127.0.0.1');
});

test('并发、重复编号和中断不会留下过期上传状态', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-upload-abort-test-'));
  const app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir });
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  let uploadRequest;

  context.after(async () => {
    uploadRequest?.destroy();
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const sender = await connectClient(baseUrl, '上传电脑', 'device-abort-sender');
  const observer = await connectClient(baseUrl, '观察电脑', 'device-abort-observer');
  sockets.push(sender.socket, observer.socket);
  await observer.inbox.waitFor((message) => message.type === 'presence' && message.count === 2);

  const uploadId = 'upload-abort-reusable';
  const abortedName = 'will-abort.bin';
  const partialChunk = Buffer.from('partial', 'utf8');
  const interruptedResponse = new Promise((resolve) => {
    uploadRequest = http.request(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        'Content-Length': 1024,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': Buffer.from(abortedName, 'utf8').toString('base64url'),
        'X-File-Type': 'application/octet-stream',
        'X-Client-Id': sender.clientId,
        'X-Upload-Id': uploadId,
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode }));
    });
    uploadRequest.on('error', (error) => resolve({ error }));
  });

  uploadRequest.flushHeaders();
  uploadRequest.write(partialChunk);
  await observer.inbox.waitFor((message) => (
    message.type === 'uploads'
    && message.uploads?.some((upload) => (
      upload.id === uploadId && upload.receivedBytes >= partialChunk.length
    ))
  ));

  const duplicate = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': Buffer.from('duplicate.bin', 'utf8').toString('base64url'),
      'X-Client-Id': sender.clientId,
      'X-Upload-Id': uploadId,
    },
    body: 'duplicate',
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, 'DUPLICATE_UPLOAD_ID');

  const otherUploadId = 'upload-concurrent-other';
  const otherUpload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': Buffer.from('other.bin', 'utf8').toString('base64url'),
      'X-Client-Id': sender.clientId,
      'X-Upload-Id': otherUploadId,
    },
    body: 'other upload',
  });
  assert.equal(otherUpload.status, 201);
  await observer.inbox.waitFor((message) => (
    message.type === 'uploads'
    && message.uploads?.length === 1
    && message.uploads[0].id === uploadId
    && message.uploads[0].receivedBytes >= partialChunk.length
  ));

  uploadRequest.destroy(new Error('intentional test abort'));
  const interruptedResult = await interruptedResponse;
  assert.equal(interruptedResult.error instanceof Error, true);
  await observer.inbox.waitFor((message) => (
    message.type === 'uploads' && message.uploads?.length === 0
  ));

  assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads')), []);
  assert.deepEqual(app.fileStore.list().map((file) => file.name), ['other.bin']);
  const storedMessages = JSON.parse(
    await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8'),
  );
  assert.equal(storedMessages.some((message) => message.file?.name === abortedName), false);

  const reused = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': Buffer.from('reused.bin', 'utf8').toString('base64url'),
      'X-Client-Id': sender.clientId,
      'X-Upload-Id': uploadId,
    },
    body: 'reused upload id',
  });
  assert.equal(reused.status, 201);
  assert.deepEqual(
    app.fileStore.list().map((file) => file.name).sort(),
    ['other.bin', 'reused.bin'],
  );
});

test('VERSION 与 npm 元数据遵循版本约定', async () => {
  const rootDir = path.join(__dirname, '..');
  const version = (await fs.readFile(path.join(rootDir, 'VERSION'), 'utf8')).trim();
  const packageMetadata = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await fs.readFile(path.join(rootDir, 'package-lock.json'), 'utf8'));

  assert.match(version, /^\d+\.\d+\.(?:[1-9]\d)$/u);
  assert.equal(packageMetadata.version, version);
  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[''].version, version);
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
      resolve({ socket, inbox, clientId: welcome.clientId, welcome });
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
