const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'dapgeun.db');
const DEFAULT_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://dapgeun.dongpark.dev';

function nowIso() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

function openDatabase(dbPath = process.env.DAPGEUN_DB_PATH || DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  return conn;
}

function init(conn = openDatabase()) {
  conn.exec(`
    create table if not exists users (
      id text primary key,
      name text not null,
      contact text not null unique,
      contact_type text not null default 'unknown',
      status text not null default 'new',
      timezone text not null default 'Asia/Seoul',
      created_at text not null,
      updated_at text not null
    );
    create table if not exists profiles (
      id text primary key,
      user_id text not null references users(id),
      role text,
      target text,
      years text,
      level text,
      goal text,
      weakness_json text not null default '[]',
      cadence text,
      channel text,
      notes text,
      created_at text not null
    );
    create table if not exists routines (
      id text primary key,
      user_id text not null references users(id),
      profile_id text not null references profiles(id),
      source text not null,
      track text,
      headline text,
      reason text,
      coach_note text,
      items_json text not null,
      agent_prompt text,
      agent_response text,
      created_at text not null
    );
    create table if not exists delivery_queue (
      id text primary key,
      user_id text not null references users(id),
      profile_id text not null references profiles(id),
      routine_id text references routines(id),
      scheduled_for text not null,
      channel text not null,
      status text not null default 'pending',
      subject text not null,
      body text not null,
      scenario_href text,
      scenario_title text,
      curation_reason text,
      retry_count integer not null default 0,
      last_error text,
      sent_at text,
      created_at text not null
    );
    create index if not exists idx_delivery_due on delivery_queue(status, scheduled_for);
    create table if not exists deliveries (
      id text primary key,
      queue_id text not null references delivery_queue(id),
      provider text not null,
      provider_message_id text,
      status text not null,
      error text,
      created_at text not null
    );
    create table if not exists answers (
      id text primary key,
      user_id text references users(id),
      scenario_href text not null,
      draft_text text not null,
      word_count integer not null default 0,
      opened_explanation integer not null default 0,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists events (
      id text primary key,
      user_id text references users(id),
      event_name text not null,
      metadata_json text not null default '{}',
      created_at text not null
    );
  `);
  return conn;
}

function contactType(contact) {
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact || '')) return 'email';
  if (/^-?\d{5,}$/.test(contact || '')) return 'telegram';
  if (/^\+?[0-9\-\s]{8,}$/.test(contact || '')) return 'phone';
  return 'unknown';
}

function upsertUser(conn, profile) {
  const contact = String(profile.contact || '').trim() || `unknown-${id()}@dapgeun.local`;
  const existing = conn.prepare('select * from users where contact = ?').get(contact);
  const ts = nowIso();
  if (existing) {
    conn.prepare('update users set name = ?, contact_type = ?, updated_at = ? where id = ?')
      .run(profile.name || existing.name || '사용자', contactType(contact), ts, existing.id);
    return conn.prepare('select * from users where id = ?').get(existing.id);
  }
  const user = { id: id(), name: profile.name || '사용자', contact, contact_type: contactType(contact), status: 'new', timezone: 'Asia/Seoul', created_at: ts, updated_at: ts };
  conn.prepare('insert into users (id, name, contact, contact_type, status, timezone, created_at, updated_at) values (@id, @name, @contact, @contact_type, @status, @timezone, @created_at, @updated_at)').run(user);
  return user;
}

function addProfile(conn, userId, profile) {
  const row = {
    id: id(),
    user_id: userId,
    role: profile.role || '',
    target: profile.target || '',
    years: profile.years || '',
    level: profile.level || '',
    goal: profile.goal || '',
    weakness_json: JSON.stringify(Array.isArray(profile.weakness) ? profile.weakness : []),
    cadence: profile.cadence || '',
    channel: profile.channel || '',
    notes: profile.notes || '',
    created_at: nowIso(),
  };
  conn.prepare('insert into profiles (id, user_id, role, target, years, level, goal, weakness_json, cadence, channel, notes, created_at) values (@id, @user_id, @role, @target, @years, @level, @goal, @weakness_json, @cadence, @channel, @notes, @created_at)').run(row);
  return row;
}

function addEvent(conn, userId, eventName, metadata = {}) {
  const row = { id: id(), user_id: userId || null, event_name: eventName, metadata_json: JSON.stringify(metadata), created_at: nowIso() };
  conn.prepare('insert into events (id, user_id, event_name, metadata_json, created_at) values (@id, @user_id, @event_name, @metadata_json, @created_at)').run(row);
  return row;
}

function saveRoutine(conn, { userId, profileId, source = 'landing', routine, agentPrompt = '', agentResponse = '' }) {
  const row = {
    id: id(), user_id: userId, profile_id: profileId, source,
    track: routine.track || '', headline: routine.headline || '', reason: routine.reason || '', coach_note: routine.coachNote || routine.coach_note || '',
    items_json: JSON.stringify(routine.items || []), agent_prompt: agentPrompt, agent_response: agentResponse, created_at: nowIso(),
  };
  conn.prepare('insert into routines (id, user_id, profile_id, source, track, headline, reason, coach_note, items_json, agent_prompt, agent_response, created_at) values (@id, @user_id, @profile_id, @source, @track, @headline, @reason, @coach_note, @items_json, @agent_prompt, @agent_response, @created_at)').run(row);
  return row;
}

