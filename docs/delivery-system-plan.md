# 답변근육 DB·큐레이션·발송 시스템 구현 계획

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 랜딩에서 받은 프로필을 DB에 저장하고, 에이전트가 매일/주기별로 개인별 학습지를 큐레이션해서 이메일 또는 메시지로 발송하는 최소 제품 루프를 만든다.

**Architecture:** 현재 `server.js`가 정적 파일과 `/api/routine`을 처리하므로, 1차는 같은 Node 서버 안에 저장·큐·발송 API를 붙인다. 외부 DB 세팅 전에도 바로 굴러가게 SQLite 파일 DB로 시작하고, 테이블/쿼리 구조는 이후 Supabase/Postgres로 옮기기 쉽게 잡는다. 발송은 큐 테이블에 먼저 쌓고, 별도 worker/cron이 due item만 처리한다.

**Tech Stack:** Node.js 22, SQLite 또는 Postgres-compatible schema, Hermes CLI agent, user systemd service, optional Resend/SMTP/Telegram delivery adapter.

---

## 0. 지금 상태

현재 완료된 것:
- 랜딩 프로필 폼이 `/api/routine`으로 요청을 보냄.
- 서버는 Hermes 에이전트를 호출해 첫 루틴 3개를 생성함.
- 운영은 `dapgeun-geunyuk.service` user systemd로 `server.js`를 실행함.

아직 없는 것:
- 제출 프로필 영구 저장.
- 사용자별 학습 이력/약점/루틴 저장.
- 매일 보낼 학습지 큐.
- 메일/메시지 발송 상태 관리.
- 관리자 확인 화면 또는 export.

제품 루프 목표:
1. 사용자가 프로필 제출.
2. DB에 `lead/user/profile/routine` 저장.
3. 에이전트가 첫 루틴을 만들고 즉시 화면에 표시.
4. 동시에 다음 N일치 학습지를 큐에 쌓음.
5. 매일 정해진 시간에 큐에서 하나씩 발송.
6. 사용자가 링크를 열고 답변하면 이벤트/답변을 저장.
7. 다음 큐레이션에 최근 답변/약점/완료 여부를 반영.

---

## 1차 구현 원칙

- **목업 금지:** 추천/발송할 학습지는 에이전트가 생성하거나 DB에 저장된 실제 큐에서 가져온다.
- **저장은 먼저:** 발송 자동화보다 프로필·루틴·큐가 DB에 남는 것이 먼저다.
- **발송은 큐 기반:** API 요청 중 바로 메일을 보내지 않는다. `delivery_queue`에 넣고 worker가 처리한다.
- **실패도 제품 상태:** 발송 실패/에이전트 실패를 숨기지 않고 `failed`, `retry_count`, `last_error`로 남긴다.
- **작게 시작:** 첫 버전은 이메일 1채널만 붙여도 된다. Telegram/카카오/문자는 adapter만 추가한다.

---

## 데이터 모델

### `users`

역할: 연락 가능한 사람 단위. 처음엔 lead와 user를 나누지 않고 하나로 둔다.

필드:
- `id`: string uuid
- `name`: text
- `contact`: text, email 또는 메시지 ID
- `contact_type`: `email | telegram | phone | unknown`
- `created_at`: datetime
- `updated_at`: datetime
- `status`: `new | active | paused | unsubscribed`
- `timezone`: text, 기본 `Asia/Seoul`

### `profiles`

역할: 면접 준비 맥락. 사용자가 폼을 다시 제출할 수 있으므로 user와 분리한다.

필드:
- `id`: string uuid
- `user_id`: users.id
- `role`: text
- `target`: text
- `years`: text
- `level`: text
- `goal`: text
- `weakness_json`: JSON string
- `cadence`: text, 예: `daily`, `주 3회`
- `channel`: text
- `notes`: text
- `created_at`: datetime

### `routines`

역할: 에이전트가 생성한 루틴 원본을 저장한다.

필드:
- `id`: string uuid
- `user_id`: users.id
- `profile_id`: profiles.id
- `source`: `landing | scheduled | manual`
- `track`: text
- `headline`: text
- `reason`: text
- `coach_note`: text
- `items_json`: JSON string
- `agent_prompt`: text, 디버깅용. 민감정보 최소화 필요
- `agent_response`: text
- `created_at`: datetime

