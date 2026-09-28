// Supabase(Postgres)를 REST API로 직접 호출하는 얇은 헬퍼입니다 (추가 npm 패키지 불필요).
//
// 필요한 환경변수:
//   SUPABASE_URL         예) https://abcdefgh.supabase.co
//   SUPABASE_SECRET_KEY  서버 전용 비밀 키 (sb_secret_... ) — 절대 브라우저/깃허브에 노출 금지
//
// 새 API 키(sb_secret_...)는 JWT가 아니라서 apikey 헤더로만 보냅니다.
// (예전 방식의 service_role JWT 키를 쓰는 경우에는 Authorization 헤더도 함께 보냅니다.)

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

function restBase() {
  return `${process.env.SUPABASE_URL.trim().replace(/\/+$/, '')}/rest/v1`;
}

function buildHeaders(prefer) {
  const key = process.env.SUPABASE_SECRET_KEY.trim();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // 레거시 JWT 키 호환
  if (prefer) headers.Prefer = prefer;
  return headers;
}

// method: GET/POST/PATCH/DELETE, table: 테이블 이름
// options: { query: {col: 'eq.값', ...}, body, prefer, returnHeaders }
async function request(method, table, options = {}) {
  const { query = {}, body, prefer, returnHeaders = false } = options;

  const url = new URL(`${restBase()}/${table}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const res = await fetch(url, {
    method,
    headers: buildHeaders(prefer),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }
  }

  if (!res.ok) {
    const detail = data && typeof data === 'object' ? data.message || data.hint || data.details : data;
    const code = data && typeof data === 'object' && data.code ? ` [${data.code}]` : '';
    const err = new Error(`DB 오류 (${res.status})${code}: ${detail || '알 수 없는 오류'}`);
    err.status = res.status;
    err.code = data && typeof data === 'object' ? data.code : undefined;
    throw err;
  }

  return returnHeaders ? { data, headers: res.headers } : data;
}

module.exports = { isConfigured, request };
