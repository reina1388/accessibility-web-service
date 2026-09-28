const loginPanel = document.getElementById('login-panel');
const configPanel = document.getElementById('config-panel');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const loginMsg = document.getElementById('login-msg');

const providerSelect = document.getElementById('provider');
const modelSelect = document.getElementById('model');
const apiKeyInput = document.getElementById('api-key');
const apiKeyLabel = document.getElementById('api-key-label');
const keyStatusEl = document.getElementById('key-status');
const keyPanelDescEl = document.getElementById('key-panel-desc');
const modeRadios = document.querySelectorAll('input[name="mode"]');
const saveBtn = document.getElementById('save-btn');
const saveMsg = document.getElementById('save-msg');

const cacheCountEl = document.getElementById('cache-count');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const cacheMsg = document.getElementById('cache-msg');

const monitorMaxEl = document.getElementById('monitor-max');
const monitorUrlInput = document.getElementById('monitor-url');
const monitorAddBtn = document.getElementById('monitor-add-btn');
const monitorMsgEl = document.getElementById('monitor-msg');
const monitorListEl = document.getElementById('monitor-list');
const monitorEnabledToggle = document.getElementById('monitor-enabled-toggle');
const monitorCycleSelect = document.getElementById('monitor-cycle');
const storageNoteEl = document.getElementById('storage-note');
const dashboardPanel = document.getElementById('dashboard-panel');
const dashRefreshBtn = document.getElementById('dash-refresh-btn');
const dashMsgEl = document.getElementById('dash-msg');
const dashSummaryEl = document.getElementById('dash-summary');
const dashTableEl = document.getElementById('dash-table');
const dashTopEl = document.getElementById('dash-top');
const monitorSettingsSaveBtn = document.getElementById('monitor-settings-save-btn');
const monitorSettingsMsgEl = document.getElementById('monitor-settings-msg');

const SEVERITY_LABEL = { critical: '심각', serious: '높음', moderate: '보통', minor: '낮음' };
const TRIGGER_LABEL = { schedule: '정기 검사', change: '변경 감지', manual: '수동 실행' };
const GRADE_CLASS = { A: 'a', B: 'b', C: 'c', D: 'd' };

const MODELS = {
  gemini: [
    { value: 'gemini-3.6-flash', label: 'gemini-3.6-flash (권장, 무료 티어)' },
    { value: 'gemini-3.5-flash', label: 'gemini-3.5-flash (무료 티어)' },
    { value: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite (가장 빠르고 저렴, 무료 티어)' },
    { value: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview (가장 정교함, 무료 티어 없음)' },
  ],
  claude: [
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5 (권장)' },
    { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5 (빠르고 저렴)' },
    { value: 'claude-opus-4-8', label: 'claude-opus-4-8 (가장 정교함)' },
  ],
  openai: [
    { value: 'gpt-5.5', label: 'gpt-5.5 (권장)' },
    { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini (빠르고 저렴)' },
    { value: 'gpt-4.1', label: 'gpt-4.1 (안정적인 구버전)' },
  ],
};

function populateModels(provider, selected) {
  modelSelect.innerHTML = '';
  MODELS[provider].forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  });
  if (selected) modelSelect.value = selected;
}

providerSelect.addEventListener('change', () => populateModels(providerSelect.value));

function getSelectedMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'admin';
}

function setSelectedMode(mode) {
  modeRadios.forEach((r) => {
    r.checked = r.value === mode;
  });
  updateModeUI(mode);
}

function updateModeUI(mode) {
  if (mode === 'visitor') {
    keyPanelDescEl.textContent =
      '이 모드에서는 방문자가 직접 공급자/모델/API 키를 입력해야 검사할 수 있습니다. 아래 공급자/모델은 방문자 화면의 추천 기본값으로만 쓰이고, API 키는 방문자 검사에 사용되지 않습니다.';
    apiKeyLabel.textContent = 'API 키 (이 모드에서는 사용되지 않음, 비워두어도 됩니다)';
  } else {
    keyPanelDescEl.textContent =
      '이 모드에서는 방문자가 아무것도 입력하지 않아도, 아래 설정된 공급자/모델/API 키로 검사가 진행됩니다. 검사 비용은 관리자에게 청구됩니다.';
    apiKeyLabel.textContent = 'API 키';
  }
}

modeRadios.forEach((r) => r.addEventListener('change', () => updateModeUI(getSelectedMode())));

function getToken() {
  return sessionStorage.getItem('admin_token');
}

function setToken(token) {
  sessionStorage.setItem('admin_token', token);
}

async function authedFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(url, { ...options, headers });
}