### `delivery_queue`

역할: 앞으로 보낼 학습지 큐. 제품의 핵심 운영 테이블.

필드:
- `id`: string uuid
- `user_id`: users.id
- `profile_id`: profiles.id
- `routine_id`: routines.id nullable
- `scheduled_for`: datetime
- `channel`: `email | telegram | manual`
- `status`: `pending | sending | sent | failed | skipped`
- `subject`: text
- `body`: text
- `scenario_href`: text
- `scenario_title`: text
- `curation_reason`: text
- `retry_count`: integer default 0
- `last_error`: text nullable
- `sent_at`: datetime nullable
- `created_at`: datetime

### `deliveries`

역할: 실제 발송 시도 로그. 큐 1개가 여러 번 재시도될 수 있다.

필드:
- `id`: string uuid
- `queue_id`: delivery_queue.id
- `provider`: `resend | smtp | telegram | manual`
- `provider_message_id`: text nullable
- `status`: `sent | failed`
- `error`: text nullable
- `created_at`: datetime

### `answers`

역할: 사용자가 시나리오 페이지에서 작성한 답변 저장. 다음 큐레이션의 근거.

필드:
- `id`: string uuid
- `user_id`: users.id nullable
- `scenario_href`: text
- `draft_text`: text
- `word_count`: integer
- `opened_explanation`: boolean
- `created_at`: datetime
- `updated_at`: datetime

### `events`

역할: 제품 지표와 상태 추적.

필드:
- `id`: string uuid
- `user_id`: users.id nullable
- `event_name`: text, 예: `profile_submitted`, `routine_generated`, `delivery_sent`, `scenario_opened`, `answer_started`
- `metadata_json`: JSON string
- `created_at`: datetime

---

## API 설계

### `POST /api/routine` 변경

현재: 프로필을 받아 에이전트 루틴만 반환.

변경 후:
1. `users` upsert: contact 기준.
2. `profiles` insert.
3. Hermes agent routine 생성.
4. `routines` insert.
5. 첫 3개 또는 7일치 `delivery_queue` insert.
6. response에 `userId`, `profileId`, `routineId`, `queuedCount` 포함.

응답 예:
```json
{
  "ok": true,
  "userId": "...",
  "profileId": "...",
  "routineId": "...",
  "queuedCount": 3,
  "routine": {
    "generatedBy": "agent",
    "headline": "운영 리스크부터 잡는 백엔드 루틴",
    "items": []
  }
}
```

### `GET /api/admin/leads`

역할: 초기 운영자가 신청자와 큐 상태를 확인.

보안:
- 1차는 `ADMIN_TOKEN` header 또는 query token.
- public 노출 금지.

### `POST /api/admin/generate-queue`

역할: 특정 user/profile에 대해 다음 N일치 큐 생성.

Body:
```json
{ "userId": "...", "days": 7 }
```

### `POST /api/admin/send-due`

역할: due 된 `delivery_queue`를 처리. cron이 호출한다.

동작:
1. `status=pending AND scheduled_for <= now` 조회.
2. item별 `sending`으로 lock 비슷하게 상태 변경.
3. delivery adapter 호출.
4. 성공 시 `sent`, 실패 시 `failed` 또는 retry.

### `POST /api/answers`

역할: 시나리오 페이지 답변 저장. localStorage만 쓰던 상태에서 서버 저장으로 확장.

Body:
```json
{
  "userId": "...",
  "scenarioHref": "./scenarios/first-backend.html",
  "draftText": "...",
  "openedExplanation": false
}
```

---

## 학습지 포맷

매일 보내는 메시지는 길면 안 된다. 링크 하나와 답변 방식만 준다.

제목:
- `[답변근육] 오늘의 12분 답변 훈련 — 동시성 선택 기준`

본문 구조:
1. 오늘의 질문 한 줄
2. 왜 이걸 보내는지 개인화 이유 한 문장
3. 답변 프레임 3줄
4. 링크
5. 완료 후 할 일: 먼저 답하고 해설 열기

