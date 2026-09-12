'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { ChatStore } = require('./chat-store');
const { FileStore, FILE_ID_PATTERN } = require('./file-store');
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
  const fileStore = new FileStore(dataDir);
  const chatStore = new ChatStore(dataDir);
  await Promise.all([fileStore.init(), chatStore.init()]);

  const clients = new Set();
  const activeUploads = new Map();
  let uploadBroadcastTimer = null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  const broadcastUploadsNow = () => {
    if (uploadBroadcastTimer) {
      clearTimeout(uploadBroadcastTimer);
      uploadBroadcastTimer = null;
    }
    broadcast(clients, { type: 'uploads', uploads: publicActiveUploads(activeUploads) });
  };

  const scheduleUploadBroadcast = () => {
    if (uploadBroadcastTimer) return;
    uploadBroadcastTimer = setTimeout(() => {
      uploadBroadcastTimer = null;
      broadcast(clients, { type: 'uploads', uploads: publicActiveUploads(activeUploads) });
    }, 250);
    uploadBroadcastTimer.unref();
  };

  const server = http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      const requestUrl = new URL(request.url, 'http://landrop.local');

      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        return sendJson(response, 200, {
          serverName,
          onlineCount: readyClients(clients).length,
          availableBytes: await fileStore.availableBytes(),
        });
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/files') {
        return sendJson(response, 200, { files: fileStore.list().map(publicFile) });
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/files') {
        assertSameOrigin(request);
        const fileName = decodeFileName(singleHeader(request.headers['x-file-name']));
        const mimeType = normalizeMimeType(singleHeader(request.headers['x-file-type']));
        const uploadId = normalizeUploadId(singleHeader(request.headers['x-upload-id']));
        const totalBytes = parseUploadSize(
          singleHeader(request.headers['content-length']),
          singleHeader(request.headers['x-file-size']),
        );
        if (activeUploads.has(uploadId)) {
          throw new HttpError(409, '上传任务编号重复', 'DUPLICATE_UPLOAD_ID');
        }
        const claimedClientId = singleHeader(request.headers['x-client-id']);
        const connectedClient = Array.from(clients).find((client) => client.id === claimedClientId);
        const sender = connectedClient
          ? publicSender(connectedClient)
          : {
              id: typeof claimedClientId === 'string' ? claimedClientId.slice(0, 80) : crypto.randomUUID(),
              name: normalizeUserName(singleHeader(request.headers['x-client-name'])),
              ip: remoteAddress(request),
            };
        const activeUpload = {
          id: uploadId,
          name: fileName,
          totalBytes,
          receivedBytes: 0,
          sender,
          startedAt: new Date().toISOString(),
        };
        activeUploads.set(uploadId, activeUpload);
        broadcastUploadsNow();

        try {
          const file = await fileStore.receive(
            request,
            { fileName, mimeType, sender },
            (receivedBytes) => {
              activeUpload.receivedBytes = receivedBytes;
              scheduleUploadBroadcast();
            },
          );
          activeUpload.receivedBytes = file.size;
          activeUpload.totalBytes = file.size;
          const message = {
            id: crypto.randomUUID(),
            kind: 'file',
            sender,
            file: publicFile(file),
            createdAt: file.createdAt,
          };

          await chatStore.add(message).catch((error) => {
            console.error('保存聊天记录失败:', error.message);
          });
          broadcast(clients, { type: 'message', message });
          return sendJson(response, 201, { file: publicFile(file), message });
        } finally {
          if (activeUploads.get(uploadId) === activeUpload) activeUploads.delete(uploadId);
          broadcastUploadsNow();
        }
      }

      const downloadMatch = /^\/api\/files\/([^/]+)\/download$/u.exec(requestUrl.pathname);
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
    const client = {
      id: normalizeDeviceId(requestUrl.searchParams.get('deviceId')),
      name: '访客',
      ip: remoteAddress(request),
      ready: false,
      isAlive: true,
      webSocket,
    };
    clients.add(client);

    sendSocket(webSocket, {
      type: 'welcome',
      clientId: client.id,
      history: chatStore.list(),
      files: fileStore.list().map(publicFile),
      uploads: publicActiveUploads(activeUploads),
      serverName,
    });

    webSocket.on('pong', () => {
      client.isAlive = true;
    });

    webSocket.on('message', async (buffer, isBinary) => {
      if (isBinary) return socketError(webSocket, '不支持二进制聊天消息');
      try {
        const payload = JSON.parse(buffer.toString('utf8'));
        if (!payload || typeof payload.type !== 'string') {
          throw new HttpError(400, '消息格式无效', 'INVALID_SOCKET_MESSAGE');
        }

        if (payload.type === 'join') {
          client.name = normalizeUserName(payload.name);
          client.ready = true;
          broadcastPresence(clients);
          return;
        }

        if (!client.ready) {
          throw new HttpError(400, '请先设置昵称', 'NOT_JOINED');
        }

        if (payload.type === 'chat') {
          const message = {
            id: crypto.randomUUID(),
            kind: 'text',
            sender: publicSender(client),
            text: normalizeChatText(payload.text),
            createdAt: new Date().toISOString(),
          };
          await chatStore.add(message);
          broadcast(clients, { type: 'message', message });
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
        socketError(webSocket, error instanceof HttpError ? error.message : '消息格式无效');
      }
    });

    const removeClient = () => {
      if (!clients.delete(client)) return;
      broadcastPresence(clients);
    };
    webSocket.on('close', removeClient);
    webSocket.on('error', removeClient);
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
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
      clearInterval(heartbeat);
      clearTimeout(uploadBroadcastTimer);
      uploadBroadcastTimer = null;
      for (const client of clients) client.webSocket.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function publicSender(client) {
  return { id: client.id, name: client.name, ip: client.ip };
}

function remoteAddress(request) {
  let address = request.socket?.remoteAddress || '';
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (address === '::1') return '127.0.0.1';
  const scopeIndex = address.indexOf('%');
  return scopeIndex === -1 ? address : address.slice(0, scopeIndex);
}

function normalizeDeviceId(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{8,80}$/iu.test(value)
    ? value
    : crypto.randomUUID();
}

function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    sha256: file.sha256,
    createdAt: file.createdAt,
    sender: file.sender,
    downloadUrl: `/api/files/${file.id}/download`,
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

function broadcastPresence(clients) {
  const online = readyClients(clients);
  broadcast(clients, {
    type: 'presence',
    count: online.length,
    users: online.map(publicSender),
  });
}

function broadcast(clients, payload, excludedClient = null) {
  const encoded = JSON.stringify(payload);
  for (const client of clients) {
    if (client !== excludedClient && client.webSocket.readyState === WebSocket.OPEN) {
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

function socketError(webSocket, message) {
  sendSocket(webSocket, { type: 'error', message });
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
