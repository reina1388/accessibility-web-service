const form = document.getElementById('check-form');
const urlInput = document.getElementById('url');
const ownProviderSelect = document.getElementById('own-provider');
const ownModelSelect = document.getElementById('own-model');
const ownApiKeyInput = document.getElementById('own-api-key');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const agentLogEl = document.getElementById('agent-log');
const agentLogListEl = document.getElementById('agent-log-list');
const agentLogCountEl = document.getElementById('agent-log-count');
const summaryEl = document.getElementById('summary');
const resultsEl = document.getElementById('results');
const cacheInfoEl = document.getElementById('cache-info');
const continueSectionEl = document.getElementById('continue-section');
const continueTextEl = document.getElementById('continue-text');
const continueBtn = document.getElementById('continue-btn');
const finishBtn = document.getElementById('finish-btn');
const downloadSectionEl = document.getElementById('download-section');
const downloadTxtBtn = document.getElementById('download-txt-btn');
const downloadHtmlBtn = document.getElementById('download-html-btn');

const SEVERITY_LABEL = { critical: '심각', serious: '높음', moderate: '보통', minor: '낮음' };

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

function populateOwnModels(provider, selected) {
  ownModelSelect.innerHTML = '';
  MODELS[provider].forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    ownModelSelect.appendChild(opt);
  });
  if (selected) ownModelSelect.value = selected;
}

ownProviderSelect.addEventListener('change', () => {
  populateOwnModels(ownProviderSelect.value, localStorage.getItem(`a11y_own_model_${ownProviderSelect.value}`));
});

function loadOwnKeySettings() {
  const provider = localStorage.getItem('a11y_own_provider') || 'gemini';
  ownProviderSelect.value = provider;
  populateOwnModels(provider, localStorage.getItem(`a11y_own_model_${provider}`));
  ownApiKeyInput.value = localStorage.getItem(`a11y_own_key_${provider}`) || '';
}

function saveOwnKeySettings() {
  const provider = ownProviderSelect.value;
  localStorage.setItem('a11y_own_provider', provider);
  localStorage.setItem(`a11y_own_model_${provider}`, ownModelSelect.value);
  if (ownApiKeyInput.value.trim()) {
    localStorage.setItem(`a11y_own_key_${provider}`, ownApiKeyInput.value.trim());
  }
}

const ownKeySectionEl = document.getElementById('own-key-section');
const ownKeyDescEl = document.getElementById('own-key-desc');

// 검사량이 많아 잠시 멈춘 경우, 이어서 진행하기 위한 현재 세션 ID
let currentSessionId = null;
let currentUsesOwnKey = false;
let serverMode = 'admin'; // 서버(관리자)가 정한 운영 모드. /api/mode로 조회해서 채워짐.
let lastReport = null; // 완료된 검사 결과 (문서 다운로드용)

initPage();

async function initPage() {
  await loadServerMode();
  loadOwnKeySettings();
  refreshCacheInfo();
}

async function loadServerMode() {
  try {
    const res = await fetch('/api/mode');
    const data = await res.json();
    serverMode = data.mode;

    if (serverMode === 'visitor') {
      ownKeySectionEl.hidden = false;
      ownKeyDescEl.textContent = '이 서비스는 방문자가 직접 API 키를 입력해야 검사할 수 있습니다.';
      ownApiKeyInput.required = true;
      // 관리자가 추천해둔 기본 공급자/모델로 미리 채워줍니다 (방문자가 바꿀 수 있음).
      if (!localStorage.getItem('a11y_own_provider')) {
        ownProviderSelect.value = data.provider;
        populateOwnModels(data.provider, data.model);
      }
    } else {
      ownKeySectionEl.hidden = true;
      ownApiKeyInput.required = false;
    }
  } catch (e) {
    // 조회 실패 시 기본값(관리자 모드)으로 동작 — own-key-section은 숨김 상태 유지
  }
}

form.addEventListener('submit', handleSubmit);
continueBtn.addEventListener('click', handleContinue);
finishBtn.addEventListener('click', handleFinish);
downloadTxtBtn.addEventListener('click', () => {
  if (lastReport) downloadTextReport(lastReport);
});
downloadHtmlBtn.addEventListener('click', () => {
  if (lastReport) downloadHtmlReport(lastReport);
});

