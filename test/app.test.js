'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { WebSocket } = require('ws');
const { createLanDropServer } = require('../src/app');
const { readConfig } = require('../src/config');
const { DailyMessageLimit, messageDay } = require('../src/daily-message-limit');
const { FileStore } = require('../src/file-store');
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
  assert.equal(uploadResult.file.storedName, undefined);

  const storedName = '家庭资料 测试[127.0.0.1].txt';
  assert.deepEqual(
    await fs.readFile(path.join(dataDir, 'uploads', storedName)),
    payload,
  );
  const fileIndex = JSON.parse(await fs.readFile(path.join(dataDir, 'files.json'), 'utf8'));
  assert.equal(fileIndex.find((file) => file.id === uploadResult.file.id).storedName, storedName);

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

test('设备上线时广播提示，改名和同设备多标签页不重复，重连后再次提示', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-online-test-'));
  const app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir });
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sockets = [];

  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const observer = await connectClient(baseUrl, '客厅电脑', 'device-online-observer');
  sockets.push(observer.socket);
  const ownNotice = await observer.inbox.waitFor((event) => event.message?.kind === 'online');
  assert.equal(ownNotice.message.sender.name, '客厅电脑');
  assert.deepEqual(observer.welcome.history, []);

  const notices = [];
  observer.socket.on('message', (buffer) => {
    const event = JSON.parse(buffer.toString('utf8'));
    if (event.type === 'message' && event.message?.kind === 'online') notices.push(event.message);
  });

  const sender = await connectClient(baseUrl, ' 书房电脑 ', 'device-online-sender');
  sockets.push(sender.socket);
  assert.equal(sender.welcome.history.some((message) => message.kind === 'online'), false);
  const firstNotice = await observer.inbox.waitFor((event) => event.message?.kind === 'online');
  const senderNotice = await sender.inbox.waitFor((event) => event.message?.kind === 'online');
  assert.deepEqual(firstNotice, senderNotice);
  assert.deepEqual(firstNotice.message.sender, {
    id: sender.clientId, name: '书房电脑', ip: '127.0.0.1',
  });
  assert.equal(Number.isNaN(Date.parse(firstNotice.message.createdAt)), false);

  sender.socket.send(JSON.stringify({ type: 'join', name: '新昵称' }));
  await observer.inbox.waitFor((event) => (
    event.type === 'presence' && event.users?.some((user) => user.name === '新昵称')
  ));
  sender.socket.send(JSON.stringify({ type: 'chat', text: '改名后发送' }));
  await observer.inbox.waitFor((event) => event.message?.text === '改名后发送');
  assert.equal(notices.length, 1);

  const tab = await connectClient(baseUrl, '新昵称', sender.clientId);
  sockets.push(tab.socket);
  await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 3);
  tab.socket.send(JSON.stringify({ type: 'chat', text: '另一标签页发送' }));
  await observer.inbox.waitFor((event) => event.message?.text === '另一标签页发送');
  assert.equal(notices.length, 1);

  sender.socket.terminate();
  await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 2);
  tab.socket.terminate();
  await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 1);
  const reconnected = await connectClient(baseUrl, '新昵称', sender.clientId);
  sockets.push(reconnected.socket);
  const reconnectNotice = await observer.inbox.waitFor((event) => event.message?.kind === 'online');
  assert.equal(reconnectNotice.message.sender.name, '新昵称');
  assert.equal(reconnectNotice.message.sender.id, sender.clientId);
  assert.notEqual(reconnectNotice.message.id, firstNotice.message.id);
  assert.equal(notices.length, 2);
  assert.deepEqual(reconnected.welcome.history.map((message) => message.kind), ['text', 'text']);

  const unjoined = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws`, { origin: baseUrl });
  sockets.push(unjoined);
  const inbox = createInbox(unjoined);
  await inbox.waitFor((event) => event.type === 'welcome');
  unjoined.send(JSON.stringify({ type: 'chat', text: '还没有加入' }));
  const error = await inbox.waitFor((event) => event.type === 'error');
  assert.equal(error.message, '请先设置昵称');
  assert.equal(notices.length, 2);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8'));
  assert.deepEqual(stored.map((message) => message.kind), ['text', 'text']);
});

for (const trustLoopbackProxy of [false, true]) {
  test(`代理 IP ${trustLoopbackProxy ? '启用' : '禁用'}时，聊天、在线成员、上传和持久化使用正确地址`, async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-proxy-test-'));
    const app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir, trustLoopbackProxy });
    const address = await app.start();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sockets = [];
    context.after(async () => {
      for (const socket of sockets) socket.terminate();
      await app.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const chatIp = trustLoopbackProxy ? '203.0.113.42' : '127.0.0.1';
    const uploadIp = trustLoopbackProxy ? '203.0.113.43' : '127.0.0.1';
    const client = await connectClient(baseUrl, '代理访问者', 'device-proxy-test', {
      'X-Real-IP': '203.0.113.42',
      'X-Forwarded-For': '198.51.100.99',
    });
    sockets.push(client.socket);
    const presence = await client.inbox.waitFor((event) => event.type === 'presence');
    assert.equal(presence.users.find((user) => user.id === client.clientId).ip, chatIp);
    const online = await client.inbox.waitFor((event) => event.message?.kind === 'online');
    assert.equal(online.message.sender.ip, chatIp);
    client.socket.send(JSON.stringify({ type: 'chat', text: '代理地址检查' }));
    const chat = await client.inbox.waitFor((event) => event.message?.kind === 'text');
    assert.equal(chat.message.sender.ip, chatIp);

    const payload = Buffer.from('proxy upload');
    const upload = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        'X-File-Name': Buffer.from('代理上传.txt').toString('base64url'),
        'X-File-Type': 'text/plain',
        'X-Real-IP': '203.0.113.43',
        'X-Forwarded-For': '198.51.100.99',
      },
      body: payload,
    });
    assert.equal(upload.status, 201);
    const result = await upload.json();
    assert.equal(result.file.sender.ip, uploadIp);
    const notice = await client.inbox.waitFor((event) => event.message?.kind === 'file');
    assert.equal(notice.message.sender.ip, uploadIp);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'uploads', `代理上传[${uploadIp}].txt`)), payload);
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8'));
    assert.deepEqual(stored.map((message) => message.sender.ip), [chatIp, uploadIp]);
  });
}

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
  const app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir, dailyMessageLimit: 2 });
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

  assert.deepEqual(await fs.readdir(path.join(dataDir, 'incoming')), []);
  assert.deepEqual(
    await fs.readdir(path.join(dataDir, 'uploads')),
    ['other[127.0.0.1].bin'],
  );
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
  const dailyCounts = JSON.parse(await fs.readFile(path.join(dataDir, 'chat-usage.json'), 'utf8'));
  assert.equal(new Map(dailyCounts.counts).get(sender.clientId), 2);
});

test('上传文件以原名和 IP 保存，同名文件不会覆盖', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-file-store-test-'));
  const uploadsDir = path.join(dataDir, 'uploads');
  const incomingDir = path.join(dataDir, 'incoming');
  const store = new FileStore(dataDir);
  await store.init();

  context.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const orphanName = '同名文件[192.168.1.23].txt';
  await fs.writeFile(path.join(uploadsDir, orphanName), 'existing file');
  const details = {
    fileName: '同名文件.txt',
    mimeType: 'text/plain',
    sender: { id: 'device-test', name: '书房电脑', ip: '192.168.1.23' },
  };
  const [first, second] = await Promise.all([
    store.receive(Readable.from([Buffer.from('first upload')]), details),
    store.receive(Readable.from([Buffer.from('second upload')]), details),
  ]);

  assert.deepEqual(
    new Set([first.storedName, second.storedName]),
    new Set([
      '同名文件[192.168.1.23] (2).txt',
      '同名文件[192.168.1.23] (3).txt',
    ]),
  );
  assert.equal(await fs.readFile(path.join(uploadsDir, orphanName), 'utf8'), 'existing file');
  assert.deepEqual(
    new Set(await Promise.all([first, second].map(async (file) => (
      fs.readFile(store.pathFor(file.id), 'utf8')
    )))),
    new Set(['first upload', 'second upload']),
  );

  const originalLongName = `${'资料'.repeat(120)}:备份?.tar.gz`;
  const ipv6File = await store.receive(
    Readable.from([Buffer.from('ipv6 upload')]),
    {
      fileName: originalLongName,
      mimeType: 'application/gzip',
      sender: { id: 'device-ipv6', name: 'IPv6 电脑', ip: 'fe80::1' },
    },
  );
  assert.equal(ipv6File.name, originalLongName);
  assert.match(ipv6File.storedName, /\[fe80__1\]\.gz$/u);
  assert.doesNotMatch(ipv6File.storedName, /[<>:"/\\|?*\u0000-\u001f]/u);
  assert.equal(ipv6File.storedName.length <= 240, true);
  assert.equal(Buffer.byteLength(ipv6File.storedName) <= 240, true);

  const interruptedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await fs.writeFile(path.join(incomingDir, `${interruptedId}.part`), 'interrupted');
  await fs.writeFile(path.join(uploadsDir, `${interruptedId}.part`), 'old interrupted');
  await fs.writeFile(path.join(uploadsDir, 'keep.part'), 'real file');

  const restartedStore = new FileStore(dataDir);
  await restartedStore.init();
  assert.equal(restartedStore.list().length, 3);
  assert.equal(await fs.readFile(restartedStore.pathFor(ipv6File.id), 'utf8'), 'ipv6 upload');
  await assert.rejects(fs.access(path.join(incomingDir, `${interruptedId}.part`)), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(uploadsDir, `${interruptedId}.part`)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(uploadsDir, 'keep.part'), 'utf8'), 'real file');
});

test('旧版 UUID 和原名文件仍可在升级后读取', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-legacy-file-test-'));
  const legacyFilesDir = path.join(dataDir, 'files');
  const legacyId = '11111111-1111-4111-8111-111111111111';
  const invalidId = '22222222-2222-4222-8222-222222222222';
  const originalNameId = '33333333-3333-4333-8333-333333333333';
  const mismatchedId = '44444444-4444-4444-8444-444444444444';
  const content = Buffer.from('legacy content');
  const originalNameContent = Buffer.from('original-name content');
  await fs.mkdir(legacyFilesDir, { recursive: true });
  await fs.writeFile(path.join(legacyFilesDir, `${legacyId}.blob`), content);
  await fs.writeFile(path.join(legacyFilesDir, 'original-name.txt'), originalNameContent);
  const baseRecord = {
    name: 'legacy.txt',
    size: content.length,
    mimeType: 'text/plain',
    sha256: 'legacy-test-hash',
    createdAt: '2026-09-22T00:00:00.000Z',
    sender: { id: 'legacy-device', name: '旧设备', ip: '192.168.1.10' },
  };
  await fs.writeFile(path.join(dataDir, 'files.json'), JSON.stringify([
    { id: legacyId, ...baseRecord },
    {
      id: mismatchedId,
      ...baseRecord,
      name: 'original-name.txt',
      size: originalNameContent.length,
      sha256: '0'.repeat(64),
    },
    {
      id: originalNameId,
      ...baseRecord,
      name: 'original-name.txt',
      size: originalNameContent.length,
      sha256: crypto.createHash('sha256').update(originalNameContent).digest('hex'),
    },
    { id: invalidId, ...baseRecord, storedName: '../escape.txt' },
  ]));

  context.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const store = new FileStore(dataDir);
  await store.init();
  assert.deepEqual(
    new Set(store.list().map((file) => file.id)),
    new Set([legacyId, originalNameId]),
  );
  assert.deepEqual(await fs.readFile(store.pathFor(legacyId)), content);
  assert.deepEqual(await fs.readFile(store.pathFor(originalNameId)), originalNameContent);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dataDir, 'files.json'), 'utf8')).map((file) => file.id),
    [legacyId, originalNameId],
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

test('每日消息上限配置默认不限，支持正整数，非法配置会阻止启动', async (context) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-config-test-'));
  const configPath = path.join(configDir, 'config.json');
  context.after(() => fs.rm(configDir, { recursive: true, force: true }));

  assert.deepEqual(await readConfig(configPath), { dailyMessageLimit: 0 });
  for (const config of [{}, { dailyMessageLimit: 0 }, { dailyMessageLimit: 100 }]) {
    await fs.writeFile(configPath, `\uFEFF${JSON.stringify(config)}`);
    assert.deepEqual(await readConfig(configPath), {
      dailyMessageLimit: config.dailyMessageLimit ?? 0,
    });
  }
  for (const value of [-1, 1.5, '100', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    await fs.writeFile(configPath, JSON.stringify({ dailyMessageLimit: value }));
    await assert.rejects(readConfig(configPath), /dailyMessageLimit 必须是非负整数/u);
  }
  for (const config of [null, [], 100, 'invalid']) {
    await fs.writeFile(configPath, JSON.stringify(config));
    await assert.rejects(readConfig(configPath), /配置文件必须是 JSON 对象/u);
  }
  await fs.writeFile(configPath, '{ invalid json');
  await assert.rejects(readConfig(configPath), /配置文件不是有效的 JSON/u);
});

test('文字、文件和图片按设备共享每日上限，改名、多标签页和重启不能重置', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-daily-limit-test-'));
  const options = { host: '127.0.0.1', port: 0, dataDir, dailyMessageLimit: 3 };
  let app = await createLanDropServer(options);
  let address = await app.start();
  let baseUrl = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const sender = await connectClient(baseUrl, '发送设备', 'device-daily-limit');
  sockets.push(sender.socket);
  assert.equal(sender.welcome.chatQuota.limit, 3);
  assert.equal(sender.welcome.chatQuota.remaining, 3);
  sender.socket.send(JSON.stringify({ type: 'chat', text: '' }));
  assert.equal((await sender.inbox.waitFor((event) => event.type === 'error')).code, 'INVALID_MESSAGE');
  sender.socket.send(JSON.stringify({ type: 'chat', text: '第 1 条' }));
  await sender.inbox.waitFor((event) => event.message?.text === '第 1 条');
  for (const [name, mime] of [['文档.txt', 'text/plain'], ['图片.png', 'image/png']]) {
    const response = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        'X-Client-Id': sender.clientId,
        'X-File-Name': Buffer.from(name).toString('base64url'),
        'X-File-Type': mime,
      },
      body: 'daily limit test',
    });
    assert.equal(response.status, 201);
    await response.json();
  }

  sender.socket.send(JSON.stringify({ type: 'join', name: '新昵称' }));
  sender.socket.send(JSON.stringify({ type: 'chat', text: '超限文字' }));
  const error = await sender.inbox.waitFor((event) => event.type === 'error');
  assert.equal(error.code, 'DAILY_MESSAGE_LIMIT');
  assert.match(error.message, /3 条上限/u);
  assert.equal(error.chatQuota.remaining, 0);
  assert.equal(error.text, '超限文字');
  const rejectedUpload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'X-Client-Id': sender.clientId,
      'X-File-Name': Buffer.from('超限文件.txt').toString('base64url'),
    },
    body: 'not saved',
  });
  assert.equal(rejectedUpload.status, 429);
  assert.equal((await rejectedUpload.json()).error, 'DAILY_MESSAGE_LIMIT');
  assert.equal(app.fileStore.list().length, 2);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'incoming')), []);

  const tab = await connectClient(baseUrl, '另一标签页', sender.clientId);
  const other = await connectClient(baseUrl, '另一个设备', 'device-daily-other');
  sockets.push(tab.socket, other.socket);
  tab.socket.send(JSON.stringify({ type: 'chat', text: '同设备超限' }));
  assert.equal((await tab.inbox.waitFor((event) => event.type === 'error')).code, 'DAILY_MESSAGE_LIMIT');
  other.socket.send(JSON.stringify({ type: 'chat', text: '其他设备仍可发送' }));
  await other.inbox.waitFor((event) => event.message?.text === '其他设备仍可发送');

  await app.stop();
  app = await createLanDropServer(options);
  address = await app.start();
  baseUrl = `http://127.0.0.1:${address.port}`;
  const reconnected = await connectClient(baseUrl, '重连设备', sender.clientId);
  sockets.push(reconnected.socket);
  assert.equal(reconnected.welcome.history.length, 4);
  reconnected.socket.send(JSON.stringify({ type: 'chat', text: '重启后仍超限' }));
  assert.equal((await reconnected.inbox.waitFor((event) => event.type === 'error')).code, 'DAILY_MESSAGE_LIMIT');
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'chat-usage.json'), 'utf8'));
  assert.equal(new Map(stored.counts).get(sender.clientId), 3);
  assert.equal(new Map(stored.counts).get(other.clientId), 1);
});