loginBtn.addEventListener('click', handleLogin);
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});

async function handleLogin() {
  loginMsg.textContent = '로그인 중...';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '로그인 실패');

    setToken(data.token);
    loginMsg.textContent = '';
    passwordInput.value = '';
    await enterConfigPanel();
  } catch (err) {
    loginMsg.textContent = `오류: ${err.message}`;
  }
}

async function enterConfigPanel() {
  loginPanel.hidden = true;
  configPanel.hidden = false;
  dashboardPanel.hidden = false;
  await loadConfig();
  await refreshCacheCount();
  await refreshMonitors();
  await refreshDashboard();
}

async function loadConfig() {
  try {
    const res = await authedFetch('/api/admin/config');
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    setSelectedMode(data.mode);
    providerSelect.value = data.provider;
    populateModels(data.provider, data.model);
    keyStatusEl.textContent = data.hasApiKey
      ? '✓ API 키가 설정되어 있습니다. (보안을 위해 실제 값은 표시하지 않습니다)'
      : '⚠ 아직 API 키가 설정되지 않았습니다. 관리자 키 모드에서는 방문자 검사가 동작하지 않습니다.';
  } catch (err) {
    saveMsg.textContent = `설정을 불러오지 못했습니다: ${err.message}`;
  }
}

saveBtn.addEventListener('click', handleSave);

async function handleSave() {
  saveBtn.disabled = true;
  saveMsg.textContent = '저장 중...';
  try {
    const body = {
      mode: getSelectedMode(),
      provider: providerSelect.value,
      model: modelSelect.value,
    };
    if (apiKeyInput.value.trim()) body.apiKey = apiKeyInput.value.trim();

    const res = await authedFetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '저장 실패');

    apiKeyInput.value = '';
    keyStatusEl.textContent = data.hasApiKey
      ? '✓ API 키가 설정되어 있습니다. (보안을 위해 실제 값은 표시하지 않습니다)'
      : '⚠ 아직 API 키가 설정되지 않았습니다.';
    saveMsg.textContent = '저장되었습니다.';
    setTimeout(() => (saveMsg.textContent = ''), 2500);
  } catch (err) {
    saveMsg.textContent = `오류: ${err.message}`;
  } finally {
    saveBtn.disabled = false;
  }
}

async function refreshCacheCount() {
  try {
    const res = await fetch('/api/cache-status');
    const data = await res.json();
    cacheCountEl.textContent = data.size;
  } catch (e) {
    cacheCountEl.textContent = '-';
  }
}

clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.disabled = true;
  try {
    const res = await authedFetch('/api/cache-clear', { method: 'POST' });
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    cacheMsg.textContent = `${data.cleared ?? ''}건 삭제되었습니다.`.trim();
    await refreshCacheCount();
    setTimeout(() => (cacheMsg.textContent = ''), 2500);
  } catch (err) {
    cacheMsg.textContent = `오류: ${err.message}`;
  } finally {
    clearCacheBtn.disabled = false;
  }
});

function logout() {
  sessionStorage.removeItem('admin_token');
  configPanel.hidden = true;
  dashboardPanel.hidden = true;
  loginPanel.hidden = false;
  loginMsg.textContent = '로그인이 만료되었습니다. 다시 로그인해주세요.';
}

// ── 정기 모니터링 ────────────────────────────────────────────
monitorAddBtn.addEventListener('click', handleAddMonitor);
monitorUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleAddMonitor();
});

