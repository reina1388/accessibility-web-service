// 메모리 저장소 — Supabase 환경변수가 없을 때 쓰는 대체 저장소입니다.
// 서버가 재시작되면 모두 사라집니다 (DB 저장소와 동일한 비동기 인터페이스를 제공합니다).
const crypto = require('crypto');

const MAX_HISTORY_IN_MEMORY = 200; // 메모리 무한 증가 방지

const state = {
  settings: { enabled: true, cycle: 'daily' },
  monitors: new Map(), // id -> monitor row
  history: new Map(), // monitorId -> [entry, ...] (최신이 앞)
};

const name = 'memory';

async function getSettings() {
  return { ...state.settings };
}

async function updateSettings(next) {
  state.settings = { ...state.settings, ...next };
  return { ...state.settings };
}

async function listMonitorRows() {
  return Array.from(state.monitors.values()).map((m) => ({ ...m }));
}

async function getMonitorRow(id) {
  const m = state.monitors.get(id);
  return m ? { ...m } : null;
}

async function insertMonitor(url) {
  const monitor = {
    id: crypto.randomUUID(),
    url,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastError: null,
    lastErrorAt: null,
  };
  state.monitors.set(monitor.id, monitor);
  state.history.set(monitor.id, []);
  return { ...monitor };
}

async function deleteMonitor(id) {
  state.history.delete(id);
  return state.monitors.delete(id);
}

// 성공한 검사 결과를 기록하고, 마지막 검사 시각 갱신 + 이전 오류 상태 해제
async function insertHistory(monitorId, entry) {
  const monitor = state.monitors.get(monitorId);
  if (!monitor) return;
  const list = state.history.get(monitorId) || [];
  list.unshift({ ...entry });
  if (list.length > MAX_HISTORY_IN_MEMORY) list.length = MAX_HISTORY_IN_MEMORY;
  state.history.set(monitorId, list);
  monitor.lastCheckedAt = entry.checkedAt;
  monitor.lastError = null;
  monitor.lastErrorAt = null;
}

async function setMonitorError(monitorId, message) {
  const monitor = state.monitors.get(monitorId);
  if (!monitor) return;
  monitor.lastError = message;
  monitor.lastErrorAt = new Date().toISOString();
}

// 최신순으로 limit건
async function getHistory(monitorId, limit = 100) {
  return (state.history.get(monitorId) || []).slice(0, limit).map((e) => ({ ...e }));
}

// 가장 최근 1건 + 전체 건수
async function getHistorySummary(monitorId) {
  const list = state.history.get(monitorId) || [];
  return { latest: list[0] ? { ...list[0] } : null, count: list.length };
}

module.exports = {
  name,
  getSettings,
  updateSettings,
  listMonitorRows,
  getMonitorRow,
  insertMonitor,
  deleteMonitor,
  insertHistory,
  setMonitorError,
  getHistory,
  getHistorySummary,
};