async function handleSubmit(e) {
  e.preventDefault();

  if (serverMode === 'visitor' && !ownApiKeyInput.value.trim()) {
    setStatus('이 서비스는 API 키를 입력해야 검사할 수 있습니다.');
    return;
  }

  // 새 검사를 시작하는 것이므로 이전 세션은 버립니다.
  currentSessionId = null;
  currentUsesOwnKey = false;
  lastReport = null;
  continueSectionEl.hidden = true;
  downloadSectionEl.hidden = true;
  resultsEl.innerHTML = '';
  summaryEl.hidden = true;
  agentLogEl.hidden = false;
  agentLogListEl.innerHTML = '';

  const payload = { url: urlInput.value.trim() };
  if (serverMode === 'visitor') {
    saveOwnKeySettings();
    payload.provider = ownProviderSelect.value;
    payload.model = ownModelSelect.value;
    payload.apiKey = ownApiKeyInput.value.trim();
  }

  await runCheck(payload);
}

async function handleContinue() {
  if (!currentSessionId) return;
  continueBtn.disabled = true;
  continueSectionEl.hidden = true;

  const payload = { sessionId: currentSessionId };
  if (currentUsesOwnKey) {
    if (!ownApiKeyInput.value.trim()) {
      setStatus('직접 입력한 키로 시작한 검사입니다. "내 API 키로 직접 테스트하기"를 펼쳐서 키를 다시 입력해주세요.');
      continueSectionEl.hidden = false;
      continueBtn.disabled = false;
      return;
    }
    payload.provider = ownProviderSelect.value;
    payload.model = ownModelSelect.value;
    payload.apiKey = ownApiKeyInput.value.trim();
  }

  await runCheck(payload);

  continueBtn.disabled = false;
}

async function handleFinish() {
  if (!currentSessionId) return;
  finishBtn.disabled = true;

  const sessionIdToClose = currentSessionId;
  currentSessionId = null;
  continueSectionEl.hidden = true;
  setStatus('지금까지 확인한 결과로 마쳤습니다.');

  try {
    await fetch('/api/check/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionIdToClose }),
    });
  } catch (e) {
    // 정리 요청이 실패해도 방문자 입장에서는 이미 결과를 확정한 상태이므로 무시합니다.
  } finally {
    finishBtn.disabled = false;
  }
}