async function handleAddMonitor() {
  const url = monitorUrlInput.value.trim();
  if (!url) return;

  monitorAddBtn.disabled = true;
  monitorMsgEl.textContent = '등록 중...';
  try {
    const res = await authedFetch('/api/admin/monitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '등록 실패');

    monitorUrlInput.value = '';
    monitorMsgEl.textContent = '등록되었습니다. 다음 확인 시점(최대 10분 이내)에 첫 검사가 실행됩니다.';
    setTimeout(() => (monitorMsgEl.textContent = ''), 4000);
    await refreshMonitors();
    await refreshDashboard();
  } catch (err) {
    monitorMsgEl.textContent = `오류: ${err.message}`;
  } finally {
    monitorAddBtn.disabled = false;
  }
}

async function refreshMonitors() {
  try {
    const res = await authedFetch('/api/admin/monitors');
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    monitorMaxEl.textContent = data.max;
    if (data.settings) {
      monitorEnabledToggle.checked = !!data.settings.enabled;
      monitorCycleSelect.value = data.settings.cycle;
    }
    if (data.storage) {
      storageNoteEl.textContent =
        data.storage === 'supabase'
          ? '💾 저장소: Supabase DB — 서버가 재시작되어도 등록 URL과 검사 이력이 유지됩니다.'
          : '⚠️ 저장소: 메모리 — 서버가 재시작되면 등록 URL과 검사 이력이 사라집니다. (Supabase 환경변수를 설정하면 DB에 저장됩니다.)';
    }
    renderMonitorList(data.monitors);
  } catch (err) {
    monitorListEl.innerHTML = `<p class="hint">목록을 불러오지 못했습니다: ${escapeHtml(err.message)}</p>`;
  }
}

monitorSettingsSaveBtn.addEventListener('click', handleSaveMonitorSettings);

async function handleSaveMonitorSettings() {
  monitorSettingsSaveBtn.disabled = true;
  monitorSettingsMsgEl.textContent = '저장 중...';
  try {
    const res = await authedFetch('/api/admin/monitors/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: monitorEnabledToggle.checked,
        cycle: monitorCycleSelect.value,
      }),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '저장 실패');

    monitorCycleSelect.value = data.settings.cycle;
    monitorEnabledToggle.checked = data.settings.enabled;
    monitorSettingsMsgEl.textContent = '저장되었습니다.';
    refreshMonitors();
    refreshDashboard();
    setTimeout(() => (monitorSettingsMsgEl.textContent = ''), 2500);
  } catch (err) {
    monitorSettingsMsgEl.textContent = `오류: ${err.message}`;
  } finally {
    monitorSettingsSaveBtn.disabled = false;
  }
}

function renderMonitorList(monitors) {
  if (!monitors.length) {
    monitorListEl.innerHTML = '<p class="hint">등록된 URL이 없습니다.</p>';
    return;
  }

  monitorListEl.innerHTML = '';
  monitors.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'monitor-card';

    const latest = m.latest;
    const badgeClass = !latest
      ? 'monitor-badge--none'
      : latest.total > 0
        ? severityBadgeClass(latest)
        : 'monitor-badge--none';
    const badgeText = !latest ? '검사 전' : latest.error ? '오류' : `위반 ${latest.total}건`;
    const lastCheckedText = m.lastCheckedAt ? new Date(m.lastCheckedAt).toLocaleString('ko-KR') : '아직 검사 안 함';

    card.innerHTML = `
      <div class="monitor-card__header">
        <div>
          <div class="monitor-card__url">${escapeHtml(m.url)}</div>
          <p class="monitor-card__meta">
            <span class="monitor-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
            마지막 검사: ${lastCheckedText} · 등급 ${latest && latest.grade ? escapeHtml(latest.grade) : '-'}
          </p>
          <p class="monitor-card__meta">다음 검사 예정: ${escapeHtml(formatNextCheck(m.nextCheckAt, m.lastCheckedAt))}</p>
          ${m.lastError ? `<p class="monitor-card__meta monitor-card__error">최근 오류: ${escapeHtml(m.lastError)} (1시간 뒤 자동 재시도)</p>` : ''}
        </div>
        <div class="monitor-card__actions">
          <button type="button" class="btn btn--ghost" data-action="history">이력 (${m.historyCount})</button>
          <button type="button" class="btn btn--secondary" data-action="check-now">지금 검사</button>
          <button type="button" class="btn btn--ghost" data-action="remove">삭제</button>
        </div>
      </div>
      <div class="monitor-history" data-history-panel hidden></div>
    `;

    card.querySelector('[data-action="check-now"]').addEventListener('click', () => handleCheckNow(m.id, card));
    card.querySelector('[data-action="remove"]').addEventListener('click', () => handleRemoveMonitor(m.id));
    card.querySelector('[data-action="history"]').addEventListener('click', () => toggleHistory(m.id, card));

    monitorListEl.appendChild(card);
  });
}

