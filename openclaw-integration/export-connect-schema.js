const fs = require('fs');
const path = require('path');
const { ConnectApiClient } = require('./connect-api-client');

async function run() {
  const outDir = path.resolve(process.cwd(), process.argv[2] || 'openclaw-integration/generated');
  fs.mkdirSync(outDir, { recursive: true });

  const client = new ConnectApiClient();
  const [schema, functions] = await Promise.all([client.schema(), client.functions()]);

  const schemaPath = path.join(outDir, 'connect_schema.json');
  const functionsPath = path.join(outDir, 'connect_functions.json');

  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  fs.writeFileSync(functionsPath, JSON.stringify(functions, null, 2));

  console.log(`Wrote ${schemaPath}`);
  console.log(`Wrote ${functionsPath}`);
}

run().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});

