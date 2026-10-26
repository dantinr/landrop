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

async function readConfig(filePath = path.join(__dirname, '..', 'config.json')) {
  let source;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { dailyMessageLimit: 0, chatHistoryLimit: DEFAULT_CHAT_HISTORY_LIMIT };
    }
    throw error;
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
  };
}

module.exports = { DEFAULT_CHAT_HISTORY_LIMIT, readConfig, validateChatHistoryLimit, validateDailyMessageLimit };