test('默认可连续发送超过 100 条，历史淘汰及随后启用上限不会丢失当天计数', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-unlimited-test-'));
  const options = { host: '127.0.0.1', port: 0, dataDir };
  let app = await createLanDropServer(options);
  const address = await app.start();
  const sockets = [];
  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const client = await connectClient(`http://127.0.0.1:${address.port}`, '不限设备', 'device-unlimited');
  sockets.push(client.socket);
  assert.equal(client.welcome.chatQuota.limit, 0);
  assert.equal(client.welcome.chatQuota.remaining, null);
  for (let index = 1; index <= 201; index += 1) {
    client.socket.send(JSON.stringify({ type: 'chat', text: `不限消息 ${index}` }));
    await client.inbox.waitFor((event) => event.message?.text === `不限消息 ${index}`);
  }
  const history = JSON.parse(await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8'));
  assert.equal(history.length, 200);
  assert.equal(history[0].text, '不限消息 2');
  const counts = JSON.parse(await fs.readFile(path.join(dataDir, 'chat-usage.json'), 'utf8'));
  assert.equal(new Map(counts.counts).get(client.clientId), 201);

  await app.stop();
  app = await createLanDropServer({ ...options, dailyMessageLimit: 201 });
  const restarted = await app.start();
  const reconnected = await connectClient(`http://127.0.0.1:${restarted.port}`, '仍是同设备', client.clientId);
  sockets.push(reconnected.socket);
  reconnected.socket.send(JSON.stringify({ type: 'chat', text: '启用上限后被拒绝' }));
  assert.equal((await reconnected.inbox.waitFor((event) => event.type === 'error')).code, 'DAILY_MESSAGE_LIMIT');
});

