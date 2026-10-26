'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@redis/client');
const { ChatStore, isStoredMessage } = require('./chat-store');
const { DEFAULT_CHAT_HISTORY_LIMIT, validateChatStorage, validateChatHistoryLimit, validateRedisOptions } = require('./config');
const { HttpError } = require('./validation');

// The list mutation and retention window must change together, including across Redis restarts.
const APPEND = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
return 1`;

const REMOVE_SENDER = `
local rows = redis.call('LRANGE', KEYS[1], 0, -1)
local removed = {}
for _, row in ipairs(rows) do
  local ok, message = pcall(cjson.decode, row)
  if ok and type(message) == 'table' and type(message.sender) == 'table' and message.sender.id == ARGV[1] then
    redis.call('LREM', KEYS[1], 1, row)
    table.insert(removed, message.id)
  end
end
return removed`;

const IMPORT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  for i = 2, #ARGV do redis.call('RPUSH', KEYS[1], ARGV[i]) end
end
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[1]), -1)
return 1`;

class RedisChatStore {
  constructor(dataDir, limit, client, key) {
    this.limit = validateChatHistoryLimit(limit ?? DEFAULT_CHAT_HISTORY_LIMIT);
    this.legacyPath = path.join(dataDir, 'messages.json');
    this.client = client;
    this.key = key;
    this.mutationQueue = Promise.resolve();
  }

  run(action) {
    const operation = this.mutationQueue.then(action).catch(() => {
      // Redis errors may carry command arguments. Never log or expose the original error.
      throw new HttpError(503, '聊天存储暂不可用，请稍后重试', 'CHAT_STORAGE_UNAVAILABLE');
    });
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async init() {
    let legacy = null;
    try {
      legacy = JSON.parse(await fs.readFile(this.legacyPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('旧聊天历史无法读取，Redis 迁移已停止');
    }
    const messages = Array.isArray(legacy) ? legacy.filter(isStoredMessage).slice(-this.limit) : [];
    await this.run(() => this.client.eval(IMPORT, {
      keys: [this.key], arguments: [String(this.limit), ...messages.map(message => JSON.stringify(message))],
    }));
    // A missing Redis key after a restart must never re-import an obsolete disk copy.
    await fs.rm(this.legacyPath, { force: true });
  }

  list() {
    return this.run(async () => {
      const rows = await this.client.lRange(this.key, -this.limit, -1);
      return rows.map(row => JSON.parse(row)).filter(isStoredMessage);
    });
  }

  add(message) {
    const snapshot = JSON.stringify(message);
    return this.run(async () => {
      await this.client.eval(APPEND, { keys: [this.key], arguments: [snapshot, String(this.limit)] });
      return structuredClone(message);
    });
  }

  removeBySender(senderId) {
    return this.run(() => this.client.eval(REMOVE_SENDER, { keys: [this.key], arguments: [senderId] }));
  }

  clear() {
    return this.run(() => this.client.del(this.key));
  }
}

async function createChatStorage(options = {}) {
  if (validateChatStorage(options.chatStorage) === 'json') {
    return { create: (directory, limit) => new ChatStore(directory, limit), clear: async () => {}, close: () => {} };
  }
  const config = validateRedisOptions(options.redis?.url, options.redis?.keyPrefix);
  const client = createClient({
    url: config.url,
    disableOfflineQueue: true,
    disableClientInfo: true,
    commandOptions: { timeout: 5000 },
    socket: { connectTimeout: 5000, reconnectStrategy: retries => Math.min(100 * (2 ** Math.min(retries, 5)), 3000) },
  });
  client.on('error', () => {});
  let timer;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 6000); }),
    ]);
  } catch {
    if (client.isOpen) client.destroy();
    throw new Error('无法连接聊天 Redis，请检查连接配置和服务状态');
  } finally {
    clearTimeout(timer);
  }
  const key = id => `${config.keyPrefix}${id || 'public'}`;
  return {
    create: (directory, limit, id) => new RedisChatStore(directory, limit, client, key(id)),
    clear: id => client.del(key(id)),
    close: () => { if (client.isOpen) client.destroy(); },
  };
}

module.exports = { RedisChatStore, createChatStorage };
