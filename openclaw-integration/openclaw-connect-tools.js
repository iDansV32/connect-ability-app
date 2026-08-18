const { ConnectApiClient } = require('./connect-api-client');

async function registerConnectAbilityTools(toolRegistry, options = {}) {
  if (!toolRegistry || typeof toolRegistry.register !== 'function') {
    throw new Error('toolRegistry.register(name, handler, metadata) is required');
  }

  const client = new ConnectApiClient(options);
  const discoveredTools = await client.discoverTools();

  discoveredTools.forEach((tool) => {
    const name = `connect.${tool.name}`;
    toolRegistry.register(
      name,
      async (args = []) => {
        const normalizedArgs = Array.isArray(args) ? args : [args];
        return client.invoke(tool.name, normalizedArgs);
      },
      {
        source: 'connect-ability',
        description: tool.description || `Invoke Connect Ability function ${tool.name}`,
        functionName: tool.name
      }
    );
  });

  return {
    count: discoveredTools.length,
    tools: discoveredTools.map((t) => t.name)
  };
}

module.exports = {
  registerConnectAbilityTools
};

