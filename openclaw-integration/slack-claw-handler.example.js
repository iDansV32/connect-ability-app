const crypto = require('crypto');
const express = require('express');
const { ConnectApiClient } = require('./connect-api-client');

const PORT = Number(process.env.SLACK_HANDLER_PORT || 8787);
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const OPENCLAW_BASE_URL = process.env.OPENCLAW_BASE_URL || '';
const OPENCLAW_API_TOKEN = process.env.OPENCLAW_API_TOKEN || '';

const connectClient = new ConnectApiClient();
const app = express();

// Slack signature verification requires raw body.
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    }
  })
);
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    }
  })
);

function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) return true;
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig || !req.rawBody) return false;

  const base = `v0:${ts}:${req.rawBody}`;
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
}

async function callOpenClawForPlan(slackText) {
  if (!OPENCLAW_BASE_URL) {
    throw new Error('OPENCLAW_BASE_URL is not configured');
  }
  const response = await fetch(`${OPENCLAW_BASE_URL.replace(/\/+$/, '')}/v1/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(OPENCLAW_API_TOKEN ? { Authorization: `Bearer ${OPENCLAW_API_TOKEN}` } : {})
    },
    body: JSON.stringify({
      input: slackText,
      toolCatalog: 'Use Connect Ability API only via POST /api/call with function + args.',
      availableFunctions: (await connectClient.functions()).functions || []
    })
  });

  if (!response.ok) {
    const msg = await response.text();
    throw new Error(`OpenClaw planning failed: ${msg}`);
  }
  return response.json();
}

app.post('/slack/claw', async (req, res) => {
  try {
    if (!verifySlackSignature(req)) {
      return res.status(401).json({ ok: false, error: 'Invalid Slack signature' });
    }

    const commandText = String(req.body?.text || '').trim();
    if (!commandText) {
      return res.status(200).send('Usage: /claw <instruction>');
    }

    // Immediate ack for Slack
    res.status(200).send(`Received: "${commandText}". Executing...`);

    // Plan with OpenClaw (replace with your existing OpenClaw runtime call as needed).
    const plan = await callOpenClawForPlan(commandText);
    const functionName = plan?.function;
    const args = Array.isArray(plan?.args) ? plan.args : [];
    if (!functionName) {
      throw new Error('OpenClaw did not return a function');
    }

    const result = await connectClient.invoke(functionName, args);
    console.log('Slack /claw execution result:', { functionName, ok: result?.ok, result });
  } catch (error) {
    console.error('Slack /claw handler failed:', error.message || error);
  }
});

app.listen(PORT, () => {
  console.log(`Slack /claw handler listening on http://127.0.0.1:${PORT}/slack/claw`);
});

