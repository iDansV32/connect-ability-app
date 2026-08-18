const DEFAULT_BASE_URL = process.env.CONNECT_API_BASE || 'http://127.0.0.1:3030';
const DEFAULT_TIMEOUT_MS = Number(process.env.CONNECT_API_TIMEOUT_MS || 30000);

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
}

class ConnectApiClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Intentional: this is a *client* (outbound HTTP consumer), not a server
    // process. The CONNECT_API_TOKEN env var here is the operator carrying their
    // own credential into a CLI tool they're invoking explicitly, which is a
    // different ergonomic class from server-side credential storage.
    // Server-side sources (Electron main, MCP server) go through
    // automation/safety/secret-source — do NOT migrate this read without
    // first deciding how client tools acquire credentials.
    this.token = options.token || process.env.CONNECT_API_TOKEN || '';
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  }

  buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
      headers['X-API-Token'] = this.token;
    }
    return headers;
  }

  async get(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const timeout = withTimeout(options.signal, this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(options.headers || {}),
        signal: timeout.signal
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || `HTTP ${response.status}`);
      }
      return json;
    } finally {
      timeout.clear();
    }
  }

  async post(path, body, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const timeout = withTimeout(options.signal, this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(options.headers || {}),
        body: JSON.stringify(body || {}),
        signal: timeout.signal
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || `HTTP ${response.status}`);
      }
      return json;
    } finally {
      timeout.clear();
    }
  }

  async health() {
    return this.get('/api/health');
  }

  async functions() {
    return this.get('/api/functions');
  }

  async schema() {
    return this.get('/api/schema');
  }

  async invoke(functionName, args = []) {
    if (!functionName || typeof functionName !== 'string') {
      throw new Error('functionName is required');
    }
    return this.post('/api/call', {
      function: functionName,
      args: Array.isArray(args) ? args : []
    });
  }

  async discoverTools() {
    const [schemaResult, functionsResult] = await Promise.allSettled([this.schema(), this.functions()]);

    const tools = {};
    if (schemaResult.status === 'fulfilled' && Array.isArray(schemaResult.value?.operations)) {
      for (const operation of schemaResult.value.operations) {
        if (!operation?.function) continue;
        tools[operation.function] = {
          name: operation.function,
          description: operation.description || operation.id || `Connect Ability: ${operation.function}`,
          operation
        };
      }
    }

    if (functionsResult.status === 'fulfilled' && Array.isArray(functionsResult.value?.functions)) {
      for (const fn of functionsResult.value.functions) {
        if (!tools[fn]) {
          tools[fn] = {
            name: fn,
            description: `Connect Ability function: ${fn}`
          };
        }
      }
    }

    return Object.values(tools);
  }
}

module.exports = {
  ConnectApiClient
};
