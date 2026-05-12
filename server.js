const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('./db');
const { buildDeliveryQueueItems } = require('./curation');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8088);
const HOST = process.env.HOST || '127.0.0.1';
const HERMES_BIN = process.env.HERMES_BIN || '/home/dongpark/.local/bin/hermes';
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 90000);
const MAX_BODY_BYTES = 32 * 1024;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://dapgeun.dongpark.dev';
const conn = db.init(db.openDatabase());

const scenarioCatalog = {
  backend: [
    { title: 'Backend 1라운드: 락 없이 큐로 처리한다면?', description: '재고/주문 상황에서 동시성과 운영 리스크를 구조화합니다.', href: './scenarios/first-backend.html', tags: ['동시성', '큐', '운영 리스크'] },
    { title: 'DB와 이벤트가 갈라지는 순간', description: 'Transactional Outbox로 dual-write 문제를 설명하는 보조 연습입니다.', href: './scenarios/software-outbox.html', tags: ['이벤트', '아웃박스', '멱등성'] },
    { title: '재고 1개에 주문 2개가 동시에 들어오면?', description: '락/조건부 업데이트/큐 기반 직렬화를 비교합니다.', href: './scenarios/stock-concurrency.html', tags: ['락', '조건부 업데이트', '트레이드오프'] },
  ],
  frontend: [
    { title: 'Frontend 1라운드: 느린 대시보드 진단', description: '성능 문제를 프론트/백엔드/네트워크 관점으로 분해합니다.', href: './scenarios/first-frontend.html', tags: ['성능', '진단', '사용자 영향'] },
    { title: '느린 대시보드, 어디서부터 볼까?', description: '프론트엔드/백엔드 경계를 넘는 성능 진단 보조 연습입니다.', href: './scenarios/frontend-performance.html', tags: ['측정', '병목', '렌더링'] },
    { title: '가입 완료율이 18% 떨어졌다', description: '제품 지표 하락을 funnel 관점으로 진단합니다.', href: './scenarios/pm-activation-drop.html', tags: ['퍼널', '지표', '가설'] },
  ],
  pm: [
    { title: 'PM 1라운드: 가입 완료율이 18% 떨어졌다면?', description: '문제 정의, 가설 분리, 검증 순서를 답변으로 만듭니다.', href: './scenarios/first-pm.html', tags: ['지표 하락', '문제 정의', '실험'] },
    { title: '실험 결과가 애매할 때', description: '유의성/비즈니스 임팩트/의사결정 기준을 설명합니다.', href: './scenarios/data-abtest.html', tags: ['A/B 테스트', '의사결정', '리스크'] },
    { title: '우선순위가 충돌할 때', description: '이해관계자 조율과 tradeoff 설명을 연습합니다.', href: './scenarios/behavioral-stakeholder.html', tags: ['우선순위', '커뮤니케이션', '트레이드오프'] },
  ],
  data: [
    { title: 'Data 1라운드: A/B 테스트가 애매하게 이겼다면?', description: '실험 결과와 출시 판단을 데이터/제품 관점으로 연결합니다.', href: './scenarios/first-data.html', tags: ['실험', '통계', '의사결정'] },
    { title: '실험 결과가 애매할 때', description: '유의성/비즈니스 임팩트/의사결정 기준을 설명합니다.', href: './scenarios/data-abtest.html', tags: ['A/B 테스트', '효과크기', '런칭'] },
    { title: '가입 완료율이 18% 떨어졌다', description: '원인 가설과 데이터 확인 순서를 구조화합니다.', href: './scenarios/pm-activation-drop.html', tags: ['퍼널', '가설', '분석'] },
  ],
  design: [
    { title: 'Design 1라운드: 버튼 변경과 CS 증가', description: 'UX 개선과 부작용을 함께 설명합니다.', href: './scenarios/first-design.html', tags: ['UX', '부작용', '실험'] },
    { title: '우선순위가 충돌할 때', description: '이해관계자 조율과 tradeoff 설명을 연습합니다.', href: './scenarios/behavioral-stakeholder.html', tags: ['조율', '설득', '트레이드오프'] },
    { title: '가입 완료율이 18% 떨어졌다', description: '제품 지표 하락을 사용자 경험 관점으로 진단합니다.', href: './scenarios/pm-activation-drop.html', tags: ['퍼널', 'UX', '진단'] },
  ],
  growth: [
    { title: 'Growth 1라운드: ROAS는 좋은데 실제 이익이 줄었다면?', description: '광고 지표와 실제 수익성의 차이를 설명합니다.', href: './scenarios/first-growth.html', tags: ['ROAS', '수익성', '세그먼트'] },
    { title: '가입 완료율이 18% 떨어졌다', description: '원인 가설과 데이터 확인 순서를 구조화합니다.', href: './scenarios/pm-activation-drop.html', tags: ['퍼널', '전환율', '가설'] },
    { title: '실험 결과가 애매할 때', description: '유의성/비즈니스 임팩트/의사결정 기준을 설명합니다.', href: './scenarios/data-abtest.html', tags: ['실험', '판단', '리스크'] },
  ],
  leadership: [
    { title: 'Leadership 1라운드: 성과가 낮은 팀원을 도울 때', description: '기대치 정렬, 코칭, 성과관리를 답변으로 만듭니다.', href: './scenarios/first-leadership.html', tags: ['코칭', '성과관리', '기대치'] },
    { title: '성과가 낮은 팀원을 어떻게 도울까?', description: '리더십/코칭/기대치 정렬 보조 연습입니다.', href: './scenarios/leadership-coaching.html', tags: ['리더십', '피드백', '성장'] },
    { title: '실패한 프로젝트를 설명하라', description: '회고를 변명이 아니라 학습으로 말합니다.', href: './scenarios/behavioral-failure.html', tags: ['회고', '책임', '학습'] },
  ],
};

