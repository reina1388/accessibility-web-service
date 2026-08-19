// 서버 전체가 공유하는 AI 설정(운영 모드/공급자/모델/API 키)을 메모리에 보관합니다.
// - mode: 'admin'  -> 방문자는 URL만 입력, 관리자가 등록한 키로 검사 (운영자가 비용 부담)
//         'visitor' -> 방문자가 반드시 자기 공급자/모델/API 키를 입력해야 검사 가능 (운영자 비용 없음)
// - 방문자는 이 설정을 절대 볼 수 없고, 관리자만 /admin.html에서 변경할 수 있습니다
//   (단, mode와 "추천 기본 공급자/모델"은 방문자 화면 구성을 위해 공개 API로 노출됩니다 — API 키는 노출 안 됨).
// - 메모리 저장이라 서버가 재시작되면 초기화됩니다. 이때는 아래 환경변수로 만든
//   기본값으로 복구되므로, Render에 DEFAULT_MODE/DEFAULT_PROVIDER/DEFAULT_API_KEY/DEFAULT_MODEL을
//   설정해두면 재시작 후에도 별도 조작 없이 계속 동작합니다.
const VALID_MODES = ['admin', 'visitor'];

const config = {
  mode: VALID_MODES.includes(process.env.DEFAULT_MODE) ? process.env.DEFAULT_MODE : 'admin',
  provider: process.env.DEFAULT_PROVIDER || 'gemini',
  model: process.env.DEFAULT_MODEL || 'gemini-3.6-flash',
  apiKey: process.env.DEFAULT_API_KEY || '',
};

// 방문자 화면(비인증)에서 볼 수 있는 정보 — API 키는 절대 포함하지 않습니다.
function getPublicMode() {
  return { mode: config.mode, provider: config.provider, model: config.model };
}

// 관리자 화면(인증됨)에서 볼 수 있는 정보 — 여기도 실제 키 값은 포함하지 않습니다 (설정 여부만).
function getPublicConfig() {
  return { mode: config.mode, provider: config.provider, model: config.model, hasApiKey: !!config.apiKey };
}

// 서버 내부(검사 로직)에서만 사용 — 실제 apiKey 포함.
function getRuntimeConfig() {
  return { mode: config.mode, provider: config.provider, model: config.model, apiKey: config.apiKey };
}

function updateConfig({ mode, provider, model, apiKey }) {
  if (mode && VALID_MODES.includes(mode)) config.mode = mode;
  if (provider) config.provider = provider;
  if (model) config.model = model;
  // apiKey가 빈 문자열/미전달이면 "기존 키 유지"로 취급합니다 (실수로 키를 지우지 않도록).
  if (apiKey) config.apiKey = apiKey;
}

module.exports = { VALID_MODES, getPublicMode, getPublicConfig, getRuntimeConfig, updateConfig };
