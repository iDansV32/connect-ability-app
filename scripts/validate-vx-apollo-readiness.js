'use strict';

const ApolloClient = require('../apollo-client');
const { getApolloApiKey } = require('../apollo-credential-store');

const DEFAULT_DEAL_CAP = 100;
const DEFAULT_TASK_CAP = 100;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const apiKey = await getApolloApiKey();
  if (!apiKey) {
    throw new Error('Apollo API key not found in keychain. Configure Apollo integration first.');
  }

  const client = new ApolloClient({ apiKey });
  const report = {
    generatedAt: new Date().toISOString(),
    contactStages: [],
    dealStages: [],
    users: [],
    endpointChecks: {},
    samples: []
  };

  report.contactStages = await loadEndpoint(
    report.endpointChecks,
    'contactStages',
    () => client.listContactStages()
  );
  report.dealStages = await loadEndpoint(
    report.endpointChecks,
    'dealStages',
    () => client.listDealStages()
  );
  report.users = await loadEndpoint(
    report.endpointChecks,
    'users',
    () => client.listUsers({ page: 1, perPage: 100 })
  );

  const sampleInputs = buildSampleInputs(args);
  for (const sample of sampleInputs) {
    report.samples.push(await inspectSample(sample, client, args));
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printHumanReport(report, args);
}

async function inspectSample(sample, client, args) {
  const base = {
    input: sample,
    resolved: false,
    resolutionSource: null,
    contact: null,
    dealsReturned: 0,
    tasksReturned: 0,
    dealCap: args.dealCap,
    taskCap: args.taskCap,
    dealCapReached: false,
    taskCapReached: false,
    errors: []
  };

  try {
    const contact = await resolveSampleContact(sample, client);
    if (!contact?.id) {
      return {
        ...base,
        resolutionSource: sample.type,
        errors: ['No Apollo contact could be resolved from the supplied sample input.']
      };
    }

    const [deals, tasks] = await Promise.all([
      client.searchDeals({
        contact_id: contact.id,
        page: 1,
        per_page: args.dealCap
      }),
      client.searchTasks({
        filters: {
          contact_id: contact.id
        },
        page: 1,
        perPage: args.taskCap
      })
    ]);

    return {
      ...base,
      resolved: true,
      resolutionSource: sample.type,
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        linkedinUrl: contact.linkedinUrl,
        ownerId: contact.ownerId,
        stageId: contact.stageId,
        stageName: contact.stageName
      },
      dealsReturned: Array.isArray(deals) ? deals.length : 0,
      tasksReturned: Array.isArray(tasks) ? tasks.length : 0,
      dealCapReached: Array.isArray(deals) && deals.length >= args.dealCap,
      taskCapReached: Array.isArray(tasks) && tasks.length >= args.taskCap
    };
  } catch (error) {
    return {
      ...base,
      resolutionSource: sample.type,
      errors: [String(error?.message || error || 'Unknown Apollo validation error').trim()]
    };
  }
}

async function resolveSampleContact(sample, client) {
  if (sample.type === 'contact-id') {
    return client.getContact(sample.value);
  }

  const matched = await client.matchPerson({
    prospect: {
      email: sample.type === 'email' ? sample.value : undefined,
      profileUrl: sample.type === 'linkedin-url' ? sample.value : undefined
    }
  });

  if (!matched?.contactId) {
    return null;
  }

  return client.getContact(matched.contactId);
}

