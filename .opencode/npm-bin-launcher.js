const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWindows = process.platform === 'win32';
const executableName = process.argv[2];
const forwardedArgs = process.argv.slice(3);
const configRoot = path.resolve(__dirname, '..');

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

function spawnAndProxy(command, args) {
  if (isWindows) {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...args], {
      stdio: 'inherit',
      cwd: configRoot,
      env: process.env,
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
    env: process.env,
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
spawnAndProxy(executablePath, forwardedArgs);
