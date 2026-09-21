const monitorsStore = require('./monitors');
const serverConfig = require('./serverConfig');
const { runFullCheckAutomated, fetchContentHash } = require('./checkRunner');

// 실제 점검 주기는 관리자가 monitorsStore 설정(pollIntervalMinutes)으로 조정합니다.
// 이 값을 그때그때 반영하기 위해, 짧은 주기(1분)로 깨어나서 "이번엔 실제로 점검할 때가 됐는지"만 확인합니다.
// (이렇게 하면 관리자가 주기를 바꿔도 타이머를 재시작할 필요 없이 바로 반영됩니다.)
const HEARTBEAT_MS = 60 * 1000;

let schedulerStarted = false;
let lastPollAt = 0;

function startScheduler() {
  if (schedulerStarted) return; // 중복 시작 방지
  schedulerStarted = true;
  setInterval(() => {
    heartbeat().catch((err) => console.error('스케줄러 오류:', err.message));
  }, HEARTBEAT_MS);
  console.log('모니터링 스케줄러 시작됨 (1분마다 실행 여부 확인)');
}

async function heartbeat() {
  const settings = monitorsStore.getSettings();
  if (!settings.enabled) return; // 관리자가 꺼둔 경우 아무것도 하지 않음

  const intervalMs = settings.pollIntervalMinutes * 60 * 1000;
  const now = Date.now();
  if (now - lastPollAt < intervalMs) return; // 아직 설정된 주기가 안 지남
  lastPollAt = now;

  await tick();
}

async function tick() {
  const cfg = serverConfig.getRuntimeConfig();
  if (!cfg.apiKey) return; // 관리자 키가 없으면 자동 검사를 실행할 수 없음

  for (const monitor of monitorsStore.monitors.values()) {
    if (!monitor.enabled) continue;
    try {
      await checkOneMonitor(monitor, cfg, {});
    } catch (err) {
      monitorsStore.recordCheck(monitor.id, {
        checkedAt: new Date().toISOString(),
        triggeredBy: 'schedule',
        error: err.message,
      });
    }
  }
}

// force가 true면 변경 여부/주기와 상관없이 즉시 정식 검사를 실행합니다 (관리자의 "지금 검사" 버튼용).
async function checkOneMonitor(monitor, cfg, { force = false } = {}) {
  const now = Date.now();
  const lastChecked = monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).getTime() : 0;
  const dueForDaily = now - lastChecked >= monitorsStore.DAILY_INTERVAL_MS;

  let shouldRunFull = force || dueForDaily;
  let triggeredBy = force ? 'manual' : dueForDaily ? 'schedule' : null;

  if (!shouldRunFull) {
    // AI 호출 없이 페이지 내용만 가볍게 확인해 변경 여부 판단
    const hash = await fetchContentHash(monitor.url);
    if (monitor.lastContentHash && hash !== monitor.lastContentHash) {
      shouldRunFull = true;
      triggeredBy = 'change';
    }
    monitorsStore.setContentHash(monitor.id, hash);
  }

  if (!shouldRunFull) return null;

  const result = await runFullCheckAutomated({
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    model: cfg.model,
    url: monitor.url,
  });

  const bySeverity = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  result.findings.forEach((f) => {
    if (bySeverity[f.severity] !== undefined) bySeverity[f.severity] += 1;
  });

  const entry = {
    checkedAt: new Date().toISOString(),
    triggeredBy,
    pageTitle: result.pageTitle,
    total: result.findings.length,
    bySeverity,
    score: result.score,
    grade: result.grade,
    // 상세 설명/스크린샷은 메모리 절약을 위해 제외하고, 목록 표시에 필요한 정보만 저장합니다.
    findings: result.findings.map((f) => ({ ruleId: f.ruleId, title: f.title, severity: f.severity })),
  };

  monitorsStore.recordCheck(monitor.id, entry);
  return entry;
}

module.exports = { startScheduler, checkOneMonitor, tick, heartbeat };