test('每日额度并发预占不会超发或阻塞其他设备，发送失败退回且计数跨日重置', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-daily-queue-test-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const countPath = path.join(dataDir, 'chat-usage.json');
  await fs.writeFile(countPath, JSON.stringify({ date: '2000-01-01', counts: [['device', 10]] }));
  const quota = new DailyMessageLimit(dataDir, 1);
  await quota.init();
  let rejectSend;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = quota.run('device', () => new Promise((resolve, reject) => {
    rejectSend = reject;
    started();
  }));
  const failed = assert.rejects(pending, /模拟发送失败/u);
  await ready;
  await assert.rejects(quota.run('device', () => assert.fail('不能超发')), { code: 'DAILY_MESSAGE_LIMIT' });
  await quota.run('other-device', async () => {});
  rejectSend(new Error('模拟发送失败'));
  await failed;
  await quota.run('device', async () => {});
  const stored = JSON.parse(await fs.readFile(countPath, 'utf8'));
  assert.equal(stored.date, messageDay());
  assert.deepEqual(new Map(stored.counts), new Map([['device', 1], ['other-device', 1]]));
  assert.equal(messageDay(new Date('2026-10-26T15:59:59.999Z')), '2026-10-26');
  assert.equal(messageDay(new Date('2026-10-26T16:00:00.000Z')), '2026-10-27');

  await fs.writeFile(countPath, JSON.stringify({ date: messageDay(), counts: [['device', -1]] }));
  await assert.rejects(new DailyMessageLimit(dataDir, 1).init(), /每日消息计数文件无效/u);
  await assert.rejects(createLanDropServer({ dataDir, dailyMessageLimit: -1 }), /dailyMessageLimit 必须是非负整数/u);
});