function severityBadgeClass(entry) {
  if (entry.bySeverity) {
    if (entry.bySeverity.critical > 0) return 'monitor-badge--critical';
    if (entry.bySeverity.serious > 0) return 'monitor-badge--serious';
    if (entry.bySeverity.moderate > 0) return 'monitor-badge--moderate';
    if (entry.bySeverity.minor > 0) return 'monitor-badge--minor';
  }
  return 'monitor-badge--none';
}

async function handleCheckNow(id, card) {
  const btn = card.querySelector('[data-action="check-now"]');
  btn.disabled = true;
  btn.textContent = '검사 중...';
  try {
    const res = await authedFetch(`/api/admin/monitors/${id}/check-now`, { method: 'POST' });
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '검사 실패');
    await refreshMonitors();
    await refreshDashboard();
  } catch (err) {
    monitorMsgEl.textContent = `오류: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '지금 검사';
  }
}

async function handleRemoveMonitor(id) {
  try {
    const res = await authedFetch(`/api/admin/monitors/${id}`, { method: 'DELETE' });
    if (res.status === 401) {
      logout();
      return;
    }
    await refreshMonitors();
    await refreshDashboard();
  } catch (err) {
    monitorMsgEl.textContent = `오류: ${err.message}`;
  }
}

async function toggleHistory(id, card) {
  const panel = card.querySelector('[data-history-panel]');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  panel.innerHTML = '<p class="hint">불러오는 중...</p>';

  try {
    const res = await authedFetch(`/api/admin/monitors/${id}/history`);
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    renderHistory(panel, data.history);
  } catch (err) {
    panel.innerHTML = `<p class="hint">이력을 불러오지 못했습니다: ${escapeHtml(err.message)}</p>`;
  }
}

function renderHistory(panel, history) {
  if (!history.length) {
    panel.innerHTML = '<p class="hint">아직 검사 이력이 없습니다.</p>';
    return;
  }

  panel.innerHTML = history
    .map((h) => {
      if (h.error) {
        return `<div class="monitor-history-row">
          <span class="trigger-tag">${escapeHtml(TRIGGER_LABEL[h.triggeredBy] || h.triggeredBy)}</span>
          <span>${new Date(h.checkedAt).toLocaleString('ko-KR')}</span>
          <span>오류: ${escapeHtml(h.error)}</span>
        </div>`;
      }
      const types = (h.findings || [])
        .map((f) => `${escapeHtml(f.title)}(${escapeHtml(SEVERITY_LABEL[f.severity] || f.severity)})`)
        .join(', ');
      return `<div class="monitor-history-row">
        <span class="trigger-tag">${escapeHtml(TRIGGER_LABEL[h.triggeredBy] || h.triggeredBy)}</span>
        <span>${new Date(h.checkedAt).toLocaleString('ko-KR')}</span>
        <span>위반 ${h.total}건 (등급 ${escapeHtml(h.grade || '-')})</span>
        ${types ? `<span>· ${types}</span>` : ''}
      </div>`;
    })
    .join('');
}

// ── 대시보드 ───────────────────────────────────────────────
dashRefreshBtn.addEventListener('click', refreshDashboard);

function formatNextCheck(nextCheckAt, lastCheckedAt) {
  if (!lastCheckedAt) return '곧 (다음 확인 시점에 첫 검사)';
  if (!nextCheckAt) return '-';
  const t = Date.parse(nextCheckAt);
  const label = new Date(t).toLocaleString('ko-KR');
  return t <= Date.now() ? `${label} (기한 지남 — 곧 실행)` : label;
}

async function refreshDashboard() {
  dashMsgEl.textContent = '불러오는 중...';
  try {
    const res = await authedFetch('/api/admin/dashboard');
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '대시보드를 불러오지 못했습니다.');
    dashMsgEl.textContent = '';
    renderDashboard(data);
  } catch (err) {
    dashMsgEl.textContent = `오류: ${err.message}`;
  }
}

// 최근 검사들의 위반 건수를 작은 막대 그래프로 (오래된 것 → 최신)
function trendBars(trend) {
  if (!trend || !trend.length) return '<span class="hint">-</span>';
  const max = Math.max(...trend.map((t) => t.total), 1);
  const barW = 8;
  const gap = 3;
  const h = 28;
  const bars = trend
    .map((t, i) => {
      const bh = Math.max(2, Math.round((t.total / max) * (h - 2)));
      const x = i * (barW + gap);
      const title = `${new Date(t.checkedAt).toLocaleDateString('ko-KR')} · 위반 ${t.total}건`;
      return `<rect x="${x}" y="${h - bh}" width="${barW}" height="${bh}" rx="1.5" fill="#2455c9"><title>${escapeHtml(title)}</title></rect>`;
    })
    .join('');
  const w = trend.length * (barW + gap) - gap;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="최근 ${trend.length}회 위반 건수 추이">${bars}</svg>`;
}

