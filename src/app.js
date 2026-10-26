'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { remoteAddress } = require('./client-ip');
const { DailyMessageLimit } = require('./daily-message-limit');
const { FILE_ID_PATTERN, MAX_UPLOAD_BYTES } = require('./file-store');
const { RoomStore, publicRoom } = require('./room-store');
const {
  HttpError,
  contentDisposition,
  decodeFileName,
  normalizeChatText,
  normalizeMimeType,
  normalizeUserName,
  parseByteRange,
} = require('./validation');

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/vendor/lucide.min.js', ['vendor/lucide.min.js', 'text/javascript; charset=utf-8']],
]);

async function createLanDropServer(options = {}) {
  const port = options.port ?? 8787;
  const host = options.host || '0.0.0.0';
  const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, '..', 'wwwroot'));
  const serverName = options.serverName || os.hostname();
  const trustLoopbackProxy = options.trustLoopbackProxy === true;
  const dailyMessageLimit = new DailyMessageLimit(dataDir, options.dailyMessageLimit, options.now);
  const rooms = new RoomStore(dataDir, options.chatHistoryLimit);
  await Promise.all([rooms.init(), dailyMessageLimit.init()]);
  const fileStore = rooms.publicRoom.fileStore;

  const allClients = new Set();
  let stopping = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  const broadcastQuota = (deviceId) => {
    for (const client of allClients) {
      if (client.id === deviceId && client.welcomed) {
        sendSocket(client.webSocket, { type: 'chatQuota', chatQuota: dailyMessageLimit.status(deviceId) });
      }
    }
  };

  const broadcastUploadsNow = (room) => {
    if (room.uploadBroadcastTimer) {
      clearTimeout(room.uploadBroadcastTimer);
      room.uploadBroadcastTimer = null;
    }
    if (!room.destroyed) broadcast(room.clients, { type: 'uploads', uploads: publicActiveUploads(room.activeUploads) });
  };

  const scheduleUploadBroadcast = (room) => {
    if (room.uploadBroadcastTimer || room.destroyed) return;
    room.uploadBroadcastTimer = setTimeout(() => {
      room.uploadBroadcastTimer = null;
      broadcastUploadsNow(room);
    }, 250);
    room.uploadBroadcastTimer.unref();
  };

  const server = http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      const requestUrl = new URL(request.url, 'http://landrop.local');

      if (request.method === 'POST' && requestUrl.pathname === '/api/rooms') {
        assertSameOrigin(request);
        const result = await rooms.create(await readRoomRequest(request));
        return sendJson(response, 201, result);
      }

      let room = rooms.publicRoom;
      let apiPath = requestUrl.pathname;
      let member = null;
      const roomMatch = /^\/api\/rooms\/([^/]+)(\/.*)?$/u.exec(apiPath);
      if (roomMatch) {
        room = rooms.get(roomMatch[1]);
        if (request.method === 'GET' && !roomMatch[2]) {
          if (!rooms.isOwner(room, ownerToken(request))) {
            throw new HttpError(403, '只有房主可以管理聊天室', 'ROOM_OWNER_REQUIRED');
          }
          return sendJson(response, 200, { room: publicRoom(room), isOwner: true });
        }
        if (request.method === 'DELETE' && !roomMatch[2]) {
          assertSameOrigin(request);
          await rooms.destroy(room.id, ownerToken(request), (destroyedRoom) => {
            clearTimeout(destroyedRoom.uploadBroadcastTimer);
            for (const client of destroyedRoom.clients) {
              sendSocket(client.webSocket, { type: 'roomDestroyed' });
              client.webSocket.close(4004, 'Room destroyed');
            }
            for (const [activeResponse, activeRequest] of destroyedRoom.responses) {
              activeRequest.destroy();
              activeResponse.destroy();
            }
          });
          return sendJson(response, 200, { destroyed: true });
        }
        const session = singleHeader(request.headers['x-room-session']) || requestUrl.searchParams.get('session');
        member = Array.from(room.clients).find((client) => (
          client.ready && client.session === session && client.webSocket.readyState === WebSocket.OPEN
        ));
        if (!member) throw new HttpError(403, '请先通过邀请链接进入聊天室', 'ROOM_SESSION_REQUIRED');
        apiPath = `/api${roomMatch[2] || ''}`;
        room.responses.set(response, request);
        response.once('close', () => room.responses.delete(response));
      }
      const { clients, chatStore, fileStore, activeUploads } = room;
      const exposeFile = (file) => publicFile(file, room.id);

      if (request.method === 'GET' && apiPath === '/api/status') {
        return sendJson(response, 200, {
          serverName,
          room: publicRoom(room),
          onlineCount: (room.id ? uniqueClients(readyClients(clients)) : readyClients(clients)).length,
          maxUploadBytes: MAX_UPLOAD_BYTES,
          chatHistoryLimit: chatStore.limit,
          availableBytes: await fileStore.availableBytes(),
        });
      }

      if (request.method === 'GET' && apiPath === '/api/files') {
        return sendJson(response, 200, { files: fileStore.list().map(exposeFile) });
      }

      if (request.method === 'POST' && apiPath === '/api/files') {
        assertSameOrigin(request);
        const fileName = decodeFileName(singleHeader(request.headers['x-file-name']));
        const mimeType = normalizeMimeType(singleHeader(request.headers['x-file-type']));
        const uploadId = normalizeUploadId(singleHeader(request.headers['x-upload-id']));
        const totalBytes = parseUploadSize(
          singleHeader(request.headers['content-length']),
          singleHeader(request.headers['x-file-size']),
        );
        if (
          Number(singleHeader(request.headers['content-length'])) > MAX_UPLOAD_BYTES
          || Number(singleHeader(request.headers['x-file-size'])) > MAX_UPLOAD_BYTES
        ) {
          throw new HttpError(413, '单个文件不能超过 20 MB', 'FILE_TOO_LARGE');
        }
        if (activeUploads.has(uploadId)) {
          throw new HttpError(409, '上传任务编号重复', 'DUPLICATE_UPLOAD_ID');
        }
        const claimedClientId = singleHeader(request.headers['x-client-id']);
        const connectedClient = member || Array.from(clients).find((client) => client.id === claimedClientId);
        const sender = connectedClient
          ? publicSender(connectedClient)
          : {
              id: typeof claimedClientId === 'string' ? claimedClientId.slice(0, 80) : crypto.randomUUID(),
              name: normalizeUserName(singleHeader(request.headers['x-client-name'])),
              ip: remoteAddress(request, trustLoopbackProxy),
            };
        const deviceSession = connectedClient?.deviceSession;
        assertDeviceSession(deviceSession);
        const activeUpload = {
          id: uploadId,
          name: fileName,
          totalBytes,
          receivedBytes: 0,
          sender,
          startedAt: new Date().toISOString(),
          deviceSession,
          request,
        };
        activeUploads.set(uploadId, activeUpload);
        broadcastUploadsNow(room);

        const quotaDeviceId = member || claimedClientId ? sender.id : `ip:${sender.ip}`;
        return await rooms.run(room, async () => {
          try {
            const file = await dailyMessageLimit.run(quotaDeviceId, async () => {
              assertDeviceSession(deviceSession);
              const received = await fileStore.receive(
                request,
                { fileName, mimeType, sender },
                (receivedBytes) => {
                  activeUpload.receivedBytes = receivedBytes;
                  scheduleUploadBroadcast(room);
                },
              );
              assertDeviceSession(deviceSession);
              return received;
            });
            rooms.assertActive(room);
            assertDeviceSession(deviceSession);
            activeUpload.receivedBytes = file.size;
            activeUpload.totalBytes = file.size;
            const message = {
              id: crypto.randomUUID(),
              kind: 'file',
              sender,
              file: exposeFile(file),
              createdAt: file.createdAt,
            };

            await chatStore.add(message).catch((error) => {
              console.error('保存聊天记录失败:', error.message);
            });
            rooms.assertActive(room);
            assertDeviceSession(deviceSession);
            broadcast(clients, { type: 'message', message });
            return sendJson(response, 201, { file: exposeFile(file), message });
          } finally {
            if (activeUploads.get(uploadId) === activeUpload) activeUploads.delete(uploadId);
            broadcastUploadsNow(room);
            broadcastQuota(quotaDeviceId);
          }
        });
      }

      const downloadMatch = /^\/api\/files\/([^/]+)\/download$/u.exec(apiPath);
      if ((request.method === 'GET' || request.method === 'HEAD') && downloadMatch) {
        return await serveDownload(request, response, fileStore, downloadMatch[1]);
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        const staticFile = STATIC_FILES.get(requestUrl.pathname);
        if (staticFile) {
          return await serveStatic(request, response, publicDir, staticFile);
        }
      }

      throw new HttpError(404, '页面不存在', 'NOT_FOUND');
    } catch (error) {
      if (error instanceof HttpError && (error.status === 413 || error.status === 429)) {
        response.setHeader('Connection', 'close');
      }
      handleHttpError(error, response);
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 15 * 1000;
  server.keepAliveTimeout = 5 * 1000;

  server.on('upgrade', (request, socket, head) => {
    try {
      const requestUrl = new URL(request.url, 'http://landrop.local');
      if (requestUrl.pathname !== '/ws') throw new Error('Unknown WebSocket endpoint');
      assertSameOrigin(request);
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit('connection', webSocket, request);
      });
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (webSocket, request) => {
    const requestUrl = new URL(request.url, 'http://landrop.local');
    let room;
    const deviceId = normalizeDeviceId(requestUrl.searchParams.get('deviceId'));
    try {
      room = rooms.get(requestUrl.searchParams.get('room') || '');
      const occupants = uniqueClients(Array.from(room.clients));
      if (room.capacity && !occupants.some((client) => client.id === deviceId)
        && occupants.length >= room.capacity) {
        throw new HttpError(409, '聊天室人数已满，请稍后重试', 'ROOM_FULL');
      }
    } catch (error) {
      socketError(webSocket, error.message, error.code);
      webSocket.close(4004, error.code);
      return;
    }
    const { clients, chatStore, fileStore, activeUploads } = room;
    const client = {
      id: deviceId,
      session: crypto.randomBytes(32).toString('base64url'),
      name: '访客',
      ip: remoteAddress(request, trustLoopbackProxy),
      ready: false,
      welcomed: false,
      deviceSession: null,
      isAlive: true,
      webSocket,
    };
    clients.add(client);
    allClients.add(client);
    const joinTimeout = setTimeout(() => {
      if (!client.ready) webSocket.close(4008, 'Join timeout');
    }, 15_000);
    joinTimeout.unref();

    const welcome = async () => {
      // A new connection must not receive history that is still being removed.
      while (room.pendingMessageRemovals.size > 0) {
        await Promise.allSettled([...room.pendingMessageRemovals]);
      }
      if (!clients.has(client) || webSocket.readyState !== WebSocket.OPEN) return;
      rooms.assertActive(room);
      sendSocket(webSocket, {
        type: 'welcome',
        clientId: client.id,
        room: publicRoom(room),
        roomSession: room.id ? client.session : undefined,
        chatQuota: dailyMessageLimit.status(client.id),
        chatHistoryLimit: chatStore.limit,
        history: chatStore.list(),
        files: fileStore.list().map((file) => publicFile(file, room.id)),
        uploads: publicActiveUploads(activeUploads),
        serverName,
      });
      client.welcomed = true;
    };
    welcome().catch(() => webSocket.close(4004, 'Room unavailable'));

    webSocket.on('pong', () => {
      client.isAlive = true;
    });

    webSocket.on('message', async (buffer, isBinary) => {
      if (isBinary) return socketError(webSocket, '不支持二进制聊天消息');
      try {
        rooms.assertActive(room);
        if (!clients.has(client) || !client.welcomed) {
          throw new HttpError(409, '房间正在准备，请重新连接', 'ROOM_NOT_READY');
        }
        const payload = JSON.parse(buffer.toString('utf8'));
        if (!payload || typeof payload.type !== 'string') {
          throw new HttpError(400, '消息格式无效', 'INVALID_SOCKET_MESSAGE');
        }

        if (payload.type === 'join') {
          clearTimeout(joinTimeout);
          const firstJoin = !client.ready;
          const alreadyOnline = readyClients(clients).some((online) => online.id === client.id);
          if (firstJoin) {
            let session = room.deviceSessions.get(client.id);
            if (!session) {
              session = { active: true };
              room.deviceSessions.set(client.id, session);
            }
            client.deviceSession = session;
          }
          client.name = normalizeUserName(payload.name);
          client.ready = true;
          sendSocket(webSocket, { type: 'room', room: publicRoom(room), isOwner: rooms.isOwner(room, payload.ownerToken) });
          broadcastPresence(clients, Boolean(room.id));
          if (firstJoin && !alreadyOnline) {
            broadcast(clients, {
              type: 'message',
              message: {
                id: crypto.randomUUID(),
                kind: 'online',
                sender: publicSender(client),
                createdAt: new Date().toISOString(),
              },
            });
          }
          return;
        }

        if (!client.ready) {
          throw new HttpError(400, '请先设置昵称', 'NOT_JOINED');
        }

        if (payload.type === 'chat') {
          const deviceSession = client.deviceSession;
          const message = {
            id: crypto.randomUUID(),
            kind: 'text',
            sender: publicSender(client),
            text: normalizeChatText(payload.text),
            createdAt: new Date().toISOString(),
          };
          try {
            await rooms.run(room, () => dailyMessageLimit.run(client.id, () => {
              assertDeviceSession(deviceSession);
              return chatStore.add(message);
            }));
            rooms.assertActive(room);
            assertDeviceSession(deviceSession);
          } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            sendSocket(webSocket, {
              type: 'error', code: error.code, status: error.status, message: error.message,
              chatQuota: dailyMessageLimit.status(client.id), text: message.text,
            });
            return;
          }
          broadcastQuota(client.id);
          broadcast(clients, { type: 'message', message });
          return;
        }

        if (payload.type === 'chatQuota') {
          sendSocket(webSocket, { type: 'chatQuota', chatQuota: dailyMessageLimit.status(client.id) });
          return;
        }

        if (payload.type === 'typing') {
          broadcast(clients, {
            type: 'typing',
            clientId: client.id,
            name: client.name,
            active: Boolean(payload.active),
          }, client);
          return;
        }

        throw new HttpError(400, '未知消息类型', 'UNKNOWN_SOCKET_MESSAGE');
      } catch (error) {
        socketError(
          webSocket,
          error instanceof HttpError ? error.message : '消息格式无效',
          error instanceof HttpError ? error.code : undefined,
        );
      }
    });

    const removeClient = () => {
      clearTimeout(joinTimeout);
      allClients.delete(client);
      if (!clients.delete(client)) return;
      if (room.destroyed || stopping) return;
      broadcastPresence(clients, Boolean(room.id));
      if (client.ready && !readyClients(clients).some((online) => online.id === client.id)) {
        client.deviceSession.active = false;
        room.deviceSessions.delete(client.id);
        for (const upload of activeUploads.values()) {
          if (upload.deviceSession === client.deviceSession) upload.request.destroy();
        }
        const removal = rooms.run(room, async () => {
          const messageIds = await chatStore.removeBySender(client.id);
          if (!room.destroyed && messageIds.length > 0) {
            broadcast(clients, { type: 'messagesRemoved', messageIds });
          }
        });
        room.pendingMessageRemovals.add(removal);
        removal.finally(() => room.pendingMessageRemovals.delete(removal)).catch((error) => {
          if (room.destroyed) return;
          console.error('清理离开成员的聊天记录失败:', error.message);
          broadcast(clients, { type: 'error', code: 'MESSAGE_CLEANUP_FAILED', message: '离开成员的消息清理失败，请稍后重试' });
        });
        broadcast(clients, {
          type: 'message',
          message: {
            id: crypto.randomUUID(),
            kind: 'offline',
            sender: publicSender(client),
            createdAt: new Date().toISOString(),
          },
        });
      }
    };
    webSocket.on('close', removeClient);
    webSocket.on('error', removeClient);
  });

  const heartbeat = setInterval(() => {
    for (const client of allClients) {
      if (!client.isAlive) {
        client.webSocket.terminate();
        continue;
      }
      client.isAlive = false;
      client.webSocket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    server,
    wss,
    fileStore,
    async start() {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
      return server.address();
    },
    async stop() {
      stopping = true;
      clearInterval(heartbeat);
      for (const room of rooms.all()) clearTimeout(room.uploadBroadcastTimer);
      for (const client of allClients) client.webSocket.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
      await Promise.allSettled(rooms.all().flatMap((room) => [...room.operations]));
    },
  };
}

function publicSender(client) {
  return { id: client.id, name: client.name, ip: client.ip };
}

function assertDeviceSession(session) {
  if (session && !session.active) {
    throw new HttpError(409, '已离开房间，请重新进入后发送', 'ROOM_LEFT');
  }
}

function normalizeDeviceId(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{8,80}$/iu.test(value)
    ? value
    : crypto.randomUUID();
}

function publicFile(file, roomId = '') {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    sha256: file.sha256,
    createdAt: file.createdAt,
    sender: file.sender,
    downloadUrl: `${roomId ? `/api/rooms/${roomId}` : '/api'}/files/${file.id}/download`,
  };
}