예시:
```text
오늘의 답변근육: 재고 1개에 주문 2개가 동시에 들어오면?

이번 질문은 “트레이드오프를 선택 기준으로 말하기”를 연습하기 좋습니다.

답변은 이렇게 시작해보세요.
1. 먼저 동시성 문제가 만드는 사용자/비즈니스 리스크를 정의합니다.
2. 락, 조건부 업데이트, 큐를 비교합니다.
3. 트래픽/정합성/복구 난이도 기준으로 선택합니다.

훈련 링크: https://dapgeun.dongpark.dev/scenarios/stock-concurrency.html
```

---

## 구현 순서

### Task 1: SQLite 저장소 추가

**Objective:** 외부 서비스 없이도 프로필과 루틴이 서버에 영구 저장되게 한다.

**Files:**
- Modify: `package.json`
- Create: `db.js`
- Create: `data/.gitkeep`
- Modify: `.gitignore`

**Steps:**
1. `better-sqlite3` 또는 Node 내장 대안 검토. Node 22에서 패키지 설치 리스크가 있으면 `sqlite3` CLI 호출보다 `better-sqlite3`를 우선.
2. `data/dapgeun.db` 생성.
3. 위 데이터 모델의 1차 테이블 생성 함수 작성.
4. `npm run check` 통과.

**Done:**
- 서버 시작 시 DB 파일이 없으면 생성된다.
- 중복 실행해도 schema init이 안전하다.

**Check:**
```bash
npm run check
node -e "const db=require('./db'); db.init(); console.log('ok')"
```

### Task 2: `/api/routine`에 저장 붙이기

**Objective:** 프로필 제출, 에이전트 루틴, 큐 seed가 DB에 남게 한다.

**Files:**
- Modify: `server.js`
- Modify: `db.js`

**Steps:**
1. `normalizeProfile()` 결과로 `users` upsert.
2. `profiles` insert.
3. agent response 검증 후 `routines` insert.
4. routine items를 기준으로 `delivery_queue`에 첫 3개 pending insert.
5. response에 ids와 `queuedCount` 포함.

**Done:**
- 같은 contact로 제출하면 user는 재사용되고 profile은 새로 생긴다.
- agent 실패 시 profile 저장 여부는 남기되 routine은 실패 이벤트로 남긴다.

**Check:**
```bash
curl -sS -X POST http://127.0.0.1:8088/api/routine -H 'content-type: application/json' --data @fixtures/backend-profile.json
sqlite3 data/dapgeun.db 'select count(*) from users; select count(*) from delivery_queue;'
```

### Task 3: 관리자 조회 API 추가

**Objective:** DB에 무엇이 쌓였는지 운영자가 확인할 수 있게 한다.

**Files:**
- Modify: `server.js`
- Modify: `db.js`

**Steps:**
1. `ADMIN_TOKEN` 환경변수 지원.
2. `GET /api/admin/leads` 추가.
3. 최근 user/profile/routine/queue 상태를 JSON으로 반환.
4. token 없으면 401.

**Done:**
- 신청자 목록과 pending queue 수가 보인다.

**Check:**
```bash
curl -i http://127.0.0.1:8088/api/admin/leads
curl -sS -H "x-admin-token: $ADMIN_TOKEN" http://127.0.0.1:8088/api/admin/leads
```

### Task 4: 큐 생성 로직 분리

**Objective:** 첫 제출뿐 아니라 나중에 7일치/14일치 큐를 생성할 수 있게 한다.

**Files:**
- Modify: `server.js`
- Create: `curation.js`

**Steps:**
1. `buildDeliveryQueueItems(profile, routine, days)` 함수 생성.
2. cadence가 `주 3회`면 월/수/금 같은 schedule을 만들고, daily면 매일 만든다.
3. 각 item에 subject/body/scenario 정보를 저장.
4. 테스트용 dry-run API를 둔다.

**Done:**
- 동일 루틴으로 7일치 큐가 만들어진다.
- 과거 시간으로 scheduled_for가 생성되지 않는다.

**Check:**
```bash
node -e "const {buildDeliveryQueueItems}=require('./curation'); console.log(buildDeliveryQueueItems({}, {items:[]}, 7))"
```

### Task 5: 이메일 adapter 추가

**Objective:** queue item을 실제 메일로 보낼 수 있게 한다.

**Files:**
- Create: `delivery/email.js`
- Modify: `server.js`
- Modify: `.env.example`

**Decision:**
- 1순위: Resend API. 구현이 단순하고 HTTP 호출만 필요.
- 2순위: SMTP. 기존 메일 서버가 있을 때 사용.

