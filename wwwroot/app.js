'use strict';

const elements = {
  connectionState: document.querySelector('#connection-state'),
  connectionLabel: document.querySelector('#connection-label'),
  onlineButton: document.querySelector('#online-button'),
  onlineCount: document.querySelector('#online-count'),
  nameInput: document.querySelector('#name-input'),
  copyAddress: document.querySelector('#copy-address'),
  serverName: document.querySelector('#server-name'),
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
};

const state = {
  socket: null,
  deviceId: loadDeviceId(),
  clientId: null,
  connected: false,
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
};

init();

function init() {
  elements.nameInput.value = loadName();
  bindEvents();
  refreshIcons();
  connectSocket();
  refreshStatus();
}

function bindEvents() {
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
  bindDropZone();

  elements.refreshFiles.addEventListener('click', refreshFiles);
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
    `${protocol}//${location.host}/ws?deviceId=${encodeURIComponent(state.deviceId)}`,
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
    setConnectionState('reconnecting', '连接已断开');
    state.reconnectTimer = setTimeout(connectSocket, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.7, 8_000);
  });

  socket.addEventListener('error', () => {
    if (socket === state.socket) socket.close();
  });
}

function handleSocketPayload(payload) {
  if (payload.type === 'welcome') {
    state.clientId = payload.clientId;
    state.connected = true;
    state.reconnectDelay = 800;
    elements.serverName.textContent = `${payload.serverName || '局域网'} · 公共房间`;
    renderHistory(payload.history || []);
    replaceFiles(payload.files || []);
    sendSocket({ type: 'join', name: currentName() });
    setConnectionState('connected', '已连接');
    return;
  }

  if (payload.type === 'presence') {
    state.users = Array.isArray(payload.users) ? payload.users : [];
    renderPresence();
    return;
  }

  if (payload.type === 'message' && payload.message) {
    appendMessage(payload.message);
    if (payload.message.kind === 'file' && payload.message.file) {
      state.files.set(payload.message.file.id, payload.message.file);
      renderFiles();
      refreshStatus();
    }
    return;
  }

  if (payload.type === 'typing') {
    updateTypingUser(payload);
    return;
  }

  if (payload.type === 'error') {
    showToast(payload.message || '消息发送失败', true);
  }
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
  elements.sendButton.disabled = kind !== 'connected';
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
  if (state.connected) sendSocket({ type: 'join', name });
}

function sendMessage(event) {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (!text) return;
  if (!state.connected) {
    showToast('尚未连接到聊天室', true);
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
  elements.chatEmpty.hidden = state.messageIds.size > 0;
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
  row.className = `message-row${own ? ' own' : ''}`;
  row.dataset.messageId = message.id;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = firstCharacter(message.sender?.name || '访');
  avatar.title = message.sender?.name || '访客';

  const content = document.createElement('div');
  content.className = 'message-content';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const sender = document.createElement('span');
  sender.className = 'message-sender';
  const senderName = message.sender?.name || '访客';
  sender.textContent = message.sender?.ip
    ? `${senderName}[${message.sender.ip}]`
    : senderName;
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
  elements.messages.append(row);
  refreshIcons();

  if (!animateScroll || wasNearBottom || own) {
    requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }
}

function createFileMessage(file) {
  const container = document.createElement('div');
  container.className = 'file-message';

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
  link.href = file.downloadUrl;
  link.download = file.name;
  link.title = `下载 ${file.name}`;
  link.setAttribute('aria-label', `下载 ${file.name}`);
  link.append(createIcon('download'));
  return link;
}

function clearMessageView() {
  for (const row of elements.messages.querySelectorAll('.message-row')) row.remove();
  state.messageIds.clear();
  elements.chatEmpty.hidden = false;
  showToast('已清空当前显示');
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
    const response = await fetch('/api/files', { cache: 'no-store' });
    if (!response.ok) throw new Error('刷新失败');
    const payload = await response.json();
    replaceFiles(payload.files || []);
  } catch {
    showToast('文件列表刷新失败', true);
  } finally {
    elements.refreshFiles.firstElementChild?.classList.remove('spinning');
  }
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) return;
    const status = await response.json();
    if (status.serverName) elements.serverName.textContent = `${status.serverName} · 公共房间`;
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

function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  if (!state.connected || !state.clientId) {
    showToast('聊天室连接后才能上传文件', true);
    return;
  }
  for (const file of files) startUpload(file);
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
  xhr.open('POST', '/api/files');
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-File-Name', encodeBase64Url(file.name));
  xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
  xhr.setRequestHeader('X-Client-Id', state.clientId);

  xhr.upload.addEventListener('progress', (event) => updateUploadProgress(upload, event));
  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      finishUpload(upload, 'done', '上传完成');
    } else {
      let message = '上传失败';
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
  row.className = 'upload-item';
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
  progressElement.setAttribute('aria-valuenow', String(Math.round(progress)));
  upload.row.querySelector('.upload-progress-bar').style.width = `${progress}%`;

  const remaining = upload.speed > 0 ? (upload.file.size - event.loaded) / upload.speed : null;
  const details = [
    `${Math.round(progress)}%`,
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
  if (status === 'done') bar.style.width = '100%';
  upload.row.querySelector('.upload-meta').textContent = message;
  const button = upload.row.querySelector('.cancel-upload');
  button.replaceChildren(createIcon(status === 'done' ? 'check' : 'circle-alert'));
  button.disabled = true;
  updateUploadSummary();
  refreshIcons();
  if (status === 'failed') showToast(`${upload.file.name}：${message}`, true);
}

function updateUploadSummary() {
  const uploads = [...state.uploads.values()];
  const active = uploads.filter((upload) => upload.status === 'uploading').length;
  const failed = uploads.filter((upload) => upload.status === 'failed').length;
  elements.uploadSummary.textContent = active > 0
    ? `${active} 个任务`
    : failed > 0 ? `${failed} 个未完成` : '全部完成';
}

function renderPresence() {
  const count = state.users.length;
  elements.onlineCount.textContent = `${count} 人在线`;
  elements.peopleSummary.textContent = `${count} 台设备已连接`;
  elements.peopleList.replaceChildren();

  for (const user of state.users) {
    const row = document.createElement('div');
    row.className = 'person-row';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = firstCharacter(user.name || '访');
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
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('地址已复制');
  } catch {
    const input = document.createElement('input');
    input.value = location.href;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showToast('地址已复制');
  }
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

function firstCharacter(value) {
  return Array.from(String(value).trim())[0]?.toUpperCase() || '访';
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
