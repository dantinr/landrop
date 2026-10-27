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
const { ChatStore } = require('../src/chat-store');
const { createClient } = require('@redis/client');
const { createChatStorage } = require('../src/redis-chat-store');
const { readConfig } = require('../src/config');
const { DailyMessageLimit, messageDay } = require('../src/daily-message-limit');
const { FileStore } = require('../src/file-store');
const { decodeFileName, parseByteRange } = require('../src/validation');
const avatars = require('../wwwroot/avatars');

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
  const version = (await fs.readFile(path.join(__dirname, '..', 'VERSION'), 'utf8')).trim();
  assert.equal(alice.welcome.version, version);
  assert.equal(bob.welcome.version, version);
  assert.equal((await (await fetch(`${baseUrl}/api/status`)).json()).version, version);

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
    id: sender.clientId, name: '书房电脑', ip: '127.0.0.1', avatar: avatars.normalize(undefined, sender.clientId),
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
  assert.deepEqual(reconnected.welcome.history, []);

  const unjoined = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws`, { origin: baseUrl });
  sockets.push(unjoined);
  const inbox = createInbox(unjoined);
  await inbox.waitFor((event) => event.type === 'welcome');
  unjoined.send(JSON.stringify({ type: 'chat', text: '还没有加入' }));
  const error = await inbox.waitFor((event) => event.type === 'error');
  assert.equal(error.message, '请先设置昵称');
  assert.equal(notices.length, 2);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8'));
  assert.deepEqual(stored, []);
});

for (const privateRoom of [false, true]) {
  test(`${privateRoom ? '专有' : '公共'}房间仅在设备最后一个连接退出时提示离开，未加入与服务停止不误报`, async (context) => {
    const fixture = await roomFixture(context);
    const { baseUrl, sockets, dataDir } = fixture;
    const created = privateRoom ? await createTestRoom(baseUrl, '离线提示测试', 3) : null;
    const room = created?.room || {};
    const observer = await connectClient(baseUrl, '观察设备', 'device-leave-observer', {}, room);
    const sender = await connectClient(baseUrl, '离开设备', 'device-leave-sender', {}, room);
    sockets.push(observer.socket, sender.socket);
    await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 2);
    const departures = [];
    observer.socket.on('message', (buffer) => {
      const event = JSON.parse(buffer);
      if (event.message?.kind === 'offline') departures.push(event.message);
    });
    const outsideDepartures = [];
    if (privateRoom) {
      const outside = await connectClient(baseUrl, '公共成员', 'device-leave-outside');
      sockets.push(outside.socket);
      outside.socket.on('message', (buffer) => {
        const event = JSON.parse(buffer);
        if (event.message?.kind === 'offline') outsideDepartures.push(event.message);
      });
    }
    sender.socket.send(JSON.stringify({ type: 'chat', text: '离开前的消息' }));
    await observer.inbox.waitFor((event) => event.message?.text === '离开前的消息');
    const tab = await connectClient(baseUrl, '同设备标签页', sender.clientId, {}, room);
    sockets.push(tab.socket);
    await observer.inbox.waitFor((event) => event.type === 'presence'
      && event.users.some((user) => user.name === '同设备标签页'));
    sender.socket.terminate();
    await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 2);
    assert.equal(departures.length, 0, '还有同设备标签页时不应提示离开');
    tab.socket.send(JSON.stringify({ type: 'join', name: '最后昵称' }));
    await observer.inbox.waitFor((event) => event.type === 'presence'
      && event.users.some((user) => user.name === '最后昵称'));
    tab.socket.close();
    const departed = await observer.inbox.waitFor((event) => event.message?.kind === 'offline');
    assert.deepEqual(departed.message.sender, { id: sender.clientId, name: '最后昵称', ip: '127.0.0.1', avatar: avatars.normalize(undefined, sender.clientId) });
    assert.equal(Number.isNaN(Date.parse(departed.message.createdAt)), false);
    assert.equal(departures.length, 1, '同一次关闭只能提示一次');
    assert.deepEqual(outsideDepartures, [], '离开提示不能广播到其他房间');
    const again = await connectClient(baseUrl, '重新进入', sender.clientId, {}, room);
    sockets.push(again.socket);
    assert.deepEqual(again.welcome.history, []);
    assert.equal(again.welcome.chatQuota.used, 1, '离开提示不能扣除发送额度');
    await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 2);
    const unjoinedUrl = new URL('/ws', baseUrl);
    unjoinedUrl.protocol = 'ws:';
    if (room.id) unjoinedUrl.searchParams.set('room', room.id);
    const unjoined = new WebSocket(unjoinedUrl, { origin: baseUrl });
    sockets.push(unjoined);
    await createInbox(unjoined).waitFor((event) => event.type === 'welcome');
    unjoined.terminate();
    await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 2);
    assert.equal(departures.length, 1, '没有加入房间的连接不应提示离开');
    const messagesPath = room.id
      ? path.join(dataDir, 'rooms', room.id, 'messages.json') : path.join(dataDir, 'messages.json');
    assert.deepEqual(JSON.parse(await fs.readFile(messagesPath, 'utf8')), []);
    if (privateRoom) {
      const response = await fetch(`${baseUrl}/api/rooms/${room.id}`, {
        method: 'DELETE', headers: { Origin: baseUrl, Authorization: `Bearer ${created.ownerToken}` },
      });
      assert.equal(response.status, 200);
      await observer.inbox.waitFor((event) => event.type === 'roomDestroyed');
    }
    await fixture.restart();
    assert.equal(departures.length, 1, '销毁房间或停止服务时不应逐个提示离开');
  });
}

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

  const storageDefaults = { chatStorage: 'json', redis: { url: process.env.LANDROP_REDIS_URL || 'redis://127.0.0.1:6380', keyPrefix: 'landrop:chat:' } };
  assert.deepEqual(await readConfig(configPath), { dailyMessageLimit: 0, chatHistoryLimit: 20, ...storageDefaults });
  for (const config of [{}, { dailyMessageLimit: 0 }, { dailyMessageLimit: 100, chatHistoryLimit: 5 }]) {
    await fs.writeFile(configPath, `\uFEFF${JSON.stringify(config)}`);
    assert.deepEqual(await readConfig(configPath), {
      dailyMessageLimit: config.dailyMessageLimit ?? 0,
      chatHistoryLimit: config.chatHistoryLimit ?? 20,
      ...storageDefaults,
    });
  }
  for (const value of [-1, 1.5, '100', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    await fs.writeFile(configPath, JSON.stringify({ dailyMessageLimit: value }));
    await assert.rejects(readConfig(configPath), /dailyMessageLimit 必须是非负整数/u);
  }
  for (const value of [0, -1, 1.5, '20', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    await fs.writeFile(configPath, JSON.stringify({ chatHistoryLimit: value }));
    await assert.rejects(readConfig(configPath), /chatHistoryLimit 必须是正整数/u);
    await assert.rejects(createLanDropServer({ dataDir: configDir, chatHistoryLimit: value }), /chatHistoryLimit 必须是正整数/u);
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
  assert.equal(history.length, 20);
  assert.equal(history[0].text, '不限消息 182');
  const counts = JSON.parse(await fs.readFile(path.join(dataDir, 'chat-usage.json'), 'utf8'));
  assert.equal(new Map(counts.counts).get(client.clientId), 201);

  await app.stop();
  app = await createLanDropServer({ ...options, dailyMessageLimit: 201 });
  const restarted = await app.start();
  const reconnected = await connectClient(`http://127.0.0.1:${restarted.port}`, '仍是同设备', client.clientId);
  sockets.push(reconnected.socket);
  assert.equal(reconnected.welcome.history.length, 20);
  assert.equal(reconnected.welcome.history[0].text, '不限消息 182');
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

