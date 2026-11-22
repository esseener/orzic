import { strict as assert } from 'node:assert'
import { test } from 'orca/testing'
import { leadPrompt, projectSteps, type NativeTask, type NativeWorker } from './flow'
import { defaultTeam, migrateTeam, validateTeam, type ModelCatalog, type Run, type Team } from './protocol'

function run(team: Team = migrateTeam(defaultTeam)): Run {
  return { schemaVersion: 2, id: 'mapping-test', goal: '修复设置页', team, status: 'active', leadTerminal: 'term_lead' }
}

const agents = [{ id: 'claude' }, { id: 'codex' }, { id: 'opencode' }, { id: 'codebuddy' }]

test('legacy saved agents and optional investigator survive team migration without mutating storage', () => {
  const saved = { lead: 'claude', implement: 'codex', diagnose: 'codebuddy', review: 'opencode' }
  const before = { ...saved }
  const team = validateTeam(saved, agents)
  assert.deepEqual(team.members.map(({ id, agent, kind }) => ({ id, agent, kind })), [
    { id: 'implement', agent: 'codex', kind: 'implement' },
    { id: 'diagnose', agent: 'codebuddy', kind: 'research' },
    { id: 'review', agent: 'opencode', kind: 'review' }
  ])
  assert.deepEqual(saved, before)
  assert.equal(validateTeam({ ...saved, diagnose: '' }, agents).members.some((member) => member.id === 'diagnose'), false)
  assert.equal(team.leadModel, undefined)
  assert.equal(team.members.every((member) => member.model === undefined), true)
  assert.equal(team.leadEffort, undefined)
  assert.equal(team.members.every((member) => member.effort === undefined), true)
  assert.equal(team.members.find(({ id }) => id === 'implement')?.cost, 'cheap')
  assert.equal(team.members.find(({ id }) => id === 'review')?.cost, 'strong')
  assert.equal(validateTeam({ ...saved, implement: 'omp', review: 'omp' }, [...agents, { id: 'omp' }]).members.every(({ cost }) => cost === 'cheap' || cost === 'strong'), true)
})

test('custom roles can share a CLI but cannot duplicate identities or remove a required responsibility', () => {
  const team = migrateTeam(defaultTeam)
  team.members.splice(1, 0, { id: 'backend', name: ' 后端实现 ', agent: 'codex', kind: 'implement', brief: ' 服务端功能 ' })
  const saved = validateTeam(team, agents)
  assert.equal(saved.members[1].name, '后端实现')
  assert.equal(team.members[1].name, ' 后端实现 ')
  const duplicate = migrateTeam(saved)
  duplicate.members[1].id = duplicate.members[0].id
  assert.throws(() => validateTeam(duplicate, agents), /标识无效或重复/)
  assert.throws(() => validateTeam({ ...saved, members: saved.members.filter((member) => member.kind !== 'review') }, agents), /审核/)
  assert.throws(() => validateTeam({ ...saved, members: saved.members.map((member) => ({ ...member, kind: 'review' })) }, agents), /实现/)
  assert.throws(() => migrateTeam({ version: 2, lead: 'claude', members: [null] }), /格式无效/)
})

test('optional models and efforts survive migration and validation without changing saved input', () => {
  const saved: Team = { ...migrateTeam(defaultTeam), leadModel: '  provider/lead-model  ', leadEffort: ' high ' }
  saved.members[0].model = '  provider/member-model  '
  saved.members[0].effort = ' ultra '
  saved.members[1].model = '   '
  saved.members[1].effort = '   '
  const before = JSON.stringify(saved)
  const migrated = migrateTeam(saved)
  assert.equal(migrated.leadModel, 'provider/lead-model')
  assert.equal(migrated.members[0].model, 'provider/member-model')
  assert.equal(migrated.members[1].model, undefined)
  assert.equal(migrated.leadEffort, 'high')
  assert.equal(migrated.members[0].effort, 'ultra')
  assert.equal(migrated.members[1].effort, undefined)
  assert.deepEqual(validateTeam(migrated, agents), migrated)
  assert.equal(JSON.stringify(saved), before)
  assert.equal(migrateTeam(defaultTeam).leadModel, undefined)
})

