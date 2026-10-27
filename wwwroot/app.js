'use strict';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const avatars = window.LanDropAvatars;

const elements = {
  connectionState: document.querySelector('#connection-state'),
  connectionLabel: document.querySelector('#connection-label'),
  onlineButton: document.querySelector('#online-button'),
  onlineCount: document.querySelector('#online-count'),
  nameInput: document.querySelector('#name-input'),
  chooseAvatar: document.querySelector('#choose-avatar'),
  currentAvatar: document.querySelector('#current-avatar'),
  avatarDialog: document.querySelector('#avatar-dialog'),
  avatarOptions: document.querySelector('#avatar-options'),
  closeAvatar: document.querySelector('#close-avatar'),
  imageViewer: document.querySelector('#image-viewer'),
  viewerImage: document.querySelector('#viewer-image'),
  viewerTitle: document.querySelector('#image-viewer-title'),
  viewerStatus: document.querySelector('#image-viewer-status'),
  viewerDownload: document.querySelector('#viewer-download'),
  closeViewer: document.querySelector('#close-viewer'),
  copyAddress: document.querySelector('#copy-address'),
  serverName: document.querySelector('#server-name'),
  appVersion: document.querySelector('#app-version'),
  roomStatus: document.querySelector('#room-status'),
  chatQuota: document.querySelector('#chat-quota'),
  historyPolicy: document.querySelector('#history-policy'),
  clearView: document.querySelector('#clear-view'),
  messages: document.querySelector('#messages'),
  chatEmpty: document.querySelector('#chat-empty'),
  typingLine: document.querySelector('#typing-line'),
  messageForm: document.querySelector('#message-form'),
  messageInput: document.querySelector('#message-input'),
  sendButton: document.querySelector('#send-button'),
  chooseFilesTop: document.querySelector('#choose-files-top'),
  chooseFiles: document.querySelector('#choose-files'),
  dropZone: document.querySelector('#drop-zone'),
  fileInput: document.querySelector('#file-input'),
  chooseImages: document.querySelector('#choose-images'),
  imageInput: document.querySelector('#image-input'),
  mobileUploadSlot: document.querySelector('#mobile-upload-slot'),
  transferPanel: document.querySelector('.transfer-panel'),
  recentSection: document.querySelector('.recent-section'),
  uploadSection: document.querySelector('#upload-section'),
  uploadSummary: document.querySelector('#upload-summary'),
  uploadList: document.querySelector('#upload-list'),
  recentFiles: document.querySelector('#file-list'),
  filesEmpty: document.querySelector('#files-empty'),
  storageLabel: document.querySelector('#storage-label'),
  refreshFiles: document.querySelector('#refresh-files'),
  peopleDialog: document.querySelector('#people-dialog'),
  peopleSummary: document.querySelector('#people-summary'),
  peopleList: document.querySelector('#people-list'),
  closePeople: document.querySelector('#close-people'),
  toastRegion: document.querySelector('#toast-region'),
  createRoom: document.querySelector('#create-room'),
  createRoomDialog: document.querySelector('#create-room-dialog'),
  closeCreateRoom: document.querySelector('#close-create-room'),
  createRoomForm: document.querySelector('#create-room-form'),
  roomName: document.querySelector('#room-name'),
  roomCapacity: document.querySelector('#room-capacity'),
  roomFormError: document.querySelector('#room-form-error'),
  submitCreateRoom: document.querySelector('#submit-create-room'),
  createdRoomLink: document.querySelector('#created-room-link'),
  inviteRoom: document.querySelector('#invite-room'),
  publicRoom: document.querySelector('#public-room'),
  destroyRoom: document.querySelector('#destroy-room'),
  destroyRoomDialog: document.querySelector('#destroy-room-dialog'),
  cancelDestroyRoom: document.querySelector('#cancel-destroy-room'),
  confirmDestroyRoom: document.querySelector('#confirm-destroy-room'),
  destroyRoomError: document.querySelector('#destroy-room-error'),
  unavailableDialog: document.querySelector('#room-unavailable-dialog'),
  unavailableMessage: document.querySelector('#room-unavailable-message'),
  retryRoom: document.querySelector('#retry-room'),
  destroyFullRoom: document.querySelector('#destroy-full-room'),
};

const state = {
  socket: null,
  deviceId: loadDeviceId(),
  avatar: null,
  clientId: null,
  connected: false,
  chatQuota: null,
  chatHistoryLimit: 20,
  quotaTimer: null,
  reconnectDelay: 800,
  reconnectTimer: null,
  nameTimer: null,
  typingTimer: null,
  typingSent: false,
  messageIds: new Set(),
  files: new Map(),
  users: [],
  typingUsers: new Map(),
  uploads: new Map(),
  networkUploads: new Map(),
  roomId: new URLSearchParams(location.search).get('room') || '',
  room: null,
  roomSession: null,
  roomUnavailable: false,
  isOwner: false,
};

const mobileChatMedia = window.matchMedia('(max-width: 900px)');

init();

function init() {
  elements.nameInput.value = loadName();
  state.avatar = avatars.normalize(localStorage.getItem('landrop-avatar'), state.deviceId);
  renderAvatarPicker();
  bindEvents();
  updateResponsiveLayout();
  refreshIcons();
  elements.inviteRoom.hidden = !state.roomId;
  elements.publicRoom.hidden = !state.roomId;
  connectSocket();
  refreshStatus();
}

