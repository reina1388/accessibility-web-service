const crypto = require('crypto');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 관리자 로그인 유지 시간: 2시간

// 토큰 -> 만료시각
const adminSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of adminSessions.entries()) {
    if (now > expiresAt) adminSessions.delete(token);
  }
}, 5 * 60 * 1000);

function login(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    // 관리자 비밀번호가 아예 설정 안 된 서버는 관리자 기능을 잠급니다 (기본값으로 뚫려있지 않도록).
    throw new Error('서버에 ADMIN_PASSWORD 환경변수가 설정되어 있지 않습니다. Render 환경변수를 먼저 설정해주세요.');
  }
  if (password !== expected) {
    throw new Error('비밀번호가 올바르지 않습니다.');
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isAuthorized(token) {
  if (!token) return false;
  const expiresAt = adminSessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

// Express 미들웨어: Authorization: Bearer <token> 헤더를 확인합니다.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!isAuthorized(token)) {
    res.status(401).json({ error: '관리자 인증이 필요합니다.' });
    return;
  }
  next();
}

module.exports = { login, isAuthorized, requireAdmin };