test('explicit models are rejected for unsupported Agents or invalid model identifiers, never silently dropped', () => {
  const saved = migrateTeam(defaultTeam)
  const unsupportedLead = { ...saved, lead: 'codebuddy', leadModel: 'provider/selected' }
  assert.equal(migrateTeam(unsupportedLead).leadModel, 'provider/selected')
  assert.throws(() => validateTeam(unsupportedLead, agents), /codebuddy.*支持指定模型/)
  const unsupportedMember = { ...saved, members: saved.members.map((member, index) =>
    index === 0 ? { ...member, agent: 'codebuddy', model: 'provider/selected' } : member) }
  assert.equal(migrateTeam(unsupportedMember).members[0].model, 'provider/selected')
  assert.throws(() => validateTeam(unsupportedMember, agents), /codebuddy.*支持指定模型/)
  assert.equal(validateTeam({ ...saved, leadModel: 'x'.repeat(200) }, agents).leadModel?.length, 200)
  for (const model of ['x'.repeat(201), '-model', 'model\u0000id', 'model\nid']) {
    assert.throws(() => validateTeam({ ...saved, leadModel: model }, agents), /模型标识/)
    assert.throws(() => validateTeam({ ...saved, members: saved.members.map((member, index) =>
      index === 0 ? { ...member, model } : member) }, agents), /模型标识/)
  }
  assert.throws(() => migrateTeam({ ...saved, leadModel: 42 }), /模型标识必须是文本/)
})

test('effort requires an explicit model and a supported Agent, and malformed saved values are rejected', () => {
  const selected: Team = { ...migrateTeam(defaultTeam), leadModel: 'opus', leadEffort: 'high' }
  assert.throws(() => validateTeam({ ...selected, leadModel: undefined }, agents), /先为主脑指定模型/)
  assert.throws(() => validateTeam({ ...selected, lead: 'opencode' }, agents), /opencode.*思考强度/)
  assert.throws(() => validateTeam({ ...selected, members: selected.members.map((member, index) =>
    index === 1 ? { ...member, model: 'fixture/reviewer', effort: 'high' } : member) }, agents), /opencode.*思考强度/)
  for (const effort of ['x'.repeat(65), '-high', 'hi\ngh', 'high\u0000', 'two words']) {
    assert.throws(() => validateTeam({ ...selected, leadEffort: effort }, agents), /思考强度/)
  }
  assert.throws(() => migrateTeam({ ...selected, leadEffort: 42 }), /思考强度必须是文本/)
  assert.throws(() => migrateTeam({ ...selected, members: selected.members.map((member, index) =>
    index === 0 ? { ...member, effort: false } : member) }), /思考强度必须是文本/)
})

test('per-model effort restrictions stay independent for members sharing one Agent', () => {
  const selected: Team = { ...migrateTeam(defaultTeam), lead: 'codex', leadModel: 'fixture/lead', leadEffort: 'low' }
  selected.members[0] = { ...selected.members[0], model: 'fixture/member', effort: 'ultra' }
  const catalogs: ModelCatalog[] = [{ agent: 'codex', source: 'synthetic effort capabilities', models: [
    { id: 'fixture/lead', name: 'Lead', efforts: ['low', 'high'] },
    { id: 'fixture/member', name: 'Member', efforts: ['ultra'] },
    { id: 'fixture/no-reasoning', name: 'No reasoning', efforts: [] },
    { id: 'fixture/unknown', name: 'Unknown capabilities' }
  ] }]
  const valid = validateTeam(selected, agents, catalogs)
  assert.equal(valid.leadEffort, 'low')
  assert.equal(valid.members[0].effort, 'ultra')
  assert.throws(() => validateTeam({ ...selected, leadEffort: 'ultra' }, agents, catalogs), /主脑.*目录未声明支持/)
  assert.throws(() => validateTeam({ ...selected, members: selected.members.map((member, index) =>
    index === 0 ? { ...member, model: 'fixture/no-reasoning' } : member) }, agents, catalogs), /目录未声明支持/)
  const unknown = validateTeam({ ...selected, members: selected.members.map((member, index) =>
    index === 0 ? { ...member, model: 'fixture/unknown', effort: 'future_level' } : member) }, agents, catalogs)
  assert.equal(unknown.members[0].effort, 'future_level', 'Unknown metadata must not be misrepresented as explicit no-reasoning support')
})