**Env:**
- `RESEND_API_KEY`
- `FROM_EMAIL`

**Done:**
- 실제 전송 전 `DRY_RUN_DELIVERY=true`면 console log만 남긴다.
- provider response id를 `deliveries.provider_message_id`에 저장한다.

**Check:**
```bash
DRY_RUN_DELIVERY=true node scripts/send-due.js
```

### Task 6: due queue 발송 worker 추가

**Objective:** 매일 발송 자동화의 실행 단위를 만든다.

**Files:**
- Create: `scripts/send-due.js`
- Modify: `package.json`

**Steps:**
1. pending due item 조회.
2. sending 상태로 변경.
3. adapter 호출.
4. sent/failed 업데이트.
5. 최대 발송 수 limit 지원.

**Done:**
- worker를 여러 번 실행해도 이미 sent 된 item은 재발송하지 않는다.
- 실패는 retry_count가 증가한다.

**Check:**
```bash
npm run send:due -- --dry-run
```

### Task 7: systemd timer 또는 Hermes cron 연결

**Objective:** 매일 정해진 시간에 due queue를 처리한다.

**Files:**
- Create: `ops/dapgeun-send-due.service`
- Create: `ops/dapgeun-send-due.timer`

**Steps:**
1. 오전 8시 또는 사용자의 timezone 기준 발송을 기본으로 한다.
2. systemd timer로 `npm run send:due` 실행.
3. 로그 확인 명령 문서화.

**Done:**
- `systemctl --user list-timers`에 timer가 보인다.
- dry-run으로 timer 실행 검증 가능.

**Check:**
```bash
systemctl --user list-timers | grep dapgeun
journalctl --user -u dapgeun-send-due.service -n 50 --no-pager
```

### Task 8: 시나리오 답변 저장 API 추가

**Objective:** 다음 학습지 큐레이션에 사용자의 실제 답변 데이터를 반영한다.

**Files:**
- Modify: scenario HTML files or shared script
- Modify: `server.js`
- Modify: `db.js`

**Steps:**
1. `POST /api/answers` 추가.
2. textarea 입력 debounce 저장.
3. `opened_explanation` 이벤트 저장.
4. localStorage는 fallback으로 유지.

**Done:**
- 사용자가 답변을 쓰면 서버 DB에도 저장된다.
- 네트워크 실패 시 localStorage는 계속 동작한다.

**Check:**
```bash
curl -sS -X POST http://127.0.0.1:8088/api/answers -H 'content-type: application/json' --data '{"scenarioHref":"./scenarios/first-backend.html","draftText":"테스트 답변"}'
```

---

## MVP 컷라인

**이번 주 안에 만들 최소 범위:**
1. DB schema/init.
2. `/api/routine` 저장.
3. `delivery_queue`에 첫 3개 pending 생성.
4. admin JSON 조회.
5. dry-run 발송 worker.

**메일 실제 발송은 그 다음:**
- 발송 도메인/from email 결정 필요.
- Resend/SMTP key 필요.
- unsubscribe 문구와 status 처리 필요.

**메시지 발송은 이메일 다음:**
- Telegram은 사용자 chat id 확보가 필요함.
- 카카오/문자는 별도 승인/비용 이슈가 있어 후순위.

---

## 운영 화면 없이도 볼 수 있는 1차 명령

```bash
# 서버 상태
systemctl --user status dapgeun-geunyuk.service --no-pager -l

# 헬스체크
curl -sS https://dapgeun.dongpark.dev/api/health

# DB 카운트
sqlite3 data/dapgeun.db 'select count(*) from users; select count(*) from delivery_queue where status="pending";'

# 발송 dry-run
DRY_RUN_DELIVERY=true npm run send:due
```

---

## 이후 제품 고도화

- 관리자 미니 대시보드: 신청자, 최근 루틴, 발송 큐, 실패 로그.
- 학습지 개인화 강화: 최근 답변 글자 수, 해설 열기 여부, 약점 태그를 prompt에 넣기.
- 구독 상태: pause/unsubscribe 링크.
- 큐레이션 품질 측정: open/click/answer_started/done 이벤트.
- 프리미엄화: 매주 약점 리포트와 다음 주 루틴 자동 생성.