function printHumanReport(report, args) {
  process.stdout.write('Virtual Xperiences Apollo readiness report\n');
  process.stdout.write(`Generated: ${report.generatedAt}\n\n`);

  process.stdout.write('Contact stages\n');
  const contactStageStatus = report.endpointChecks.contactStages;
  if (contactStageStatus?.ok === false) {
    process.stdout.write(`- ERROR: ${contactStageStatus.error}\n`);
  }
  for (const stage of report.contactStages) {
    process.stdout.write(`- ${stage.name || stage.id}\n`);
  }
  if (!report.contactStages.length) {
    process.stdout.write('- <none returned>\n');
  }

  process.stdout.write('\nDeal stages\n');
  const dealStageStatus = report.endpointChecks.dealStages;
  if (dealStageStatus?.ok === false) {
    process.stdout.write(`- ERROR: ${dealStageStatus.error}\n`);
  }
  for (const stage of report.dealStages) {
    process.stdout.write(`- ${stage.name || stage.id}\n`);
  }
  if (!report.dealStages.length) {
    process.stdout.write('- <none returned>\n');
  }

  process.stdout.write(`\nSample validation (deal cap ${args.dealCap}, task cap ${args.taskCap})\n`);
  const userStatus = report.endpointChecks.users;
  process.stdout.write('\nUser access check\n');
  if (userStatus?.ok === false) {
    process.stdout.write(`- ERROR: ${userStatus.error}\n`);
  } else {
    process.stdout.write(`- users returned: ${Array.isArray(report.users) ? report.users.length : 0}\n`);
  }

  process.stdout.write(`\nSample validation (deal cap ${args.dealCap}, task cap ${args.taskCap})\n`);
  if (!report.samples.length) {
    process.stdout.write('- No sample contacts provided. Pass --contact-id, --email, or --linkedin-url to validate deal/task bounds.\n');
    return;
  }

  for (const sample of report.samples) {
    process.stdout.write(`- ${sample.input.type}: ${sample.input.value}\n`);
    if (!sample.resolved) {
      process.stdout.write(`  resolved: no\n`);
      for (const error of sample.errors) {
        process.stdout.write(`  error: ${error}\n`);
      }
      continue;
    }

    process.stdout.write(`  resolved: yes (${sample.contact.id})\n`);
    process.stdout.write(`  stage: ${sample.contact.stageName || sample.contact.stageId || '<unknown>'}\n`);
    process.stdout.write(`  deals returned: ${sample.dealsReturned}${sample.dealCapReached ? ' (hit cap)' : ''}\n`);
    process.stdout.write(`  tasks returned: ${sample.tasksReturned}${sample.taskCapReached ? ' (hit cap)' : ''}\n`);
  }
}

function buildSampleInputs(args) {
  return [
    ...args.contactIds.map((value) => ({ type: 'contact-id', value })),
    ...args.emails.map((value) => ({ type: 'email', value })),
    ...args.linkedinUrls.map((value) => ({ type: 'linkedin-url', value }))
  ];
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    json: false,
    dealCap: DEFAULT_DEAL_CAP,
    taskCap: DEFAULT_TASK_CAP,
    contactIds: [],
    emails: [],
    linkedinUrls: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--contact-id':
        parsed.contactIds.push(requireValue(argv, ++index, '--contact-id'));
        break;
      case '--email':
        parsed.emails.push(requireValue(argv, ++index, '--email'));
        break;
      case '--linkedin-url':
        parsed.linkedinUrls.push(requireValue(argv, ++index, '--linkedin-url'));
        break;
      case '--deal-cap':
        parsed.dealCap = normalizePositiveInteger(requireValue(argv, ++index, '--deal-cap'), DEFAULT_DEAL_CAP);
        break;
      case '--task-cap':
        parsed.taskCap = normalizePositiveInteger(requireValue(argv, ++index, '--task-cap'), DEFAULT_TASK_CAP);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  const value = String(argv[index] || '').trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

async function loadEndpoint(endpointChecks, key, loader) {
  try {
    const value = await loader();
    endpointChecks[key] = { ok: true, error: null };
    return Array.isArray(value) ? value : [];
  } catch (error) {
    endpointChecks[key] = {
      ok: false,
      error: String(error?.message || error || 'Unknown endpoint error').trim()
    };
    return [];
  }
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/validate-vx-apollo-readiness.js [options]',
      '',
      'Options:',
      '  --contact-id <id>       Validate a specific Apollo contact by id (repeatable)',
      '  --email <email>         Resolve a sample Apollo contact by email (repeatable)',
      '  --linkedin-url <url>    Resolve a sample Apollo contact by LinkedIn URL (repeatable)',
      '  --deal-cap <n>          Query cap used for deal-bound validation (default: 100)',
      '  --task-cap <n>          Query cap used for task-bound validation (default: 100)',
      '  --json                  Emit JSON instead of human-readable text',
      '  --help                  Show this help text'
    ].join('\n') + '\n'
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || error || 'Unknown error').trim()}\n`);
  process.exitCode = 1;
});
