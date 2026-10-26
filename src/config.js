'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_CHAT_HISTORY_LIMIT = 20;

function validateDailyMessageLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('dailyMessageLimit 必须是非负整数，0 表示不限');
  }
  return value;
}

function validateChatHistoryLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('chatHistoryLimit 必须是正整数');
  }
  return value;
}

function validateChatStorage(value = 'json') {
  if (value !== 'json' && value !== 'redis') throw new Error('chatStorage 必须是 json 或 redis');
  return value;
}

function validateRedisOptions(url = 'redis://127.0.0.1:6380', keyPrefix = 'landrop:chat:') {
  try {
    const parsed = new URL(url);
    if (typeof url !== 'string' || !['redis:', 'rediss:'].includes(parsed.protocol)
      || !parsed.hostname || parsed.search || parsed.hash || !/^\/(?:\d+)?$/u.test(parsed.pathname || '/')
      || (parsed.port && (Number(parsed.port) < 1 || Number(parsed.port) > 65535))) throw new Error();
  } catch {
    throw new Error('redisUrl 必须是有效的 redis:// 或 rediss:// 连接地址');
  }
  if (typeof keyPrefix !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/u.test(keyPrefix)) {
    throw new Error('redisKeyPrefix 只能包含字母、数字、冒号、下划线或短横线，长度 1–100');
  }
  return { url, keyPrefix };
}

async function readConfig(filePath = path.join(__dirname, '..', 'config.json')) {
  let source;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      source = '{}';
    } else {
      throw error;
    }
  }

  let config;
  try {
    config = JSON.parse(source.replace(/^\uFEFF/u, ''));
  } catch {
    throw new Error(`配置文件不是有效的 JSON: ${filePath}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`配置文件必须是 JSON 对象: ${filePath}`);
  }

  return {
    dailyMessageLimit: validateDailyMessageLimit(
      Object.hasOwn(config, 'dailyMessageLimit') ? config.dailyMessageLimit : 0,
    ),
    chatHistoryLimit: validateChatHistoryLimit(
      Object.hasOwn(config, 'chatHistoryLimit') ? config.chatHistoryLimit : DEFAULT_CHAT_HISTORY_LIMIT,
    ),
    chatStorage: validateChatStorage(config.chatStorage),
    redis: validateRedisOptions(process.env.LANDROP_REDIS_URL || config.redisUrl, config.redisKeyPrefix),
  };
}

module.exports = { DEFAULT_CHAT_HISTORY_LIMIT, readConfig, validateChatHistoryLimit, validateDailyMessageLimit, validateChatStorage, validateRedisOptions };
