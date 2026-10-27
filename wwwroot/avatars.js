'use strict';

// Shared by Node.js and the browser so older messages receive the same default.
((root) => {
  const choices = Object.freeze([
    { id: 'rat', name: '鼠', emoji: '🐭' },
    { id: 'ox', name: '牛', emoji: '🐮' },
    { id: 'tiger', name: '虎', emoji: '🐯' },
    { id: 'rabbit', name: '兔', emoji: '🐰' },
    { id: 'dragon', name: '龙', emoji: '🐲' },
    { id: 'snake', name: '蛇', emoji: '🐍' },
    { id: 'horse', name: '马', emoji: '🐴' },
    { id: 'goat', name: '羊', emoji: '🐑' },
    { id: 'monkey', name: '猴', emoji: '🐵' },
    { id: 'rooster', name: '鸡', emoji: '🐔' },
    { id: 'dog', name: '狗', emoji: '🐶' },
    { id: 'pig', name: '猪', emoji: '🐷' },
  ].map(Object.freeze));

  function isValid(value) {
    return choices.some((choice) => choice.id === value);
  }

  function normalize(value, deviceId = '') {
    if (isValid(value)) return value;
    let hash = 0;
    for (const character of String(deviceId)) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
    return choices[hash % choices.length].id;
  }

  const avatars = Object.freeze({ choices, isValid, normalize });
  if (typeof module === 'object' && module.exports) module.exports = avatars;
  else root.LanDropAvatars = avatars;
})(globalThis);
