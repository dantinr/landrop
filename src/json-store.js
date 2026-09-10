'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class JsonStore {
  constructor(filePath, fallbackValue) {
    this.filePath = filePath;
    this.fallbackValue = fallbackValue;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      const source = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(source);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return structuredClone(this.fallbackValue);
      }
      throw error;
    }
  }

  write(value) {
    const snapshot = JSON.stringify(value, null, 2);
    const operation = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, snapshot, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporaryPath, this.filePath);
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { JsonStore };
