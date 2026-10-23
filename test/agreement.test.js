import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateStudy, validateConfig, validateState, tasksFor, requestFor, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/study.json', import.meta.url));
const one = () => ({ ...structuredClone(example), items: structuredClone(example.items.slice(0, 1)) });
async function setup(t, study = one()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-agreement-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now), options = { client: api.client, directory, study, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
const pendingId = (result) => result.assessments.find((a) => a.status === 'pending').questionId;
async function answer(s, value) { const r = await s.run(); s.api.answer(pendingId(r), value); return s.run(); }

test('two assessors independently receive the same rubric; final evidence replays without network', async (t) => {
  const s = await setup(t); const first = await answer(s, 'question');
  assert.equal(first.pairedItemCount, 0); assert.equal(first.agreementFraction, null); assert.equal(first.status, 'ready');
  const result = await answer(s, 'question');
  assert.equal(result.status, 'finished'); assert.equal(result.agreementCount, 1); assert.equal(result.agreementFraction, 1);
  const sent = s.api.calls.filter((c) => c.method === 'POST');
  assert.equal(sent[0].body.prompt, sent[1].body.prompt); assert.notEqual(sent[0].body.target_user_id, sent[1].body.target_user_id);
  assert.equal(sent[1].body.data.item_id, 'item-a'); assert.equal(Object.hasOwn(sent[1].body.data, 'answer'), false);
  const calls = s.api.calls.length; assert.equal((await s.run()).status, 'finished'); assert.equal(s.api.calls.length, calls);
  assert.equal((await stat(join(s.directory, 'state.json'))).mode & 0o777, 0o600);
});

test('golden confusion counts keep disagreements, Skip, and incomplete pairs separate', async (t) => {
  const s = await setup(t, structuredClone(example));
  for (const label of ['question', 'question', 'bug', 'question', 'skip', 'request']) await answer(s, label);
  const result = await localReport(s.directory, s.options.study, { save: true });
  assert.equal(result.expectedAssessments, 6); assert.equal(result.answeredAssessments, 6);
  assert.equal(result.pairedItemCount, 2); assert.equal(result.agreementCount, 1); assert.equal(result.agreementFraction, 0.5);
  assert.deepEqual(result.confusion.counts, [[1, 0, 0], [1, 0, 0], [0, 0, 0]]);
  assert.deepEqual(result.disputedItems.map((i) => i.itemId), ['item-b']);
  assert.deepEqual(result.skippedItems, ['item-c']); assert.deepEqual(result.incompleteItems, []);
  assert.deepEqual(await readJson(join(s.directory, 'report.json')), result); assert.equal(sends(s.api), 6);
});

test('all skipped answers yield no paired score, not perfect or zero agreement', async (t) => {
  const s = await setup(t); await answer(s, 'skip'); const r = await answer(s, 'skip');
  assert.equal(r.agreementFraction, null); assert.equal(r.pairedItemCount, 0);
  assert.equal(r.answeredAssessments, 2); assert.deepEqual(r.skippedItems, ['item-a']); assert.deepEqual(r.incompleteItems, []);
});

test('item IDs order work once each; assessor order fixes matrix axes', async (t) => {
  const study = structuredClone(example); study.items.reverse(); const s = await setup(t, study);
  assert.deepEqual(tasksFor(study, CONFIG).map((a) => a.itemId), ['item-a', 'item-a', 'item-b', 'item-b', 'item-c', 'item-c']);
  await answer(s, 'request'); const result = await answer(s, 'bug');
  assert.equal(result.confusion.rowAssessorId, CONFIG.assessors[0].id);
  assert.equal(result.confusion.columnAssessorId, CONFIG.assessors[1].id); assert.equal(result.confusion.counts[2][1], 1);
});

test('pending reads never send again and neither pending nor unasked is an abstention', async (t) => {
  const s = await setup(t); await s.run(); const r = await s.run();
  assert.equal(sends(s.api), 1); assert.equal(r.status, 'pending'); assert.equal(r.agreementFraction, null);
  assert.deepEqual(r.assessments.map((a) => a.status), ['pending', 'unasked']); assert.deepEqual(r.skippedItems, []);
});

test('expiry and cancellation finish one assessment without manufacturing a label or repeating it', async (t) => {
  for (const status of ['expired', 'cancelled']) {
    const s = await setup(t); await s.run(); if (status === 'expired') s.clock.value = '2026-01-01T09:15:30.000Z';
    s.api.terminal(id(1), status); const result = await s.run();
    assert.equal(result.observedStatus, status); assert.equal(result.pairedItemCount, 0); assert.deepEqual(result.skippedItems, []);
    const done = await answer(s, 'question'); assert.equal(done.status, 'finished'); assert.equal(done.agreementFraction, null);
    const calls = s.api.calls.length; await s.run(); assert.equal(s.api.calls.length, calls); assert.equal(sends(s.api), 2);
  }
});

test('lost creation response blocks all later assessments until exact verified recovery', async (t) => {
  const s = await setup(t); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.equal(sends(s.api), 1); assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'bug'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('malformed response and empty search retain uncertainty', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  s.api.questions.clear(); assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates room, target, exact rubric, option semantics, and question provenance', async (t) => {
  for (const mutate of [q => { q.id = id(99); }, q => { q.target_user_id = OTHER; }, q => { q.room.code = 'WRONG1234567'; },
    q => { q.options[0].primary = true; }, q => { q.options.reverse(); }, q => { q.data.item_id = 'wrong'; },
    q => { q.prompt = 'Wrong'; }, q => { q.is_handoff = true; }, q => { q.resolution_policy = 'all'; },
    q => { q.asker.type = 'user'; }, q => { q.results = {}; }]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating'); assert.equal(sends(s.api), 1);
  }
});

test('wrong or missing responder, typed text, and unknown labels cannot contribute to agreement', async (t) => {
  for (const mutate of [q => { q.answer.responder.id = OTHER; }, q => { q.answer.responder = null; },
    q => { q.answer.text = 'bug'; }, q => { q.answer.value = 'anything'; }, q => { q.answer.label = 'Wrong'; }]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'bug'); mutate(s.api.questions.get(id(1)));
    const r = await s.run(); assert.equal(r.observedStatus, 'invalid_answer'); assert.equal(r.answeredAssessments, 0); assert.equal(r.agreementFraction, null);
  }
});

test('all assessments bind to the original asking registration and saved creation intent', async (t) => {
  const s = await setup(t); await answer(s, 'bug'); s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const o = await setup(t); o.api.controls.loseNext = true; await o.run();
  const q = o.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(o.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('question lifetime and identity cannot drift after its first read', async (t) => {
  for (const mutate of [q => { q.asker.id = OTHER; }, q => { q.created_at = '2026-01-01T09:00:01Z'; q.expires_at = '2026-01-01T09:15:01Z'; }]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run(), /identity or lifetime/); assert.equal((await s.saved()).attempts[0].status, 'pending');
  }
});

test('answer/cancellation cannot resolve after expiry and answer time must match resolution', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'bug'); s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const status of ['answered', 'cancelled']) {
    const o = await setup(t); await o.run(); o.clock.value = '2026-01-01T09:16:00.000Z';
    if (status === 'answered') o.api.answer(id(1), 'bug'); else o.api.terminal(id(1), status);
    await assert.rejects(o.run(), /resolution time/);
  }
});

