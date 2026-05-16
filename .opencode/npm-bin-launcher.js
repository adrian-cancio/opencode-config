const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWindows = process.platform === 'win32';
const executableName = process.argv[2];
const forwardedArgs = process.argv.slice(3);
const configRoot = path.resolve(__dirname, '..');

const REQUIRED_ENV_BY_EXECUTABLE = {
  'brave-search-mcp-server': ['BRAVE_API_KEY'],
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function resolveExecutable(name) {
  const candidate = path.join(
    configRoot,
    'node_modules',
    '.bin',
    isWindows ? `${name}.cmd` : name,
  );

  if (!fs.existsSync(candidate)) {
    fail(`Missing local npm binary: ${candidate}. Run npm install for ${name}.`);
  }

  return candidate;
}

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

function buildLaunchEnv(name) {
  const merged = { ...process.env };

  for (const filePath of getExistingEnvFiles()) {
    const fileEnv = loadEnvFile(filePath);
    for (const [key, value] of Object.entries(fileEnv)) {
      if (value) {
        merged[key] = value;
      }
    }
  }

  const requiredEnv = REQUIRED_ENV_BY_EXECUTABLE[name] || [];
  for (const key of requiredEnv) {
    if (!merged[key]) {
      fail(`Missing required variable ${key} in .env.opencode-mcp for ${name}.`);
    }
  }

  return merged;
}

function spawnAndProxy(command, args, env) {
  if (isWindows) {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...args], {
      stdio: 'inherit',
      cwd: configRoot,
      env,
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
      fail(`Failed to launch npm binary '${executableName}': ${error.message}`);
    });

    return;
  }

  const child = spawn(command, args, {
    stdio: 'inherit',
    cwd: configRoot,
    env,
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
    fail(`Failed to launch npm binary '${executableName}': ${error.message}`);
  });
}

if (!executableName) {
  fail('Usage: node .opencode/npm-bin-launcher.js <bin-name> [...args]');
}

const executablePath = resolveExecutable(executableName);
const launchEnv = buildLaunchEnv(executableName);
spawnAndProxy(executablePath, forwardedArgs, launchEnv);
