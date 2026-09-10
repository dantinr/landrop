'use strict';

const path = require('node:path');
const { JsonStore } = require('./json-store');

class ChatStore {
  constructor(dataDir, limit = 200) {
    this.limit = limit;
    this.messages = [];
    this.store = new JsonStore(path.join(dataDir, 'messages.json'), []);
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    const stored = await this.store.read();
    this.messages = Array.isArray(stored)
      ? stored.filter(isStoredMessage).slice(-this.limit)
      : [];
  }

  list() {
    return this.messages.map((message) => structuredClone(message));
  }

  add(message) {
    const operation = this.mutationQueue.then(async () => {
      const nextMessages = [...this.messages, structuredClone(message)].slice(-this.limit);
      await this.store.write(nextMessages);
      this.messages = nextMessages;
      return message;
    });
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }
}

function isStoredMessage(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && typeof message.id === 'string'
    && (message.kind === 'text' || message.kind === 'file')
    && typeof message.createdAt === 'string',
  );
}

module.exports = { ChatStore };
