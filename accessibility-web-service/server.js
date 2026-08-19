const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { runAgentLoop, DEFAULT_TOKEN_LIMIT } = require('./core/agentLoop');
const { captureElementScreenshot } = require('./core/executors');
const { getCacheSize, clearCache } = require('./core/cache');
const serverConfig = require('./core/serverConfig');
const adminAuth = require('./core/adminAuth');
const rateLimit = require('./core/rateLimit');

const app = express();
app.set('trust proxy', true); // Render는 프록시 뒤에 있어서, 실제 방문자 IP를 얻으려면 필요합니다.
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PAGE_LOAD_TIMEOUT_MS = 30000;
const SESSION_TTL_MS = 5 * 60 * 1000; // 5분간 "계속 검사"를 안 누르면 세션 정리
const VALID_PROVIDERS = ['claude', 'gemini', 'openai'];

// 검사량이 많아 잠시 멈춘 경우, 이어서 진행하기 위한 세션 저장소
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastUsedAt > SESSION_TTL_MS) {
      session.browser.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60 * 1000);

function computeScoreAndGrade(findings) {
  const weights = { critical: 10, serious: 5, moderate: 2, minor: 1 };
  const penalty = findings.reduce((sum, f) => sum + (weights[f.severity] || 1), 0);
  const score = Math.max(0, 100 - penalty);
  let grade = 'D';
  if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';
  return { score, grade };
}

async function attachScreenshots(page, findings, onStep) {
  const withEvidence = [];
  for (const f of findings) {
    let screenshotDataUrl = null;
    if (f.selector) {
      if (onStep) onStep({ tool: 'screenshot', text: `"${f.title}" 위치 스크린샷 캡처 중...` });
      screenshotDataUrl = await captureElementScreenshot(page, f.selector);
    }
    withEvidence.push({ ...f, screenshotDataUrl });
  }
  return withEvidence;
}

// 관리자가 정한 운영 모드에 따라 자격증명을 결정합니다.
// - admin 모드: 방문자 입력은 무시하고 항상 서버(관리자) 키를 씁니다.
// - visitor 모드: 방문자가 공급자/모델/API 키를 반드시 함께 보내야 합니다.
function resolveCredentials(body) {
  const cfg = serverConfig.getRuntimeConfig();

  if (cfg.mode === 'visitor') {
    if (!body.apiKey || !body.provider || !VALID_PROVIDERS.includes(body.provider) || !body.model) {
      throw new Error('이 서비스는 방문자가 직접 공급자/모델/API 키를 입력해야 검사할 수 있습니다.');
    }
    return { provider: body.provider, model: body.model, apiKey: body.apiKey, isOwnKey: true };
  }

  // admin 모드
  if (!cfg.apiKey) {
    throw new Error('관리자가 아직 이 서비스의 API 키를 설정하지 않았습니다.');
  }
  return { provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, isOwnKey: false };
}