test('已部署版本的当天计数可继续使用，查询额度会在北京时间零点恢复', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-legacy-quota-test-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'chat-usage.json'), JSON.stringify({
    date: '2026-10-26', counts: [['legacy-device', 100]],
  }));
  let now = Date.parse('2026-10-26T15:59:59.000Z');
  const quota = new DailyMessageLimit(dataDir, 0, () => now);
  await quota.init();
  assert.deepEqual(quota.status('legacy-device'), {
    date: '2026-10-26', limit: 0, used: 100, remaining: null,
    resetAt: '2026-10-26T16:00:00.000Z',
  });
  await quota.run('legacy-device', async () => {});
  assert.equal(quota.status('legacy-device').used, 101);
  now = Date.parse('2026-10-26T16:00:00.000Z');
  assert.equal(quota.status('legacy-device').used, 0);
  await quota.run('legacy-device', async () => {});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'chat-usage.json'), 'utf8')), {
    date: '2026-10-27', counts: [['legacy-device', 1]],
  });
});

function connectClient(baseUrl, name, deviceId = `device-${Date.now()}-${Math.random()}`, headers = {}) {
  return new Promise((resolve, reject) => {
    const socketUrl = new URL('/ws', baseUrl);
    socketUrl.protocol = 'ws:';
    socketUrl.searchParams.set('deviceId', deviceId);
    const socket = new WebSocket(socketUrl, { origin: baseUrl, headers });
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