test('cost tiers mark member routing without inventing model parameters', () => {
  const team = migrateTeam(defaultTeam)
  team.members[0] = { ...team.members[0], agent: 'omp', model: 'provider/cheap', cost: 'cheap' }
  team.members[1] = { ...team.members[1], agent: 'omp', model: 'provider/deep', cost: 'strong' }
  const routed = validateTeam(team, [...agents, { id: 'omp' }])
  assert.equal(routed.members[0].cost, 'cheap')
  assert.equal(routed.members[1].cost, 'strong')
  const artifact = leadPrompt(run(routed)).match(/```json\n([\s\S]*?)\n```/)
  const roster = JSON.parse(artifact![1])
  const cheap = roster.find((row: { 标识: string }) => row.标识 === '[TF:implement]')
  const strong = roster.find((row: { 标识: string }) => row.标识 === '[TF:review]')
  assert.equal(cheap.成本档位, '便宜打工')
  assert.equal(strong.成本档位, '贵审判')
  assert.deepEqual(cheap.startupArgs, ['--agent', 'omp', '--model', 'provider/cheap'])
  assert.deepEqual(strong.startupArgs, ['--agent', 'omp', '--model', 'provider/deep'])
  assert.throws(() => validateTeam({ ...routed, members: routed.members.map((row, index) =>
    index === 0 ? { ...row, cost: 'expensive' } : row) } as unknown as Team, [...agents, { id: 'omp' }]), /成本档位/)
})

test('coordinator startup data binds distinct models to same-Agent members and leaves defaults unselected', () => {
  const team = migrateTeam(defaultTeam)
  team.members[0].model = 'provider/app-model'
  team.members[0].effort = 'high'
  team.members.splice(1, 0, { id: 'backend', name: '后端开发', agent: 'codex', model: 'provider/backend-model', effort: 'ultra', kind: 'implement', brief: '修改后端' })
  const prompt = leadPrompt(run(team))
  const artifact = prompt.match(/```json\n([\s\S]*?)\n```/)
  assert.ok(artifact, 'Coordinator prompt must contain its structured startup roster')
  const roster = JSON.parse(artifact[1])
  assert.deepEqual(roster.map((member: { 标识: string; agent: string; model: string | null; effort: string | null; startupArgs: string[] }) =>
    [member.标识, member.agent, member.model, member.effort, member.startupArgs]), [
    ['[TF:implement]', 'codex', 'provider/app-model', 'high', ['--agent', 'codex', '--model', 'provider/app-model', '--effort', 'high']],
    ['[TF:backend]', 'codex', 'provider/backend-model', 'ultra', ['--agent', 'codex', '--model', 'provider/backend-model', '--effort', 'ultra']],
    ['[TF:review]', 'opencode', null, null, ['--agent', 'opencode']]
  ])
  assert.equal(roster[2].模型, '沿用 Agent 默认（具体模型未知）')
})

test('two implementation members using the same CLI retain separate tasks and output identities after renaming', () => {
  const team = migrateTeam(defaultTeam)
  team.members[0].name = '前端开发'
  team.members.splice(1, 0, { id: 'backend', name: '后端开发', agent: 'codex', kind: 'implement', brief: '' })
  const tasks: NativeTask[] = [
    { id: 'api-task', title: '[TF:backend] 后端开发: 修改接口', status: 'running' },
    { id: 'ui-task', title: '[TF:implement] 已经改过的角色名称: 修改表单', status: 'completed' }
  ]
  const workers: NativeWorker[] = [
    { taskId: 'api-task', dispatchId: 'dispatch-api', state: 'working', terminal: 'term_api' },
    { taskId: 'ui-task', dispatchId: 'dispatch-ui', state: 'succeeded', terminal: 'term_ui' }
  ]
  const steps = projectSteps(run(team), 'working', tasks, workers)
  assert.deepEqual(steps.find((step) => step.memberId === 'implement'), {
    memberId: 'implement', state: 'done', taskId: 'ui-task', task: '已经改过的角色名称: 修改表单', terminal: 'term_ui', dispatch: 'dispatch-ui'
  })
  assert.equal(steps.find((step) => step.memberId === 'backend')?.dispatch, 'dispatch-api')
  assert.equal(steps.find((step) => step.memberId === 'review')?.state, 'queued')
})

test('a stable recorded task identity survives a title change', () => {
  const current = run()
  current.taskIds = { implement: 'original-task' }
  const steps = projectSteps(current, 'working', [{ id: 'original-task', title: '用户改写了任务标题', status: 'running' }], [
    { taskId: 'original-task', dispatchId: 'dispatch-1', state: 'working', terminal: 'term_1' }
  ])
  assert.equal(steps[1].taskId, 'original-task')
  assert.equal(steps[1].task, '用户改写了任务标题')
  assert.equal(steps[1].dispatch, 'dispatch-1')
})

