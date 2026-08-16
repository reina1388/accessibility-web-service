// 간단한 인메모리 캐시입니다. 서버가 켜져 있는 동안 모든 방문자가 공유합니다.
// (한 사이트를 여러 사람이 검사하면 서로 캐시 혜택을 봄) 서버 재시작 시 초기화됩니다.
// 방문자별로 분리하거나 영구 저장이 필요하면 Redis/DB로 교체하세요.

const CACHE_VERSION = 'v1';
const store = new Map();

function cacheKey(domain, ruleId) {
  return `${CACHE_VERSION}:${domain}:${ruleId}`;
}

function checkExplanationCache(domain, ruleId) {
  const entry = store.get(cacheKey(domain, ruleId));
  return entry ? { cached: true, ...entry } : { cached: false };
}

function saveExplanationCache(domain, { ruleId, title, kwcagRef, explanation, howToFix }) {
  store.set(cacheKey(domain, ruleId), {
    title,
    kwcagRef,
    explanation,
    howToFix,
    savedAt: new Date().toISOString(),
  });
  return { saved: true };
}

function getCacheSize() {
  return store.size;
}

function clearCache() {
  const size = store.size;
  store.clear();
  return { cleared: size };
}

module.exports = { checkExplanationCache, saveExplanationCache, getCacheSize, clearCache };