function bindEvents() {
  elements.closeViewer.addEventListener('click', () => elements.imageViewer.close());
  elements.imageViewer.addEventListener('click', (event) => {
    if (event.target === elements.imageViewer || event.target.classList.contains('image-viewer-stage')) {
      elements.imageViewer.close();
    }
  });
  elements.imageViewer.addEventListener('close', () => {
    elements.viewerImage.removeAttribute('src');
    elements.viewerImage.alt = '';
    elements.viewerDownload.removeAttribute('href');
    elements.viewerTitle.textContent = '';
  });
  elements.viewerImage.addEventListener('load', () => {
    if (!elements.imageViewer.open) return;
    elements.viewerImage.hidden = false;
    elements.viewerStatus.hidden = true;
  });
  elements.viewerImage.addEventListener('error', () => {
    if (!elements.imageViewer.open) return;
    elements.viewerImage.hidden = true;
    elements.viewerStatus.textContent = '图片加载失败，可下载后查看';
    elements.viewerStatus.hidden = false;
  });
  elements.chooseAvatar.addEventListener('click', () => elements.avatarDialog.showModal());
  elements.closeAvatar.addEventListener('click', () => elements.avatarDialog.close());
  elements.avatarDialog.addEventListener('click', (event) => {
    if (event.target === elements.avatarDialog) elements.avatarDialog.close();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== 'landrop-avatar') return;
    state.avatar = avatars.normalize(event.newValue, state.deviceId);
    renderAvatarPicker();
    refreshMessageAvatars();
    sendProfile();
  });
  elements.createRoom.addEventListener('click', () => {
    elements.roomFormError.textContent = '';
    elements.createdRoomLink.hidden = true;
    elements.createRoomDialog.showModal();
  });
  elements.closeCreateRoom.addEventListener('click', () => elements.createRoomDialog.close());
  elements.createRoomForm.addEventListener('submit', createRoom);
  elements.inviteRoom.addEventListener('click', copyCurrentAddress);
  elements.destroyRoom.addEventListener('click', () => {
    elements.destroyRoomError.textContent = '';
    elements.destroyRoomDialog.showModal();
  });
  elements.cancelDestroyRoom.addEventListener('click', () => elements.destroyRoomDialog.close());
  elements.destroyFullRoom.addEventListener('click', () => {
    elements.destroyRoomError.textContent = '';
    elements.destroyRoomDialog.showModal();
  });
  elements.confirmDestroyRoom.addEventListener('click', destroyRoom);
  elements.retryRoom.addEventListener('click', () => {
    elements.unavailableDialog.close();
    state.roomUnavailable = false;
    connectSocket();
  });
  elements.messageForm.addEventListener('submit', sendMessage);
  elements.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      elements.messageForm.requestSubmit();
    }
  });
  elements.messageInput.addEventListener('input', () => {
    resizeComposer();
    sendTypingState();
  });
  elements.messageInput.addEventListener('paste', pasteImages);

  elements.nameInput.addEventListener('input', () => {
    clearTimeout(state.nameTimer);
    state.nameTimer = setTimeout(commitName, 350);
  });
  elements.nameInput.addEventListener('blur', commitName);
  elements.nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') elements.nameInput.blur();
  });

  elements.copyAddress.addEventListener('click', copyCurrentAddress);
  elements.clearView.addEventListener('click', clearMessageView);
  elements.onlineButton.addEventListener('click', openPeopleDialog);
  elements.closePeople.addEventListener('click', () => elements.peopleDialog.close());
  elements.peopleDialog.addEventListener('click', (event) => {
    if (event.target === elements.peopleDialog) elements.peopleDialog.close();
  });

  elements.chooseFiles.addEventListener('click', (event) => {
    event.stopPropagation();
    elements.fileInput.click();
  });
  elements.chooseFilesTop.addEventListener('click', () => elements.fileInput.click());
  elements.dropZone.addEventListener('click', (event) => {
    if (!event.target.closest('button')) elements.fileInput.click();
  });
  elements.dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
  elements.fileInput.addEventListener('change', () => {
    uploadFiles(elements.fileInput.files);
    elements.fileInput.value = '';
  });
  elements.chooseImages.addEventListener('click', () => elements.imageInput.click());
  elements.imageInput.addEventListener('change', () => {
    const selected = Array.from(elements.imageInput.files || []);
    const images = selected.filter(isImageFile);
    if (images.length !== selected.length) showToast('请选择图片文件', true);
    uploadFiles(images);
    elements.imageInput.value = '';
  });
  bindDropZone();

  elements.refreshFiles.addEventListener('click', refreshFiles);
  mobileChatMedia.addEventListener('change', updateResponsiveLayout);
  window.addEventListener('focus', () => {
    if (state.connected) sendSocket({ type: 'chatQuota' });
  });
  window.addEventListener('beforeunload', (event) => {
    if ([...state.uploads.values()].some((upload) => upload.status === 'uploading')) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

function connectSocket() {
  clearTimeout(state.reconnectTimer);
  setConnectionState('reconnecting', state.socket ? '正在重连' : '正在连接');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(
    `${protocol}//${location.host}/ws?deviceId=${encodeURIComponent(state.deviceId)}&room=${encodeURIComponent(state.roomId)}`,
  );
  state.socket = socket;

  socket.addEventListener('open', () => {
    if (socket !== state.socket) return;
    setConnectionState('reconnecting', '正在进入房间');
  });

  socket.addEventListener('message', (event) => {
    if (socket !== state.socket) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSocketPayload(payload);
  });

  socket.addEventListener('close', () => {
    if (socket !== state.socket) return;
    state.connected = false;
    state.clientId = null;
    state.roomSession = null;
    state.networkUploads.clear();
    renderNetworkUploads();
    if (state.roomUnavailable) return;
    setConnectionState('reconnecting', '连接已断开');
    state.reconnectTimer = setTimeout(connectSocket, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.7, 8_000);
  });

  socket.addEventListener('error', () => {
    if (socket === state.socket) socket.close();
  });
}

function handleSocketPayload(payload) {
  if (state.roomUnavailable && payload.type !== 'welcome') return;
  if (payload.type === 'welcome') {
    state.clientId = payload.clientId;
    state.connected = true;
    state.reconnectDelay = 800;
    state.roomSession = payload.roomSession;
    state.room = payload.room;
    state.roomUnavailable = false;
    elements.unavailableDialog.close();
    state.chatHistoryLimit = Number.isSafeInteger(payload.chatHistoryLimit) && payload.chatHistoryLimit > 0
      ? payload.chatHistoryLimit : 20;
    elements.historyPolicy.textContent = `仅保留最近 ${state.chatHistoryLimit} 条聊天记录`;
    updateChatQuota(payload.chatQuota);
    renderVersion(payload.version);
    renderRoom(payload.serverName);
    renderHistory(payload.history || []);
    replaceFiles(payload.files || []);
    replaceNetworkUploads(payload.uploads || []);
    sendProfile();
    setConnectionState('connected', '已连接');
    refreshStatus();
    return;
  }

  if (payload.type === 'room') {
    state.room = payload.room;
    state.isOwner = payload.isOwner;
    elements.destroyRoom.hidden = !state.isOwner;
    renderRoom();
    return;
  }

  if (payload.type === 'roomDestroyed') {
    roomUnavailable('聊天室已被房主销毁，记录和文件已清除，邀请链接已失效。', false);
    return;
  }

  if (payload.type === 'presence') {
    state.users = Array.isArray(payload.users) ? payload.users : [];
    refreshMessageAvatars();
    renderPresence();
    renderRoom();
    return;
  }

  if (payload.type === 'message' && payload.message) {
    if (payload.message.kind === 'offline') {
      updateTypingUser({ clientId: payload.message.sender?.id, active: false });
    }
    appendMessage(payload.message);
    if (payload.message.kind === 'file' && payload.message.file) {
      state.files.set(payload.message.file.id, payload.message.file);
      renderFiles();
      refreshStatus();
    }
    return;
  }

  if (payload.type === 'messagesRemoved') {
    removeMessages(payload.messageIds);
    return;
  }

  if (payload.type === 'typing') {
    updateTypingUser(payload);
    return;
  }

  if (payload.type === 'uploads') {
    replaceNetworkUploads(payload.uploads || []);
    return;
  }

  if (payload.type === 'error') {
    if (['ROOM_FULL', 'ROOM_NOT_FOUND'].includes(payload.code)) {
      roomUnavailable(payload.message, payload.code === 'ROOM_FULL');
      return;
    }
    if (payload.chatQuota) updateChatQuota(payload.chatQuota);
    if (['DAILY_MESSAGE_LIMIT', 'DAILY_CHAT_LIMIT'].includes(payload.code)
      && !elements.messageInput.value && payload.text) {
      elements.messageInput.value = payload.text;
      resizeComposer();
    }
    showToast(payload.message || '消息发送失败', true);
  }
  if (payload.type === 'chatQuota') updateChatQuota(payload.chatQuota);
}

function updateChatQuota(quota) {
  if (!quota || !Number.isSafeInteger(quota.limit) || quota.limit < 0
    || (quota.limit > 0 && !Number.isSafeInteger(quota.remaining))) return;
  state.chatQuota = quota;
  elements.chatQuota.textContent = quota.limit === 0
    ? '每日发送不限'
    : quota.remaining === 0
      ? `今日已达 ${quota.limit} 条，北京时间零点恢复`
      : `今日剩余 ${quota.remaining}/${quota.limit} 条 · 文字、文件及图片合计`;
  elements.sendButton.disabled = !state.connected || quota.remaining === 0;
  clearTimeout(state.quotaTimer);
  if (quota.limit === 0) return;
  const delay = Date.parse(quota.resetAt) - Date.now();
  state.quotaTimer = setTimeout(() => {
    if (state.connected) sendSocket({ type: 'chatQuota' });
  }, Math.min(Math.max(delay + 100, 1000), 24 * 60 * 60 * 1000));
}

function sendSocket(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(payload));
  return true;
}

function setConnectionState(kind, label) {
  elements.connectionState.classList.toggle('connected', kind === 'connected');
  elements.connectionState.classList.toggle('reconnecting', kind === 'reconnecting');
  elements.connectionLabel.textContent = label;
  elements.connectionState.title = label;
  elements.connectionState.setAttribute('aria-label', label);
  elements.sendButton.disabled = kind !== 'connected' || state.chatQuota?.remaining === 0;
  elements.chooseImages.disabled = kind !== 'connected';
}

function loadName() {
  const stored = localStorage.getItem('landrop-name');
  if (stored && stored.trim()) return stored.slice(0, 24);
  const generated = `用户${Math.floor(1000 + Math.random() * 9000)}`;
  localStorage.setItem('landrop-name', generated);
  return generated;
}

function loadDeviceId() {
  const stored = localStorage.getItem('landrop-device-id');
  if (stored && /^[a-z0-9_-]{8,80}$/iu.test(stored)) return stored;
  const generated = createLocalId('device');
  localStorage.setItem('landrop-device-id', generated);
  return generated;
}

function currentName() {
  return elements.nameInput.value.trim().slice(0, 24) || '访客';
}

function commitName() {
  clearTimeout(state.nameTimer);
  const name = currentName();
  elements.nameInput.value = name;
  localStorage.setItem('landrop-name', name);
  sendProfile();
}

function sendProfile() {
  if (state.connected) sendSocket({ type: 'join', name: currentName(), avatar: state.avatar, ownerToken: loadOwnerToken() });
}

function renderAvatarPicker() {
  const selected = avatars.choices.find((choice) => choice.id === state.avatar);
  elements.currentAvatar.textContent = selected.emoji;
  elements.chooseAvatar.title = `当前头像：${selected.name}，点击修改`;
  elements.chooseAvatar.setAttribute('aria-label', `修改头像，当前为${selected.name}`);
  elements.avatarOptions.replaceChildren();
  for (const choice of avatars.choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'avatar-option';
    button.setAttribute('aria-label', `${choice.name}头像`);
    button.setAttribute('aria-pressed', String(choice.id === state.avatar));
    const emoji = document.createElement('span');
    emoji.className = 'zodiac-emoji';
    emoji.textContent = choice.emoji;
    emoji.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = choice.name;
    button.append(emoji, label);
    button.addEventListener('click', () => {
      state.avatar = choice.id;
      localStorage.setItem('landrop-avatar', state.avatar);
      renderAvatarPicker();
      refreshMessageAvatars();
      sendProfile();
      elements.avatarDialog.close();
      showToast(`已切换为${choice.name}头像`);
    });
    elements.avatarOptions.append(button);
  }
}

function renderAvatar(element, sender) {
  const profile = sender?.id === state.clientId
    ? { ...sender, avatar: state.avatar }
    : state.users.find((user) => user.id === sender?.id) || sender;
  const id = avatars.normalize(profile?.avatar, profile?.id);
  const choice = avatars.choices.find((avatar) => avatar.id === id);
  element.textContent = choice.emoji;
  element.dataset.avatar = id;
  element.dataset.senderId = sender?.id || '';
  element.title = `${sender?.name || '访客'} · ${choice.name}头像`;
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', `${choice.name}头像`);
}

function refreshMessageAvatars() {
  for (const element of elements.messages.querySelectorAll('.avatar')) {
    const profile = state.users.find((user) => user.id === element.dataset.senderId);
    if (profile || element.dataset.senderId === state.clientId) {
      renderAvatar(element, profile || { id: state.clientId, name: currentName() });
    }
  }
}

function sendMessage(event) {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (!text) return;
  if (!state.connected) {
    showToast('尚未连接到聊天室', true);
    return;
  }
  if (state.chatQuota?.remaining === 0) {
    showToast(`今日发送已达 ${state.chatQuota.limit} 条，北京时间零点恢复`, true);
    return;
  }
  if (sendSocket({ type: 'chat', text })) {
    elements.messageInput.value = '';
    resizeComposer();
    stopTyping();
  }
}

function sendTypingState() {
  if (!state.connected) return;
  if (!state.typingSent) {
    state.typingSent = true;
    sendSocket({ type: 'typing', active: true });
  }
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(stopTyping, 900);
}

function stopTyping() {
  clearTimeout(state.typingTimer);
  if (state.typingSent) sendSocket({ type: 'typing', active: false });
  state.typingSent = false;
}

function updateTypingUser(payload) {
  if (!payload.clientId || payload.clientId === state.clientId) return;
  const previous = state.typingUsers.get(payload.clientId);
  if (previous?.timer) clearTimeout(previous.timer);

  if (payload.active) {
    const timer = setTimeout(() => {
      state.typingUsers.delete(payload.clientId);
      renderTypingLine();
    }, 1_800);
    state.typingUsers.set(payload.clientId, { name: payload.name || '有人', timer });
  } else {
    state.typingUsers.delete(payload.clientId);
  }
  renderTypingLine();
}

function renderTypingLine() {
  const names = [...state.typingUsers.values()].map((entry) => entry.name);
  if (names.length === 0) elements.typingLine.textContent = '';
  else if (names.length === 1) elements.typingLine.textContent = `${names[0]} 正在输入...`;
  else elements.typingLine.textContent = `${names.slice(0, 2).join('、')} 正在输入...`;
}

function resizeComposer() {
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 118)}px`;
}

function renderHistory(messages) {
  state.messageIds.clear();
  for (const row of elements.messages.querySelectorAll('.message-row')) row.remove();
  for (const message of messages) appendMessage(message, false);
  updateChatEmptyState();
  elements.messages.scrollTop = elements.messages.scrollHeight;
  refreshIcons();
}

function appendMessage(message, animateScroll = true) {
  if (!message?.id || state.messageIds.has(message.id)) return;
  const wasNearBottom = elements.messages.scrollHeight
    - elements.messages.scrollTop
    - elements.messages.clientHeight < 100;
  state.messageIds.add(message.id);
  elements.chatEmpty.hidden = true;

  const own = message.sender?.id === state.clientId;
  const row = document.createElement('article');
  row.className = `message-row${own ? ' own' : ''}${message.kind === 'file' ? ' file-message-row' : ''}`;
  if (message.kind === 'file' && isImageFile(message.file)) row.classList.add('image-message-row');
  row.dataset.messageId = message.id;

  if (message.kind === 'online' || message.kind === 'offline') {
    row.classList.add('system-message-row');
    const notice = document.createElement('span');
    notice.className = 'system-message';
    notice.textContent = `${formatSenderIdentity(message.sender)} ${message.kind === 'offline' ? '已经离开房间...' : '上线了'}`;
    row.append(notice);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    renderAvatar(avatar, message.sender);

    const content = document.createElement('div');
    content.className = 'message-content';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('span');
    sender.className = 'message-sender';
    sender.textContent = formatSenderIdentity(message.sender);
    sender.title = sender.textContent;
    const time = document.createElement('time');
    time.dateTime = message.createdAt || '';
    time.textContent = formatTime(message.createdAt);
    meta.append(sender, time);
    content.append(meta);

    if (message.kind === 'file' && message.file) {
      content.append(createFileMessage(message.file));
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = message.text || '';
      content.append(bubble);
    }

    row.append(avatar, content);
  }
  elements.messages.append(row);
  trimChatHistory();
  updateChatEmptyState();
  refreshIcons();

  if (!animateScroll || wasNearBottom || own) {
    requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }
}

function trimChatHistory() {
  const rows = [...elements.messages.querySelectorAll('.message-row:not(.message-removing)')];
  const messages = rows.filter((row) => !row.classList.contains('system-message-row'));
  const notices = rows.filter((row) => row.classList.contains('system-message-row'));
  const expired = new Set([
    ...messages.slice(0, -state.chatHistoryLimit),
    ...notices.slice(0, -state.chatHistoryLimit),
  ]);
  // Discard notices preceding an expired message as that part of the conversation leaves the window.
  if (messages.length > state.chatHistoryLimit) {
    const oldestRetained = messages[messages.length - state.chatHistoryLimit];
    for (const row of rows) {
      if (row === oldestRetained) break;
      expired.add(row);
    }
  }
  for (const row of expired) {
    state.messageIds.delete(row.dataset.messageId);
    row.remove();
  }
}

function removeMessages(messageIds) {
  if (!Array.isArray(messageIds)) return;
  const removedIds = new Set(messageIds);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const row of elements.messages.querySelectorAll('.message-row:not(.system-message-row)')) {
    if (!removedIds.has(row.dataset.messageId) || row.classList.contains('message-removing')) continue;
    let timer;
    const finish = () => {
      clearTimeout(timer);
      row.removeEventListener('animationend', finish);
      state.messageIds.delete(row.dataset.messageId);
      row.remove();
      updateChatEmptyState();
    };
    if (reduceMotion) {
      finish();
      continue;
    }
    row.style.setProperty('--removed-height', `${row.offsetHeight}px`);
    row.setAttribute('aria-hidden', 'true');
    row.classList.add('message-removing');
    row.addEventListener('animationend', finish, { once: true });
    timer = setTimeout(finish, 750);
  }
}

function createFileMessage(file) {
  const container = document.createElement('div');
  container.className = 'file-message';

  if (isImageFile(file)) {
    container.classList.add('image-file-message');
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'image-preview-button';
    preview.title = '点击放大预览';
    preview.setAttribute('aria-label', `放大预览 ${file.name}`);
    preview.setAttribute('aria-haspopup', 'dialog');
    preview.setAttribute('aria-controls', 'image-viewer');
    preview.addEventListener('click', () => openImagePreview(file));
    const image = document.createElement('img');
    image.className = 'image-preview';
    image.alt = file.name;
    image.loading = 'lazy';
    image.decoding = 'async';
    const fallback = document.createElement('p');
    fallback.className = 'image-preview-error';
    fallback.textContent = '图片暂时无法预览，可下载查看';
    fallback.hidden = true;
    image.addEventListener('error', () => {
      preview.hidden = true;
      fallback.hidden = false;
    }, { once: true });
    image.src = fileDownloadUrl(file);
    preview.append(image);
    container.append(preview, fallback);
  }

  const icon = document.createElement('div');
  icon.className = 'file-type-icon';
  icon.append(createIcon(fileIconName(file)));

  const info = document.createElement('div');
  info.className = 'file-message-info';
  const name = document.createElement('span');
  name.className = 'file-message-name';
  name.textContent = file.name;
  name.title = file.name;
  const meta = document.createElement('span');
  meta.className = 'file-message-meta';
  meta.textContent = formatBytes(file.size);
  info.append(name, meta);

  const download = createDownloadButton(file);
  container.append(icon, info, download);
  return container;
}

function createDownloadButton(file) {
  const link = document.createElement('a');
  link.className = 'download-button';
  link.href = fileDownloadUrl(file);
  link.download = file.name;
  link.title = `下载 ${file.name}`;
  link.setAttribute('aria-label', `下载 ${file.name}`);
  link.append(createIcon('download'));
  return link;
}

function openImagePreview(file) {
  const url = fileDownloadUrl(file);
  elements.viewerTitle.textContent = file.name;
  elements.viewerImage.alt = file.name;
  elements.viewerImage.hidden = true;
  elements.viewerStatus.textContent = '正在加载图片…';
  elements.viewerStatus.hidden = false;
  elements.viewerDownload.href = url;
  elements.viewerDownload.download = file.name;
  elements.viewerDownload.setAttribute('aria-label', `下载 ${file.name}`);
  elements.imageViewer.showModal();
  elements.viewerImage.src = url;
}

function fileDownloadUrl(file) {
  const url = new URL(file.downloadUrl, location.origin);
  if (state.roomId && state.roomSession) url.searchParams.set('session', state.roomSession);
  return url.href;
}

function clearMessageView() {
  for (const row of elements.messages.querySelectorAll('.message-row')) row.remove();
  state.messageIds.clear();
  elements.chatEmpty.hidden = false;
  showToast('已清空当前显示');
}

function updateChatEmptyState() {
  const selector = mobileChatMedia.matches
    ? '.message-row:not(.file-message-row), .image-message-row'
    : '.message-row';
  elements.chatEmpty.hidden = Boolean(elements.messages.querySelector(selector));
}

function updateResponsiveLayout() {
  if (mobileChatMedia.matches) {
    elements.mobileUploadSlot.append(elements.uploadSection);
  } else {
    elements.transferPanel.insertBefore(elements.uploadSection, elements.recentSection);
  }
  updateUploadSummary();
  updateChatEmptyState();
}

function isImageFile(file) {
  if (!file) return false;
  const mimeType = String(file.type || file.mimeType || '').toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  if (mimeType && mimeType !== 'application/octet-stream') return false;
  return /\.(?:png|jpe?g|jfif|gif|webp|bmp|avif|heic|heif|tiff?|svg|ico|apng|jxl)$/iu.test(file.name || '');
}

function replaceFiles(files) {
  state.files.clear();
  for (const file of files) {
    if (file?.id) state.files.set(file.id, file);
  }
  renderFiles();
}

function renderFiles() {
  for (const row of elements.recentFiles.querySelectorAll('.recent-file')) row.remove();
  const files = [...state.files.values()].sort((left, right) => (
    String(right.createdAt).localeCompare(String(left.createdAt))
  ));
  elements.filesEmpty.hidden = files.length > 0;

  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'recent-file';

    const icon = document.createElement('div');
    icon.className = 'recent-file-icon';
    icon.append(createIcon(fileIconName(file)));

    const info = document.createElement('div');
    info.className = 'recent-file-info';
    const name = document.createElement('span');
    name.className = 'recent-file-name';
    name.textContent = file.name;
    name.title = file.name;
    const meta = document.createElement('span');
    meta.className = 'recent-file-meta';
    const senderName = file.sender?.name ? ` · ${file.sender.name}` : '';
    meta.textContent = `${formatBytes(file.size)}${senderName}`;
    info.append(name, meta);

    row.append(icon, info, createDownloadButton(file));
    elements.recentFiles.append(row);
  }
  refreshIcons();
}

async function refreshFiles() {
  elements.refreshFiles.firstElementChild?.classList.add('spinning');
  try {
    const response = await fetch(roomApi('/files'), { cache: 'no-store', headers: roomHeaders() });
    if (!response.ok) throw new Error('刷新失败');
    const payload = await response.json();
    if (state.roomUnavailable) return;
    replaceFiles(payload.files || []);
  } catch {
    showToast('文件列表刷新失败', true);
  } finally {
    elements.refreshFiles.firstElementChild?.classList.remove('spinning');
  }
}

async function refreshStatus() {
  if (state.roomId && !state.roomSession) return;
  try {
    const response = await fetch(roomApi('/status'), { cache: 'no-store', headers: roomHeaders() });
    if (!response.ok) return;
    const status = await response.json();
    if (state.roomUnavailable) return;
    renderVersion(status.version);
    renderRoom(status.serverName);
    elements.storageLabel.textContent = Number.isFinite(status.availableBytes)
      ? `可用 ${formatBytes(status.availableBytes)}`
      : '';
  } catch {
    // The WebSocket state already shows connection failures.
  }
}

function bindDropZone() {
  let dragDepth = 0;
  elements.dropZone.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    elements.dropZone.classList.add('dragging');
  });
  elements.dropZone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  elements.dropZone.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) elements.dropZone.classList.remove('dragging');
  });
  elements.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    elements.dropZone.classList.remove('dragging');
    uploadFiles(event.dataTransfer.files);
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (hasFiles(event) && !elements.dropZone.contains(event.target)) event.preventDefault();
  });
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function pasteImages(event) {
  const clipboard = event.clipboardData;
  let images = Array.from(clipboard?.items || [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (images.length === 0) {
    images = Array.from(clipboard?.files || []).filter((file) => file.type.startsWith('image/'));
  }
  if (images.length === 0) return;
  event.preventDefault();
  uploadFiles(images);
}

function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  if (!state.connected || !state.clientId) {
    showToast('聊天室连接后才能上传文件', true);
    return;
  }
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast(`${file.name}：单个文件不能超过 20 MB`, true);
      continue;
    }
    startUpload(file);
  }
}

function startUpload(file) {
  const upload = {
    id: createLocalId(),
    file,
    status: 'uploading',
    loaded: 0,
    speed: 0,
    lastLoaded: 0,
    lastMeasuredAt: performance.now(),
    xhr: new XMLHttpRequest(),
    row: null,
  };
  state.uploads.set(upload.id, upload);
  upload.row = createUploadRow(upload);
  elements.uploadList.prepend(upload.row);
  elements.uploadSection.hidden = false;
  updateUploadSummary();
  refreshIcons();

  const xhr = upload.xhr;
  xhr.open('POST', roomApi('/files'));
  if (state.roomId) xhr.setRequestHeader('X-Room-Session', state.roomSession);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-File-Name', encodeBase64Url(file.name));
  xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
  xhr.setRequestHeader('X-Client-Id', state.clientId);
  xhr.setRequestHeader('X-Upload-Id', upload.id);
  xhr.setRequestHeader('X-File-Size', String(file.size));

  xhr.upload.addEventListener('progress', (event) => updateUploadProgress(upload, event));
  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      finishUpload(upload, 'done', '上传完成');
    } else {
      let message = xhr.status === 413 ? '单个文件不能超过 20 MB' : '上传失败';
      try { message = JSON.parse(xhr.responseText).message || message; } catch {}
      finishUpload(upload, 'failed', message);
    }
  });
  xhr.addEventListener('error', () => finishUpload(upload, 'failed', '网络连接中断'));
  xhr.addEventListener('abort', () => finishUpload(upload, 'failed', '已取消'));
  xhr.send(file);
}

function createUploadRow(upload) {
  const row = document.createElement('div');
  row.className = 'upload-item local-upload';
  if (isImageFile(upload.file)) row.classList.add('image-upload');
  row.dataset.uploadId = upload.id;

  const info = document.createElement('div');
  info.className = 'upload-info';
  const name = document.createElement('span');
  name.className = 'upload-name';
  name.textContent = upload.file.name;
  name.title = upload.file.name;
  const meta = document.createElement('span');
  meta.className = 'upload-meta';
  meta.textContent = `准备上传 · ${formatBytes(upload.file.size)}`;
  const progress = document.createElement('div');
  progress.className = 'upload-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', `${upload.file.name} 上传进度`);
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  const bar = document.createElement('div');
  bar.className = 'upload-progress-bar';
  progress.append(bar);
  info.append(name, meta, progress);

  const cancel = document.createElement('button');
  cancel.className = 'small-icon-button cancel-upload';
  cancel.type = 'button';
  cancel.title = '取消上传';
  cancel.setAttribute('aria-label', `取消上传 ${upload.file.name}`);
  cancel.append(createIcon('x'));
  cancel.addEventListener('click', () => upload.xhr.abort());

  row.append(info, cancel);
  return row;
}

function updateUploadProgress(upload, event) {
  if (upload.status !== 'uploading') return;
  const now = performance.now();
  const elapsed = (now - upload.lastMeasuredAt) / 1000;
  if (elapsed >= 0.3) {
    const instantSpeed = (event.loaded - upload.lastLoaded) / elapsed;
    upload.speed = upload.speed ? upload.speed * 0.55 + instantSpeed * 0.45 : instantSpeed;
    upload.lastLoaded = event.loaded;
    upload.lastMeasuredAt = now;
  }
  upload.loaded = event.loaded;

  const progress = event.lengthComputable && event.total > 0
    ? Math.min(100, (event.loaded / event.total) * 100)
    : 0;
  const progressElement = upload.row.querySelector('.upload-progress');
  const roundedProgress = Math.round(progress);
  progressElement.setAttribute('aria-valuenow', String(roundedProgress));
  progressElement.setAttribute('aria-valuetext', `${roundedProgress}%`);
  upload.row.querySelector('.upload-progress-bar').style.width = `${progress}%`;

  const remaining = upload.speed > 0 ? (upload.file.size - event.loaded) / upload.speed : null;
  const details = [
    `${roundedProgress}%`,
    upload.speed > 0 ? `${formatBytes(upload.speed)}/s` : null,
    remaining !== null && remaining > 1 ? `约 ${formatDuration(remaining)}` : null,
  ].filter(Boolean).join(' · ');
  upload.row.querySelector('.upload-meta').textContent = details || '正在上传';
}

function finishUpload(upload, status, message) {
  if (upload.status !== 'uploading') return;
  upload.status = status;
  upload.row.classList.add(status);
  const bar = upload.row.querySelector('.upload-progress-bar');
  if (status === 'done') {
    bar.style.width = '100%';
    const progress = upload.row.querySelector('.upload-progress');
    progress.setAttribute('aria-valuenow', '100');
    progress.setAttribute('aria-valuetext', '上传完成');
  }
  upload.row.querySelector('.upload-meta').textContent = message;
  const button = upload.row.querySelector('.cancel-upload');
  button.replaceChildren(createIcon(status === 'done' ? 'check' : 'circle-alert'));
  button.title = message;
  button.setAttribute('aria-label', `${upload.file.name}：${message}`);
  button.disabled = true;
  updateUploadSummary();
  refreshIcons();
  if (status === 'failed') showToast(`${upload.file.name}：${message}`, true);
}

function updateUploadSummary() {
  const uploads = [...state.uploads.values()]
    .filter((upload) => !mobileChatMedia.matches || isImageFile(upload.file));
  const networkUploads = [...state.networkUploads.values()]
    .filter((upload) => !mobileChatMedia.matches || isImageFile(upload));
  const activeIds = new Set(networkUploads.map((upload) => upload.id));
  for (const upload of uploads) {
    if (upload.status === 'uploading') activeIds.add(upload.id);
  }
  const active = activeIds.size;
  const failed = uploads.filter((upload) => upload.status === 'failed').length;
  const summary = [];
  if (active > 0) summary.push(`${active} 个正在上传`);
  if (failed > 0) summary.push(`${failed} 个未完成`);
  const summaryText = summary.join(' · ') || '全部完成';
  if (elements.uploadSummary.textContent !== summaryText) {
    elements.uploadSummary.textContent = summaryText;
  }
  elements.uploadSection.hidden = uploads.length === 0 && networkUploads.length === 0;
  elements.mobileUploadSlot.hidden = !mobileChatMedia.matches || elements.uploadSection.hidden;
}

function replaceNetworkUploads(uploads) {
  state.networkUploads.clear();
  for (const upload of uploads) {
    if (upload?.id && upload?.name) state.networkUploads.set(upload.id, upload);
  }
  renderNetworkUploads();
}

function renderNetworkUploads() {
  const visibleUploads = new Map(
    [...state.networkUploads.entries()].filter(([id]) => !state.uploads.has(id)),
  );
  const existingRows = new Map(
    [...elements.uploadList.querySelectorAll('.network-upload')]
      .map((row) => [row.dataset.uploadId, row]),
  );

  for (const [id, row] of existingRows) {
    if (!visibleUploads.has(id)) row.remove();
  }

  let addedRow = false;
  const orderedUploads = [...visibleUploads.values()].sort((left, right) => (
    String(left.startedAt).localeCompare(String(right.startedAt))
  ));
  for (const upload of orderedUploads) {
    let row = existingRows.get(upload.id);
    if (!row) {
      row = createNetworkUploadRow(upload);
      elements.uploadList.prepend(row);
      addedRow = true;
    }
    updateNetworkUploadRow(row, upload);
  }

  updateUploadSummary();
  if (addedRow) refreshIcons();
}

function createNetworkUploadRow(upload) {
  const row = document.createElement('div');
  row.className = 'upload-item network-upload';
  if (isImageFile(upload)) row.classList.add('image-upload');
  row.dataset.uploadId = upload.id;

  const info = document.createElement('div');
  info.className = 'upload-info';
  const name = document.createElement('span');
  name.className = 'upload-name';
  const meta = document.createElement('span');
  meta.className = 'upload-meta';
  const progress = document.createElement('div');
  progress.className = 'upload-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', `${upload.name} 上传进度`);
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  const bar = document.createElement('div');
  bar.className = 'upload-progress-bar';
  progress.append(bar);
  info.append(name, meta, progress);

  const indicator = document.createElement('div');
  indicator.className = 'network-upload-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.append(createIcon('cloud-upload'));
  row.append(info, indicator);
  return row;
}

function updateNetworkUploadRow(row, upload) {
  const name = row.querySelector('.upload-name');
  name.textContent = upload.name;
  name.title = upload.name;

  const receivedBytes = Number.isFinite(Number(upload.receivedBytes))
    ? Math.max(0, Number(upload.receivedBytes))
    : 0;
  const totalBytes = Number.isFinite(Number(upload.totalBytes))
    ? Math.max(0, Number(upload.totalBytes))
    : null;
  const hasTotal = totalBytes !== null && totalBytes > 0;
  const progress = hasTotal ? Math.min(100, (receivedBytes / totalBytes) * 100) : null;
  const progressElement = row.querySelector('.upload-progress');
  const progressBar = row.querySelector('.upload-progress-bar');
  progressElement.classList.toggle('indeterminate', progress === null);

  let progressLabel;
  if (progress === null) {
    progressElement.removeAttribute('aria-valuenow');
    progressBar.style.width = '';
    progressLabel = `${formatBytes(receivedBytes)} 已接收`;
  } else {
    const roundedProgress = Math.round(progress);
    progressElement.setAttribute('aria-valuenow', String(roundedProgress));
    progressBar.style.width = `${progress}%`;
    progressLabel = `${roundedProgress}% · ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
  }
  progressElement.setAttribute('aria-valuetext', progressLabel);
  const meta = row.querySelector('.upload-meta');
  meta.textContent = `${formatSenderIdentity(upload.sender)} · ${progressLabel}`;
  meta.title = meta.textContent;
}