test('启动即将旧聊天记录清理到最近 20 条，磁盘、重连和重启结果一致', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-history-startup-'));
  const messagesPath = path.join(dataDir, 'messages.json');
  const original = Array.from({ length: 25 }, (_, index) => ({
    id: `legacy-message-${index + 1}`, kind: 'text',
    sender: { id: 'legacy-device', name: '旧设备', ip: '192.168.1.10' },
    text: `旧记录 ${index + 1}`, createdAt: '2026-10-26T00:00:00.000Z',
  }));
  await fs.writeFile(messagesPath, JSON.stringify([...original, { kind: 'online' }]));
  const options = { host: '127.0.0.1', port: 0, dataDir };
  let app = await createLanDropServer(options);
  const sockets = [];
  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const expected = original.slice(-20);
  assert.deepEqual(JSON.parse(await fs.readFile(messagesPath, 'utf8')), expected);
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const first = await connectClient(baseUrl, '读取设备', 'device-history-reader');
  sockets.push(first.socket);
  assert.equal(first.welcome.chatHistoryLimit, 20);
  assert.deepEqual(first.welcome.history, expected);
  assert.equal((await (await fetch(`${baseUrl}/api/status`)).json()).chatHistoryLimit, 20);

  await app.stop();
  app = await createLanDropServer(options);
  const restarted = await app.start();
  const second = await connectClient(`http://127.0.0.1:${restarted.port}`, '重连设备', first.clientId);
  sockets.push(second.socket);
  assert.deepEqual(second.welcome.history, expected);
  assert.deepEqual(JSON.parse(await fs.readFile(messagesPath, 'utf8')), expected);
});