test('expiry observation may be delayed but must not precede expiry or be implausibly future', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z'; s.api.terminal(id(1), 'expired');
  const q = s.api.questions.get(id(1)); q.resolved_at = '2026-01-01T09:14:59Z'; await assert.rejects(s.run(), /resolution time/);
  q.resolved_at = '2026-01-01T09:17:00.001Z'; await assert.rejects(s.run(), /resolution time/);
  q.resolved_at = '2026-01-01T09:15:30Z'; assert.equal((await s.run()).observedStatus, 'expired');
  assert.equal((await localReport(s.directory, s.options.study)).assessments[0].status, 'expired');
});

test('timestamp validation rejects impossible dates, wrong TTL, and future evidence', async (t) => {
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
  const s = await setup(t); await s.run(); const q = s.api.questions.get(id(1)); q.expires_at = '2026-01-01T10:00:00Z';
  await assert.rejects(s.run(), /lifetime/); q.created_at = '2027-01-01T09:00:00Z'; q.expires_at = '2027-01-01T09:15:00Z'; await assert.rejects(s.run(), /future/);
});

test('changed study, rubric, assessor order, credential, or room cannot reuse observations', async (t) => {
  const s = await setup(t); await s.run();
  await assert.rejects(s.run({ study: { ...s.options.study, rubric: 'New rule' } }), /changed study/);
  const config = structuredClone(CONFIG); config.assessors.reverse(); await assert.rejects(s.run({ config }), /another connection/);
  await assert.rejects(s.run({ token: 'new-token' }), /another connection/); await assert.rejects(s.run({ room: 'OTHER1234567' }), /another connection/);
  assert.equal(sends(s.api), 1);
});