function publicActiveUploads(activeUploads) {
  return Array.from(activeUploads.values())
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .map((upload) => ({
      id: upload.id,
      name: upload.name,
      totalBytes: upload.totalBytes,
      receivedBytes: upload.receivedBytes,
      sender: structuredClone(upload.sender),
      startedAt: upload.startedAt,
    }));
}

function readyClients(clients) {
  return Array.from(clients).filter((client) => client.ready);
}

function uniqueClients(clients) {
  return [...new Map(clients.map((client) => [client.id, client])).values()];
}

function broadcastPresence(clients, byDevice = false) {
  const online = byDevice ? uniqueClients(readyClients(clients)) : readyClients(clients);
  broadcast(clients, {
    type: 'presence',
    count: online.length,
    users: online.map(publicSender),
  });
}

function broadcast(clients, payload, excludedClient = null) {
  const encoded = JSON.stringify(payload);
  for (const client of clients) {
    if (client !== excludedClient && client.welcomed && client.webSocket.readyState === WebSocket.OPEN) {
      try {
        client.webSocket.send(encoded);
      } catch {
        client.webSocket.terminate();
      }
    }
  }
}

function sendSocket(webSocket, payload) {
  if (webSocket.readyState === WebSocket.OPEN) {
    try {
      webSocket.send(JSON.stringify(payload));
    } catch {
      webSocket.terminate();
    }
  }
}