test('自定义保留条数包含文字、文件及图片，并发发送按顺序淘汰且每日额度继续累计', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-history-window-'));
  const app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir, chatHistoryLimit: 3 });
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const sender = await connectClient(baseUrl, '发送设备', 'device-window-sender');
  const observer = await connectClient(baseUrl, '观察设备', 'device-window-observer');
  sockets.push(sender.socket, observer.socket);
  assert.equal(sender.welcome.chatHistoryLimit, 3);
  sender.socket.send(JSON.stringify({ type: 'chat', text: '消息 1' }));
  await observer.inbox.waitFor((event) => event.message?.text === '消息 1');
  const uploads = [];
  for (const [name, mime] of [['文件 2.txt', 'text/plain'], ['图片 3.png', 'image/png']]) {
    const response = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: {
        Origin: baseUrl, 'X-Client-Id': sender.clientId,
        'X-File-Name': Buffer.from(name).toString('base64url'), 'X-File-Type': mime,
      },
      body: 'history retention test',
    });
    assert.equal(response.status, 201);
    uploads.push(await response.json());
    await observer.inbox.waitFor((event) => event.message?.file?.name === name);
  }
  const messagesPath = path.join(dataDir, 'messages.json');
  assert.deepEqual(JSON.parse(await fs.readFile(messagesPath, 'utf8')).map((message) => message.kind), ['text', 'file', 'file']);
  for (let index = 4; index <= 7; index += 1) {
    sender.socket.send(JSON.stringify({ type: 'chat', text: `消息 ${index}` }));
  }
  for (let index = 4; index <= 7; index += 1) {
    await observer.inbox.waitFor((event) => event.message?.text === `消息 ${index}`);
  }
  const stored = JSON.parse(await fs.readFile(messagesPath, 'utf8'));
  assert.deepEqual(stored.map((message) => message.text), ['消息 5', '消息 6', '消息 7']);
  const late = await connectClient(baseUrl, '后来设备', 'device-window-late');
  sockets.push(late.socket);
  assert.deepEqual(late.welcome.history, stored);
  const counts = JSON.parse(await fs.readFile(path.join(dataDir, 'chat-usage.json'), 'utf8'));
  assert.equal(new Map(counts.counts).get(sender.clientId), 7);
  assert.equal((await (await fetch(`${baseUrl}/api/files`)).json()).files.length, 2);
  for (const upload of uploads) {
    const download = await fetch(`${baseUrl}${upload.file.downloadUrl}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'history retention test');
  }
});

test('专有聊天室隔离消息、成员、输入状态、上传和下载，房主凭证不会随邀请泄露', async (context) => {
  const fixture = await roomFixture(context);
  const { baseUrl, sockets } = fixture;
  const created = await createTestRoom(baseUrl, '朋友的小屋', 3);
  assert.equal(created.room.name, '朋友的小屋');
  assert.equal(created.room.capacity, 3);
  assert.equal(created.room.ownerHash, undefined);
  assert.equal(created.room.invitePath, `/?room=${created.room.id}`);
  assert.equal(created.room.invitePath.includes(created.ownerToken), false);
  const otherRoom = await createTestRoom(baseUrl, '另一个房间', 2);
  const publicClient = await connectClient(baseUrl, '公共成员', 'device-room-public');
  const owner = await connectClient(baseUrl, '房主', 'device-room-owner', {}, { ...created.room, ownerToken: created.ownerToken });
  const guest = await connectClient(baseUrl, '朋友', 'device-room-guest', {}, created.room);
  const other = await connectClient(baseUrl, '邻居', 'device-room-other', {}, otherRoom.room);
  sockets.push(publicClient.socket, owner.socket, guest.socket, other.socket);
  assert.equal(owner.membership.isOwner, true);
  assert.equal(guest.membership.isOwner, false);
  assert.equal(guest.welcome.ownerToken, undefined);
  const outsideEvents = [];
  for (const client of [publicClient, other]) {
    client.socket.on('message', (buffer) => outsideEvents.push(JSON.parse(buffer)));
  }
  owner.socket.send(JSON.stringify({ type: 'chat', text: '房间里的私聊' }));
  await guest.inbox.waitFor((event) => event.message?.text === '房间里的私聊');
  owner.socket.send(JSON.stringify({ type: 'typing', active: true }));
  await guest.inbox.waitFor((event) => event.type === 'typing' && event.clientId === owner.clientId);
  const headers = { 'X-Room-Session': owner.welcome.roomSession };
  const prefix = `${baseUrl}/api/rooms/${created.room.id}`;
  const response = await fetch(`${prefix}/files`, {
    method: 'POST', headers: {
      ...headers, Origin: baseUrl, 'X-File-Name': Buffer.from('房间图片.png').toString('base64url'),
      'X-File-Type': 'image/png', 'X-Client-Id': other.clientId,
    }, body: 'private image bytes',
  });
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.equal(uploaded.file.sender.id, owner.clientId, '不能伪造其他设备作为上传者');
  assert.match(uploaded.file.downloadUrl, new RegExp(`/api/rooms/${created.room.id}/files/`));
  await guest.inbox.waitFor((event) => event.message?.file?.id === uploaded.file.id);
  const files = await (await fetch(`${prefix}/files`, { headers })).json();
  assert.equal(files.files.length, 1);
  for (const pathName of ['/files', '/status', `/files/${uploaded.file.id}/download`]) {
    assert.equal((await fetch(`${prefix}${pathName}`)).status, 403);
    assert.equal((await fetch(`${prefix}${pathName}`, { headers: { 'X-Room-Session': other.welcome.roomSession } })).status, 403);
  }
  const download = await fetch(`${baseUrl}${uploaded.file.downloadUrl}?session=${guest.welcome.roomSession}`, { headers: { Range: 'bytes=0-6' } });
  assert.equal(download.status, 206);
  assert.equal(await download.text(), 'private');
  assert.equal((await fetch(`${baseUrl}/api/files/${uploaded.file.id}/download`)).status, 404);
  assert.equal((await (await fetch(`${baseUrl}/api/files`)).json()).files.length, 0);
  const wrongRoomDownload = `/api/rooms/${otherRoom.room.id}/files/${uploaded.file.id}/download`;
  assert.equal((await fetch(`${baseUrl}${wrongRoomDownload}`, { headers: { 'X-Room-Session': other.welcome.roomSession } })).status, 404);
  assert.equal(outsideEvents.some((event) => ['typing', 'uploads'].includes(event.type) || event.message?.sender?.id === owner.clientId), false);
  const status = await (await fetch(`${prefix}/status`, { headers })).json();
  assert.equal(status.onlineCount, 2);
  assert.equal(status.room.capacity, 3);
  assert.equal(status.room.ownerHash, undefined);
  guest.socket.terminate();
  await owner.inbox.waitFor((event) => event.type === 'presence' && event.count === 1);
  assert.equal((await fetch(`${baseUrl}${uploaded.file.downloadUrl}?session=${guest.welcome.roomSession}`)).status, 403);
});

test('人数限制按设备原子预留，同设备多标签共用名额，退出后可加入且满员不泄露历史', async (context) => {
  const { baseUrl, sockets } = await roomFixture(context);
  const created = await createTestRoom(baseUrl, '两人房间', 2);
  const owner = await connectClient(baseUrl, '房主', 'device-seats-owner', {}, created.room);
  sockets.push(owner.socket);
  owner.socket.send(JSON.stringify({ type: 'chat', text: '满员不可见的历史' }));
  await owner.inbox.waitFor((event) => event.message?.text === '满员不可见的历史');
  const attempts = await Promise.allSettled(['first', 'second'].map((suffix) => (
    connectClient(baseUrl, suffix, `device-seats-${suffix}`, {}, created.room)
  )));
  const joined = attempts.filter((item) => item.status === 'fulfilled');
  const rejected = attempts.filter((item) => item.status === 'rejected');
  assert.equal(joined.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'ROOM_FULL');
  const member = joined[0].value;
  sockets.push(member.socket);
  const tab = await connectClient(baseUrl, '同设备标签页', member.clientId, {}, created.room);
  sockets.push(tab.socket);
  const presence = await tab.inbox.waitFor((event) => event.type === 'presence');
  assert.equal(presence.count, 2);
  assert.equal(presence.users.length, 2);
  assert.equal((await fetch(`${baseUrl}/api/rooms/${created.room.id}`)).status, 403);
  const management = await fetch(`${baseUrl}/api/rooms/${created.room.id}`, { headers: { Authorization: `Bearer ${created.ownerToken}` } });
  assert.equal(management.status, 200, '房主无需占用成员名额也可管理满员房间');
  assert.deepEqual(await management.json(), { room: created.room, isOwner: true });
  member.socket.terminate();
  await owner.inbox.waitFor((event) => event.type === 'presence' && event.users.some((user) => user.name === '同设备标签页'));
  await assert.rejects(connectClient(baseUrl, '仍然满员', 'device-seats-third', {}, created.room), { code: 'ROOM_FULL' });
  tab.socket.terminate();
  await owner.inbox.waitFor((event) => event.type === 'presence' && event.count === 1);
  const newcomer = await connectClient(baseUrl, '新成员', 'device-seats-new', {}, created.room);
  sockets.push(newcomer.socket);
  assert.equal(newcomer.welcome.history[0].text, '满员不可见的历史');
});

test('聊天室重启后保留记录与房主权限，销毁需正确凭证且清除数据并使原链接失效', async (context) => {
  const fixture = await roomFixture(context);
  const { sockets, dataDir } = fixture;
  let baseUrl = fixture.baseUrl;
  const created = await createTestRoom(baseUrl, '持久房间', 2);
  const owner = await connectClient(baseUrl, '房主', 'device-persist-owner', {}, created.room);
  sockets.push(owner.socket);
  owner.socket.send(JSON.stringify({ type: 'chat', text: '重启后保留' }));
  await owner.inbox.waitFor((event) => event.message?.text === '重启后保留');
  await fixture.restart();
  baseUrl = fixture.baseUrl;
  const ownerAgain = await connectClient(baseUrl, '房主', owner.clientId, {}, { ...created.room, ownerToken: created.ownerToken });
  const guest = await connectClient(baseUrl, '成员', 'device-persist-guest', {}, created.room);
  sockets.push(ownerAgain.socket, guest.socket);
  assert.equal(ownerAgain.membership.isOwner, true);
  assert.equal(ownerAgain.welcome.history[0].text, '重启后保留');
  const uploaded = await fetch(`${baseUrl}/api/rooms/${created.room.id}/files`, {
    method: 'POST', headers: {
      Origin: baseUrl, 'X-Room-Session': guest.welcome.roomSession,
      'X-File-Name': Buffer.from('to-delete.txt').toString('base64url'),
    }, body: 'delete with room',
  });
  assert.equal(uploaded.status, 201);
  const roomUrl = `${baseUrl}/api/rooms/${created.room.id}`;
  for (const token of ['', 'a'.repeat(43)]) {
    const denied = await fetch(roomUrl, { method: 'DELETE', headers: { Origin: baseUrl, Authorization: `Bearer ${token}` } });
    assert.equal(denied.status, 403);
  }
  const foreignOrigin = await fetch(roomUrl, { method: 'DELETE', headers: { Origin: 'https://elsewhere.invalid', Authorization: `Bearer ${created.ownerToken}` } });
  assert.equal(foreignOrigin.status, 403);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'rooms', created.room.id, 'room.json'), 'utf8'));
  assert.equal(persisted.ownerToken, undefined);
  assert.notEqual(persisted.ownerHash, created.ownerToken);
  const deleted = await fetch(roomUrl, { method: 'DELETE', headers: { Origin: baseUrl, Authorization: `Bearer ${created.ownerToken}` } });
  assert.equal(deleted.status, 200);
  await guest.inbox.waitFor((event) => event.type === 'roomDestroyed');
  await assert.rejects(fs.stat(path.join(dataDir, 'rooms', created.room.id)), { code: 'ENOENT' });
  await assert.rejects(connectClient(baseUrl, '旧链接', 'device-old-link', {}, created.room), { code: 'ROOM_NOT_FOUND' });
  assert.equal((await fetch(`${roomUrl}/files`, { headers: { 'X-Room-Session': guest.welcome.roomSession } })).status, 404);
  await fixture.restart();
  await assert.rejects(connectClient(fixture.baseUrl, '重启后旧链接', 'device-old-link', {}, created.room), { code: 'ROOM_NOT_FOUND' });
  assert.equal((await fetch(`${fixture.baseUrl}/api/status`)).status, 200);
  // Simulate a crash after revocation was persisted but before the directory was removed.
  const interrupted = await createTestRoom(fixture.baseUrl, '销毁中断', 2);
  const metadataPath = path.join(dataDir, 'rooms', interrupted.room.id, 'room.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, destroyed: true }));
  await fixture.restart();
  await assert.rejects(fs.stat(path.dirname(metadataPath)), { code: 'ENOENT' });
  await assert.rejects(connectClient(fixture.baseUrl, '失效邀请', 'device-crashed-room', {}, interrupted.room), { code: 'ROOM_NOT_FOUND' });
});

test('销毁中断上传且不遗留文件，房间切换不能绕过每日额度，创建参数与来源严格校验', async (context) => {
  const { baseUrl, sockets, dataDir } = await roomFixture(context, { dailyMessageLimit: 2 });
  for (const input of [{ name: '', capacity: 2 }, { name: '房间', capacity: 0 }, { name: '房间', capacity: 1.5 }, { name: '房间', capacity: '2' }, null]) {
    assert.equal((await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers: { Origin: baseUrl }, body: JSON.stringify(input) })).status, 400);
  }
  assert.equal((await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers: { Origin: baseUrl }, body: '{' })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers: { Origin: 'https://elsewhere.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers: { Origin: baseUrl }, body: ' '.repeat(8193) })).status, 413);
  const created = await createTestRoom(baseUrl, '上传销毁测试', 1);
  const owner = await connectClient(baseUrl, '房主', 'device-destroy-upload', {}, created.room);
  const publicClient = await connectClient(baseUrl, '同一设备', owner.clientId);
  sockets.push(owner.socket, publicClient.socket);
  publicClient.socket.send(JSON.stringify({ type: 'chat', text: '公共消息占用一条' }));
  await publicClient.inbox.waitFor((event) => event.message?.text === '公共消息占用一条');
  owner.socket.send(JSON.stringify({ type: 'chat', text: '房间消息占用一条' }));
  await owner.inbox.waitFor((event) => event.message?.text === '房间消息占用一条');
  owner.socket.send(JSON.stringify({ type: 'chat', text: '不能绕过限额' }));
  assert.equal((await owner.inbox.waitFor((event) => event.type === 'error')).code, 'DAILY_MESSAGE_LIMIT');
  // A different device has quota available for a streaming upload in another room.
  const uploadRoom = await createTestRoom(baseUrl, '进行中的上传', 1);
  const uploader = await connectClient(baseUrl, '上传设备', 'device-stream-destroy', {}, uploadRoom.room);
  sockets.push(uploader.socket);
  let uploadRequest;
  const ended = new Promise((resolve) => {
    uploadRequest = http.request(`${baseUrl}/api/rooms/${uploadRoom.room.id}/files`, {
      method: 'POST', headers: {
        Origin: baseUrl, 'Content-Length': 1024 * 1024,
        'X-File-Name': Buffer.from('unfinished.png').toString('base64url'), 'X-File-Type': 'image/png',
        'X-Room-Session': uploader.welcome.roomSession, 'X-Upload-Id': 'destroy-stream-upload',
      },
    }, (response) => { response.resume(); response.on('end', resolve); });
    uploadRequest.on('error', resolve);
  });
  context.after(() => uploadRequest.destroy());
  uploadRequest.write(Buffer.alloc(1024));
  await uploader.inbox.waitFor((event) => event.type === 'uploads' && event.uploads.some((upload) => upload.receivedBytes >= 1024));
  const deleted = await fetch(`${baseUrl}/api/rooms/${uploadRoom.room.id}`, {
    method: 'DELETE', headers: { Origin: baseUrl, Authorization: `Bearer ${uploadRoom.ownerToken}` },
  });
  assert.equal(deleted.status, 200);
  await ended;
  await assert.rejects(fs.stat(path.join(dataDir, 'rooms', uploadRoom.room.id)), { code: 'ENOENT' });
  const usage = JSON.parse(await fs.readFile(path.join(dataDir, 'chat-usage.json'), 'utf8'));
  assert.equal(new Map(usage.counts).get(uploader.clientId) || 0, 0);
});

for (const privateRoom of [false, true]) {
  test(`${privateRoom ? '专有' : '公共'}房间同步删除离开者的文字与文件消息，保留他人消息且重连重启不恢复`, async (context) => {
    const fixture = await roomFixture(context);
    const { baseUrl, sockets, dataDir } = fixture;
    const created = privateRoom ? await createTestRoom(baseUrl, '消息消失测试', 4) : null;
    const room = created?.room || {};
    const observer = await connectClient(baseUrl, '保留的成员', 'device-erase-observer', {}, room);
    const sender = await connectClient(baseUrl, '离开的成员', 'device-erase-sender', {}, room);
    sockets.push(observer.socket, sender.socket);
    let outsideMessage;
    const outsideRemovals = [];
    if (privateRoom) {
      const outside = await connectClient(baseUrl, '公共房间同一设备', sender.clientId);
      sockets.push(outside.socket);
      outside.socket.send(JSON.stringify({ type: 'chat', text: '同一设备在公共房间的消息保留' }));
      outsideMessage = (await outside.inbox.waitFor((event) => event.message?.text === '同一设备在公共房间的消息保留')).message;
      outside.socket.on('message', (buffer) => {
        const event = JSON.parse(buffer);
        if (event.type === 'messagesRemoved') outsideRemovals.push(event);
      });
    }
    observer.socket.send(JSON.stringify({ type: 'chat', text: '其他人的消息应保留' }));
    const retained = (await observer.inbox.waitFor((event) => event.message?.text === '其他人的消息应保留')).message;
    sender.socket.send(JSON.stringify({ type: 'chat', text: '离开后删除的文字' }));
    const ownText = (await observer.inbox.waitFor((event) => event.message?.text === '离开后删除的文字')).message;
    const deletedIds = [ownText.id];
    const prefix = room.id ? `/api/rooms/${room.id}` : '/api';
    const uploads = [];
    for (const [name, mimeType] of [['离开的文件.txt', 'text/plain'], ['离开的图片.png', 'image/png']]) {
      const upload = await fetch(`${baseUrl}${prefix}/files`, {
        method: 'POST', headers: {
          Origin: baseUrl, 'X-Client-Id': sender.clientId,
          'X-Room-Session': sender.welcome.roomSession || '',
          'X-File-Name': Buffer.from(name).toString('base64url'), 'X-File-Type': mimeType,
        }, body: 'file content stays available',
      });
      assert.equal(upload.status, 201);
      const result = await upload.json();
      uploads.push(result.file);
      deletedIds.push(result.message.id);
      await observer.inbox.waitFor((event) => event.message?.id === result.message.id);
    }
    const tab = await connectClient(baseUrl, '同设备标签页', sender.clientId, {}, room);
    const peer = await connectClient(baseUrl, '另一位观察者', 'device-erase-peer', {}, room);
    sockets.push(tab.socket, peer.socket);
    await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === (privateRoom ? 3 : 4));
    const removedEvents = [];
    observer.socket.on('message', (buffer) => {
      const event = JSON.parse(buffer);
      if (event.type === 'messagesRemoved') removedEvents.push(event);
    });
    // A member cannot delete arbitrary messages by sending a forged removal event.
    sender.socket.send(JSON.stringify({ type: 'messagesRemoved', messageIds: [retained.id] }));
    assert.equal((await sender.inbox.waitFor((event) => event.type === 'error')).code, 'UNKNOWN_SOCKET_MESSAGE');
    sender.socket.terminate();
    await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 3);
    assert.deepEqual(removedEvents, [], '仍有同设备标签页时不能删除消息');
    tab.socket.close();
    const [firstRemoval, secondRemoval] = await Promise.all([
      observer.inbox.waitFor((event) => event.type === 'messagesRemoved'),
      peer.inbox.waitFor((event) => event.type === 'messagesRemoved'),
    ]);
    assert.deepEqual(new Set(firstRemoval.messageIds), new Set(deletedIds));
    assert.deepEqual(firstRemoval, secondRemoval, '所有成员收到同一批删除编号');
    assert.deepEqual(outsideRemovals, []);
    if (privateRoom) {
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8')), [outsideMessage]);
    }
    const again = await connectClient(baseUrl, '重进的成员', sender.clientId, {}, room);
    sockets.push(again.socket);
    assert.deepEqual(again.welcome.history, [retained]);
    assert.equal(again.welcome.chatQuota.used, privateRoom ? 4 : 3, '清理消息不能恢复每日额度');
    const messagesPath = room.id
      ? path.join(dataDir, 'rooms', room.id, 'messages.json') : path.join(dataDir, 'messages.json');
    assert.deepEqual(JSON.parse(await fs.readFile(messagesPath, 'utf8')), [retained]);
    assert.equal(again.welcome.files.length, 2, '删除聊天记录不删除已经上传的文件本体');
    for (const file of uploads) {
      const response = await fetch(`${baseUrl}${file.downloadUrl}`, {
        headers: { 'X-Room-Session': peer.welcome.roomSession || '' },
      });
      assert.equal(await response.text(), 'file content stays available');
    }
    await fixture.restart();
    const afterRestart = await connectClient(fixture.baseUrl, '重启后重进', sender.clientId, {}, room);
    sockets.push(afterRestart.socket);
    assert.deepEqual(afterRestart.welcome.history, [retained]);
  });
}

test('成员离开会中断未完成上传并退回额度，立即重连不会恢复旧消息', async (context) => {
  const { baseUrl, sockets, dataDir } = await roomFixture(context);
  const observer = await connectClient(baseUrl, '观察者', 'device-stream-erase-observer');
  const sender = await connectClient(baseUrl, '离开者', 'device-stream-erase-sender');
  sockets.push(observer.socket, sender.socket);
  sender.socket.send(JSON.stringify({ type: 'chat', text: '上传前的旧消息' }));
  await observer.inbox.waitFor((event) => event.message?.text === '上传前的旧消息');
  let request;
  const ended = new Promise((resolve) => {
    request = http.request(`${baseUrl}/api/files`, {
      method: 'POST', headers: {
        Origin: baseUrl, 'Content-Length': 1024 * 1024,
        'X-File-Name': Buffer.from('unfinished.txt').toString('base64url'),
        'X-Client-Id': sender.clientId, 'X-Upload-Id': 'stream-erase-upload',
      },
    }, (response) => { response.resume(); response.on('end', resolve); });
    request.on('error', resolve);
  });
  context.after(() => request.destroy());
  request.write(Buffer.alloc(1024));
  await observer.inbox.waitFor((event) => event.type === 'uploads' && event.uploads.some((upload) => upload.receivedBytes >= 1024));
  sender.socket.terminate();
  await observer.inbox.waitFor((event) => event.message?.kind === 'offline');
  const again = await connectClient(baseUrl, '立即重连', sender.clientId);
  sockets.push(again.socket);
  assert.deepEqual(again.welcome.history, []);
  await ended;
  if (again.welcome.chatQuota.used !== 1) {
    await again.inbox.waitFor((event) => event.type === 'chatQuota' && event.chatQuota.used === 1);
  }
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'incoming')), []);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads')), []);
});

test('离开前已接收但尚未完成的上传不能在重连后重新插入旧消息，新连接消息仍保留', async (context) => {
  const fixture = await roomFixture(context);
  const { baseUrl, sockets, dataDir } = fixture;
  const observer = await connectClient(baseUrl, '观察者', 'device-late-erase-observer');
  const sender = await connectClient(baseUrl, '旧连接', 'device-late-erase-sender');
  sockets.push(observer.socket, sender.socket);
  sender.socket.send(JSON.stringify({ type: 'chat', text: '需要删除的旧消息' }));
  await observer.inbox.waitFor((event) => event.message?.text === '需要删除的旧消息');
  const store = fixture.app.fileStore;
  const originalReceive = store.receive;
  let releaseReceive;
  const gate = new Promise((resolve) => { releaseReceive = resolve; });
  let markReceived;
  const received = new Promise((resolve) => { markReceived = resolve; });
  store.receive = async function (...args) {
    const file = await originalReceive.apply(this, args);
    markReceived();
    await gate;
    return file;
  };
  try {
    const upload = fetch(`${baseUrl}/api/files`, {
      method: 'POST', headers: {
        Origin: baseUrl, 'X-Client-Id': sender.clientId,
        'X-File-Name': Buffer.from('late.txt').toString('base64url'),
      }, body: 'completed bytes before leaving',
    }).then((response) => response.arrayBuffer(), () => null);
    await received;
    sender.socket.close();
    await observer.inbox.waitFor((event) => event.message?.kind === 'offline');
    const again = await connectClient(baseUrl, '新连接', sender.clientId);
    sockets.push(again.socket);
    assert.deepEqual(again.welcome.history, []);
    again.socket.send(JSON.stringify({ type: 'chat', text: '重新进入后的新消息' }));
    const fresh = (await observer.inbox.waitFor((event) => event.message?.text === '重新进入后的新消息')).message;
    releaseReceive();
    await upload;
    await again.inbox.waitFor((event) => event.type === 'chatQuota' && event.chatQuota.used === 2);
    const late = await connectClient(baseUrl, '后来者', 'device-late-erase-reader');
    sockets.push(late.socket);
    assert.deepEqual(late.welcome.history, [fresh]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8')), [fresh]);
  } finally {
    releaseReceive();
    store.receive = originalReceive;
  }
});

test('删除聊天记录与新增写入排队，写盘失败不改变内存且可重试', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-erase-store-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new ChatStore(dataDir);
  await store.init();
  const message = (id, senderId) => ({ id, kind: 'text', text: id, sender: { id: senderId }, createdAt: new Date().toISOString() });
  const first = message('remove-first', 'sender');
  const retained = message('retained', 'observer');
  await store.add(first);
  await store.add(retained);
  const originalWrite = store.store.write;
  store.store.write = () => Promise.reject(new Error('simulated disk failure'));
  await assert.rejects(store.removeBySender('sender'), /simulated disk failure/u);
  assert.deepEqual(store.list(), [first, retained]);
  store.store.write = originalWrite;
  const queued = message('remove-queued', 'sender');
  const [added, removed] = await Promise.all([store.add(queued), store.removeBySender('sender')]);
  assert.deepEqual(added, queued);
  assert.deepEqual(removed, [first.id, queued.id]);
  assert.deepEqual(store.list(), [retained]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8')), [retained]);
});

test('Redis 配置严格校验连接地址、前缀和存储类型，错误不暴露密码', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-redis-config-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  await fs.writeFile(file, JSON.stringify({ chatStorage: 'redis', redisUrl: 'rediss://user:secret@localhost:6380/2', redisKeyPrefix: 'custom:chat:' }));
  const configured = await readConfig(file);
  assert.equal(configured.chatStorage, 'redis');
  assert.equal(configured.redis.keyPrefix, 'custom:chat:');
  assert.equal(configured.redis.url, process.env.LANDROP_REDIS_URL || 'rediss://user:secret@localhost:6380/2');
  for (const value of ['memory', null, 1, {}]) {
    await fs.writeFile(file, JSON.stringify({ chatStorage: value }));
    await assert.rejects(readConfig(file), /chatStorage 必须是 json 或 redis/u);
  }
  const { validateRedisOptions } = require('../src/config');
  for (const url of ['http://user:secret@localhost', 'redis://localhost/abc', 'redis://localhost?secret=password', null, 1]) {
    assert.throws(() => validateRedisOptions(url), error => !error.message.includes('secret') && /redisUrl/u.test(error.message));
  }
  for (const prefix of ['', '*', 'space prefix', null, 100]) assert.throws(() => validateRedisOptions(undefined, prefix), /redisKeyPrefix/u);
});

test('Redis 无法连接时启动失败，不回退写入 JSON 或暴露凭证', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-redis-unavailable-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const unused = require('node:net').createServer();
  await new Promise(resolve => unused.listen(0, '127.0.0.1', resolve));
  const port = unused.address().port;
  await new Promise(resolve => unused.close(resolve));
  await assert.rejects(createLanDropServer({ dataDir: directory, chatStorage: 'redis', redis: { url: `redis://private:never-log-this@127.0.0.1:${port}` } }), error => {
    assert.match(error.message, /无法连接聊天 Redis/u);
    assert.doesNotMatch(error.message, /never-log-this|private/u);
    return true;
  });
  await assert.rejects(fs.stat(path.join(directory, 'messages.json')), { code: 'ENOENT' });
});