// ── 방문자용: 웹 접근성 검사 ─────────────────────────────────
app.post('/api/check', async (req, res) => {
  const { url, sessionId, provider, model, apiKey } = req.body || {};
  const ip = req.ip || req.connection.remoteAddress || 'unknown';

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);

  // ── 이어서 진행하는 요청인지 확인 ──────────────────────────
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      send({ type: 'error', message: '이전 검사 세션을 찾을 수 없습니다. 처음부터 다시 검사해주세요.' });
      res.end();
      return;
    }

    let apiKeyToUse;
    if (session.isOwnKey) {
      if (!apiKey) {
        send({ type: 'error', message: '직접 입력한 키로 시작한 검사입니다. 계속하려면 API 키를 다시 입력해주세요.' });
        res.end();
        return;
      }
      apiKeyToUse = apiKey;
    } else {
      const cfg = serverConfig.getRuntimeConfig();
      if (!cfg.apiKey) {
        send({ type: 'error', message: '관리자가 설정한 기본 API 키를 더 이상 사용할 수 없습니다.' });
        res.end();
        return;
      }
      apiKeyToUse = cfg.apiKey;
    }

    session.lastUsedAt = Date.now();

    try {
      const result = await runAgentLoop({
        provider: session.provider,
        apiKey: apiKeyToUse,
        model: session.model,
        page: session.page,
        domain: session.domain,
        transcript: session.transcript,
        tokenLimit: DEFAULT_TOKEN_LIMIT,
        onStep: (step) => send({ type: 'log', tool: step.tool, text: step.text, done: !!step.done }),
      });

      if (result.done) {
        const findingsWithEvidence = await attachScreenshots(session.page, result.findings, (step) =>
          send({ type: 'log', tool: step.tool, text: step.text })
        );
        const { score, grade } = computeScoreAndGrade(findingsWithEvidence);
        send({
          type: 'done',
          done: true,
          findings: findingsWithEvidence,
          score,
          grade,
          pageUrl: session.url,
          pageTitle: session.pageTitle,
        });
        await session.browser.close().catch(() => {});
        sessions.delete(sessionId);
      } else {
        session.transcript = result.transcript;
        const findingsWithEvidence = await attachScreenshots(session.page, result.findings, (step) =>
          send({ type: 'log', tool: step.tool, text: step.text })
        );
        send({
          type: 'paused',
          done: false,
          sessionId,
          findings: findingsWithEvidence,
          pageUrl: session.url,
          pageTitle: session.pageTitle,
        });
      }
    } catch (err) {
      send({ type: 'error', message: err.message });
      await session.browser.close().catch(() => {});
      sessions.delete(sessionId);
    } finally {
      res.end();
    }
    return;
  }

  // ── 새 검사 시작 ──────────────────────────────────────────
  let creds;
  try {
    creds = resolveCredentials({ provider, model, apiKey });
  } catch (err) {
    send({ type: 'error', message: err.message });
    res.end();
    return;
  }

  // 관리자 키를 쓰는 요청만 엄격히 제한합니다 (운영자 비용 보호 목적).
  // 방문자가 자기 키를 쓰는 경우는 서버 자원(헤드리스 브라우저) 보호를 위한 더 넉넉한 한도만 적용합니다.
  const limited = creds.isOwnKey
    ? rateLimit.isRateLimited(`own:${ip}`, { max: 20 })
    : rateLimit.isRateLimited(`shared:${ip}`);
  if (limited) {
    send({
      type: 'error',
      message: creds.isOwnKey
        ? '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.'
        : `기본 제공 검사는 1시간에 최대 ${rateLimit.MAX_REQUESTS_PER_WINDOW}회까지 가능합니다. 더 많이 쓰시려면 직접 API 키를 입력해주세요.`,
    });
    res.end();
    return;
  }

  if (!url) {
    send({ type: 'error', message: 'url은 필수입니다.' });
    res.end();
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('http/https만 지원합니다.');
  } catch (e) {
    send({ type: 'error', message: '올바른 URL 형식이 아닙니다 (http:// 또는 https://로 시작해야 함).' });
    res.end();
    return;
  }

  let browser;
  try {
    send({ type: 'log', text: '브라우저를 준비하는 중...' });
    browser = await chromium.launch();
    const page = await browser.newPage();

    send({ type: 'log', text: `${parsedUrl.hostname} 페이지를 여는 중...` });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });

    const pageTitle = await page.title().catch(() => '');
    const domain = parsedUrl.hostname;

    const result = await runAgentLoop({
      provider: creds.provider,
      apiKey: creds.apiKey,
      model: creds.model,
      page,
      domain,
      tokenLimit: DEFAULT_TOKEN_LIMIT,
      onStep: (step) => send({ type: 'log', tool: step.tool, text: step.text, done: !!step.done }),
    });

    if (result.done) {
      const findingsWithEvidence = await attachScreenshots(page, result.findings, (step) =>
        send({ type: 'log', tool: step.tool, text: step.text })
      );
      const { score, grade } = computeScoreAndGrade(findingsWithEvidence);
      send({
        type: 'done',
        done: true,
        findings: findingsWithEvidence,
        score,
        grade,
        pageUrl: url,
        pageTitle,
      });
      await browser.close();
    } else {
      const newSessionId = crypto.randomUUID();
      sessions.set(newSessionId, {
        browser,
        page,
        provider: creds.provider,
        model: creds.model,
        isOwnKey: creds.isOwnKey,
        domain,
        url,
        pageTitle,
        transcript: result.transcript,
        lastUsedAt: Date.now(),
      });
      const findingsWithEvidence = await attachScreenshots(page, result.findings, (step) =>
        send({ type: 'log', tool: step.tool, text: step.text })
      );
      send({
        type: 'paused',
        done: false,
        sessionId: newSessionId,
        usingOwnKey: creds.isOwnKey,
        findings: findingsWithEvidence,
        pageUrl: url,
        pageTitle,
      });
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
    if (browser) await browser.close().catch(() => {});
  } finally {
    res.end();
  }
});

app.get('/api/mode', (req, res) => {
  res.json(serverConfig.getPublicMode());
});

// 방문자가 "계속하기" 대신 지금까지의 결과로 마치기로 했을 때, 살려둔 브라우저/세션을 정리합니다.
// (findings는 어차피 pause 시점에 이미 클라이언트로 전달했으므로, 여기서는 자원 정리만 합니다.)
app.post('/api/check/finish', (req, res) => {
  const { sessionId } = req.body || {};
  const session = sessions.get(sessionId);
  if (session) {
    session.browser.close().catch(() => {});
    sessions.delete(sessionId);
  }
  res.json({ ok: true });
});

app.get('/api/cache-status', (req, res) => {
  res.json({ size: getCacheSize() });
});

app.post('/api/cache-clear', adminAuth.requireAdmin, (req, res) => {
  res.json(clearCache());
});

// ── 관리자 전용 ──────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  try {
    const token = adminAuth.login((req.body || {}).password);
    res.json({ token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/admin/config', adminAuth.requireAdmin, (req, res) => {
  res.json(serverConfig.getPublicConfig());
});

app.post('/api/admin/config', adminAuth.requireAdmin, (req, res) => {
  const { mode, provider, model, apiKey } = req.body || {};
  if (mode && !serverConfig.VALID_MODES.includes(mode)) {
    res.status(400).json({ error: `알 수 없는 모드: ${mode}` });
    return;
  }
  if (provider && !VALID_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: `알 수 없는 공급자: ${provider}` });
    return;
  }
  serverConfig.updateConfig({ mode, provider, model, apiKey });
  res.json(serverConfig.getPublicConfig());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`웹 접근성 검증 에이전트 서버 실행 중: http://localhost:${PORT}`);
});