function formatSenderIdentity(sender) {
  const name = sender?.name || '访客';
  return sender?.ip ? `${name}[${sender.ip}]` : name;
}

function renderPresence() {
  const count = state.users.length;
  elements.onlineCount.textContent = `${count} 人在线`;
  elements.onlineButton.title = `${count} 人在线`;
  elements.onlineButton.setAttribute('aria-label', `${count} 人在线，查看在线成员`);
  elements.peopleSummary.textContent = `${count} 台设备已连接`;
  elements.peopleList.replaceChildren();

  for (const user of state.users) {
    const row = document.createElement('div');
    row.className = 'person-row';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    renderAvatar(avatar, user);
    const info = document.createElement('div');
    info.className = 'person-info';
    const name = document.createElement('strong');
    name.textContent = user.id === state.clientId ? `${user.name}（我）` : user.name;
    const status = document.createElement('span');
    status.textContent = '在线';
    info.append(name, status);
    row.append(avatar, info);
    elements.peopleList.append(row);
  }
}

function openPeopleDialog() {
  renderPresence();
  elements.peopleDialog.showModal();
}

async function copyCurrentAddress() {
  const address = new URL(state.roomId ? `/?room=${encodeURIComponent(state.roomId)}` : '/', location.origin).href;
  try {
    await navigator.clipboard.writeText(address);
    showToast(state.roomId ? '邀请链接已复制' : '地址已复制');
  } catch {
    const input = document.createElement('input');
    input.value = address;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showToast(state.roomId ? '邀请链接已复制' : '地址已复制');
  }
}