function severityChips(bySeverity) {
  const order = ['critical', 'serious', 'moderate', 'minor'];
  const chips = order
    .filter((sev) => bySeverity && bySeverity[sev] > 0)
    .map((sev) => `<span class="monitor-badge monitor-badge--${sev}">${SEVERITY_LABEL[sev]} ${bySeverity[sev]}</span>`)
    .join('');
  return chips || '<span class="monitor-badge monitor-badge--none">없음</span>';
}

function renderDashboard(d) {
  const t = d.totals;
  const gradeText = d.monitors.length ? '' : '';

  dashSummaryEl.innerHTML = `
    <div class="dash-card"><div class="dash-card__num">${t.monitorCount}</div><div class="dash-card__label">모니터링 URL</div></div>
    <div class="dash-card"><div class="dash-card__num">${t.totalViolations}</div><div class="dash-card__label">현재 위반 합계<br/>(각 URL 최근 검사 기준)</div></div>
    <div class="dash-card"><div class="dash-card__num">${t.avgScore === null ? '-' : t.avgScore}</div><div class="dash-card__label">평균 점수${gradeText}</div></div>
    <div class="dash-card"><div class="dash-card__num dash-card__num--sm">${escapeHtml(d.settings.cycleLabel)}</div><div class="dash-card__label">검사 주기${d.settings.enabled ? '' : ' (꺼짐)'}</div></div>
  `;

  if (!d.monitors.length) {
    dashTableEl.innerHTML = '<p class="hint">등록된 URL이 없습니다. 아래 "정기 모니터링"에서 URL을 등록해주세요.</p>';
    dashTopEl.innerHTML = '';
    return;
  }

  const rows = d.monitors
    .map((m) => {
      const l = m.latest;
      const grade = l && l.grade ? `<span class="grade-pill grade-pill--${GRADE_CLASS[l.grade] || 'd'}">${escapeHtml(l.grade)}</span>` : '-';
      const status = l
        ? `<div>${new Date(l.checkedAt).toLocaleString('ko-KR')}</div>`
        : '<div class="hint">검사 전</div>';
      const err = m.lastError ? `<div class="monitor-card__error">오류: ${escapeHtml(m.lastError)}</div>` : '';
      return `<tr>
        <td class="dash-url">${escapeHtml(m.url)}${err}</td>
        <td>${status}<div class="hint">이력 ${m.historyCount}건</div></td>
        <td>${l ? `<strong>${l.total}건</strong><div>${severityChips(l.bySeverity)}</div>` : '-'}</td>
        <td>${grade}${l && typeof l.score === 'number' ? `<div class="hint">${l.score}점</div>` : ''}</td>
        <td>${trendBars(m.trend)}</td>
        <td class="hint">${escapeHtml(formatNextCheck(m.nextCheckAt, m.lastCheckedAt))}</td>
      </tr>`;
    })
    .join('');

  dashTableEl.innerHTML = `
    <div class="dash-scroll">
      <table class="dash-table">
        <thead><tr><th>URL</th><th>최근 검사</th><th>위반</th><th>등급</th><th>추이(최근 10회)</th><th>다음 검사</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  if (!d.topViolations.length) {
    dashTopEl.innerHTML = '';
    return;
  }
  const top = d.topViolations
    .map(
      (v) => `<li>
        <span class="monitor-badge monitor-badge--${v.severity}">${escapeHtml(SEVERITY_LABEL[v.severity] || v.severity)}</span>
        ${escapeHtml(v.title)} <span class="hint">— ${v.monitorCount}개 URL에서 발견</span>
      </li>`
    )
    .join('');
  dashTopEl.innerHTML = `<p class="dash-section-title">가장 많이 발견된 위반 유형 TOP ${d.topViolations.length}</p><ol class="dash-top">${top}</ol>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 페이지를 열었을 때 이미 로그인되어 있으면(같은 브라우저 탭) 바로 설정 화면으로
if (getToken()) {
  enterConfigPanel();
}
