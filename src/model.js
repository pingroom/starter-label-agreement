import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

export function validateStudy(input) {
  if (!keys(input, ['studyId', 'title', 'rubric', 'labels', 'items']) || !word(input.studyId)
    || !line(input.title, 40) || !line(input.rubric, 60) || !Array.isArray(input.labels)
    || input.labels.length < 2 || input.labels.length > 3 || !Array.isArray(input.items)
    || input.items.length < 1 || input.items.length > 12) throw new Error('Provide a study ID, title, rubric, 2–3 labels, and 1–12 items.');
  for (const label of input.labels) {
    if (!keys(label, ['id', 'label', 'definition']) || !word(label.id) || label.id === 'skip'
      || !line(label.label, 20) || label.label === 'Skip' || !line(label.definition, 40)) throw new Error('Invalid label or definition; Skip is reserved.');
  }
  for (const item of input.items) if (!keys(item, ['id', 'text']) || !word(item.id) || !line(item.text, 120)) throw new Error('Invalid item ID or text.');
  for (const [rows, field] of [[input.labels, 'id'], [input.labels, 'label'], [input.items, 'id']]) {
    if (new Set(rows.map((row) => row[field])).size !== rows.length) throw new Error('Label IDs, label names, and item IDs must each be distinct.');
  }
  return structuredClone(input);
}

export function validateConfig(config) {
  if (!keys(config, ['assessors']) || !Array.isArray(config.assessors) || config.assessors.length !== 2) throw new Error('Configure exactly two distinct named assessors.');
  for (const assessor of config.assessors) if (!keys(assessor, ['id', 'label']) || !isId(assessor.id) || !line(assessor.label, 60)) throw new Error('Each assessor requires an exact UUID and label.');
  if (config.assessors[0].id === config.assessors[1].id || config.assessors[0].label === config.assessors[1].label) throw new Error('Use two different assessor UUIDs and labels.');
  return structuredClone(config);
}

export function tasksFor(input, config) {
  return input.items.map((item) => item.id).sort(compare).flatMap((itemId) => config.assessors.map((assessor) => ({ itemId, assessorId: assessor.id })));
}

export function requestFor(input, config, task, attemptId) {
  if (!isId(attemptId) || !tasksFor(input, config).some((t) => hash(t) === hash(task))) throw new Error('Invalid item, assessor, or attempt.');
  const item = input.items.find((i) => i.id === task.itemId), key = `agreement-${attemptId}`;
  const prompt = [input.title, input.rubric, `Item: ${item.text}`, ...input.labels.map((label) => `${label.label}: ${label.definition}`)].join('\n');
  if (prompt.length > 500) throw new Error('Question exceeds 500 characters.');
  return {
    prompt, context: `Label ${hash({ input, task }).slice(0, 20)}`,
    options: [...input.labels.map(({ id, label }) => ({ value: id, label, style: 'default' })), { value: 'skip', label: 'Skip', style: 'default' }],
    responder_scope: 'direct', target_user_id: task.assessorId, ttl: TTL, correlation_id: key,
    data: { study_hash: hash(input), item_id: task.itemId, assessor_id: task.assessorId, attempt_id: attemptId }, idempotencyKey: key,
  };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved label evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered questions must not contain label evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved item, room, or assessor.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function validateState(state, input) {
  validateStudy(input);
  if (!keys(state, ['version', 'studyHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.studyHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed study. Restore the original inputs.');
  validateConfig(state.config);
  const tasks = tasksFor(input, state.config);
  if (state.attempts.length > tasks.length) throw new Error('Too many saved assessments.');
  const ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'task', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || hash(attempt.task) !== hash(tasks[index]) || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, tasks[index], attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved assessment.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last assessment may be active.');
  }
  return state;
}

export function report(state, input) {
  validateState(state, input);
  const assessments = tasksFor(input, state.config).map((task, index) => {
    const attempt = state.attempts[index];
    return { ...task, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      questionId: attempt?.questionId ?? null, value: attempt?.observation?.answer?.value ?? null,
      observedAt: attempt?.observation?.checkedAt ?? null, answeredAt: attempt?.observation?.answer?.answeredAt ?? null };
  });
  const labelIds = input.labels.map((label) => label.id);
  const matrix = labelIds.map(() => labelIds.map(() => 0));
  const pairedItems = [], skippedItems = [], incompleteItems = [];
  for (const item of input.items) {
    const rows = assessments.filter((a) => a.itemId === item.id);
    if (rows.every((a) => a.status === 'answered' && a.value !== 'skip')) {
      const values = rows.map((a) => a.value); matrix[labelIds.indexOf(values[0])][labelIds.indexOf(values[1])]++;
      pairedItems.push({ itemId: item.id, labels: values, agrees: values[0] === values[1], questionIds: rows.map((a) => a.questionId) });
    }
    if (rows.some((a) => a.status === 'answered' && a.value === 'skip')) skippedItems.push(item.id);
    if (rows.some((a) => a.status !== 'answered')) incompleteItems.push(item.id);
  }
  const active = assessments.find((a) => ['create_unknown', 'pending'].includes(a.status));
  const agreementCount = pairedItems.filter((a) => a.agrees).length;
  return { studyId: input.studyId, studyHash: state.studyHash, title: input.title, rubric: input.rubric, labels: input.labels,
    assessors: state.config.assessors, status: active?.status ?? (assessments.some((a) => a.status === 'unasked') ? 'ready' : 'finished'),
    expectedAssessments: assessments.length, answeredAssessments: assessments.filter((a) => a.status === 'answered').length,
    totalItems: input.items.length, pairedItemCount: pairedItems.length, agreementCount,
    agreementFraction: pairedItems.length ? agreementCount / pairedItems.length : null,
    confusion: { rowAssessorId: state.config.assessors[0].id, columnAssessorId: state.config.assessors[1].id, labelIds, counts: matrix },
    pairedItems, disputedItems: pairedItems.filter((a) => !a.agrees), skippedItems, incompleteItems, assessments };
}

export function assertAssessorRoom(rooms, room, assessors) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !assessors.every((assessor) => selected.members.some((member) => member?.user_id === assessor.id))) throw new Error('Use a granted standard private room containing both named assessors.');
}