const redisTestOptions = { skip: !process.env.LANDROP_TEST_REDIS_URL };

async function redisFixture(context) {
  const client = createClient({ url: process.env.LANDROP_TEST_REDIS_URL, socket: { reconnectStrategy: false } });
  client.on('error', () => {});
  await client.connect();
  const keyPrefix = `landrop-test:${crypto.randomUUID()}:`;
  context.after(async () => {
    try {
      for await (const keys of client.scanIterator({ MATCH: `${keyPrefix}*`, COUNT: 100 })) {
        if (keys.length) await client.del(keys);
      }
    } finally { client.destroy(); }
  });
  return { client, redis: { url: process.env.LANDROP_TEST_REDIS_URL, keyPrefix }, key: id => `${keyPrefix}${id || 'public'}` };
}

test('Redis 迁移旧 JSON 后只存内存，原子保留条数、并发删除、清空后不复活历史', redisTestOptions, async (context) => {
  const fixture = await redisFixture(context);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-redis-store-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const message = (id, sender = 'sender-a') => ({ id, kind: 'text', text: `private body ${id}`, sender: { id: sender, name: sender, ip: '127.0.0.1' }, createdAt: new Date().toISOString() });
  await fs.writeFile(path.join(directory, 'messages.json'), JSON.stringify([message('1'), message('2'), message('3'), message('4')]));
  let storage = await createChatStorage({ chatStorage: 'redis', redis: fixture.redis });
  context.after(() => storage.close());
  let store = storage.create(directory, 3, '');
  await store.init();
  assert.deepEqual((await store.list()).map(row => row.id), ['2', '3', '4']);
  await assert.rejects(fs.stat(path.join(directory, 'messages.json')), { code: 'ENOENT' });
  await Promise.all([store.add(message('5', 'sender-b')), store.add(message('6')), store.removeBySender('sender-a')]);
  assert.deepEqual((await store.list()).map(row => row.id), ['5']);
  storage.close();
  storage = await createChatStorage({ chatStorage: 'redis', redis: fixture.redis });
  store = storage.create(directory, 3, '');
  await store.init();
  assert.deepEqual((await store.list()).map(row => row.id), ['5'], '仅重启程序仍使用 Redis 中的记录');
  await fixture.client.del(fixture.key(''));
  assert.deepEqual(await store.list(), [], 'Redis 中清空后不使用内存或旧 JSON 副本');
  await store.add(message('7'));
  assert.deepEqual((await store.list()).map(row => row.id), ['7']);
  await fixture.client.set(fixture.key(''), 'wrong data type');
  await assert.rejects(store.add(message('never-log-private')), error => error.code === 'CHAT_STORAGE_UNAVAILABLE' && !error.message.includes('private'));
  await fixture.client.del(fixture.key(''));
  await store.add(message('8'));
  assert.deepEqual((await store.list()).map(row => row.id), ['8'], '失败后写入队列仍可恢复');
  await assert.rejects(fs.stat(path.join(directory, 'messages.json')), { code: 'ENOENT' });
});

