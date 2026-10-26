'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function validateDailyMessageLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('dailyMessageLimit 必须是非负整数，0 表示不限');
  }
  return value;
}

async function readConfig(filePath = path.join(__dirname, '..', 'config.json')) {
  let source;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { dailyMessageLimit: 0 };
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
  };
}

module.exports = { readConfig, validateDailyMessageLimit };
