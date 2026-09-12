'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./json-store');
const { HttpError } = require('./validation');

const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class FileStore {
  constructor(dataDir) {
    this.filesDir = path.join(dataDir, 'files');
    this.tempDir = path.join(dataDir, 'uploads');
    this.files = new Map();
    this.index = new JsonStore(path.join(dataDir, 'files.json'), []);
    this.commitQueue = Promise.resolve();
  }

  async init() {
    await Promise.all([
      fsp.mkdir(this.filesDir, { recursive: true }),
      fsp.mkdir(this.tempDir, { recursive: true }),
    ]);
    await this.#clearInterruptedUploads();

    const records = await this.index.read();
    const validRecords = [];
    if (Array.isArray(records)) {
      for (const record of records) {
        if (!isFileRecord(record)) continue;
        try {
          const stat = await fsp.stat(this.pathFor(record.id));
          if (!stat.isFile() || stat.size !== record.size) continue;
          this.files.set(record.id, record);
          validRecords.push(record);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }

    if (!Array.isArray(records) || validRecords.length !== records.length) {
      await this.index.write(validRecords);
    }
  }

  list() {
    return Array.from(this.files.values())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => structuredClone(record));
  }

  get(id) {
    if (!FILE_ID_PATTERN.test(id)) return null;
    const record = this.files.get(id);
    return record ? structuredClone(record) : null;
  }

  pathFor(id) {
    if (!FILE_ID_PATTERN.test(id)) {
      throw new HttpError(404, '文件不存在', 'FILE_NOT_FOUND');
    }
    return path.join(this.filesDir, `${id}.blob`);
  }

  async availableBytes() {
    try {
      const stat = await fsp.statfs(this.filesDir);
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  }

  async receive(request, details, onProgress = null) {
    const id = crypto.randomUUID();
    const temporaryPath = path.join(this.tempDir, `${id}.part`);
    const finalPath = this.pathFor(id);
    const hash = crypto.createHash('sha256');
    let bytesWritten = 0;
    let published = false;
    let handle;

    try {
      handle = await fsp.open(temporaryPath, 'wx');
      for await (const chunk of request) {
        await writeAll(handle, chunk);
        bytesWritten += chunk.length;
        hash.update(chunk);
        if (typeof onProgress === 'function') onProgress(bytesWritten);
      }

      if (request.aborted) {
        throw new HttpError(499, '上传已中断', 'UPLOAD_ABORTED');
      }

      await handle.close();
      handle = null;
      const record = {
        id,
        name: details.fileName,
        size: bytesWritten,
        mimeType: details.mimeType,
        sha256: hash.digest('hex'),
        createdAt: new Date().toISOString(),
        sender: structuredClone(details.sender),
      };

      const commit = this.commitQueue.then(async () => {
        const nextRecords = [...this.files.values(), record]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        await this.index.write(nextRecords);
        try {
          await fsp.rename(temporaryPath, finalPath);
        } catch (error) {
          await this.index.write(this.list()).catch(() => {});
          throw error;
        }
        published = true;
        this.files.set(id, record);
      });
      this.commitQueue = commit.catch(() => {});
      await commit;
      return structuredClone(record);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fsp.unlink(temporaryPath).catch(() => {});
      if (published) await fsp.unlink(finalPath).catch(() => {});
      throw error;
    }
  }

  async #clearInterruptedUploads() {
    const entries = await fsp.readdir(this.tempDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.part'))
      .map((entry) => fsp.unlink(path.join(this.tempDir, entry.name)).catch(() => {})));
  }
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset);
    if (result.bytesWritten <= 0) throw new Error('Unable to write upload data');
    offset += result.bytesWritten;
  }
}

function isFileRecord(record) {
  return Boolean(
    record
    && typeof record === 'object'
    && typeof record.id === 'string'
    && FILE_ID_PATTERN.test(record.id)
    && typeof record.name === 'string'
    && Number.isSafeInteger(record.size)
    && record.size >= 0
    && typeof record.mimeType === 'string'
    && typeof record.sha256 === 'string'
    && typeof record.createdAt === 'string',
  );
}

module.exports = { FILE_ID_PATTERN, FileStore };
