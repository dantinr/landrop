'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./json-store');
const { HttpError } = require('./validation');

const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_STORED_NAME_LENGTH = 240;
const MAX_STORED_NAME_BYTES = 240;
const INVALID_WINDOWS_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/gu;
const HAS_INVALID_WINDOWS_NAME_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

class FileStore {
  constructor(dataDir) {
    this.legacyFilesDir = path.join(dataDir, 'files');
    this.uploadsDir = path.join(dataDir, 'uploads');
    this.tempDir = path.join(dataDir, 'incoming');
    this.files = new Map();
    this.paths = new Map();
    this.index = new JsonStore(path.join(dataDir, 'files.json'), []);
    this.commitQueue = Promise.resolve();
  }

  async init() {
    await Promise.all([
      fsp.mkdir(this.legacyFilesDir, { recursive: true }),
      fsp.mkdir(this.uploadsDir, { recursive: true }),
      fsp.mkdir(this.tempDir, { recursive: true }),
    ]);
    await Promise.all([
      this.#clearInterruptedUploads(this.tempDir),
      this.#clearInterruptedUploads(this.uploadsDir),
    ]);

    const records = await this.index.read();
    const validRecords = [];
    const claimedPaths = new Set();
    this.files.clear();
    this.paths.clear();
    if (Array.isArray(records)) {
      for (const record of records) {
        if (!isFileRecord(record)) continue;
        const filePath = await this.#findExistingPath(record, claimedPaths);
        if (!filePath) continue;
        this.files.set(record.id, record);
        this.paths.set(record.id, filePath);
        validRecords.push(record);
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
    const record = this.files.get(id);
    if (!record) throw new HttpError(404, '文件不存在', 'FILE_NOT_FOUND');
    const filePath = this.paths.get(id);
    if (!filePath) throw new HttpError(404, '文件不存在', 'FILE_NOT_FOUND');
    return filePath;
  }

  async availableBytes() {
    try {
      const stat = await fsp.statfs(this.uploadsDir);
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  }

  async receive(request, details, onProgress = null) {
    const id = crypto.randomUUID();
    const temporaryPath = path.join(this.tempDir, `${id}.part`);
    const hash = crypto.createHash('sha256');
    let bytesWritten = 0;
    let finalPath;
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
      const pendingRecord = {
        id,
        name: details.fileName,
        size: bytesWritten,
        mimeType: details.mimeType,
        sha256: hash.digest('hex'),
        createdAt: new Date().toISOString(),
        sender: structuredClone(details.sender),
      };

      const commit = this.commitQueue.then(async () => {
        let record;
        while (true) {
          const storedName = await this.#nextStoredName(details.fileName, details.sender?.ip);
          record = { ...pendingRecord, storedName };
          finalPath = this.#pathForRecord(record);
          try {
            await publishFileExclusive(temporaryPath, finalPath);
            break;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }

        const nextRecords = [...this.files.values(), record]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        try {
          await this.index.write(nextRecords);
        } catch (error) {
          await fsp.unlink(finalPath).catch(() => {});
          throw error;
        }
        await fsp.unlink(temporaryPath).catch(() => {});
        this.files.set(id, record);
        this.paths.set(id, finalPath);
        return record;
      });
      this.commitQueue = commit.catch(() => {});
      return structuredClone(await commit);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fsp.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  #pathForRecord(record) {
    if (record.storedName) return path.join(this.uploadsDir, record.storedName);
    return path.join(this.legacyFilesDir, `${record.id}.blob`);
  }

  async #findExistingPath(record, claimedPaths) {
    const candidates = [{ filePath: this.#pathForRecord(record), verifyHash: false }];
    if (!record.storedName && isSafeLegacyFileName(record.name)) {
      candidates.push({
        filePath: path.join(this.legacyFilesDir, record.name),
        verifyHash: true,
      });
    }

    for (const candidate of candidates) {
      const key = path.resolve(candidate.filePath).toLowerCase();
      if (claimedPaths.has(key)) continue;
      try {
        const stat = await fsp.stat(candidate.filePath);
        if (!stat.isFile() || stat.size !== record.size) continue;
        if (candidate.verifyHash) {
          const actualHash = await sha256File(candidate.filePath);
          if (actualHash.toLowerCase() !== record.sha256.toLowerCase()) continue;
        }
        claimedPaths.add(key);
        return candidate.filePath;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  async #nextStoredName(fileName, ipAddress) {
    const occupiedNames = new Set(
      Array.from(this.files.values())
        .map((record) => record.storedName?.toLowerCase())
        .filter(Boolean),
    );
    const entries = await fsp.readdir(this.uploadsDir);
    for (const entry of entries) occupiedNames.add(entry.toLowerCase());

    for (let sequence = 1; ; sequence += 1) {
      const candidate = buildStoredName(fileName, ipAddress, sequence);
      if (!occupiedNames.has(candidate.toLowerCase())) return candidate;
    }
  }

  async #clearInterruptedUploads(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && isTemporaryFileName(entry.name))
      .map((entry) => fsp.unlink(path.join(directory, entry.name)).catch(() => {})));
  }
}

async function publishFileExclusive(sourcePath, targetPath) {
  try {
    await fsp.link(sourcePath, targetPath);
  } catch (error) {
    if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error;
    await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function buildStoredName(fileName, ipAddress, sequence) {
  let safeName = String(fileName || 'file')
    .normalize('NFC')
    .replace(INVALID_WINDOWS_NAME_CHARACTERS, '_')
    .replace(/[. ]+$/gu, '');
  if (!safeName || safeName === '.' || safeName === '..') safeName = 'file';

  const rawExtension = path.extname(safeName);
  const extension = rawExtension.length <= 32 ? rawExtension : '';
  let stem = extension ? safeName.slice(0, -extension.length) : safeName;
  stem = stem.replace(/[. ]+$/gu, '') || 'file';

  const safeIp = truncateUtf16(
    String(ipAddress || 'unknown')
      .replace(/[^a-z0-9._-]/giu, '_') || 'unknown',
    64,
  );
  const collision = sequence > 1 ? ` (${sequence})` : '';
  const suffix = `[${safeIp}]${collision}${extension}`;
  const maxStemLength = Math.max(1, MAX_STORED_NAME_LENGTH - suffix.length);
  const maxStemBytes = Math.max(1, MAX_STORED_NAME_BYTES - Buffer.byteLength(suffix));
  stem = truncateFileComponent(stem, maxStemLength, maxStemBytes)
    .replace(/[. ]+$/gu, '') || 'f';
  return `${stem}${suffix}`;
}

function truncateUtf16(value, maxLength) {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

function truncateFileComponent(value, maxLength, maxBytes) {
  let result = '';
  for (const character of value) {
    if (
      result.length + character.length > maxLength
      || Buffer.byteLength(result + character) > maxBytes
    ) break;
    result += character;
  }
  return result;
}

function isTemporaryFileName(name) {
  return name.endsWith('.part') && FILE_ID_PATTERN.test(name.slice(0, -'.part'.length));
}

function isSafeStoredName(name) {
  return Boolean(
    typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_STORED_NAME_LENGTH
    && Buffer.byteLength(name) <= MAX_STORED_NAME_BYTES
    && path.basename(name) === name
    && path.win32.basename(name) === name
    && path.posix.basename(name) === name
    && !HAS_INVALID_WINDOWS_NAME_CHARACTER.test(name)
    && !/[. ]$/u.test(name)
    && name !== '.'
    && name !== '..'
    && !WINDOWS_DEVICE_NAME.test(name),
  );
}

function isSafeLegacyFileName(name) {
  return Boolean(
    typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_STORED_NAME_LENGTH
    && path.basename(name) === name
    && path.win32.basename(name) === name
    && path.posix.basename(name) === name
    && !HAS_INVALID_WINDOWS_NAME_CHARACTER.test(name)
    && !/[. ]$/u.test(name)
    && name !== '.'
    && name !== '..'
    && !WINDOWS_DEVICE_NAME.test(name),
  );
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
    && typeof record.createdAt === 'string'
    && (record.storedName === undefined || isSafeStoredName(record.storedName)),
  );
}

module.exports = { FILE_ID_PATTERN, FileStore };