async function runCheck(payload) {
  submitBtn.disabled = true;
  setStatus('요청을 보내는 중...');

  try {
    const response = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !response.body) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `서버 오류 (${response.status})`);
    }

    await readStream(response.body);
    refreshCacheInfo();
  } catch (err) {
    console.error(err);
    setStatus(`오류: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
}

async function readStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) handleEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) handleEvent(JSON.parse(buffer.trim()));
}

function handleEvent(event) {
  if (event.type === 'log') {
    logAgentStep(event.text, event.done);
  } else if (event.type === 'error') {
    setStatus(`오류: ${event.message}`);
    currentSessionId = null;
  } else if (event.type === 'paused') {
    currentSessionId = event.sessionId;
    currentUsesOwnKey = !!event.usingOwnKey;

    if (event.findings && event.findings.length > 0) {
      renderSummary(event.findings);
      renderResults(event.findings);
    }

    const count = (event.findings || []).length;
    continueTextEl.textContent =
      count > 0
        ? `위에 지금까지 확인된 ${count}건이 표시되어 있습니다. 계속 검사해서 더 찾아볼까요?`
        : '아직 확정된 결과가 없습니다. 계속 검사할까요?';
    continueSectionEl.hidden = false;
    setStatus(`일부 결과 확인 · ${event.pageTitle || event.pageUrl}`);
  } else if (event.type === 'done') {
    currentSessionId = null;
    continueSectionEl.hidden = true;

    if (!event.findings || event.findings.length === 0) {
      setStatus('접근성 위반 항목을 발견하지 못했습니다.');
      return;
    }
    renderSummary(event.findings);
    renderResults(event.findings);
    setStatus(
      `검사 완료 · ${event.pageTitle || event.pageUrl} · 총 ${event.findings.length}건의 위반 항목` +
        (event.grade ? ` · 준수 등급 ${event.grade} (${event.score}/100)` : '')
    );

    lastReport = {
      pageUrl: event.pageUrl,
      pageTitle: event.pageTitle,
      score: event.score,
      grade: event.grade,
      findings: event.findings,
    };
    downloadSectionEl.hidden = false;
  }
}

function logAgentStep(text, done) {
  const li = document.createElement('li');
  li.className = `agent-log-item${done ? ' agent-log-item--done' : ''}`;
  li.innerHTML = `<span>${done ? '✓' : '›'}</span><span>${escapeHtml(text)}</span>`;
  agentLogListEl.appendChild(li);
  agentLogCountEl.textContent = `(${agentLogListEl.children.length})`;
  setStatus(text);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function renderSummary(findings) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  findings.forEach((f) => {
    if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  });
  summaryEl.innerHTML = Object.entries(counts)
    .filter(([, c]) => c > 0)
    .map(([sev, c]) => `<span class="summary__chip summary__chip--${sev}">${SEVERITY_LABEL[sev]} ${c}</span>`)
    .join('');
  summaryEl.hidden = false;
}

function renderResults(findings) {
  resultsEl.innerHTML = '';
  findings.forEach((f, index) => {
    const card = document.createElement('details');
    card.className = 'card';
    if (index === 0) card.open = true;
    const severity = f.severity || 'minor';

    card.innerHTML = `
      <summary class="card__header">
        <span class="badge badge--${severity}">${SEVERITY_LABEL[severity] || severity}</span>
        <span class="card__title">${escapeHtml(f.title)}</span>
        ${f.verified ? '<span class="verified-badge">✓ 검증됨</span>' : ''}
      </summary>
      <div class="card__body">
        ${f.kwcagRef ? `<span class="card__ref">${escapeHtml(f.kwcagRef)}</span>` : ''}
        <p class="card__section-label">무엇이 문제인가요</p>
        <p class="card__text">${escapeHtml(f.explanation)}</p>
        <p class="card__section-label">어떻게 수정하나요</p>
        <p class="card__text">${escapeHtml(f.howToFix)}</p>
        ${f.selector ? `<code class="card__selector">${escapeHtml(f.selector)}</code>` : ''}
        ${
          f.screenshotDataUrl
            ? `<p class="card__section-label">문제 위치</p><img class="card__screenshot" src="${f.screenshotDataUrl}" alt="${escapeHtml(f.title)} 문제 요소 스크린샷" />`
            : ''
        }
      </div>
    `;
    resultsEl.appendChild(card);
  });
}

async function refreshCacheInfo() {
  try {
    const res = await fetch('/api/cache-status');
    const data = await res.json();
    cacheInfoEl.textContent = `서버에 저장된 설명 캐시: ${data.size}건 (모든 방문자가 공유, 서버 재시작 시 초기화)`;
  } catch (e) {
    cacheInfoEl.textContent = '';
  }
}

// ── 문서 다운로드 (.txt / .html) ────────────────────────────
// 스크린샷은 파일 용량을 크게 키우므로 제외하고, 텍스트 정보만 담습니다.

function reportFileBaseName(report) {
  const safeHost = (() => {
    try {
      return new URL(report.pageUrl).hostname;
    } catch (e) {
      return 'report';
    }
  })();
  return `accessibility-report-${safeHost}-${Date.now()}`;
}

function triggerDownload(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 마크다운 기호(#, ** 등) 없이 줄바꿈과 구분선만으로 구성한 순수 텍스트
function buildPlainTextReport(report) {
  const lines = [];
  const divider = '='.repeat(50);
  const subDivider = '-'.repeat(50);

  lines.push('웹 접근성 검사 리포트');
  lines.push(divider);
  lines.push(`검사 대상: ${report.pageUrl}`);
  lines.push(`페이지 제목: ${report.pageTitle || '(제목 없음)'}`);
  lines.push(`생성 일시: ${new Date().toLocaleString('ko-KR')}`);
  if (report.grade) lines.push(`준수 등급: ${report.grade} (${report.score}/100)`);
  lines.push(`총 위반 항목: ${report.findings.length}건`);
  lines.push('');
  lines.push('※ 스크린샷은 문서저장 시 제외됩니다. 문제 위치는 웹 화면에서 확인해주세요.');
  lines.push(divider);
  lines.push('');

  report.findings.forEach((f, index) => {
    const severity = SEVERITY_LABEL[f.severity] || f.severity;
    lines.push(`${index + 1}. ${f.title} (${severity})`);
    if (f.kwcagRef) lines.push(`   관련 KWCAG: ${f.kwcagRef}`);
    if (f.verified) lines.push('   [AI가 실제로 검증한 수정안]');
    lines.push('');
    lines.push('   [무엇이 문제인가요]');
    lines.push(`   ${f.explanation || ''}`);
    lines.push('');
    lines.push('   [어떻게 수정하나요]');
    lines.push(`   ${f.howToFix || ''}`);
    lines.push('');
    if (f.selector) lines.push(`   선택자: ${f.selector}`);
    lines.push('');
    lines.push(subDivider);
    lines.push('');
  });

  return lines.join('\n');
}

function downloadTextReport(report) {
  triggerDownload(buildPlainTextReport(report), 'text/plain;charset=utf-8', `${reportFileBaseName(report)}.txt`);
}

// 더블클릭하면 바로 브라우저로 열리는 독립형 HTML 문서
function buildHtmlReport(report) {
  const genDate = new Date().toLocaleString('ko-KR');
  const items = report.findings
    .map((f, index) => {
      const severity = SEVERITY_LABEL[f.severity] || f.severity;
      return `
      <div class="item">
        <h2>${index + 1}. ${escapeHtml(f.title)} <span class="badge">${escapeHtml(severity)}</span>${
        f.verified ? ' <span class="verified">✓ AI 검증됨</span>' : ''
      }</h2>
        ${f.kwcagRef ? `<p class="ref">관련 KWCAG: ${escapeHtml(f.kwcagRef)}</p>` : ''}
        <p class="label">무엇이 문제인가요</p>
        <p>${escapeHtml(f.explanation || '')}</p>
        <p class="label">어떻게 수정하나요</p>
        <p>${escapeHtml(f.howToFix || '')}</p>
        ${f.selector ? `<code>${escapeHtml(f.selector)}</code>` : ''}
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<title>웹 접근성 검사 리포트 - ${escapeHtml(report.pageTitle || report.pageUrl)}</title>
<style>
  body { font-family: -apple-system, "Malgun Gothic", system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a2233; line-height: 1.6; }
  h1 { font-size: 22px; }
  .meta { font-size: 13px; color: #5b6472; margin-bottom: 8px; }
  .disclaimer { background: #fff8e6; border: 1px solid #f0d98c; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin: 16px 0; }
  .item { border-top: 1px solid #e2e5ea; padding: 16px 0; }
  h2 { font-size: 16px; }
  .badge { font-size: 11px; font-weight: 700; color: #fff; background: #ad5700; padding: 2px 8px; border-radius: 999px; }
  .verified { font-size: 12px; color: #0f7a3d; font-weight: 700; }
  .ref { font-size: 12px; color: #2455c9; }
  .label { font-size: 12px; font-weight: 700; color: #5b6472; margin: 10px 0 2px; }
  code { display: inline-block; margin-top: 6px; background: #f5f6f8; padding: 3px 8px; border-radius: 6px; font-size: 12px; }
</style>
</head>
<body>
  <h1>웹 접근성 검사 리포트</h1>
  <p class="meta">검사 대상: ${escapeHtml(report.pageUrl)}</p>
  <p class="meta">페이지 제목: ${escapeHtml(report.pageTitle || '(제목 없음)')}</p>
  <p class="meta">생성 일시: ${genDate}</p>
  ${report.grade ? `<p class="meta">준수 등급: ${escapeHtml(report.grade)} (${report.score}/100)</p>` : ''}
  <p class="meta">총 위반 항목: ${report.findings.length}건</p>
  <div class="disclaimer">※ 스크린샷은 문서저장 시 제외됩니다. 문제 위치는 웹 화면에서 확인해주세요.</div>
  ${items}
</body>
</html>`;
}

function downloadHtmlReport(report) {
  triggerDownload(buildHtmlReport(report), 'text/html;charset=utf-8', `${reportFileBaseName(report)}.html`);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
