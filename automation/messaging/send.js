// messaging/send.js
const { randomDelay } = require('../human/delay');
const { handleMessagingInterface, verifyMessageSent } = require('./interface');
const { canConsumeMessageQuota, updateMessageQuota } = require('./quota');
const { logAction } = require('../util/log');

function personalizeMessage(template, profile) {
  return template
    .replace(/{{\s*name\s*}}/gi, profile?.name || 'there')
    .replace(/{{\s*company\s*}}/gi, profile?.company || 'your company');
}

async function sendLinkedInMessage(page, toProfile, message) {
  const quotaState = canConsumeMessageQuota(1);
  if (!quotaState.allowed) return false;
  await handleMessagingInterface(page);
  const btn = await page.$('button[aria-label*="Message"], a[aria-label*="Message"]');
  if (btn) { await btn.click(); await page.waitForTimeout(800); }
  const box = await page.$('div[role="textbox"][contenteditable="true"], textarea');
  if (!box) return false;
  await box.type(message, { delay: 35 + Math.random()*45 });
  await page.keyboard.press('Enter');
  await randomDelay(400, 700);
  const ok = await verifyMessageSent(page);
  if (ok) updateMessageQuota(1);
  return ok;
}

async function sendBulkMessages(page, profiles, template) {
  let sent = 0;
  for (const p of profiles) {
    const msg = personalizeMessage(template, p);
    if (await sendLinkedInMessage(page, p, msg)) sent++;
    await randomDelay(800, 1200);
  }
  logAction(`sendBulkMessages: ${sent}/${profiles.length}`);
  return sent;
}

async function processMessageSending(page, profiles, template) {
  return sendBulkMessages(page, profiles, template);
}

module.exports = { sendLinkedInMessage, handleMessagingInterface, verifyMessageSent, sendBulkMessages, personalizeMessage, processMessageSending };