test('strict schema rejects duplicate labels/items, extra keys, oversized studies, and one assessor', () => {
  for (const mutate of [p => { p.items.push(p.items[0]); }, p => { p.labels[1].id = p.labels[0].id; },
    p => { p.labels[0].label = 'Skip'; }, p => { p.labels[0].id = 'skip'; }, p => { p.labels[1].label = p.labels[0].label; },
    p => { p.studyId = 42; }, p => { p.items = []; }, p => { p.run = 'anything'; }, p => { p.items[0].text = 'x'.repeat(121); }]) {
    const p = one(); mutate(p); assert.throws(() => validateStudy(p));
  }
  assert.throws(() => validateConfig({ assessors: [CONFIG.assessors[0]] }));
  assert.throws(() => validateConfig({ assessors: [CONFIG.assessors[0], CONFIG.assessors[0]] }));
  const p = one(); p.title = 'x'.repeat(40); p.rubric = 'x'.repeat(60); p.items[0].text = 'x'.repeat(120);
  p.labels = p.labels.map((l,i) => ({ ...l, label: String(i).repeat(20), definition: 'x'.repeat(40) }));
  validateStudy(p); assert.ok(requestFor(p, CONFIG, tasksFor(p, CONFIG)[0], id(1)).prompt.length <= 500);
});

test('both assessor memberships and a standard private room are required before sending', async (t) => {
  for (const mutate of [r => { r[0].is_public = true; }, r => { r[0].type = 'dm'; }, r => { r[0].members.pop(); }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('failed reservations send nothing and failed answer saves reread the same question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'bug');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure is recovered by exact ID rather than resending', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads retain state and corrupt requests or duplicate assessments fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  const saved = await s.saved(); saved.attempts[0].request.ttl = 30; await atomicJson(s.directory, 'state.json', saved);
  const calls = s.api.calls.length; await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  const duplicate = JSON.parse(before); duplicate.attempts.push(duplicate.attempts[0]); assert.throws(() => validateState(duplicate, s.options.study));
});

test('state null, malformed JSON, symlinks, and live locks cannot create new questions', async (t) => {
  const s = await setup(t); await writeFile(join(s.directory, 'state.json'), 'null'); await assert.rejects(s.run(), /null/);
  await writeFile(join(s.directory, 'state.json'), '{'); await assert.rejects(s.run(), /malformed/);
  await rm(join(s.directory, 'state.json')); await writeFile(join(s.directory, 'target'), '{}'); await symlink('target', join(s.directory, 'state.json')); await assert.rejects(s.run());
  await rm(join(s.directory, 'state.json')); const release = await acquireLock(s.directory);
  try { await assert.rejects(s.run(), /lock exists/); } finally { await release(); }
  assert.equal(sends(s.api), 0);
});

test('partial shell credentials cannot borrow the other half from .env or saved connection', async (t) => {
  const s = await setup(t); const path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'external-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

test('transport rejects redirects, malformed UTF8 and oversized bodies', async () => {
  for (const response of [new Response(null, { status: 302 }), new Response(new Uint8Array([0xff])), new Response('x'.repeat(512 * 1024 + 1))]) {
    const client = makeClient({ token: 'offline', fetchImpl: async () => response }); await assert.rejects(client.rooms.list());
  }
});

test('complete-body deadline interrupts stalled and endless empty streams', async () => {
  for (const stream of [new ReadableStream({ start() {} }), new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); } })]) {
    const client = makeClient({ token: 'offline', deadlineMs: 20, fetchImpl: async () => new Response(stream) });
    const started = performance.now(); await assert.rejects(client.rooms.list()); assert.ok(performance.now() - started < 1500);
  }
});
