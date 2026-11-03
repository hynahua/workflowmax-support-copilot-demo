import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Script, createContext } from 'node:vm';

test('file entry uses a classic script and shows launch guidance without an API request', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /<script defer src="\.\/app\.js"><\/script>/);
  const elements = new Map();
  const classes = [];
  let requests = 0;
  const context = createContext({
    window: { location: { protocol: 'file:' } },
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, { hidden: true, addEventListener() {} }); return elements.get(id); },
      querySelectorAll: () => [], body: { classList: { add: value => classes.push(value) } }
    },
    fetch: () => { requests++; throw new Error('A file entry must not fetch.'); }
  });
  new Script(await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).runInContext(context);
  assert.ok(classes.includes('file-mode'));
  assert.equal(elements.get('fileHelp').hidden, false);
  assert.equal(requests, 0);
});

test('launcher server selects a free loopback port and serves the complete rehearsal app', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflowmax-launch-test-'));
  const child = spawn(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname, '--rehearsal', '--auto-port'], {
    cwd: tmpdir(), env: { ...process.env, DEMO_DATA_DIR: directory, PORT: 'not-a-port' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
    await rm(directory, { recursive: true, force: true });
  });
  const address = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local launcher startup timed out.')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Local launcher exited before readiness.')); });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/WorkflowMAX Support Lab: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const bootstrap = await (await fetch(`${address}/api/bootstrap`)).json();
  assert.equal(bootstrap.mode, 'rules_rehearsal');
  assert.equal(bootstrap.tickets.length, 12);
  for (const path of ['/', '/styles.css', '/app.js']) assert.equal((await fetch(`${address}${path}`)).status, 200);
});
