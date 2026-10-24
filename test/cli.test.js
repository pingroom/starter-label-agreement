import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { step } from '../src/engine.js';
import { mockApi, CONFIG, ROOM_CODE, id } from '../src/mock.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const study = JSON.parse(await readFile(join(source, 'examples/study.json')));
const pairing = () => ({ pair_token: 'offline-fixture', pair_url: 'https://api.pingroom.io/agent/pair/offline-fixture', expires_in: 900, poll_interval_ms: 1000 });

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agreement-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'study.json'), JSON.stringify(study));
  await writeFile(join(directory, 'config.json'), JSON.stringify(CONFIG));
  await writeFile(join(directory, 'transport.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('fixture.json', root)));
const calls = [];
globalThis.fetch = async (raw, init) => {
  const path = new URL(raw).pathname;
  calls.push({ method: init.method, path });
  writeFileSync(new URL('calls.json', root), JSON.stringify(calls));
  if (fixture.question && path === '/api/agent/questions/' + fixture.question.id) return Response.json(fixture.question);
  if (fixture.loseAt === path) throw new Error('Simulated lost response.');
  if (path === '/api/agent/auth') return Response.json({ credential: 'offline-pending', credential_type: 'pre_claim', expires_in: 900 });
  if (path === '/api/agent/auth/pair/start') return Response.json(fixture.pairing);
  if (path === '/api/agent/auth/pair/status') return Response.json({ status: 'active', credential: 'offline-active', credential_type: 'active', expires_in: null, room: { invite_code: 'DEMO12345678' } });
  throw new Error('Unexpected fixture request: ' + path);
};
`);
  async function run(command, fixture = {}) {
    await writeFile(join(directory, 'fixture.json'), JSON.stringify(fixture));
    await writeFile(join(directory, 'calls.json'), '[]');
    const env = { ...process.env };
    delete env.PINGROOM_TOKEN; delete env.PINGROOM_ROOM;
    if (command !== 'connect') Object.assign(env, { PINGROOM_TOKEN: 'offline-fixture-token', PINGROOM_ROOM: ROOM_CODE });
    const result = spawnSync(process.execPath, ['--import', join(directory, 'transport.mjs'), join(directory, 'src/cli.js'), command],
      { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return { ...result, calls: JSON.parse(await readFile(join(directory, 'calls.json'))) };
  }
  async function assessment(status) {
    const clock = { value: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
    const api = mockApi(() => clock.value);
    await step({ client: api.client, directory: join(directory, '.agreement'), study, config: CONFIG,
      token: 'offline-fixture-token', room: ROOM_CODE, now: () => clock.value });
    if (status === 'expired') {
      clock.value = new Date(Date.parse(clock.value) + 16 * 60 * 1000).toISOString();
      api.terminal(id(1), 'expired'); api.questions.get(id(1)).resolved_at = clock.value;
    } else if (status === 'cancelled') api.terminal(id(1), status);
    else if (['answered', 'invalid_answer'].includes(status)) {
      api.answer(id(1), 'bug');
      if (status === 'invalid_answer') api.questions.get(id(1)).answer.responder.id = CONFIG.assessors[1].id;
    }
    return { question: api.questions.get(id(1)) };
  }
  return { directory, run, assessment };
}

for (const status of ['expired', 'cancelled', 'invalid_answer']) {
  test(`CLI exits 2 when ${status} is observed with assessments remaining`, async (t) => {
    const s = await setup(t), result = await s.run('run', await s.assessment(status));
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'ready'); assert.equal(report.observedStatus, status);
    assert.equal(report.pairedItemCount, 0);
    assert.deepEqual(result.calls, [{ method: 'GET', path: `/api/agent/questions/${id(1)}` }]);
    const saved = JSON.parse(await readFile(join(s.directory, '.agreement/state.json')));
    assert.equal(saved.attempts[0].status, status);
  });
}

test('CLI keeps exit 3 for ordinary pending and ready work', async (t) => {
  for (const status of ['pending', 'answered']) {
    const s = await setup(t), result = await s.run('run', await s.assessment(status));
    assert.equal(result.status, 3, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, status === 'pending' ? 'pending' : 'ready');
    assert.equal(report.observedStatus, status);
    assert.equal(result.calls.length, 1); assert.equal(result.calls[0].method, 'GET');
  }
});

for (const style of ['documented pair_url', 'API browser URL', 'legacy website browser URL']) {
  test(`connect accepts the ${style} and saves the approved connection`, async (t) => {
    const s = await setup(t), links = pairing();
    if (style === 'API browser URL') links.pair_browser_url = `${links.pair_url}?browser=1`;
    if (style === 'legacy website browser URL') links.pair_browser_url = 'https://pingroom.io/agent/pair/offline-fixture';
    const result = await s.run('connect', { pairing: links });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(links.pair_browser_url ?? links.pair_url));
    assert.deepEqual(result.calls.map((call) => call.path), ['/api/agent/auth', '/api/agent/auth/pair/start', '/api/agent/auth/pair/status']);
    const saved = join(s.directory, '.pingroom/credentials.json');
    assert.deepEqual(JSON.parse(await readFile(saved)), { token: 'offline-active', room: ROOM_CODE });
    assert.equal((await stat(saved)).mode & 0o777, 0o600);
    await assert.rejects(readFile(join(s.directory, '.pingroom/pairing.json')), { code: 'ENOENT' });
    const again = await s.run('connect');
    assert.equal(again.status, 1); assert.deepEqual(again.calls, []);
  });
}

test('connect rejects malformed and untrusted links without polling or replacing pending state', async (t) => {
  for (const url of ['not a URL', '', 'http://api.pingroom.io/pair/fixture', 'https://pingroom.io.evil.example/pair/fixture',
    'https://api.pingroom.io:444/pair/fixture', 'https://user:pass@pingroom.io/pair/fixture', 'javascript:alert(1)']) {
    const s = await setup(t), links = { ...pairing(), pair_browser_url: url };
    const result = await s.run('connect', { pairing: links });
    assert.equal(result.status, 1); assert.equal(result.calls.length, 2);
    assert.ok(result.calls.every((call) => call.method === 'POST'));
    const path = join(s.directory, '.pingroom/pairing.json'), saved = await readFile(path, 'utf8');
    assert.equal(JSON.parse(saved).pairing.pair_browser_url, url);
    await assert.rejects(readFile(join(s.directory, '.pingroom/credentials.json')), { code: 'ENOENT' });
    const again = await s.run('connect');
    assert.equal(again.status, 1); assert.deepEqual(again.calls, []);
    assert.equal(await readFile(path, 'utf8'), saved);
  }
});

test('connect preserves uncertain registration or pairing intent and never repeats its POSTs', async (t) => {
  for (const loseAt of ['/api/agent/auth', '/api/agent/auth/pair/start']) {
    const s = await setup(t), result = await s.run('connect', { pairing: pairing(), loseAt });
    assert.equal(result.status, 1);
    const path = join(s.directory, '.pingroom/pairing.json'), saved = await readFile(path, 'utf8');
    assert.equal(JSON.parse(saved).phase, 'creating'); assert.equal((await stat(path)).mode & 0o777, 0o600);
    const again = await s.run('connect', { pairing: pairing() });
    assert.equal(again.status, 1); assert.match(again.stderr, /creation is uncertain/); assert.deepEqual(again.calls, []);
    assert.equal(await readFile(path, 'utf8'), saved);
  }
});
