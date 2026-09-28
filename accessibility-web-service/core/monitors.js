const db = require('./db');
const memoryStore = require('./stores/memoryStore');
const supabaseStore = require('./stores/supabaseStore');

const MAX_MONITORS = 5; // 서버 자원 보호를 위한 등록 상한

const DAY_MS = 24 * 60 * 60 * 1000;

// 관리자가 선택할 수 있는 검사 주기 (한 달은 편의상 30일로 계산합니다)
const CYCLES = {
  daily: { label: '하루', ms: 1 * DAY_MS },
  weekly: { label: '일주일', ms: 7 * DAY_MS },
  biweekly: { label: '2주', ms: 14 * DAY_MS },
  monthly: { label: '한 달(30일)', ms: 30 * DAY_MS },
};

const SEVERITY_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };

// Supabase 환경변수가 있으면 DB, 없으면 메모리를 사용합니다.
let store = db.isConfigured() ? supabaseStore : memoryStore;

// 테스트용: 저장소를 바꿔 끼울 수 있습니다.
function useStore(nextStore) {
  store = nextStore;
}

function storageName() {
  return store.name;
}

function cycleList() {
  return Object.entries(CYCLES).map(([key, v]) => ({ key, label: v.label }));
}

// ── 설정 ────────────────────────────────────────────────────
async function getSettings() {
  const s = await store.getSettings();
  const cycle = CYCLES[s.cycle] ? s.cycle : 'daily';
  return { enabled: Boolean(s.enabled), cycle, cycleLabel: CYCLES[cycle].label };
}

async function updateSettings({ enabled, cycle } = {}) {
  const next = {};
  if (typeof enabled === 'boolean') next.enabled = enabled;
  if (cycle !== undefined) {
    if (!CYCLES[cycle]) throw new Error('검사 주기는 하루 / 일주일 / 2주 / 한 달 중에서 선택해주세요.');
    next.cycle = cycle;
  }
  await store.updateSettings(next);
  invalidatePublicDashboard();
  return getSettings();
}

// ── 모니터링 대상 ────────────────────────────────────────────
async function addMonitor(url) {
  const rows = await store.listMonitorRows();
  if (rows.length >= MAX_MONITORS) {
    throw new Error(`등록 가능한 모니터링 URL은 최대 ${MAX_MONITORS}개입니다.`);
  }
  if (rows.some((r) => r.url === url)) throw new Error('이미 등록된 URL입니다.');
  const created = await store.insertMonitor(url);
  invalidatePublicDashboard();
  return created;
}

async function removeMonitor(id) {
  const removed = await store.deleteMonitor(id);
  invalidatePublicDashboard();
  return removed;
}

function getMonitor(id) {
  return store.getMonitorRow(id);
}

function listMonitorRows() {
  return store.listMonitorRows();
}

// 마지막 검사 시각 + 선택된 주기 = 다음 검사 예정 시각 (아직 검사 전이면 null → "곧 실행")
function nextCheckAt(monitor, cycleKey) {
  if (!monitor.lastCheckedAt) return null;
  return new Date(Date.parse(monitor.lastCheckedAt) + CYCLES[cycleKey].ms).toISOString();
}

// 관리자 화면의 URL 카드 목록용 (최근 검사 요약 + 이력 건수 포함)
async function listMonitors() {
  const [settings, rows] = await Promise.all([getSettings(), store.listMonitorRows()]);
  return Promise.all(
    rows.map(async (m) => {
      const { latest, count } = await store.getHistorySummary(m.id);
      return { ...m, latest, historyCount: count, nextCheckAt: nextCheckAt(m, settings.cycle) };
    })
  );
}

function getHistory(id, limit = 100) {
  return store.getHistory(id, limit);
}

async function recordCheck(id, entry) {
  await store.insertHistory(id, entry);
  invalidatePublicDashboard();
}

async function recordError(id, message) {
  await store.setMonitorError(id, message);
  invalidatePublicDashboard();
}