function normalizeHref(href) {
  return String(href || '').replace(/^\.\//, '');
}

function absoluteUrl(baseUrl, href) {
  return new URL(normalizeHref(href), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function nextSchedule(index, cadence = '') {
  const date = new Date();
  date.setUTCHours(23, 0, 0, 0); // 08:00 KST
  const stepDays = String(cadence).includes('3') ? 2 : 1;
  date.setUTCDate(date.getUTCDate() + (index * stepDays));
  return date.toISOString();
}

function buildQueueItem({ userId, profileId, routineId = null, item, index = 0, cadence = '', channel = 'email', baseUrl = DEFAULT_BASE_URL }) {
  const link = absoluteUrl(baseUrl, item.href);
  const title = item.title || '오늘의 답변 훈련';
  return {
    userId, profileId, routineId,
    scheduledFor: nextSchedule(index, cadence),
    channel: channel === 'telegram' ? 'telegram' : 'email',
    subject: `[답변근육] 오늘의 12분 답변 훈련 — ${title.replace(/^.*?:\s*/, '').slice(0, 40)}`,
    body: `오늘의 답변근육: ${title}\n\n${item.reason || '지금 프로필에 맞춘 훈련입니다.'}\n\n답변은 이렇게 시작해보세요.\n1. 먼저 문제 상황과 리스크를 정의합니다.\n2. 가능한 선택지를 비교합니다.\n3. 내가 고를 기준과 후속 확인 방법을 말합니다.\n\n훈련 링크: ${link}`,
    scenarioHref: item.href || '',
    scenarioTitle: title,
    curationReason: item.reason || '',
  };
}

function insertDeliveryQueueItem(conn, input) {
  const row = {
    id: id(),
    user_id: input.userId,
    profile_id: input.profileId,
    routine_id: input.routineId || null,
    scheduled_for: input.scheduledFor,
    channel: input.channel || 'email',
    status: 'pending',
    subject: input.subject,
    body: input.body,
    scenario_href: input.scenarioHref || '',
    scenario_title: input.scenarioTitle || '',
    curation_reason: input.curationReason || '',
    retry_count: 0,
    last_error: null,
    sent_at: null,
    created_at: nowIso(),
  };
  conn.prepare('insert into delivery_queue (id, user_id, profile_id, routine_id, scheduled_for, channel, status, subject, body, scenario_href, scenario_title, curation_reason, retry_count, last_error, sent_at, created_at) values (@id, @user_id, @profile_id, @routine_id, @scheduled_for, @channel, @status, @subject, @body, @scenario_href, @scenario_title, @curation_reason, @retry_count, @last_error, @sent_at, @created_at)').run(row);
  return row;
}

function seedDeliveryQueue(conn, { userId, profileId, routineId = null, routine, cadence = '', channel = 'email', baseUrl = DEFAULT_BASE_URL }) {
  const items = (routine.items || []).slice(0, 7);
  return items.map((item, index) => insertDeliveryQueueItem(conn, buildQueueItem({ userId, profileId, routineId, item, index, cadence, channel, baseUrl })));
}

function claimDueQueue(conn, { now = nowIso(), limit = 10 } = {}) {
  const rows = conn.prepare("select * from delivery_queue where status = 'pending' and scheduled_for <= ? order by scheduled_for asc limit ?").all(now, limit);
  const update = conn.prepare("update delivery_queue set status = 'sending' where id = ? and status = 'pending'");
  const claimed = [];
  for (const row of rows) {
    const result = update.run(row.id);
    if (result.changes) claimed.push({ ...row, status: 'sending' });
  }
  return claimed;
}

function markDeliverySent(conn, queueId, { provider = 'dry-run', providerMessageId = null } = {}) {
  const ts = nowIso();
  conn.prepare("update delivery_queue set status = 'sent', sent_at = ?, last_error = null where id = ?").run(ts, queueId);
  const row = { id: id(), queue_id: queueId, provider, provider_message_id: providerMessageId, status: 'sent', error: null, created_at: ts };
  conn.prepare('insert into deliveries (id, queue_id, provider, provider_message_id, status, error, created_at) values (@id, @queue_id, @provider, @provider_message_id, @status, @error, @created_at)').run(row);
  return row;
}

function markDeliveryFailed(conn, queueId, error, { provider = 'unknown' } = {}) {
  const ts = nowIso();
  const message = String(error && error.message ? error.message : error).slice(0, 1000);
  conn.prepare("update delivery_queue set status = case when retry_count >= 2 then 'failed' else 'pending' end, retry_count = retry_count + 1, last_error = ? where id = ?").run(message, queueId);
  const row = { id: id(), queue_id: queueId, provider, provider_message_id: null, status: 'failed', error: message, created_at: ts };
  conn.prepare('insert into deliveries (id, queue_id, provider, provider_message_id, status, error, created_at) values (@id, @queue_id, @provider, @provider_message_id, @status, @error, @created_at)').run(row);
  return row;
}

function adminLeads(conn, { limit = 50 } = {}) {
  return conn.prepare(`
    select u.id as user_id, u.name, u.contact, u.contact_type, u.status, u.created_at,
      p.id as profile_id, p.role, p.target, p.years, p.level, p.goal, p.cadence, p.channel, p.created_at as profile_created_at,
      (select count(*) from delivery_queue dq where dq.user_id = u.id and dq.status = 'pending') as pending_count,
      (select count(*) from delivery_queue dq where dq.user_id = u.id and dq.status = 'sent') as sent_count,
      (select headline from routines r where r.user_id = u.id order by r.created_at desc limit 1) as latest_headline
    from users u
    left join profiles p on p.id = (select id from profiles where user_id = u.id order by created_at desc limit 1)
    order by u.created_at desc
    limit ?
  `).all(limit);
}

module.exports = {
  DEFAULT_DB_PATH,
  openDatabase,
  init,
  upsertUser,
  addProfile,
  addEvent,
  saveRoutine,
  seedDeliveryQueue,
  insertDeliveryQueueItem,
  claimDueQueue,
  markDeliverySent,
  markDeliveryFailed,
  adminLeads,
  buildQueueItem,
};