test('Redis 迁移失败保留原始 JSON，已有 Redis 记录不会被旧磁盘副本覆盖', redisTestOptions, async (context) => {
  const fixture = await redisFixture(context);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-redis-migrate-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const message = { id: 'existing', kind: 'text', text: 'private migration text', createdAt: new Date().toISOString() };
  const legacyPath = path.join(directory, 'messages.json');
  await fs.writeFile(legacyPath, JSON.stringify([message]));
  const storage = await createChatStorage({ chatStorage: 'redis', redis: fixture.redis });
  context.after(() => storage.close());
  await fixture.client.set(fixture.key(''), 'wrong type');
  const store = storage.create(directory, 20, '');
  await assert.rejects(store.init(), { code: 'CHAT_STORAGE_UNAVAILABLE' });
  assert.deepEqual(JSON.parse(await fs.readFile(legacyPath, 'utf8')), [message]);
  await fixture.client.del(fixture.key(''));
  await fixture.client.rPush(fixture.key(''), JSON.stringify({ ...message, id: 'redis-newer' }));
  await store.init();
  assert.deepEqual((await store.list()).map(row => row.id), ['redis-newer']);
  await assert.rejects(fs.stat(legacyPath), { code: 'ENOENT' });
});

test('Redis 公共与专有房间隔离，文字图片文件受保留限制，离开同步清理且销毁删键', redisTestOptions, async (context) => {
  const redis = await redisFixture(context);
  const fixture = await roomFixture(context, { chatStorage: 'redis', redis: redis.redis, chatHistoryLimit: 3 });
  const { baseUrl, sockets, dataDir } = fixture;
  const created = await createTestRoom(baseUrl, 'Redis 房间', 3);
  const owner = await connectClient(baseUrl, 'Redis 房主', 'device-redis-owner', {}, { ...created.room, ownerToken: created.ownerToken });
  const sender = await connectClient(baseUrl, 'Redis 成员', 'device-redis-sender', {}, created.room);
  const outside = await connectClient(baseUrl, '公共成员', 'device-redis-outside');
  sockets.push(owner.socket, sender.socket, outside.socket);
  outside.socket.send(JSON.stringify({ type: 'chat', text: '公共消息应保留' }));
  await outside.inbox.waitFor(event => event.message?.text === '公共消息应保留');
  sender.socket.send(JSON.stringify({ type: 'chat', text: '会被条数淘汰' }));
  await owner.inbox.waitFor(event => event.message?.text === '会被条数淘汰');
  const own = [];
  for (const [name, mime] of [['example.txt', 'text/plain'], ['example.png', 'image/png']]) {
    const response = await fetch(`${baseUrl}/api/rooms/${created.room.id}/files`, {
      method: 'POST', headers: { Origin: baseUrl, 'X-Room-Session': sender.welcome.roomSession, 'X-File-Name': Buffer.from(name).toString('base64url'), 'X-File-Type': mime }, body: 'redis-file-content',
    });
    assert.equal(response.status, 201);
    own.push((await response.json()).message.id);
  }
  owner.socket.send(JSON.stringify({ type: 'chat', text: '房主消息保留' }));
  const retained = (await owner.inbox.waitFor(event => event.message?.text === '房主消息保留')).message;
  assert.equal(await redis.client.lLen(redis.key(created.room.id)), 3);
  const tab = await connectClient(baseUrl, '成员另一标签', sender.clientId, {}, created.room);
  sockets.push(tab.socket);
  sender.socket.close();
  await owner.inbox.waitFor(event => event.type === 'presence' && event.count === 2);
  assert.equal(await redis.client.lLen(redis.key(created.room.id)), 3);
  tab.socket.close();
  const removed = await owner.inbox.waitFor(event => event.type === 'messagesRemoved');
  assert.deepEqual(new Set(removed.messageIds), new Set(own));
  assert.deepEqual((await redis.client.lRange(redis.key(created.room.id), 0, -1)).map(JSON.parse), [retained]);
  assert.equal(await redis.client.lLen(redis.key('')), 1);
  for (const directory of [dataDir, path.join(dataDir, 'rooms', created.room.id)]) {
    await assert.rejects(fs.stat(path.join(directory, 'messages.json')), { code: 'ENOENT' });
  }
  const again = await connectClient(baseUrl, '重连成员', sender.clientId, {}, created.room);
  sockets.push(again.socket);
  assert.deepEqual(again.welcome.history, [retained]);
  assert.equal(again.welcome.files.length, 2);
  await fixture.restart();
  const restarted = await connectClient(fixture.baseUrl, '程序重启后', sender.clientId, {}, created.room);
  sockets.push(restarted.socket);
  assert.deepEqual(restarted.welcome.history, [retained]);
  await redis.client.del(redis.key(created.room.id));
  const empty = await connectClient(fixture.baseUrl, 'Redis 清空后', 'device-redis-empty', {}, created.room);
  sockets.push(empty.socket);
  assert.deepEqual(empty.welcome.history, [], '程序仍在运行也不能下发 Redis 已清除的旧消息');
  await redis.client.set(redis.key(created.room.id), 'wrong type');
  restarted.socket.send(JSON.stringify({ type: 'chat', text: '不应记录到日志的正文' }));
  assert.equal((await restarted.inbox.waitFor(event => event.type === 'error')).code, 'CHAT_STORAGE_UNAVAILABLE');
  const failedUpload = await fetch(`${fixture.baseUrl}/api/rooms/${created.room.id}/files`, {
    method: 'POST', headers: { Origin: fixture.baseUrl, 'X-Room-Session': restarted.welcome.roomSession, 'X-File-Name': Buffer.from('error.png').toString('base64url'), 'X-File-Type': 'image/png' }, body: 'private-body-must-not-appear-in-errors',
  });
  assert.equal(failedUpload.status, 503);
  assert.deepEqual(await failedUpload.json(), { error: 'CHAT_STORAGE_UNAVAILABLE', message: '聊天存储暂不可用，请稍后重试' });
  await redis.client.del(redis.key(created.room.id));
  const deleted = await fetch(`${fixture.baseUrl}/api/rooms/${created.room.id}`, { method: 'DELETE', headers: { Origin: fixture.baseUrl, Authorization: `Bearer ${created.ownerToken}` } });
  assert.equal(deleted.status, 200);
  assert.equal(await redis.client.exists(redis.key(created.room.id)), 0);
  assert.equal(await redis.client.lLen(redis.key('')), 1);
  assert.equal((await fetch(`${fixture.baseUrl}/api/rooms/${created.room.id}`)).status, 404);
});

