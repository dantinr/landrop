'use strict';

const path = require('node:path');
const { JsonStore } = require('./json-store');
const { DEFAULT_CHAT_HISTORY_LIMIT, validateChatHistoryLimit } = require('./config');

class ChatStore {
  constructor(dataDir, limit = DEFAULT_CHAT_HISTORY_LIMIT) {
    this.limit = validateChatHistoryLimit(limit);
    this.messages = [];
    this.store = new JsonStore(path.join(dataDir, 'messages.json'), []);
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    const stored = await this.store.read();
    const messages = Array.isArray(stored)
      ? stored.filter(isStoredMessage).slice(-this.limit)
      : [];
    if (!Array.isArray(stored) || messages.length !== stored.length) {
      await this.store.write(messages);
    }
    this.messages = messages;
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

  removeBySender(senderId) {
    const operation = this.mutationQueue.then(async () => {
      const removed = this.messages.filter((message) => message.sender?.id === senderId);
      if (removed.length === 0) return [];
      const nextMessages = this.messages.filter((message) => message.sender?.id !== senderId);
      await this.store.write(nextMessages);
      this.messages = nextMessages;
      return removed.map((message) => message.id);
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
