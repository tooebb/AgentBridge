#!/usr/bin/env node

const { spawnSync } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.SERVER || 'http://127.0.0.1:8080';
const REQUIRE_DEVICE = process.env.W3_REQUIRE_DEVICE === '1';
const TIMEOUT_MS = Number(process.env.W3_PREFLIGHT_TIMEOUT_MS || 5000);

let passed = 0;
let warned = 0;
let failed = 0;

function pass(name, detail) {
  console.log(`  PASS: ${name}${detail ? ' - ' + detail : ''}`);
  passed++;
}

function warn(name, detail) {
  console.log(`  WARN: ${name}${detail ? ' - ' + detail : ''}`);
  warned++;
}

function fail(name, detail) {
  console.log(`  FAIL: ${name}${detail ? ' - ' + detail : ''}`);
  failed++;
}

function requestHealth() {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${SERVER}/health`);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 8080,
      path: parsed.pathname,
      method: 'GET',
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
          return;
        }
        reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout || TIMEOUT_MS,
  });
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    pass('Node.js version', process.version);
  } else {
    fail('Node.js version', `requires >=18, got ${process.version}`);
  }
}

function checkPackageInstall() {
  const result = runCommand('npm', ['ls', 'ws', '--depth=0'], { cwd: __dirname });
  if (result.status === 0) {
    pass('mock-device dependencies installed');
  } else {
    fail('mock-device dependencies installed', 'run npm install under mock-device');
  }
}

async function checkCore() {
  try {
    await requestHealth();
    pass('middleware core health endpoint reachable', SERVER);
    return true;
  } catch (err) {
    fail('middleware core health endpoint reachable', `${SERVER} (${err.message})`);
    return false;
  }
}

function checkW3Readiness() {
  const result = runCommand('npm', ['run', 'test:w3'], {
    cwd: __dirname,
    timeout: Number(process.env.W3_READINESS_TIMEOUT_MS || 30000),
  });
  if (result.status === 0) {
    pass('simulated W3 readiness check');
    return;
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  fail('simulated W3 readiness check', output.split('\n').slice(-4).join(' | '));
}

function parseAdbDevices(output) {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    });
}

function checkAdbDevices() {
  const version = runCommand('adb', ['version']);
  if (version.error && version.error.code === 'ENOENT') {
    const message = 'adb not found; install Android platform-tools on the machine used for real W3/phone联调';
    REQUIRE_DEVICE ? fail('adb available', message) : warn('adb available', message);
    return;
  }
  if (version.status !== 0) {
    const detail = (version.stderr || version.stdout || '').trim();
    REQUIRE_DEVICE ? fail('adb available', detail) : warn('adb available', detail);
    return;
  }
  pass('adb available', version.stdout.split('\n')[0]);

  const devicesResult = runCommand('adb', ['devices']);
  if (devicesResult.status !== 0) {
    const detail = (devicesResult.stderr || devicesResult.stdout || '').trim();
    REQUIRE_DEVICE ? fail('adb devices', detail) : warn('adb devices', detail);
    return;
  }

  const devices = parseAdbDevices(devicesResult.stdout || '');
  const readyDevices = devices.filter((device) => device.state === 'device');
  const blockedDevices = devices.filter((device) => device.state !== 'device');
  if (readyDevices.length > 0) {
    pass('adb connected devices', readyDevices.map((device) => device.serial).join(', '));
  } else {
    const detail = blockedDevices.length > 0
      ? `no ready device; seen ${blockedDevices.map((device) => `${device.serial}:${device.state}`).join(', ')}`
      : 'no Android/W3 device visible to this host';
    REQUIRE_DEVICE ? fail('adb connected devices', detail) : warn('adb connected devices', detail);
  }
}

async function run() {
  console.log('\n  AgentBridge W3 Device Preflight\n');
  console.log(`  Server:         ${SERVER}`);
  console.log(`  Require device: ${REQUIRE_DEVICE ? 'yes' : 'no'}\n`);

  checkNode();
  checkPackageInstall();
  const coreReady = await checkCore();
  if (coreReady) {
    checkW3Readiness();
  } else {
    warn('simulated W3 readiness check', 'skipped because middleware core is not reachable');
  }
  checkAdbDevices();

  console.log('\n  Real-device联调 handoff:');
  console.log('  1. Connect W3/phone to this host and confirm adb devices shows state=device.');
  console.log('  2. Run W3_REQUIRE_DEVICE=1 npm run w3:preflight.');
  console.log('  3. If SDK/App behavior fails, capture adb logcat, app logs, and the Core console output.');

  console.log(`\n  Results: ${passed} passed, ${warned} warnings, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run().catch((err) => {
  console.error('Preflight error:', err.message);
  process.exitCode = 1;
});