for (const privateRoom of [false, true]) {
  test(`${privateRoom ? '专有' : '公共'}房间的生肖头像同步到成员、文字、上传和历史，拒绝非法头像`, async (context) => {
    const fixture = await roomFixture(context, { dailyMessageLimit: 10 });
    const { baseUrl, sockets, dataDir } = fixture;
    const room = privateRoom ? (await createTestRoom(baseUrl, '头像测试', 3)).room : {};
    const observer = await connectClient(baseUrl, '观察者', 'device-avatar-observer', {}, room);
    const sender = await connectClient(baseUrl, '生肖用户', 'device-avatar-sender', {}, room);
    sockets.push(observer.socket, sender.socket);
    const initial = await observer.inbox.waitFor((event) => event.type === 'presence' && event.count === 2);
    assert.equal(initial.users.find((user) => user.id === sender.clientId).avatar, avatars.normalize(undefined, sender.clientId));
    const online = await observer.inbox.waitFor((event) => event.message?.kind === 'online' && event.message.sender.id === sender.clientId);
    assert.equal(online.message.sender.avatar, avatars.normalize(undefined, sender.clientId));

    const notices = [];
    observer.socket.on('message', (buffer) => {
      const event = JSON.parse(buffer.toString());
      if (event.message?.kind === 'online') notices.push(event);
    });
    sender.socket.send(JSON.stringify({ type: 'join', name: '生肖用户', avatar: 'dragon' }));
    await observer.inbox.waitFor((event) => event.type === 'presence'
      && event.users.some((user) => user.id === sender.clientId && user.avatar === 'dragon'));
    for (const avatar of ['https://example.com/avatar.png', '<svg onload=alert(1)>', '', null, {}, 1]) {
      sender.socket.send(JSON.stringify({ type: 'join', name: '不应生效', avatar }));
      const error = await sender.inbox.waitFor((event) => event.type === 'error');
      assert.equal(error.code, 'INVALID_AVATAR');
    }
    sender.socket.send(JSON.stringify({ type: 'chat', text: '龙头像消息' }));
    const message = (await observer.inbox.waitFor((event) => event.message?.text === '龙头像消息')).message;
    assert.equal(message.sender.avatar, 'dragon');
    assert.equal(message.sender.name, '生肖用户');
    const apiPath = room.id ? `/api/rooms/${room.id}` : '/api';
    const upload = await fetch(`${baseUrl}${apiPath}/files`, {
      method: 'POST',
      headers: {
        Origin: baseUrl, 'X-Client-Id': sender.clientId, 'X-Room-Session': sender.welcome.roomSession || '',
        'X-File-Name': Buffer.from('头像图片.png').toString('base64url'), 'X-File-Type': 'image/png',
      },
      body: Buffer.from([137, 80, 78, 71]),
    });
    assert.equal(upload.status, 201);
    assert.equal((await upload.json()).file.sender.avatar, 'dragon');
    const file = (await observer.inbox.waitFor((event) => event.message?.kind === 'file')).message;
    assert.equal(file.sender.avatar, 'dragon');
    assert.equal(file.file.sender.avatar, 'dragon');
    sender.socket.send(JSON.stringify({ type: 'chatQuota' }));
    assert.equal((await sender.inbox.waitFor((event) => event.type === 'chatQuota' && event.chatQuota.remaining === 8)).chatQuota.used, 2);

    const tab = await connectClient(baseUrl, '同设备标签页', sender.clientId, {}, room);
    sockets.push(tab.socket);
    assert.deepEqual(tab.welcome.history.map((event) => event.sender.avatar), ['dragon', 'dragon']);
    tab.socket.send(JSON.stringify({ type: 'join', name: '同设备标签页', avatar: 'goat' }));
    const updated = await observer.inbox.waitFor((event) => event.type === 'presence'
      && event.users.some((user) => user.id === sender.clientId)
      && event.users.filter((user) => user.id === sender.clientId).every((user) => user.avatar === 'goat'));
    assert.ok(updated.users.some((user) => user.id === sender.clientId));
    // Older clients omit avatar when changing their name; keep the chosen avatar.
    sender.socket.send(JSON.stringify({ type: 'join', name: '兼容旧客户端' }));
    sender.socket.send(JSON.stringify({ type: 'chat', text: '羊头像消息' }));
    const latest = (await observer.inbox.waitFor((event) => event.message?.text === '羊头像消息')).message;
    assert.equal(latest.sender.avatar, 'goat');
    const historyPath = path.join(dataDir, ...(room.id ? ['rooms', room.id] : []), 'messages.json');
    const history = JSON.parse(await fs.readFile(historyPath, 'utf8'));
    assert.deepEqual(history.map((event) => event.sender.avatar), ['dragon', 'dragon', 'goat']);
    assert.equal(notices.length, 0);
    const catalog = await fetch(`${baseUrl}/avatars.js`);
    assert.equal(catalog.status, 200);
    assert.match(catalog.headers.get('content-type'), /javascript/u);
  });
}