function roomApi(suffix) {
  return `${state.roomId ? `/api/rooms/${encodeURIComponent(state.roomId)}` : '/api'}${suffix}`;
}

function roomHeaders() {
  return state.roomId ? { 'X-Room-Session': state.roomSession || '' } : {};
}

function loadOwnerToken() {
  try {
    return localStorage.getItem(`landrop-owner-${state.roomId}`) || undefined;
  } catch {
    return undefined;
  }
}

function renderVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.[1-9]\d$/u.test(version)) return;
  elements.appVersion.textContent = `v${version}`;
  elements.appVersion.setAttribute('aria-label', `版本 ${version}`);
  elements.appVersion.hidden = false;
}

function renderRoom(serverName) {
  if (serverName) state.serverName = serverName;
  const room = state.room;
  elements.serverName.textContent = `${state.serverName || '局域网'} · ${room?.name || (state.roomId ? '专有聊天室' : '公共房间')}`;
  elements.serverName.title = elements.serverName.textContent;
  elements.roomStatus.hidden = !room?.capacity;
  elements.roomStatus.textContent = room?.capacity ? `${state.users.length} / ${room.capacity} 人${state.isOwner ? ' · 房主' : ''}` : '';
  document.title = room?.id ? `${room.name} · 邻传` : '邻传';
}

