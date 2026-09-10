'use strict';

const { TextDecoder } = require('node:util');

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function decodeFileName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1400) {
    throw new HttpError(400, '文件名无效', 'INVALID_FILE_NAME');
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64url'));
  } catch {
    throw new HttpError(400, '文件名无效', 'INVALID_FILE_NAME');
  }

  const name = decoded.normalize('NFC');
  const byteLength = Buffer.byteLength(name, 'utf8');
  if (
    name.length === 0
    || name.length > 240
    || byteLength > 700
    || name === '.'
    || name === '..'
    || /[\u0000-\u001f\u007f/\\]/u.test(name)
  ) {
    throw new HttpError(400, '文件名无效', 'INVALID_FILE_NAME');
  }

  return name;
}

function normalizeUserName(value) {
  if (typeof value !== 'string') return '访客';
  const normalized = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return Array.from(normalized).slice(0, 24).join('') || '访客';
}

function normalizeChatText(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, '消息内容无效', 'INVALID_MESSAGE');
  }

  const normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (normalized.length === 0 || normalized.length > 2000) {
    throw new HttpError(400, '消息需为 1 到 2000 个字符', 'INVALID_MESSAGE');
  }
  return normalized;
}

function normalizeMimeType(value) {
  if (typeof value !== 'string' || value.length > 120) return 'application/octet-stream';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value)
    ? value.toLowerCase()
    : 'application/octet-stream';
}

function parseByteRange(header, size) {
  if (!header) return null;
  if (!Number.isSafeInteger(size) || size < 0 || !header.startsWith('bytes=')) {
    throw new HttpError(416, '请求的文件范围无效', 'INVALID_RANGE');
  }

  const expression = header.slice(6).trim();
  if (expression.includes(',')) {
    throw new HttpError(416, '不支持多个文件范围', 'MULTIPLE_RANGES');
  }

  const match = /^(\d*)-(\d*)$/u.exec(expression);
  if (!match || (!match[1] && !match[2]) || size === 0) {
    throw new HttpError(416, '请求的文件范围无效', 'INVALID_RANGE');
  }

  let start;
  let end;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new HttpError(416, '请求的文件范围无效', 'INVALID_RANGE');
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new HttpError(416, '请求的文件范围无效', 'INVALID_RANGE');
    }
  }

  if (start < 0 || start >= size || end < start) {
    throw new HttpError(416, '请求的文件范围无效', 'INVALID_RANGE');
  }

  return { start, end: Math.min(end, size - 1) };
}

function contentDisposition(fileName) {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\]/gu, '_')
    .slice(0, 180) || 'download';
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  HttpError,
  contentDisposition,
  decodeFileName,
  normalizeChatText,
  normalizeMimeType,
  normalizeUserName,
  parseByteRange,
};
