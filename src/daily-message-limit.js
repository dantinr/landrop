'use strict';

const path = require('node:path');
const { validateDailyMessageLimit } = require('./config');
const { JsonStore } = require('./json-store');
const { HttpError } = require('./validation');

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

class DailyMessageLimit {
  constructor(dataDir, limit = 0, now = Date.now) {
    this.limit = validateDailyMessageLimit(limit);
    this.now = now;
    this.date = '';
    this.counts = new Map();
    this.store = new JsonStore(path.join(dataDir, 'chat-usage.json'), {
      date: '', counts: [],
    });
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    const stored = await this.store.read();
    if (
      !stored || typeof stored !== 'object'
      || typeof stored.date !== 'string'
      || (stored.date !== '' && !/^\d{4}-\d{2}-\d{2}$/u.test(stored.date))
      || !Array.isArray(stored.counts)
      || !stored.counts.every((entry) => Array.isArray(entry) && entry.length === 2
        && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1]) && entry[1] >= 0)
    ) {
      throw new Error('每日消息计数文件无效');
    }
    this.date = stored.date;
    this.counts = new Map(stored.counts);
  }

  status(deviceId) {
    const now = this.now();
    const date = messageDay(new Date(now));
    const used = this.date === date ? (this.counts.get(deviceId) || 0) : 0;
    const nextDay = Math.floor((now + 8 * 60 * 60 * 1000) / 86_400_000) * 86_400_000
      + 86_400_000 - 8 * 60 * 60 * 1000;
    return {
      date, limit: this.limit, used,
      remaining: this.limit === 0 ? null : Math.max(0, this.limit - used),
      resetAt: new Date(nextDay).toISOString(),
    };
  }

  async run(deviceId, send) {
    // Reserve before sending so concurrent text messages and uploads share the same cap.
    const date = await this.#queue(async () => {
      const today = messageDay(new Date(this.now()));
      const counts = this.date === today ? new Map(this.counts) : new Map();
      const count = counts.get(deviceId) || 0;
      if (this.limit > 0 && count >= this.limit) {
        throw new HttpError(429, `本设备今日发送已达 ${this.limit} 条上限，请明天再试`, 'DAILY_MESSAGE_LIMIT');
      }
      counts.set(deviceId, count + 1);
      await this.#save(today, counts);
      return today;
    });

    try {
      return await send();
    } catch (error) {
      await this.#queue(async () => {
        if (this.date !== date) return;
        const counts = new Map(this.counts);
        const count = counts.get(deviceId) || 0;
        if (count <= 1) counts.delete(deviceId);
        else counts.set(deviceId, count - 1);
        await this.#save(date, counts);
      }).catch((rollbackError) => {
        console.error('退回每日消息额度失败:', rollbackError.message);
      });
      throw error;
    }
  }

  #queue(mutate) {
    const operation = this.mutationQueue.then(mutate);
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async #save(date, counts) {
    await this.store.write({ date, counts: [...counts] });
    this.date = date;
    this.counts = counts;
  }
}

function messageDay(date = new Date()) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = { DailyMessageLimit, messageDay };