async function createRoom(event) {
  event.preventDefault();
  // Open during the submit gesture; opening after fetch can trigger popup blockers.
  const roomWindow = window.open('', '_blank');
  if (!roomWindow) {
    elements.roomFormError.textContent = '浏览器拦截了新标签页，请允许弹出窗口后重试。';
    return;
  }
  roomWindow.opener = null;
  elements.submitCreateRoom.disabled = true;
  elements.roomFormError.textContent = '';
  elements.createdRoomLink.hidden = true;
  let created = false;
  try {
    // Check persistence before creating a room so the owner credential survives navigation.
    localStorage.setItem('landrop-storage-check', '1');
    localStorage.removeItem('landrop-storage-check');
    const response = await fetch('/api/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: elements.roomName.value.trim(), capacity: Number(elements.roomCapacity.value) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '创建失败');
    localStorage.setItem(`landrop-owner-${result.room.id}`, result.ownerToken);
    created = true;
    elements.createdRoomLink.href = result.room.invitePath;
    if (roomWindow.closed) throw new Error('新标签页已关闭，请点击下方链接打开已创建的聊天室。');
    roomWindow.location.replace(new URL(result.room.invitePath, location.origin).href);
    elements.createRoomDialog.close();
    showToast('聊天室已在新标签页打开');
  } catch (error) {
    if (!roomWindow.closed) roomWindow.close();
    elements.createdRoomLink.hidden = !created;
    elements.roomFormError.textContent = error.message || '创建失败，请检查浏览器是否允许本地存储';
  } finally {
    elements.submitCreateRoom.disabled = false;
  }
}

async function destroyRoom() {
  elements.confirmDestroyRoom.disabled = true;
  elements.destroyRoomError.textContent = '';
  try {
    const response = await fetch(roomApi(''), {
      method: 'DELETE', headers: { Authorization: `Bearer ${loadOwnerToken() || ''}` },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '销毁失败');
    elements.destroyRoomDialog.close();
    roomUnavailable('聊天室已销毁，记录和文件已清除，邀请链接已失效。', false);
    try { localStorage.removeItem(`landrop-owner-${state.roomId}`); } catch {}
  } catch (error) {
    elements.destroyRoomError.textContent = error.message || '销毁失败，请重试';
  } finally {
    elements.confirmDestroyRoom.disabled = false;
  }
}

function roomUnavailable(message, canRetry) {
  if (elements.imageViewer.open) elements.imageViewer.close();
  state.roomUnavailable = true;
  state.connected = false;
  state.roomSession = null;
  state.isOwner = false;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.quotaTimer);
  state.socket?.close();
  for (const upload of state.uploads.values()) {
    if (upload.status === 'uploading') upload.xhr.abort();
  }
  state.uploads.clear();
  elements.uploadList.replaceChildren();
  renderHistory([]);
  replaceFiles([]);
  replaceNetworkUploads([]);
  state.users = [];
  renderPresence();
  for (const user of state.typingUsers.values()) clearTimeout(user.timer);
  state.typingUsers.clear();
  elements.typingLine.textContent = '';
  elements.destroyRoom.hidden = true;
  setConnectionState('disconnected', canRetry ? '人数已满' : '房间已失效');
  elements.destroyRoomDialog.close();
  elements.unavailableMessage.textContent = message;
  elements.retryRoom.hidden = !canRetry;
  elements.destroyFullRoom.hidden = true;
  if (canRetry && loadOwnerToken()) verifyRoomOwner();
  if (!elements.unavailableDialog.open) elements.unavailableDialog.showModal();
}

async function verifyRoomOwner() {
  try {
    const response = await fetch(roomApi(''), { headers: { Authorization: `Bearer ${loadOwnerToken()}` }, cache: 'no-store' });
    if (response.ok && state.roomUnavailable && !elements.retryRoom.hidden) elements.destroyFullRoom.hidden = false;
  } catch {}
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.append(createIcon(isError ? 'circle-alert' : 'circle-check'));
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(text);
  elements.toastRegion.append(toast);
  refreshIcons();
  setTimeout(() => toast.remove(), 3_500);
}

function createIcon(name) {
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function refreshIcons() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
  }
}

function fileIconName(file) {
  const type = file.mimeType || '';
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'film';
  if (type.startsWith('audio/')) return 'music-2';
  if (type.includes('zip') || ['zip', 'rar', '7z', 'gz', 'tar'].includes(extension)) return 'archive';
  if (type.includes('pdf') || extension === 'pdf') return 'file-text';
  if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(extension)) return 'file-text';
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'sheet';
  if (['ppt', 'pptx'].includes(extension)) return 'presentation';
  return 'file';
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '未知大小';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** unit);
  const digits = unit === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.ceil(seconds / 3600)} 小时`;
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function createLocalId(prefix = 'upload') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