function normalizeUploadId(value) {
  if (value === undefined || value === null || value === '') return crypto.randomUUID();
  if (typeof value !== 'string' || !/^[a-z0-9_-]{8,80}$/iu.test(value)) {
    throw new HttpError(400, '上传任务编号无效', 'INVALID_UPLOAD_ID');
  }
  return value;
}

function parseUploadSize(contentLength, advertisedSize) {
  return parseNonNegativeInteger(contentLength) ?? parseNonNegativeInteger(advertisedSize);
}

function parseNonNegativeInteger(value) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function socketError(webSocket, message, code) {
  sendSocket(webSocket, { type: 'error', message, code });
}

function assertSameOrigin(request) {
  const origin = singleHeader(request.headers.origin);
  const host = singleHeader(request.headers.host);
  if (!origin || !host) throw new HttpError(403, '请求来源无效', 'INVALID_ORIGIN');

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, '请求来源无效', 'INVALID_ORIGIN');
  }
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.host !== host) {
    throw new HttpError(403, '请求来源无效', 'INVALID_ORIGIN');
  }
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function ownerToken(request) {
  const authorization = singleHeader(request.headers.authorization) || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

async function readRoomRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8192) throw new HttpError(413, '创建请求过大', 'INVALID_ROOM_REQUEST');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '创建请求格式无效', 'INVALID_ROOM_REQUEST');
  }
}