// ── 대시보드 집계 ────────────────────────────────────────────
async function buildDashboard({ includeFindings = false } = {}) {
  const settings = await getSettings();
  const rows = await store.listMonitorRows();

  const monitors = await Promise.all(
    rows.map(async (m) => {
      const [summary, recent] = await Promise.all([store.getHistorySummary(m.id), store.getHistory(m.id, 10)]);
      const latest = summary.latest;
      return {
        id: m.id,
        url: m.url,
        lastCheckedAt: m.lastCheckedAt,
        lastError: m.lastError,
        lastErrorAt: m.lastErrorAt,
        nextCheckAt: nextCheckAt(m, settings.cycle),
        historyCount: summary.count,
        latest: latest
          ? {
              checkedAt: latest.checkedAt,
              total: latest.total,
              bySeverity: latest.bySeverity,
              score: latest.score,
              grade: latest.grade,
              pageTitle: latest.pageTitle,
            }
          : null,
        // 오래된 것 → 최신 순 (추이 그래프용)
        trend: recent
          .slice()
          .reverse()
          .map((h) => ({ checkedAt: h.checkedAt, total: h.total, triggeredBy: h.triggeredBy, grade: h.grade })),
        latestFindings: latest ? latest.findings : [],
      };
    })
  );

  // 전체 합계
  const checked = monitors.filter((m) => m.latest);
  const bySeverity = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let totalViolations = 0;
  const scores = [];
  checked.forEach((m) => {
    totalViolations += m.latest.total || 0;
    Object.keys(bySeverity).forEach((sev) => {
      bySeverity[sev] += (m.latest.bySeverity && m.latest.bySeverity[sev]) || 0;
    });
    if (typeof m.latest.score === 'number') scores.push(m.latest.score);
  });

  // 자주 나온 위반 유형: 각 URL의 "최근 검사" 결과 기준, URL 단위로 한 번씩만 집계
  const violationMap = new Map();
  monitors.forEach((m) => {
    const seenInThisMonitor = new Set();
    (m.latestFindings || []).forEach((f) => {
      const key = f.ruleId || f.title;
      if (seenInThisMonitor.has(key)) return;
      seenInThisMonitor.add(key);
      const prev = violationMap.get(key);
      const rank = SEVERITY_RANK[f.severity] ?? 9;
      if (!prev) {
        violationMap.set(key, { ruleId: f.ruleId, title: f.title, severity: f.severity, rank, monitorCount: 1 });
      } else {
        prev.monitorCount += 1;
        if (rank < prev.rank) {
          prev.rank = rank;
          prev.severity = f.severity;
        }
      }
    });
  });
  const topViolations = Array.from(violationMap.values())
    .sort((a, b) => b.monitorCount - a.monitorCount || a.rank - b.rank)
    .slice(0, 5)
    .map(({ ruleId, title, severity, monitorCount }) => ({ ruleId, title, severity, monitorCount }));

  // 전체 URL의 위반 건수 추이를 하나로 합칩니다.
  // 각 URL의 검사 시각이 서로 다르므로, "몇 번째로 최근 검사인지"(순번) 기준으로 맞춰
  // 대략적인 전체 흐름만 보여줍니다 (정밀한 날짜 정렬이 아닙니다).
  const maxTrendLen = Math.max(0, ...monitors.map((m) => m.trend.length));
  const overallTrend = [];
  for (let i = 0; i < maxTrendLen; i++) {
    let sum = 0;
    let any = false;
    monitors.forEach((m) => {
      const point = m.trend[m.trend.length - maxTrendLen + i];
      if (point) {
        sum += point.total;
        any = true;
      }
    });
    if (any) overallTrend.push({ total: sum });
  }

  // 최근 활동: 성공한 검사 이력과, 현재 미해결 상태인 오류를 시각순으로 합칩니다.
  // (오류는 가장 최근 1건만 저장되므로, 해결되기 전까지만 목록에 남습니다.)
  const activity = [];
  monitors.forEach((m) => {
    if (m.latest) {
      activity.push({
        url: m.url,
        checkedAt: m.latest.checkedAt,
        type: 'success',
        total: m.latest.total,
        grade: m.latest.grade,
      });
    }
    if (m.lastError) {
      activity.push({
        url: m.url,
        checkedAt: m.lastErrorAt || m.latest?.checkedAt || null,
        type: 'error',
        message: m.lastError,
      });
    }
  });
  const recentActivity = activity
    .filter((a) => a.checkedAt)
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))
    .slice(0, 8);

  return {
    storage: store.name,
    settings,
    totals: {
      monitorCount: monitors.length,
      checkedCount: checked.length,
      totalViolations,
      bySeverity,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    },
    monitors: monitors.map(({ latestFindings, ...rest }) =>
      includeFindings ? { ...rest, findings: latestFindings } : rest
    ),
    topViolations,
    overallTrend,
    recentActivity,
  };
}

