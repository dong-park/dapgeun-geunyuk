const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../db');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dapgeun-db-'));
  return path.join(dir, 'test.db');
}

const sampleProfile = {
  name: '동팍',
  contact: 'dp@example.com',
  role: 'Backend Engineer',
  target: '프로덕트 엔지니어',
  years: '5~8년',
  level: '중급',
  goal: '이직 준비',
  weakness: ['구조화된 답변', '운영/실무 리스크'],
  cadence: '주 3회',
  channel: 'email',
  notes: '트레이드오프 답변이 약합니다.',
};

const sampleRoutine = {
  track: 'Backend',
  headline: '운영 리스크 루틴',
  reason: '운영 장애와 선택 기준을 연습합니다.',
  coachNote: '문제 정의부터 시작하세요.',
  items: [
    { title: 'A', description: '첫 질문', href: './scenarios/first-backend.html', reason: '첫 훈련' },
    { title: 'B', description: '둘째 질문', href: './scenarios/software-outbox.html', reason: '정합성' },
  ],
};

test('init creates all product loop tables', () => {
  const conn = db.openDatabase(tempDb());
  db.init(conn);
  const rows = conn.prepare("select name from sqlite_master where type='table' order by name").all().map((x) => x.name);
  for (const name of ['answers', 'deliveries', 'delivery_queue', 'events', 'profiles', 'routines', 'users']) {
    assert.ok(rows.includes(name), `${name} table should exist`);
  }
  conn.close();
});

test('upsertUser reuses the same contact and addProfile stores each submission', () => {
  const conn = db.openDatabase(tempDb());
  db.init(conn);
  const user1 = db.upsertUser(conn, sampleProfile);
  const user2 = db.upsertUser(conn, { ...sampleProfile, name: '동팍2' });
  assert.equal(user1.id, user2.id);

  const p1 = db.addProfile(conn, user1.id, sampleProfile);
  const p2 = db.addProfile(conn, user1.id, { ...sampleProfile, target: 'Staff Engineer' });
  assert.notEqual(p1.id, p2.id);
  assert.equal(conn.prepare('select count(*) as c from users').get().c, 1);
  assert.equal(conn.prepare('select count(*) as c from profiles').get().c, 2);
  conn.close();
});

test('saveRoutine and seedDeliveryQueue persist routine-backed pending queue items', () => {
  const conn = db.openDatabase(tempDb());
  db.init(conn);
  const user = db.upsertUser(conn, sampleProfile);
  const profile = db.addProfile(conn, user.id, sampleProfile);
  const routine = db.saveRoutine(conn, { userId: user.id, profileId: profile.id, source: 'landing', routine: sampleRoutine, agentPrompt: 'prompt', agentResponse: '{"ok":true}' });
  const queued = db.seedDeliveryQueue(conn, { userId: user.id, profileId: profile.id, routineId: routine.id, routine: sampleRoutine, cadence: sampleProfile.cadence, channel: 'email', baseUrl: 'https://dapgeun.dongpark.dev' });

  assert.equal(queued.length, 2);
  assert.equal(conn.prepare('select count(*) as c from routines').get().c, 1);
  assert.equal(conn.prepare("select count(*) as c from delivery_queue where status='pending'").get().c, 2);
  assert.match(queued[0].body, /https:\/\/dapgeun\.dongpark\.dev\/scenarios\/first-backend\.html/);
  conn.close();
});

test('claimDueQueue marks pending due items as sending without claiming future items', () => {
  const conn = db.openDatabase(tempDb());
  db.init(conn);
  const user = db.upsertUser(conn, sampleProfile);
  const profile = db.addProfile(conn, user.id, sampleProfile);
  db.insertDeliveryQueueItem(conn, { userId: user.id, profileId: profile.id, scheduledFor: '2020-01-01T00:00:00.000Z', channel: 'email', subject: 'due', body: 'body', scenarioHref: './a', scenarioTitle: 'A', curationReason: 'r' });
  db.insertDeliveryQueueItem(conn, { userId: user.id, profileId: profile.id, scheduledFor: '2999-01-01T00:00:00.000Z', channel: 'email', subject: 'future', body: 'body', scenarioHref: './b', scenarioTitle: 'B', curationReason: 'r' });

  const due = db.claimDueQueue(conn, { now: '2026-01-01T00:00:00.000Z', limit: 10 });
  assert.equal(due.length, 1);
  assert.equal(due[0].subject, 'due');
  assert.equal(conn.prepare("select count(*) as c from delivery_queue where status='sending'").get().c, 1);
  assert.equal(conn.prepare("select count(*) as c from delivery_queue where status='pending'").get().c, 1);
  conn.close();
});
