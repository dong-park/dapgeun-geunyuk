const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeliveryQueueItems } = require('../curation');

test('buildDeliveryQueueItems expands routine items to requested days with absolute links', () => {
  const rows = buildDeliveryQueueItems(
    { cadence: 'daily', channel: 'email' },
    { items: [{ title: '첫 질문', href: './scenarios/first-backend.html', reason: '약점 보강' }] },
    3,
    { userId: 'u1', profileId: 'p1', baseUrl: 'https://dapgeun.dongpark.dev' },
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].userId, 'u1');
  assert.match(rows[0].body, /https:\/\/dapgeun\.dongpark\.dev\/scenarios\/first-backend\.html/);
  assert.ok(rows[1].scheduledFor > rows[0].scheduledFor);
});
