const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWindows = process.platform === 'win32';
const requestedServer = process.argv[2];
const launcherDir = __dirname;
const configRoot = path.resolve(launcherDir, '..');

function getMcpRemoteCommand() {
  const localBinary = path.join(
    configRoot,
    'node_modules',
    '.bin',
    isWindows ? 'mcp-remote.cmd' : 'mcp-remote',
  );

  if (fs.existsSync(localBinary)) {
    return {
      command: localBinary,
      args: [],
    };
  }

  return {
    command: isWindows ? 'npx.cmd' : 'npx',
    args: ['-y', 'mcp-remote@latest'],
  };
}

const SERVER_CONFIG = {
  github: {
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http-only',
    headers: ['Authorization: Bearer {GITHUB_MCP_PAT}'],
    requiredEnv: ['GITHUB_MCP_PAT'],
  },
  context7: {
    url: 'https://mcp.context7.com/mcp',
    transport: 'http-only',
    headers: ['CONTEXT7_API_KEY: {CONTEXT7_API_KEY}'],
    requiredEnv: ['CONTEXT7_API_KEY'],
  },
};

function stripWrappingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function loadEnvFile(filePath) {
  const result = {};
  const content = fs.readFileSync(filePath, 'utf8');

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
    result[key] = value;
  }

  return result;
}

function getEnvCandidates() {
  return [path.join(configRoot, '.env.opencode-mcp')];
}

function getExistingEnvFiles() {
  return getEnvCandidates().filter((candidate) => fs.existsSync(candidate));
}

function mergeEnvFiles(filePaths) {
  const merged = { ...process.env };

  for (const filePath of filePaths) {
    const fileEnv = loadEnvFile(filePath);
    for (const [key, value] of Object.entries(fileEnv)) {
      if (value) {
        merged[key] = value;
      }
    }
  }

  return merged;
}

function buildHeaders(headerTemplates, env) {
  return headerTemplates.map((template) =>
    template.replace(/\{([A-Z0-9_]+)\}/gu, (_, key) => env[key] || ''),
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function spawnAndProxy(command, args, options = {}) {
  if (isWindows) {
    const child = spawn(process.env.ComSpec || 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      command,
      ...args,
    ], {
      stdio: 'inherit',
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exit(code ?? 0);
    });

    child.on('error', (error) => {
      fail(`Failed to launch remote MCP '${requestedServer}': ${error.message}`);
    });

    return;
  }

  const child = spawn(command, args, {
    stdio: 'inherit',
    cwd: options.cwd,
    env: options.env,
    shell: false,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    fail(`Failed to launch remote MCP '${requestedServer}': ${error.message}`);
  });
}

function launch() {
  if (!requestedServer || !SERVER_CONFIG[requestedServer]) {
    fail('Usage: node .opencode/mcp-remote-launcher.js <github|context7>');
  }

  const config = SERVER_CONFIG[requestedServer];
  const envFilePaths = getExistingEnvFiles();
  const localEnvPath = path.join(configRoot, '.env.opencode-mcp');

  if (envFilePaths.length === 0) {
    fail(
      `Missing ${localEnvPath}. Copy .env.opencode-mcp.example and fill in the required secrets.`,
    );
  }

  const mergedEnv = mergeEnvFiles(envFilePaths);

  for (const key of config.requiredEnv) {
    if (!mergedEnv[key]) {
      fail(`Missing required variable ${key} in ${envFilePaths.join(', ')}.`);
    }
  }

  const runtime = getMcpRemoteCommand();
  const args = [...runtime.args, config.url, '--transport', config.transport];
  for (const header of buildHeaders(config.headers, mergedEnv)) {
    args.push('--header', header);
  }

  spawnAndProxy(runtime.command, args, {
    cwd: configRoot,
    env: mergedEnv,
  });
}

launch();
