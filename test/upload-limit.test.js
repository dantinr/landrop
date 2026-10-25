'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createLanDropServer } = require('../src/app');
const { MAX_UPLOAD_BYTES } = require('../src/file-store');

test('恰好 20 MB 和空文件可以上传，超限声明会立即收到 413', async (context) => {
  const { baseUrl, dataDir } = await startServer(context);
  assert.equal(MAX_UPLOAD_BYTES, 20 * 1024 * 1024);
  const status = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(status.maxUploadBytes, MAX_UPLOAD_BYTES);

  const atLimit = await upload(baseUrl, { 'Content-Length': MAX_UPLOAD_BYTES }, Buffer.alloc(MAX_UPLOAD_BYTES, 0x61));
  assert.equal(atLimit.status, 201);
  assert.equal(atLimit.body.file.size, MAX_UPLOAD_BYTES);
  assert.equal((await fs.stat(path.join(dataDir, 'uploads', 'limit[127.0.0.1].bin'))).size, MAX_UPLOAD_BYTES);
  const download = await fetch(`${baseUrl}${atLimit.body.file.downloadUrl}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(download.status, 206);
  assert.equal(await download.text(), 'aaaa');

  const empty = await upload(baseUrl, { 'Content-Length': 0, 'X-File-Name': encodeName('empty.bin') });
  assert.equal(empty.status, 201);
  assert.equal(empty.body.file.size, 0);
  for (const headers of [
    { 'Content-Length': MAX_UPLOAD_BYTES + 1 },
    { 'Content-Length': '999999999999999999' },
    { 'X-File-Size': MAX_UPLOAD_BYTES + 1 },
  ]) {
    const rejected = await upload(baseUrl, headers);
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.error, 'FILE_TOO_LARGE');
    assert.equal(rejected.body.message, '单个文件不能超过 20 MB');
    assert.equal(rejected.headers.connection, 'close');
  }
  assert.equal((await (await fetch(`${baseUrl}/api/files`)).json()).files.length, 2);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'incoming')), []);
});

test('分块上传按实际字节限制，缺失或伪造大小提示不能绕过，拒绝后可重新上传', async (context) => {
  const { baseUrl, dataDir } = await startServer(context);
  const chunk = Buffer.alloc(1024 * 1024, 0x62);
  const atLimit = await upload(baseUrl, {}, Readable.from(Array(20).fill(chunk)));
  assert.equal(atLimit.status, 201);
  assert.equal(atLimit.body.file.size, MAX_UPLOAD_BYTES);

  for (const advertisedSize of [undefined, '1']) {
    const headers = { 'X-Upload-Id': 'upload-limit-reusable' };
    if (advertisedSize !== undefined) headers['X-File-Size'] = advertisedSize;
    const rejected = await upload(baseUrl, headers, Readable.from([...Array(20).fill(chunk), Buffer.from('x')]));
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.error, 'FILE_TOO_LARGE');
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'incoming')), []);
    assert.equal((await fs.readdir(path.join(dataDir, 'uploads'))).some((name) => name.endsWith('.part')), false);
    const retry = await upload(baseUrl, headers, Buffer.from('retry'));
    assert.equal(retry.status, 201);
    assert.equal(retry.body.file.size, 5);
  }
  const files = (await (await fetch(`${baseUrl}/api/files`)).json()).files;
  assert.deepEqual(files.map((file) => file.size).sort((a, b) => a - b), [5, 5, MAX_UPLOAD_BYTES]);
  const history = JSON.parse(await fs.readFile(path.join(dataDir, 'messages.json'), 'utf8'));
  assert.equal(history.length, 3);
  assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);
});

async function startServer(context) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'landrop-upload-limit-'));
  const app = await createLanDropServer({ host: '127.0.0.1', port: 0, dataDir });
  context.after(async () => {
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const address = await app.start();
  return { dataDir, baseUrl: `http://127.0.0.1:${address.port}` };
}

function encodeName(name) {
  return Buffer.from(name).toString('base64url');
}

function upload(baseUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        'X-File-Name': encodeName('limit.bin'),
        'Content-Type': 'application/octet-stream',
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks)) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (body instanceof Readable) body.on('error', reject).pipe(request);
    else request.end(body);
  });
}
