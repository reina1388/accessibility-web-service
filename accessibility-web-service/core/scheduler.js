const monitorsStore = require('./monitors');
const serverConfig = require('./serverConfig');
const { runFullCheckAutomated } = require('./checkRunner');

// 선택한 주기(하루/일주일/2주/한 달)는 최소 하루 단위라서, 자주 깨어날 필요가 없습니다.
// 10분마다 "검사할 때가 된 URL이 있는지"만 가볍게 확인합니다.
const HEARTBEAT_MS = 10 * 60 * 1000;

// 검사가 실패한 URL은 다음 주기(최대 한 달)까지 기다리지 않고, 이 간격 뒤에 다시 시도합니다.
const RETRY_AFTER_ERROR_MS = 60 * 60 * 1000;

let schedulerStarted = false;
let running = false; // 이전 점검이 아직 끝나지 않았으면 겹쳐 실행하지 않음
const lastAttempt = new Map(); // monitorId -> 마지막 시도 시각(메모리, 재시작 시 초기화)

function startScheduler() {
  if (schedulerStarted) return; // 중복 시작 방지
  schedulerStarted = true;
  setInterval(() => {
    heartbeat().catch((err) => console.error('스케줄러 오류:', err.message));
  }, HEARTBEAT_MS);
  console.log(`모니터링 스케줄러 시작됨 (저장소: ${monitorsStore.storageName()}, ${HEARTBEAT_MS / 60000}분마다 확인)`);
}

async function heartbeat(now = Date.now()) {
  if (running) return [];
  running = true;
  const executed = [];
  try {
    const settings = await monitorsStore.getSettings();
    if (!settings.enabled) return executed; // 관리자가 꺼둔 경우

    const cfg = serverConfig.getRuntimeConfig();
    if (!cfg.apiKey) return executed; // 관리자 키가 없으면 자동 검사를 실행할 수 없음

    const cycleMs = monitorsStore.CYCLES[settings.cycle].ms;
    const monitors = await monitorsStore.listMonitorRows();

    for (const monitor of monitors) {
      if (!monitor.enabled) continue;

      const due = !monitor.lastCheckedAt || now - Date.parse(monitor.lastCheckedAt) >= cycleMs;
      if (!due) continue;

      // 방금 실패했다면 잠시 쉬었다가 재시도
      const attempted = lastAttempt.get(monitor.id) || 0;
      if (now - attempted < RETRY_AFTER_ERROR_MS) continue;
      lastAttempt.set(monitor.id, now);

      try {
        await runCheck(monitor, cfg, 'schedule');
        executed.push(monitor.id);
      } catch (err) {
        console.error(`모니터링 검사 실패 (${monitor.url}):`, err.message);
      }
    }
  } finally {
    running = false;
  }
  return executed;
}

// 정식 검사를 실행하고 결과를 저장합니다. 실패하면 오류 상태를 저장하고 예외를 다시 던집니다.
// triggeredBy: 'schedule'(자동) | 'manual'(관리자가 "지금 검사" 클릭)
async function runCheck(monitor, cfg, triggeredBy) {
  try {
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
      // 상세 설명/스크린샷은 제외하고, 목록·대시보드 표시에 필요한 정보만 저장합니다.
      findings: result.findings.map((f) => ({ ruleId: f.ruleId, title: f.title, severity: f.severity })),
    };

    await monitorsStore.recordCheck(monitor.id, entry);
    return entry;
  } catch (err) {
    await monitorsStore.recordError(monitor.id, err.message).catch(() => {});
    throw err;
  }
}

module.exports = { startScheduler, heartbeat, runCheck };
