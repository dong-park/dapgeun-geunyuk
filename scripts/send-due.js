#!/usr/bin/env node
const db = require('../db');
const { sendEmail } = require('../delivery/email');

function parseArgs(argv) {
  const args = { dryRun: false, limit: Number(process.env.SEND_DUE_LIMIT || 20) };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1] || args.limit);
  }
  return args;
}

async function sendDue(options = {}) {
  const conn = options.conn || db.init(db.openDatabase(options.dbPath));
  const due = db.claimDueQueue(conn, { now: options.now || new Date().toISOString(), limit: options.limit || 20 });
  const results = [];
  for (const item of due) {
    try {
      const user = conn.prepare('select * from users where id = ?').get(item.user_id);
      if (!user) throw new Error(`user not found: ${item.user_id}`);
      if (item.channel !== 'email') throw new Error(`unsupported channel: ${item.channel}`);
      const sent = await sendEmail({ to: user.contact, subject: item.subject, body: item.body }, { dryRun: options.dryRun });
      db.markDeliverySent(conn, item.id, { provider: sent.provider, providerMessageId: sent.messageId });
      db.addEvent(conn, user.id, 'delivery_sent', { queueId: item.id, provider: sent.provider });
      results.push({ id: item.id, status: 'sent', provider: sent.provider });
    } catch (err) {
      db.markDeliveryFailed(conn, item.id, err, { provider: item.channel || 'unknown' });
      results.push({ id: item.id, status: 'failed', error: String(err.message || err) });
    }
  }
  return { claimed: due.length, results };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  sendDue(args)
    .then((result) => {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      process.exit(result.results.some((x) => x.status === 'failed') ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { sendDue, parseArgs };