async function serveDownload(request, response, fileStore, rawId) {
  const id = rawId;
  if (!FILE_ID_PATTERN.test(id)) throw new HttpError(404, '文件不存在', 'FILE_NOT_FOUND');
  const file = fileStore.get(id);
  if (!file) throw new HttpError(404, '文件不存在', 'FILE_NOT_FOUND');

  let range;
  try {
    range = parseByteRange(singleHeader(request.headers.range), file.size);
  } catch (error) {
    response.setHeader('Content-Range', `bytes */${file.size}`);
    throw error;
  }

  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  response.setHeader('Content-Disposition', contentDisposition(file.name));
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('ETag', `"${file.sha256}"`);

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, file.size - 1);
  const contentLength = range ? end - start + 1 : file.size;
  if (range) {
    response.statusCode = 206;
    response.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
  } else {
    response.statusCode = 200;
  }
  response.setHeader('Content-Length', contentLength);

  if (request.method === 'HEAD' || file.size === 0) return response.end();

  const stream = fs.createReadStream(fileStore.pathFor(id), { start, end });
  response.once('close', () => stream.destroy());
  stream.on('error', (error) => {
    if (!response.headersSent) handleHttpError(error, response);
    else response.destroy(error);
  });
  stream.pipe(response);
}

async function serveStatic(request, response, publicDir, [relativePath, contentType]) {
  const filePath = path.join(publicDir, relativePath);
  const stat = await fsp.stat(filePath);
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', stat.size);
  response.setHeader('Cache-Control', relativePath.startsWith('vendor/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache');
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(filePath).pipe(response);
}

function applySecurityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function handleHttpError(error, response) {
  if (response.writableEnded || response.destroyed) return;
  if (error instanceof HttpError) {
    return sendJson(response, error.status === 499 ? 400 : error.status, {
      error: error.code,
      message: error.message,
    });
  }
  if (error.code === 'ENOENT') {
    return sendJson(response, 404, { error: 'NOT_FOUND', message: '页面不存在' });
  }
  console.error('请求处理失败:', error);
  return sendJson(response, 500, { error: 'INTERNAL_ERROR', message: '服务器处理失败' });
}

function getLanAddresses(port) {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
        addresses.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return [...new Set(addresses)];
}

module.exports = { createLanDropServer, getLanAddresses };
