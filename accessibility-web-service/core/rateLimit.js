// 매우 단순한 메모리 기반 rate limit입니다. 정교한 방어가 아니라,
// 같은 방문자가 실수/장난으로 반복 클릭해 비용이 크게 나가는 걸 막는 최소한의 안전장치입니다.
const WINDOW_MS = 60 * 60 * 1000; // 1시간
const MAX_REQUESTS_PER_WINDOW = 5; // 같은 IP당 1시간에 5회

const hits = new Map(); // ip -> [timestamp, ...]

function isRateLimited(key, options = {}) {
  const max = options.max || MAX_REQUESTS_PER_WINDOW;
  const now = Date.now();
  const timestamps = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);

  if (timestamps.length >= max) {
    hits.set(key, timestamps);
    return true;
  }

  timestamps.push(now);
  hits.set(key, timestamps);
  return false;
}

module.exports = { isRateLimited, MAX_REQUESTS_PER_WINDOW };
