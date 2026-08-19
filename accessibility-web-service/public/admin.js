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
  await loadConfig();
  await refreshCacheCount();
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
  loginPanel.hidden = false;
  loginMsg.textContent = '로그인이 만료되었습니다. 다시 로그인해주세요.';
}

// 페이지를 열었을 때 이미 로그인되어 있으면(같은 브라우저 탭) 바로 설정 화면으로
if (getToken()) {
  enterConfigPanel();
}
