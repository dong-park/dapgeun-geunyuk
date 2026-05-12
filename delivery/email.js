async function sendEmail(message, options = {}) {
  const dryRun = options.dryRun ?? (process.env.DRY_RUN_DELIVERY === 'true' || !process.env.RESEND_API_KEY);
  const provider = dryRun ? 'dry-run' : 'resend';
  if (dryRun) {
    console.log(`[dry-run-email] to=${message.to} subject=${message.subject}`);
    return { provider, messageId: `dry-${Date.now()}` };
  }
  const from = process.env.FROM_EMAIL;
  if (!from) throw new Error('FROM_EMAIL is required for Resend delivery');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from, to: message.to, subject: message.subject, text: message.body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend failed with ${response.status}`);
  return { provider, messageId: data.id || null };
}

module.exports = { sendEmail };
