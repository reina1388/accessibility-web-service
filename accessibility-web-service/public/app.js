const form = document.getElementById('check-form');
const urlInput = document.getElementById('url');
const providerSelect = document.getElementById('provider');
const modelSelect = document.getElementById('model');
const apiKeyInput = document.getElementById('api-key');
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

const SEVERITY_LABEL = { critical: '심각', serious: '높음', moderate: '보통', minor: '낮음' };

const MODELS = {
  gemini: [
    { value: 'gemini-3.6-flash', label: 'gemini-3.6-flash (권장)' },
    { value: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (빠르고 저렴)' },
    { value: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview (가장 정교함)' },
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

// 토큰 한도에 걸려 일시정지된 검사를 이어가기 위한 현재 세션 ID
let currentSessionId = null;

function populateModels(provider, selectedModel) {
  modelSelect.innerHTML = '';
  MODELS[provider].forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  });
  if (selectedModel) modelSelect.value = selectedModel;
}

// ── 로컬 저장 (브라우저에만 저장, 서버로는 요청 시에만 전달) ─────
function loadSavedSettings() {
  const provider = localStorage.getItem('a11y_provider') || 'gemini';
  providerSelect.value = provider;
  populateModels(provider, localStorage.getItem(`a11y_model_${provider}`));
  apiKeyInput.value = localStorage.getItem(`a11y_key_${provider}`) || '';
}

function saveCurrentSettings() {
  const provider = providerSelect.value;
  localStorage.setItem('a11y_provider', provider);
  localStorage.setItem(`a11y_model_${provider}`, modelSelect.value);
  localStorage.setItem(`a11y_key_${provider}`, apiKeyInput.value);
}

providerSelect.addEventListener('change', () => {
  const provider = providerSelect.value;
  populateModels(provider, localStorage.getItem(`a11y_model_${provider}`));
  apiKeyInput.value = localStorage.getItem(`a11y_key_${provider}`) || '';
});

loadSavedSettings();
refreshCacheInfo();

form.addEventListener('submit', handleSubmit);
continueBtn.addEventListener('click', handleContinue);

async function handleSubmit(e) {
  e.preventDefault();
  saveCurrentSettings();

  // 새 검사를 시작하는 것이므로 이전 세션은 버립니다.
  currentSessionId = null;
  continueSectionEl.hidden = true;
  resultsEl.innerHTML = '';
  summaryEl.hidden = true;
  agentLogEl.hidden = false;
  agentLogListEl.innerHTML = '';

  await runCheck({
    url: urlInput.value.trim(),
    provider: providerSelect.value,
    model: modelSelect.value,
    apiKey: apiKeyInput.value.trim(),
  });
}

async function handleContinue() {
  if (!currentSessionId) return;
  continueBtn.disabled = true;
  continueSectionEl.hidden = true;

  await runCheck({
    sessionId: currentSessionId,
    provider: providerSelect.value,
    model: modelSelect.value,
    apiKey: apiKeyInput.value.trim(),
  });

  continueBtn.disabled = false;
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

    if (event.findings && event.findings.length > 0) {
      renderSummary(event.findings);
      renderResults(event.findings);
    }

    const count = (event.findings || []).length;
    continueTextEl.textContent =
      count > 0
        ? `지금까지 ${count}건을 확인했습니다. 계속 검사하시겠습니까?`
        : '지금까지 조사를 진행했습니다. 계속 검사하시겠습니까?';
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
