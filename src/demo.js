import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, localReport } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-agreement-demo-'));
try {
  const now = () => '2026-01-01T09:00:00.000Z';
  const api = mockApi(now), study = await readJson(new URL('../examples/study.json', import.meta.url));
  const options = { client: api.client, directory, study, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
  for (const value of ['question', 'question', 'bug', 'question', 'skip', 'request']) {
    const result = await step(options), questionId = result.assessments.find((a) => a.status === 'pending').questionId;
    api.answer(questionId, value); await step(options);
  }
  const report = await localReport(directory, study);
  console.log(JSON.stringify({ mode: 'offline', status: report.status, pairedItemCount: report.pairedItemCount,
    agreementCount: report.agreementCount, agreementFraction: report.agreementFraction,
    confusion: report.confusion, disputedItems: report.disputedItems, skippedItems: report.skippedItems }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
