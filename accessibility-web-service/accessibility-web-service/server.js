const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { runAgentLoop, DEFAULT_TOKEN_LIMIT } = require('./core/agentLoop');
const { captureElementScreenshot } = require('./core/executors');
const { getCacheSize, clearCache } = require('./core/cache');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PAGE_LOAD_TIMEOUT_MS = 30000;
const SESSION_TTL_MS = 5 * 60 * 1000; // 5분간 "계속 검사"를 안 누르면 세션 정리

// 검사량이 많아 잠시 멈춘 경우, 이어서 진행하기 위한 세션 저장소
// (브라우저/페이지를 살려둔 채로, 다음 요청에서 이어서 진행합니다)
// 한도 자체는 사용자에게 노출하지 않는 내부 운영 값입니다 (core/agentLoop.js의 DEFAULT_TOKEN_LIMIT).
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

// 위반 항목마다 문제 요소의 스크린샷을 캡처해 붙입니다 ("여기가 문제입니다" 증거).
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

app.post('/api/check', async (req, res) => {
  const { url, provider, apiKey, model, sessionId } = req.body || {};

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
    if (!apiKey) {
      send({ type: 'error', message: 'apiKey가 필요합니다.' });
      res.end();
      return;
    }

    session.lastUsedAt = Date.now();

    try {
      const result = await runAgentLoop({
        provider: session.provider,
        apiKey,
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
  if (!url || !provider || !apiKey || !model) {
    send({ type: 'error', message: 'url, provider, apiKey, model은 모두 필수입니다.' });
    res.end();
    return;
  }
  if (!['claude', 'gemini', 'openai'].includes(provider)) {
    send({ type: 'error', message: `알 수 없는 공급자: ${provider}` });
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
      provider,
      apiKey,
      model,
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
      // 검사량이 많아 잠시 멈춤 — 세션을 저장해두고 브라우저는 살려둠
      const newSessionId = crypto.randomUUID();
      sessions.set(newSessionId, {
        browser,
        page,
        provider,
        model,
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
        findings: findingsWithEvidence,
        pageUrl: url,
        pageTitle,
      });
      // 주의: 여기서는 browser.close()를 호출하지 않습니다 (이어서 진행하기 위해 살려둠).
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
    if (browser) await browser.close().catch(() => {});
  } finally {
    res.end();
  }
});

app.get('/api/cache-status', (req, res) => {
  res.json({ size: getCacheSize() });
});

app.post('/api/cache-clear', (req, res) => {
  res.json(clearCache());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`웹 접근성 검증 에이전트 서버 실행 중: http://localhost:${PORT}`);
});
