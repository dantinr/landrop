'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./json-store');
const { ChatStore } = require('./chat-store');
const { FileStore } = require('./file-store');
const { HttpError } = require('./validation');

const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{32}$/u;

class RoomStore {
  constructor(dataDir, chatHistoryLimit) {
    this.dataDir = dataDir;
    this.roomsDir = path.join(dataDir, 'rooms');
    this.chatHistoryLimit = chatHistoryLimit;
    this.rooms = new Map();
  }

  async init() {
    this.publicRoom = await this.initialize({ id: '', name: '公共房间', capacity: null }, this.dataDir);
    await fs.mkdir(this.roomsDir, { recursive: true });
    for (const entry of await fs.readdir(this.roomsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ROOM_ID_PATTERN.test(entry.name)) continue;
      const directory = path.join(this.roomsDir, entry.name);
      const metadata = await new JsonStore(path.join(directory, 'room.json'), null).read();
      if (!metadata) continue;
      if (metadata.destroyed) {
        await fs.rm(directory, { recursive: true, force: true });
        continue;
      }
      if (metadata.id !== entry.name || !/^[a-f0-9]{64}$/u.test(metadata.ownerHash || '')) {
        throw new Error(`聊天室元数据无效: ${entry.name}`);
      }
      validateRoom(metadata);
      this.rooms.set(metadata.id, await this.initialize(metadata, directory));
    }
  }

  async initialize(metadata, directory) {
    const room = {
      ...metadata, directory, destroyed: false,
      clients: new Set(), activeUploads: new Map(), operations: new Set(),
      responses: new Map(), uploadBroadcastTimer: null,
      metadata: new JsonStore(path.join(directory, 'room.json'), null),
      fileStore: new FileStore(directory),
      chatStore: new ChatStore(directory, this.chatHistoryLimit),
    };
    await Promise.all([room.fileStore.init(), room.chatStore.init()]);
    return room;
  }

  get(id = '') {
    const room = id ? this.rooms.get(id) : this.publicRoom;
    this.assertActive(room);
    return room;
  }

  assertActive(room) {
    if (!room || room.destroyed) {
      throw new HttpError(404, '聊天室不存在或已被销毁', 'ROOM_NOT_FOUND');
    }
  }

  async create(input) {
    const { name, capacity } = validateRoom(input);
    const id = crypto.randomBytes(24).toString('base64url');
    const ownerToken = crypto.randomBytes(32).toString('base64url');
    const metadata = { id, name, capacity, ownerHash: hashToken(ownerToken), createdAt: new Date().toISOString() };
    const directory = path.join(this.roomsDir, id);
    await new JsonStore(path.join(directory, 'room.json'), null).write(metadata);
    const room = await this.initialize(metadata, directory);
    this.rooms.set(id, room);
    return { room: publicRoom(room), ownerToken };
  }

  run(room, action) {
    this.assertActive(room);
    const operation = Promise.resolve().then(() => {
      this.assertActive(room);
      return action();
    });
    room.operations.add(operation);
    operation.finally(() => room.operations.delete(operation)).catch(() => {});
    return operation;
  }

  async destroy(id, ownerToken, onDestroy) {
    const room = this.get(id);
    if (!id || !this.isOwner(room, ownerToken)) {
      throw new HttpError(403, '只有房主可以销毁聊天室', 'ROOM_OWNER_REQUIRED');
    }
    // Revoke admission synchronously, then persist a tombstone before deleting any data.
    room.destroyed = true;
    try {
      await room.metadata.write({
        id: room.id, name: room.name, capacity: room.capacity,
        ownerHash: room.ownerHash, createdAt: room.createdAt, destroyed: true,
      });
    } catch (error) {
      room.destroyed = false;
      throw error;
    }
    onDestroy(room);
    await Promise.allSettled([...room.operations]);
    await fs.rm(room.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    this.rooms.delete(id);
  }

  isOwner(room, token) {
    if (!room.id || typeof token !== 'string' || token.length !== 43) return false;
    return crypto.timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(room.ownerHash, 'hex'));
  }

  all() {
    return [this.publicRoom, ...this.rooms.values()];
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function validateRoom(input) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40
    || /[\u0000-\u001f\u007f]/u.test(input.name)) {
    throw new HttpError(400, '聊天室名称须为 1–40 个字符', 'INVALID_ROOM_NAME');
  }
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 1) {
    throw new HttpError(400, '人数上限须为正整数（包含房主）', 'INVALID_ROOM_CAPACITY');
  }
  return { name: input.name.trim(), capacity: input.capacity };
}

function publicRoom(room) {
  return { id: room.id, name: room.name, capacity: room.capacity, invitePath: room.id ? `/?room=${room.id}` : '/' };
}

module.exports = { RoomStore, publicRoom };
