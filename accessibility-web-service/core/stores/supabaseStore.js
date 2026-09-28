// Supabase(Postgres) 저장소 — memoryStore와 동일한 인터페이스를 제공합니다.
// 테이블 구조는 supabase/schema.sql 을 참고하세요.
const db = require('../db');

const name = 'supabase';
const DEFAULT_SETTINGS = { enabled: true, cycle: 'daily' };

// ── DB 행(snake_case) ↔ 앱 객체(camelCase) 변환 ─────────────────
function toMonitor(row) {
  return {
    id: row.id,
    url: row.url,
    enabled: row.enabled,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
  };
}

function toHistory(row) {
  return {
    checkedAt: row.checked_at,
    triggeredBy: row.triggered_by,
    pageTitle: row.page_title,
    total: row.total,
    bySeverity: row.by_severity || {},
    score: row.score,
    grade: row.grade,
    findings: row.findings || [],
  };
}

// ── 설정 (monitor_settings: id=1 한 행만 사용) ──────────────────
async function getSettings() {
  const rows = await db.request('GET', 'monitor_settings', { query: { select: '*', id: 'eq.1' } });
  if (!rows.length) return { ...DEFAULT_SETTINGS };
  return { enabled: rows[0].enabled, cycle: rows[0].cycle };
}

async function updateSettings(next) {
  const current = await getSettings();
  const merged = { id: 1, enabled: current.enabled, cycle: current.cycle, ...next, updated_at: new Date().toISOString() };
  const rows = await db.request('POST', 'monitor_settings', {
    query: { on_conflict: 'id' },
    body: merged,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return { enabled: rows[0].enabled, cycle: rows[0].cycle };
}

// ── 모니터링 대상 URL (monitors) ────────────────────────────────
async function listMonitorRows() {
  const rows = await db.request('GET', 'monitors', { query: { select: '*', order: 'created_at.asc' } });
  return rows.map(toMonitor);
}

async function getMonitorRow(id) {
  const rows = await db.request('GET', 'monitors', { query: { select: '*', id: `eq.${id}` } });
  return rows.length ? toMonitor(rows[0]) : null;
}

async function insertMonitor(url) {
  try {
    const rows = await db.request('POST', 'monitors', {
      body: { url },
      prefer: 'return=representation',
    });
    return toMonitor(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Error('이미 등록된 URL입니다.'); // unique 위반
    throw err;
  }
}

async function deleteMonitor(id) {
  // check_history는 on delete cascade로 함께 삭제됩니다.
  const rows = await db.request('DELETE', 'monitors', {
    query: { id: `eq.${id}` },
    prefer: 'return=representation',
  });
  return rows.length > 0;
}

// ── 검사 이력 (check_history) ───────────────────────────────────
async function insertHistory(monitorId, entry) {
  await db.request('POST', 'check_history', {
    body: {
      monitor_id: monitorId,
      checked_at: entry.checkedAt,
      triggered_by: entry.triggeredBy,
      page_title: entry.pageTitle,
      total: entry.total,
      by_severity: entry.bySeverity,
      score: entry.score,
      grade: entry.grade,
      findings: entry.findings,
    },
    prefer: 'return=minimal',
  });

  // 마지막 검사 시각 갱신 + 이전 오류 상태 해제
  await db.request('PATCH', 'monitors', {
    query: { id: `eq.${monitorId}` },
    body: { last_checked_at: entry.checkedAt, last_error: null, last_error_at: null },
    prefer: 'return=minimal',
  });
}

async function setMonitorError(monitorId, message) {
  await db.request('PATCH', 'monitors', {
    query: { id: `eq.${monitorId}` },
    body: { last_error: message, last_error_at: new Date().toISOString() },
    prefer: 'return=minimal',
  });
}

async function getHistory(monitorId, limit = 100) {
  const rows = await db.request('GET', 'check_history', {
    query: { select: '*', monitor_id: `eq.${monitorId}`, order: 'checked_at.desc', limit: String(limit) },
  });
  return rows.map(toHistory);
}

// 가장 최근 1건 + 전체 건수를 요청 1번으로 가져옵니다 (Content-Range 헤더에 전체 건수가 담겨 옴).
async function getHistorySummary(monitorId) {
  const { data, headers } = await db.request('GET', 'check_history', {
    query: { select: '*', monitor_id: `eq.${monitorId}`, order: 'checked_at.desc', limit: '1' },
    prefer: 'count=exact',
    returnHeaders: true,
  });
  const range = headers.get('content-range') || ''; // 예: "0-0/12" 또는 "*/0"
  const match = range.match(/\/(\d+)$/);
  return {
    latest: data.length ? toHistory(data[0]) : null,
    count: match ? Number(match[1]) : data.length,
  };
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
