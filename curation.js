const { buildQueueItem } = require('./db');

function buildDeliveryQueueItems(profile, routine, days = 7, options = {}) {
  const items = Array.isArray(routine.items) ? routine.items : [];
  const count = Math.max(0, Math.min(Number(days) || 0, 30));
  const expanded = [];
  for (let i = 0; i < count; i += 1) {
    const item = items[i % Math.max(items.length, 1)] || {
      title: '오늘의 답변 훈련',
      description: '프로필 기반 답변 훈련입니다.',
      href: './',
      reason: '꾸준히 답변 구조를 연습하기 위한 기본 학습지입니다.',
    };
    expanded.push(buildQueueItem({
      userId: options.userId || 'dry-run-user',
      profileId: options.profileId || 'dry-run-profile',
      routineId: options.routineId || null,
      item,
      index: i,
      cadence: profile.cadence || options.cadence || '',
      channel: options.channel || profile.channel || 'email',
      baseUrl: options.baseUrl,
    }));
  }
  return expanded;
}

module.exports = { buildDeliveryQueueItems };
