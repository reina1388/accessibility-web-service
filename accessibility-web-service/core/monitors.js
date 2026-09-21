const crypto = require('crypto');

const MAX_MONITORS = 5; // 서버 자원 보호를 위한 상한
const MAX_HISTORY_PER_MONITOR = 30; // URL당 보관할 최근 검사 이력 수
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 최소 하루 한 번은 검사
const MIN_POLL_INTERVAL_MINUTES = 5; // 너무 짧게 설정해 자원을 낭비하지 않도록 하는 하한

const monitors = new Map(); // id -> monitor

// 모니터링 전체 켜기/끄기 및 "변경 여부 확인" 주기 (관리자가 조정 가능)
const settings = {
  enabled: true,
  pollIntervalMinutes: 60,
};

function getSettings() {
  return { ...settings };
}

function updateSettings({ enabled, pollIntervalMinutes } = {}) {
  if (typeof enabled === 'boolean') settings.enabled = enabled;
  if (pollIntervalMinutes !== undefined && pollIntervalMinutes !== null && pollIntervalMinutes !== '') {
    const n = Number(pollIntervalMinutes);
    if (!Number.isFinite(n) || n < MIN_POLL_INTERVAL_MINUTES) {
      throw new Error(`점검 주기는 ${MIN_POLL_INTERVAL_MINUTES}분 이상이어야 합니다.`);
    }
    settings.pollIntervalMinutes = n;
  }
  return getSettings();
}

function addMonitor(url) {
  if (monitors.size >= MAX_MONITORS) {
    throw new Error(`등록 가능한 모니터링 URL은 최대 ${MAX_MONITORS}개입니다.`);
  }
  for (const m of monitors.values()) {
    if (m.url === url) throw new Error('이미 등록된 URL입니다.');
  }

  const id = crypto.randomUUID();
  const monitor = {
    id,
    url,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastContentHash: null,
    history: [], // 최신 항목이 배열 맨 앞(unshift)에 오도록 저장
  };
  monitors.set(id, monitor);
  return monitor;
}

function removeMonitor(id) {
  return monitors.delete(id);
}

function getMonitor(id) {
  return monitors.get(id);
}

function toSummary(monitor) {
  return {
    id: monitor.id,
    url: monitor.url,
    enabled: monitor.enabled,
    createdAt: monitor.createdAt,
    lastCheckedAt: monitor.lastCheckedAt,
    latest: monitor.history[0] || null,
    historyCount: monitor.history.length,
  };
}

function listMonitors() {
  return Array.from(monitors.values()).map(toSummary);
}

function recordCheck(id, entry) {
  const monitor = monitors.get(id);
  if (!monitor) return;
  monitor.history.unshift(entry);
  if (monitor.history.length > MAX_HISTORY_PER_MONITOR) {
    monitor.history.length = MAX_HISTORY_PER_MONITOR;
  }
  monitor.lastCheckedAt = entry.checkedAt;
}

function setContentHash(id, hash) {
  const monitor = monitors.get(id);
  if (monitor) monitor.lastContentHash = hash;
}

module.exports = {
  MAX_MONITORS,
  MAX_HISTORY_PER_MONITOR,
  DAILY_INTERVAL_MS,
  MIN_POLL_INTERVAL_MINUTES,
  monitors,
  addMonitor,
  removeMonitor,
  getMonitor,
  listMonitors,
  recordCheck,
  setContentHash,
  getSettings,
  updateSettings,
};