test('an active rework task replaces the old completed binding rather than showing stale success', () => {
  const current = run()
  current.taskIds = { implement: 'first-task' }
  const steps = projectSteps(current, 'working', [
    { id: 'first-task', title: '[TF:implement] 初次实现', status: 'completed' },
    { id: 'rework-task', title: '[TF:implement] 修复审核问题', status: 'running' }
  ], [
    { taskId: 'rework-task', dispatchId: 'dispatch-rework', state: 'working' },
    { taskId: 'first-task', dispatchId: 'dispatch-first', state: 'succeeded' }
  ])
  assert.equal(steps[1].taskId, 'rework-task')
  assert.equal(steps[1].dispatch, 'dispatch-rework')
  assert.equal(steps[1].state, 'working')
})

test('multiple unfinished tasks for one member are reported as ambiguous instead of opening an arbitrary session', () => {
  const steps = projectSteps(run(), 'working', [
    { id: 'one', title: '[TF:implement] 第一个任务', status: 'running' },
    { id: 'two', title: '[TF:implement] 第二个任务', status: 'queued' }
  ], [{ taskId: 'one', dispatchId: 'dispatch-one', state: 'working', terminal: 'term_one' }])
  assert.equal(steps[1].state, 'unknown')
  assert.match(steps[1].issue!, /无法唯一关联/)
  assert.equal(steps[1].terminal, undefined)
  assert.equal(steps[1].dispatch, undefined)
})

test('settled rework uses the most recent dispatch in the documented newest-first listing', () => {
  const steps = projectSteps(run(), 'done', [
    { id: 'older', title: '[TF:implement] 第一轮', status: 'failed' },
    { id: 'newer', title: '[TF:implement] 第二轮', status: 'completed' }
  ], [
    { taskId: 'newer', dispatchId: 'dispatch-new', state: 'succeeded', terminalState: 'released', terminal: 'term_released' },
    { taskId: 'older', dispatchId: 'dispatch-old', state: 'failed' }
  ])
  assert.equal(steps[1].state, 'done')
  assert.equal(steps[1].taskId, 'newer')
  assert.equal(steps[1].dispatch, 'dispatch-new')
  assert.equal(steps[1].terminal, undefined)
})

test('a completed Task is not turned into failure by an old failed dispatch record', () => {
  const steps = projectSteps(run(), 'done', [{ id: 'task', title: '[TF:implement] 已完成', status: 'completed' }], [
    { taskId: 'task', dispatchId: 'dispatch-old', state: 'failed' }
  ])
  assert.equal(steps[1].state, 'done')
})

test('missing bound tasks and unsupported native statuses stay unknown, not completed', () => {
  const current = run()
  current.taskIds = { implement: 'missing' }
  assert.equal(projectSteps(current, 'done')[1].state, 'unknown')
  const steps = projectSteps(run(), 'done', [{ id: 'new-state', title: '[TF:implement] 同步中', status: 'future-status' }])
  assert.equal(steps[1].state, 'unknown')
})

test('a member named by an object-prototype key remains queued until its actual Task exists', () => {
  const team = migrateTeam(defaultTeam)
  team.members[0].id = 'constructor'
  const current = run(validateTeam(team, agents))
  current.taskIds = {}
  const step = projectSteps(current, 'working')[1]
  assert.equal(step.memberId, 'constructor')
  assert.equal(step.state, 'queued')
  assert.equal(step.issue, undefined)
})

test('an old persisted run still reads its original fixed-role Task titles', () => {
  const current = run(migrateTeam({ lead: 'claude', implement: 'codex', diagnose: 'codebuddy', review: 'opencode' }))
  delete current.schemaVersion
  const steps = projectSteps(current, 'done', [
    { id: 'implement-old', title: 'Implement: 修复表单', status: 'completed' },
    { id: 'diagnose-old', title: 'Diagnose: 复现', status: 'completed' },
    { id: 'review-old', title: 'Review: 审核', status: 'completed' }
  ])
  assert.deepEqual(steps.slice(1).map((step) => [step.memberId, step.taskId, step.state]), [
    ['implement', 'implement-old', 'done'], ['diagnose', 'diagnose-old', 'done'], ['review', 'review-old', 'done']
  ])
})