async function roomFixture(context, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-rooms-'));
  let app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir, ...options });
  const sockets = [];
  const fixture = { dataDir, sockets, baseUrl: `http://127.0.0.1:${(await app.start()).port}`, get app() { return app; } };
  fixture.restart = async () => {
    await app.stop();
    app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir, ...options });
    fixture.baseUrl = `http://127.0.0.1:${(await app.start()).port}`;
  };
  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return fixture;
}

async function createTestRoom(baseUrl, name, capacity) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, capacity }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

function connectClient(baseUrl, name, deviceId = `device-${Date.now()}-${Math.random()}`, headers = {}, room = {}) {
  return new Promise((resolve, reject) => {
    const socketUrl = new URL('/ws', baseUrl);
    socketUrl.protocol = 'ws:';
    socketUrl.searchParams.set('deviceId', deviceId);
    if (room.id) socketUrl.searchParams.set('room', room.id);
    const socket = new WebSocket(socketUrl, { origin: baseUrl, headers });
    const inbox = createInbox(socket);
    const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 3_000);

    inbox.waitFor((message) => ['welcome', 'error'].includes(message.type)).then(async (welcome) => {
      clearTimeout(timeout);
      if (welcome.type === 'error') {
        socket.close();
        throw Object.assign(new Error(welcome.message), { code: welcome.code });
      }
      socket.send(JSON.stringify({ type: 'join', name, ownerToken: room.ownerToken }));
      const membership = room.id ? await inbox.waitFor((message) => message.type === 'room') : null;
      resolve({ socket, inbox, clientId: welcome.clientId, welcome, membership });
    }).catch(reject);
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