// ── 메인 화면(방문자)용 공개 대시보드 ─────────────────────────────
// 관리자용 집계에서 "공개해도 안전한 정보만" 골라 담습니다.
//   포함: 등록 URL, 최근 검사 결과(위반 건수/종류/등급/점수), 추이, 검사 주기, 다음 검사 예정
//   제외: 내부 ID, 오류 원문(API 오류 등 내부 정보), 저장소 종류, 관리 설정
// DB 부담을 줄이려고 결과를 짧게 캐시합니다 (관리자 조작/검사 결과 저장 시에는 즉시 갱신).
const PUBLIC_CACHE_TTL_MS = 60 * 1000;
let publicCache = { at: 0, data: null };

function invalidatePublicDashboard() {
  publicCache = { at: 0, data: null };
}

function toPublicDashboard(d) {
  return {
    generatedAt: new Date().toISOString(),
    monitoringEnabled: d.settings.enabled,
    cycleLabel: d.settings.cycleLabel,
    totals: {
      monitorCount: d.totals.monitorCount,
      checkedCount: d.totals.checkedCount,
      totalViolations: d.totals.totalViolations,
      avgScore: d.totals.avgScore,
    },
    monitors: d.monitors.map((m) => ({
      url: m.url,
      lastCheckedAt: m.lastCheckedAt,
      nextCheckAt: m.nextCheckAt,
      // 검사 전 / 정상 / 최근 재검사 실패(원문은 숨기고 실패 여부만 표시)
      status: m.latest ? (m.lastError ? 'recheck-failed' : 'ok') : m.lastError ? 'error' : 'pending',
      latest: m.latest
        ? {
            checkedAt: m.latest.checkedAt,
            total: m.latest.total,
            bySeverity: m.latest.bySeverity,
            score: m.latest.score,
            grade: m.latest.grade,
            pageTitle: m.latest.pageTitle,
          }
        : null,
      trend: (m.trend || []).map((t) => ({ checkedAt: t.checkedAt, total: t.total })),
      findings: (m.findings || []).map((f) => ({ ruleId: f.ruleId, title: f.title, severity: f.severity })),
    })),
  };
}

async function buildPublicDashboard() {
  const now = Date.now();
  if (publicCache.data && now - publicCache.at < PUBLIC_CACHE_TTL_MS) return publicCache.data;
  const data = toPublicDashboard(await buildDashboard({ includeFindings: true }));
  publicCache = { at: now, data };
  return data;
}

module.exports = {
  MAX_MONITORS,
  CYCLES,
  cycleList,
  useStore,
  storageName,
  getSettings,
  updateSettings,
  addMonitor,
  removeMonitor,
  getMonitor,
  listMonitorRows,
  listMonitors,
  getHistory,
  recordCheck,
  recordError,
  buildDashboard,
  buildPublicDashboard,
  invalidatePublicDashboard,
};