const trackLabels = {
  backend: 'Backend', frontend: 'Frontend', pm: 'PM', data: 'Data', design: 'Design', growth: 'Growth', leadership: 'Leadership',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeText(value, max = 400) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeProfile(raw) {
  const weakness = Array.isArray(raw.weakness) ? raw.weakness.map((x) => safeText(x, 80)).filter(Boolean).slice(0, 8) : [];
  return {
    name: safeText(raw.name, 80) || '사용자',
    contact: safeText(raw.contact, 120),
    role: safeText(raw.role, 120) || 'Other',
    target: safeText(raw.target, 160),
    years: safeText(raw.years, 40),
    level: safeText(raw.level, 40),
    goal: safeText(raw.goal, 80),
    weakness,
    cadence: safeText(raw.cadence, 40),
    channel: safeText(raw.channel, 80),
    notes: safeText(raw.notes, 700),
  };
}

function inferTrack(profile) {
  const r = `${profile.role} ${profile.target} ${profile.weakness.join(' ')} ${profile.notes}`.toLowerCase();
  if (r.includes('designer') || r.includes('design') || r.includes('ux')) return 'design';
  if (r.includes('marketer') || r.includes('growth') || r.includes('marketing')) return 'growth';
  if (r.includes('data') || r.includes('데이터') || r.includes('분석')) return 'data';
  if (r.includes('pm') || r.includes('product')) return 'pm';
  if (r.includes('frontend') || r.includes('front-end') || r.includes('react')) return 'frontend';
  if (r.includes('manager') || r.includes('lead') || r.includes('커뮤니케이션') || r.includes('리더십')) return 'leadership';
  return 'backend';
}

function extractJson(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error('agent did not return valid JSON');
}

function validateRoutine(data, profile, fallbackTrack) {
  const allowed = new Map(Object.values(scenarioCatalog).flat().map((s) => [s.href, s]));
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems
    .map((item) => {
      const href = safeText(item.href, 200);
      const known = allowed.get(href);
      if (!known) return null;
      return {
        title: safeText(item.title, 160) || known.title,
        description: safeText(item.description, 240) || known.description,
        href: known.href,
        reason: safeText(item.reason, 180) || '현재 프로필과 약점에 맞는 훈련입니다.',
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  const used = new Set(items.map((x) => x.href));
  for (const s of scenarioCatalog[fallbackTrack]) {
    if (items.length >= 3) break;
    if (!used.has(s.href)) {
      items.push({ title: s.title, description: s.description, href: s.href, reason: '프로필 기반 기본 후보입니다.' });
    }
  }

  return {
    generatedBy: 'agent',
    track: trackLabels[fallbackTrack],
    headline: safeText(data.headline, 120) || `${profile.name}님을 위한 첫 훈련 루틴`,
    reason: safeText(data.reason, 420) || `${profile.name}님 프로필을 바탕으로 ${trackLabels[fallbackTrack]} 트랙에서 지금 답변 밀도를 올리기 좋은 질문을 골랐습니다.`,
    coachNote: safeText(data.coachNote, 420) || '첫 답변에서는 정답을 맞히기보다 문제 정의, 선택지, 운영 리스크를 한 문단씩 분리해 말해보세요.',
    items,
  };
}

function buildPrompt(profile, track) {
  return `당신은 답변근육이라는 한국어 면접 답변 훈련 제품의 루틴 생성 에이전트입니다.
사용자의 프로필을 보고, 제공된 시나리오 카탈로그 안에서만 첫 훈련 링크 3개를 고르세요.
목표는 링크 목록을 대충 보여주는 것이 아니라, 왜 이 순서로 훈련해야 하는지 개인화된 이유를 주는 것입니다.

규칙:
- 반드시 JSON 객체만 출력하세요. 마크다운 금지.
- href는 카탈로그에 있는 값만 사용하세요.
- items는 정확히 3개입니다.
- 개인정보/연락처는 reason에 반복하지 마세요.
- 과장된 합격 보장, 점수 보장 표현은 금지합니다.
- 한국어로 짧고 제품 UI에 바로 넣을 수 있게 씁니다.

사용자 프로필:
${JSON.stringify(profile, null, 2)}

추정 트랙: ${trackLabels[track]}

사용 가능한 시나리오 카탈로그:
${JSON.stringify(scenarioCatalog, null, 2)}

출력 스키마:
{
  "headline": "짧은 제목",
  "reason": "왜 이 루틴인지 2문장 이내",
  "coachNote": "첫 답변을 쓸 때의 코칭 한 문장",
  "items": [
    { "title": "카탈로그 제목 또는 더 자연스러운 제목", "description": "짧은 설명", "href": "카탈로그 href", "reason": "이 사용자의 약점/목표와 연결되는 이유" }
  ]
}`;
}

function runAgent(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(HERMES_BIN, ['-z', prompt, '--toolsets', ''], {
      cwd: ROOT,
      env: { ...process.env, HOME: process.env.HOME || '/home/dongpark', HERMES_QUIET: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('agent timeout'));
    }, AGENT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`agent exited ${code}: ${stderr.slice(-1000)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function handleRoutine(req, res) {
  let user = null;
  let profileRow = null;
  try {
    const raw = JSON.parse(await readBody(req) || '{}');
    const profile = normalizeProfile(raw);
    user = db.upsertUser(conn, profile);
    profileRow = db.addProfile(conn, user.id, profile);
    db.addEvent(conn, user.id, 'profile_submitted', { profileId: profileRow.id, source: 'landing' });

    const track = inferTrack(profile);
    const prompt = buildPrompt(profile, track);
    const agentText = await runAgent(prompt);
    const agentJson = extractJson(agentText);
    const routine = validateRoutine(agentJson, profile, track);
    const routineRow = db.saveRoutine(conn, {
      userId: user.id,
      profileId: profileRow.id,
      source: 'landing',
      routine,
      agentPrompt: prompt,
      agentResponse: agentText,
    });
    const queued = db.seedDeliveryQueue(conn, {
      userId: user.id,
      profileId: profileRow.id,
      routineId: routineRow.id,
      routine,
      cadence: profile.cadence,
      channel: profile.channel,
      baseUrl: PUBLIC_BASE_URL,
    });
    db.addEvent(conn, user.id, 'routine_generated', { profileId: profileRow.id, routineId: routineRow.id, queuedCount: queued.length });
    sendJson(res, 200, { ok: true, userId: user.id, profileId: profileRow.id, routineId: routineRow.id, queuedCount: queued.length, routine });
  } catch (err) {
    console.error('[routine-api]', err);
    if (user) db.addEvent(conn, user.id, 'routine_failed', { profileId: profileRow && profileRow.id, error: String(err.message || err).slice(0, 400) });
    sendJson(res, err.statusCode || 502, {
      ok: false,
      error: 'AGENT_ROUTINE_FAILED',
      message: '루틴 생성 에이전트 응답을 받지 못했습니다. 잠시 후 다시 시도해주세요.',
    });
  }
}

function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return req.headers['x-admin-token'] === token || url.searchParams.get('token') === token;
}

function requireAdmin(req, res) {
  if (!process.env.ADMIN_TOKEN) {
    sendJson(res, 503, { ok: false, error: 'ADMIN_TOKEN_NOT_CONFIGURED' });
    return false;
  }
  if (!isAdmin(req)) {
    sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    return false;
  }
  return true;
}

async function handleAdminGenerateQueue(req, res) {
  if (!requireAdmin(req, res)) return;
  try {
    const raw = JSON.parse(await readBody(req) || '{}');
    const days = Math.max(1, Math.min(Number(raw.days || 7), 30));
    const profile = conn.prepare('select * from profiles where id = ?').get(raw.profileId);
    if (!profile) {
      sendJson(res, 404, { ok: false, error: 'PROFILE_NOT_FOUND' });
      return;
    }
    const routineRow = conn.prepare('select * from routines where profile_id = ? order by created_at desc limit 1').get(profile.id);
    if (!routineRow) {
      sendJson(res, 404, { ok: false, error: 'ROUTINE_NOT_FOUND' });
      return;
    }
    const profileInput = { cadence: profile.cadence, channel: profile.channel };
    const routine = { items: JSON.parse(routineRow.items_json || '[]') };
    const items = buildDeliveryQueueItems(profileInput, routine, days, {
      userId: profile.user_id,
      profileId: profile.id,
      routineId: routineRow.id,
      baseUrl: PUBLIC_BASE_URL,
    }).map((item) => db.insertDeliveryQueueItem(conn, item));
    sendJson(res, 200, { ok: true, queuedCount: items.length, items });
  } catch (err) {
    console.error('[admin-generate-queue]', err);
    sendJson(res, 500, { ok: false, error: 'GENERATE_QUEUE_FAILED' });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml; charset=utf-8',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'dapgeun-geunyuk', agent: 'hermes', db: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/leads') {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, { ok: true, leads: db.adminLeads(conn, { limit: Number(url.searchParams.get('limit') || 50) }) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/generate-queue') {
    handleAdminGenerateQueue(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/routine') {
    handleRoutine(req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { allow: 'GET, HEAD, POST' });
  res.end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`dapgeun-geunyuk agent server listening on http://${HOST}:${PORT}`);
});
