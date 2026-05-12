const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../db');
const { sendDue } = require('../scripts/send-due');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dapgeun-send-'));
  return path.join(dir, 'test.db');
}

test('sendDue dry-run sends due email queue and records delivery', async () => {
  const conn = db.init(db.openDatabase(tempDb()));
  const user = db.upsertUser(conn, { name: '동팍', contact: 'dp@example.com' });
  const profile = db.addProfile(conn, user.id, { role: 'Backend', weakness: [] });
  db.insertDeliveryQueueItem(conn, {
    userId: user.id,
    profileId: profile.id,
    scheduledFor: '2020-01-01T00:00:00.000Z',
    channel: 'email',
    subject: '오늘의 학습지',
    body: '본문',
    scenarioHref: './scenarios/first-backend.html',
    scenarioTitle: '질문',
    curationReason: '이유',
  });

  const result = await sendDue({ conn, dryRun: true, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(result.claimed, 1);
  assert.equal(result.results[0].status, 'sent');
  assert.equal(conn.prepare("select count(*) as c from delivery_queue where status='sent'").get().c, 1);
  assert.equal(conn.prepare('select count(*) as c from deliveries').get().c, 1);
  conn.close();
});
