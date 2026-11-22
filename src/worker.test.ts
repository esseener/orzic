import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import type { JsonValue } from 'orca/worker'
import { maxTaskLength, type ModelCatalog, type Run, type Team } from './protocol'
import activate from './worker'
import { defaultPolicy } from './workflow'

const workspace = 'folder:current'
const other = 'folder:other'
const path = process.platform === 'win32' ? 'C:\\Projects\\Exact Location' : '/projects/Exact Location'
const runKey = `run:${workspace}`
const legacy = { lead: 'claude', implement: 'codex', diagnose: 'omp', review: 'opencode' }
const agents = ['claude', 'codex', 'omp', 'opencode'].map((id) => ({ id, name: id }))
const team: Team = { version: 2, lead: 'claude', members: [
  { id: 'app', name: '应用改动', kind: 'implement', agent: 'codex', brief: '更新入口' },
  { id: 'tests', name: '测试改动', kind: 'implement', agent: 'codex', brief: '补回归用例' },
  { id: 'review', name: '验收审核', kind: 'review', agent: 'opencode', brief: '核实测试结果' }
] }
const request = { workspace, goal: '  改进输入处理  ', acceptance: '  空输入有明确错误  ', instructions: '  使用项目既有组件，保留用户改动。  ', team }
const finished: Run = { schemaVersion: 2, id: 'previous', team, status: 'completed', goal: 'previous goal', path,
  nativeId: 'run_previous', leadTerminal: 'term_lead' }
const tasks = [
  { id: 'task_app', title: '[TF:app] 应用改动', status: 'completed' },
  { id: 'task_tests', title: '[TF:tests] 测试改动', status: 'completed' },
  { id: 'task_review', title: '[TF:review] 验收审核', status: 'completed' }
]
const launchReceipt = { outcome: { kind: 'terminal', handle: 'term_lead' }, prompt: { outcome: 'handed-to-terminal' } }
const target = { id: workspace, kind: 'folder', name: 'Current', path, branch: null, hostId: null }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function setup(handler?: (args: string[]) => unknown, storage: Record<string, JsonValue> = {},
  catalogReader?: (agent: string, cwd: string, signal?: AbortSignal) => Promise<ModelCatalog>) {
  const calls: string[][] = []
  const host = mockHost({ storage, results: {
    'workspace.readContext': { workspaceId: workspace, displayName: 'Current', branch: '', terminals: [] },
    'workspace.list': { workspaces: [target], truncated: false }
  } })
  const command = async <T>(...args: string[]): Promise<T> => {
    calls.push(args)
    const custom = handler?.(args)
    if (custom !== undefined) return await custom as T
    switch (args.slice(0, 2).join(' ')) {
      case 'agent installed': return { agents } as T
      case 'agent launch': return launchReceipt as T
      case 'agent list': return { agents: [{ paneKey: 'tab:leaf', worktreeId: workspace, state: 'done' }] } as T
      case 'terminal list': return { terminals: [{ handle: 'term_lead', worktreeId: workspace, tabId: 'tab', leafId: 'leaf' }] } as T
      case 'terminal read': return { terminal: { tail: ['Lead console available'] } } as T
      case 'terminal switch': return { navigated: true } as T
      case 'orchestration run-list': return { runs: [] } as T
      case 'orchestration task-list': return { tasks } as T
      case 'orchestration worker-list': return { workers: [] } as T
      default: throw new Error(`Unexpected CLI command: ${args.join(' ')}`)
    }
  }
  const worker = await mountWorker({ default: (orca) => activate(orca, command, catalogReader) }, { host })
  return { worker, host, calls, launches: () => calls.filter(([group, action]) => group === 'agent' && action === 'launch') }
}

const planInput = { summary: '修复输入边界并完成审核', steps: ['修正输入处理', '执行验证并只读审核'],
  paths: ['src/input.ts'], checks: ['运行输入处理回归测试'], risks: [] }
const panelCaller = { panel: 'team-flow' }

async function proposeFirst(worker: TestWorker) {
  const run = await worker.request('flow.start', request)
  await worker.request('flow.snapshot', {}) // Observe the lead launch receipt before confirming.
  return worker.request('flow.propose', { workspace, runId: run.id, baseRevision: 0, plan: planInput })
}

test('a new run requires a submitted plan before any execution authorization', async () => {
  const { worker, calls } = await setup()
  try {
    const run = await worker.request('flow.start', request)
    equal(run.workflow?.phase, 'planning')
    deepEqual(run.workflow?.policy, defaultPolicy)
    await rejects(worker.request('flow.approve', { workspace, runId: run.id, revision: 0 }, panelCaller), /没有可以确认/)
    const review = await worker.request('flow.propose', { workspace, runId: run.id, baseRevision: 0, plan: planInput })
    equal(review.workflow?.phase, 'review')
    equal(review.workflow?.plan?.revision, 1)
    await rejects(worker.request('flow.propose', { workspace, runId: run.id, baseRevision: 0, plan: planInput }), /版本已变化/)
    const snapshot = await worker.request('flow.snapshot', {})
    equal(snapshot.canStart, false)
    equal(snapshot.run?.status, 'attention')
    equal(calls.some((args) => args[1] === 'send'), false)
  } finally { await worker.deactivate() }
})

test('a confirmed revision sends one authorization to the original lead despite concurrent clicks', async () => {
  const entered = deferred<void>()
  const receipt = deferred<{ message: { id: string } }>()
  let body = ''
  let committed = false
  const { worker, host, calls } = await setup((args) => {
    if (args[1] !== 'send') return undefined
    return (async () => {
      const stored = host.data().storage[runKey] as Run
      committed = stored.workflow?.approvedRevision === 1 && stored.workflow.delivery === 'sending'
      body = await readFile(args[args.indexOf('--body-file') + 1], 'utf8')
      entered.resolve(undefined)
      return receipt.promise
    })()
  })
  try {
    const review = await proposeFirst(worker)
    const approval = { workspace, runId: review.id, revision: 1 }
    const pending = worker.request('flow.approve', approval, panelCaller)
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Authorization did not enter its send') })])
    equal(committed, true)
    equal((await worker.request('flow.approve', approval, panelCaller)).workflow?.phase, 'approving')
    receipt.resolve({ message: { id: 'msg_authorization' } })
    const confirmed = await pending
    equal(confirmed.workflow?.phase, 'executing')
    equal(confirmed.workflow?.messageId, 'msg_authorization')
    equal(confirmed.workflow?.delivery, 'accepted')
    equal((await worker.request('flow.approve', approval, panelCaller)).workflow?.approvedRevision, 1)
    const sends = calls.filter((args) => args[1] === 'send')
    equal(sends.length, 1)
    equal(sends[0][sends[0].indexOf('--to') + 1], 'term_lead')
    ok(body.includes(planInput.summary), 'The lead must receive the exact plan that the user approved')
    await rejects(worker.request('flow.propose', { workspace, runId: review.id, baseRevision: 1, plan: planInput }), /已经确认/)
  } finally { receipt.resolve({ message: { id: 'msg_cleanup' } }); await worker.deactivate() }
})

test('unknown approval delivery is durable and cannot authorize an automatic second send', async () => {
  const { worker, host, calls } = await setup((args) => {
    if (args[1] === 'send') throw Object.assign(new Error('mail receipt lost'), { code: 'mail_unknown' })
  })
  let persisted: Record<string, JsonValue> = {}
  try {
    const review = await proposeFirst(worker)
    const approval = { workspace, runId: review.id, revision: 1 }
    const uncertain = await worker.request('flow.approve', approval, panelCaller)
    equal(uncertain.workflow?.phase, 'blocked')
    equal(uncertain.workflow?.delivery, 'unknown')
    match(uncertain.workflow?.issue ?? '', /mail_unknown/)
    await rejects(worker.request('flow.approve', approval, panelCaller), /送达尚未核实/)
    await rejects(worker.request('flow.revise', { ...approval, feedback: '重新发送' }, panelCaller), /不能重复发送/)
    equal(calls.filter((args) => args[1] === 'send').length, 1)
    persisted = JSON.parse(JSON.stringify(host.data().storage)) as Record<string, JsonValue>
  } finally { await worker.deactivate() }
  const restarted = await setup(undefined, persisted)
  try {
    const snapshot = await restarted.worker.request('flow.snapshot', {})
    equal(snapshot.run?.workflow?.delivery, 'unknown')
    equal(snapshot.canStart, false)
    await rejects(restarted.worker.request('flow.approve', { workspace, runId: snapshot.run!.id, revision: 1 }, panelCaller), /送达尚未核实/)
    equal(restarted.calls.some((args) => args[1] === 'send'), false)
  } finally { await restarted.worker.deactivate() }
})

test('replanning snapshots new boundaries and invalidates the previous approval version', async () => {
  const { worker, launches } = await setup((args) => args[1] === 'send' ? { id: 'msg_replan' } : undefined)
  try {
    const review = await proposeFirst(worker)
    const policy = { ...defaultPolicy, allowedPaths: ['src'], maxReworks: 1 }
    const replanning = await worker.request('flow.revise', { workspace, runId: review.id, revision: 1,
      feedback: '只修改输入模块，不调整依赖。', policy }, panelCaller)
    equal(replanning.workflow?.phase, 'planning')
    deepEqual(replanning.workflow?.policy, policy)
    equal(replanning.workflow?.approvedRevision, undefined)
    await rejects(worker.request('flow.approve', { workspace, runId: review.id, revision: 1 }, panelCaller), /没有可以确认/)
    await rejects(worker.request('flow.propose', { workspace, runId: review.id, baseRevision: 1,
      plan: { ...planInput, paths: ['package.json'] } }), /范围|路径/)
    const revised = await worker.request('flow.propose', { workspace, runId: review.id, baseRevision: 1, plan: planInput })
    equal(revised.workflow?.plan?.revision, 2)
    equal(revised.workflow?.feedback, '只修改输入模块，不调整依赖。')
    await rejects(worker.request('flow.approve', { workspace, runId: review.id, revision: 1 }, panelCaller), /版本已变化/)
    equal(launches().length, 1)
  } finally { await worker.deactivate() }
})

test('background proposals remain bound to their project while approval requires the focused project', async () => {
  const { worker, host, calls } = await setup()
  try {
    const run = await worker.request('flow.start', request)
    await worker.request('flow.snapshot', {})
    host.respond('workspace.readContext', { workspaceId: other, displayName: 'Other', branch: '', terminals: [] })
    host.respond('workspace.list', { workspaces: [target, { ...target, id: other, path: `${path}-other` }], truncated: false })
    const review = await worker.request('flow.propose', { workspace, runId: run.id, baseRevision: 0, plan: planInput })
    equal(review.workflow?.phase, 'review')
    await rejects(worker.request('flow.approve', { workspace, runId: run.id, revision: 1 }, panelCaller), /工作区已切换/)
    const blocked = await worker.request('flow.block', { workspace, runId: run.id, reason: '需要超出当前范围，已停止派发。' })
    equal(blocked.workflow?.phase, 'blocked')
    equal((host.data().storage[runKey] as Run).id, run.id)
    equal(calls.some((args) => args[1] === 'send'), false)
  } finally { await worker.deactivate() }
})

test('a restarted in-flight approval cannot look completed even when native tasks are settled', async () => {
  const interrupted: Run = { ...finished, workspace, workflow: { phase: 'approving', policy: { ...defaultPolicy },
    plan: { ...planInput, revision: 1 }, approvedRevision: 1, approvedAt: 1, delivery: 'sending' } }
  const { worker, host, calls } = await setup(undefined, { [runKey]: interrupted } as unknown as Record<string, JsonValue>)
  try {
    const snapshot = await worker.request('flow.snapshot', {})
    equal(snapshot.run?.workflow?.phase, 'blocked')
    equal(snapshot.run?.workflow?.delivery, 'unknown')
    equal(snapshot.run?.status, 'attention')
    equal(snapshot.canStart, false)
    equal((host.data().storage[runKey] as Run).workflow?.delivery, 'unknown')
    equal(calls.some((args) => args[1] === 'send'), false)
  } finally { await worker.deactivate() }
})

test('a planning blockage can collect clarification before the first plan exists', async () => {
  const { worker } = await setup((args) => args[1] === 'send' ? { id: 'msg_clarification' } : undefined)
  try {
    const run = await worker.request('flow.start', request)
    await worker.request('flow.snapshot', {})
    await worker.request('flow.block', { workspace, runId: run.id, reason: '尚未确认错误应显示在表单何处。' })
    const clarified = await worker.request('flow.revise', { workspace, runId: run.id, revision: 0,
      feedback: '沿用既有表单顶部的错误区域。' }, panelCaller)
    equal(clarified.workflow?.phase, 'planning')
    equal(clarified.workflow?.approvedRevision, undefined)
    const review = await worker.request('flow.propose', { workspace, runId: run.id, baseRevision: 0, plan: planInput })
    equal(review.workflow?.plan?.revision, 1)
  } finally { await worker.deactivate() }
})

test('approved execution still requires native completion rather than the authorization receipt', async () => {
  const executing: Run = { ...finished, workspace, workflow: { phase: 'executing', policy: { ...defaultPolicy },
    plan: { ...planInput, revision: 1 }, approvedRevision: 1, approvedAt: 1, delivery: 'accepted' } }
  let active = true
  const { worker } = await setup((args) => args[1] === 'task-list' ?
    { tasks: active ? tasks.map((task, index) => index === 0 ? { ...task, status: 'running' } : task) : tasks } : undefined,
  { [runKey]: executing } as unknown as Record<string, JsonValue>)
  try {
    equal((await worker.request('flow.snapshot', {})).canStart, false)
    active = false
    const done = await worker.request('flow.snapshot', {})
    equal(done.run?.status, 'completed')
    equal(done.canStart, true)
  } finally { await worker.deactivate() }
})

test('reading model choices preserves the saved team and run without launching an Agent', async () => {
  const initial = { team: legacy, [runKey]: finished } as unknown as Record<string, JsonValue>
  const seen: string[][] = []
  const catalog: ModelCatalog = { agent: 'codex', models: [{ id: 'provider/model-a', name: 'Model A' }], source: 'test CLI directory' }
  const { worker, host, launches } = await setup(undefined, initial, async (agent, cwd) => { seen.push([agent, cwd]); return catalog })
  try {
    deepEqual(await worker.request('flow.models', { workspace, agent: 'codex' }), catalog)
    deepEqual(seen, [['codex', path]])
    deepEqual(host.data().storage, initial)
    equal(launches().length, 0)
    deepEqual(worker.refusals, [])
  } finally { await worker.deactivate() }
})

test('model discovery refuses foreign or uninstalled targets and avoids nonlocal CLI execution', async () => {
  let reads = 0
  const { worker, host, launches } = await setup(undefined, {}, async (agent) => { ++reads; return { agent, models: [], source: 'test' } })
  try {
    await rejects(worker.request('flow.models', { workspace: other, agent: 'codex' }), /工作区已切换/)
    await rejects(worker.request('flow.models', { workspace, agent: 'codex & other-command' }), /已安装/)
    host.respond('workspace.list', { workspaces: [{ ...target, hostId: 'ssh:remote' }], truncated: false })
    const result = await worker.request('flow.models', { workspace, agent: 'codex' })
    deepEqual(result.models, [])
    match(result.notice ?? '', /本机工作区/)
    equal(reads, 0)
    equal(launches().length, 0)
  } finally { await worker.deactivate() }
})

test('a catalog response from the old workspace is discarded instead of being relabeled for the new one', async () => {
  const entered = deferred<void>()
  const pending = deferred<ModelCatalog>()
  const { worker, host, launches } = await setup(undefined, {}, async () => { entered.resolve(undefined); return pending.promise })
  try {
    const response = worker.request('flow.models', { workspace, agent: 'codex' })
    await entered.promise
    host.respond('workspace.readContext', { workspaceId: other, displayName: 'Other', branch: '', terminals: [] })
    host.respond('workspace.list', { workspaces: [{ ...target, id: other }], truncated: false })
    pending.resolve({ agent: 'codex', models: [{ id: 'old-model', name: 'Old project model' }], source: 'old project' })
    await rejects(response, /已丢弃原项目/)
    equal(launches().length, 0)
    deepEqual(host.data().storage, {})
  } finally { await worker.deactivate() }
})

test('saving migrates a fixed team and preserves custom members without launching', async () => {
  const { worker, host, launches } = await setup(undefined, { team: legacy })
  try {
    const before = await worker.request('flow.snapshot', {})
    deepEqual(before.team.members.map(({ id, agent }) => [id, agent]), [['implement', 'codex'], ['diagnose', 'omp'], ['review', 'opencode']])
    deepEqual(host.data().storage.team, legacy)
    // The runtime still accepts a saved legacy payload from a panel open during upgrade.
    const upgraded = await worker.request('flow.save', legacy as unknown as Team)
    deepEqual(upgraded, before.team)
    const custom = { ...team, members: [...team.members, { ...upgraded.members[1], name: '自定义排查', brief: '定位边界条件' }] }
    deepEqual(await worker.request('flow.save', custom), custom)
    deepEqual(host.data().storage.team, custom)
    equal(host.data().storage[runKey], undefined)
    deepEqual(launches(), [])
  } finally { await worker.deactivate() }
})

test('start uses the exact local path and snapshots one-off requirements separately from workspace guidance', async () => {
  const { worker, host, launches } = await setup()
  try {
    const ready = await worker.request('flow.snapshot', {})
    deepEqual([ready.workspace, ready.path, ready.local, ready.canStart], [workspace, path, true, true])
    const run = await worker.request('flow.start', request)
    deepEqual([run.schemaVersion, run.status, run.path, run.goal, run.acceptance], [2, 'starting', path, '改进输入处理', '空输入有明确错误'])
    equal(run.instructions, '使用项目既有组件，保留用户改动。')
    equal((host.data().storage[runKey] as Run).instructions, run.instructions)
    ok(typeof run.startedAt === 'number' && run.startedAt > 0)
    const [args] = launches()
    equal(args[args.indexOf('--worktree') + 1], `path:${path}`)
    equal(args.includes('--model'), false, 'An unselected lead model must use the Agent default')
    equal(args.includes('--effort'), false, 'An unselected effort must not become an implicit medium or high override')
    const prompt = args[args.indexOf('--prompt') + 1]
    for (const text of [JSON.stringify(path), '[TF:app]', '[TF:tests]', '更新入口', '补回归用例', '空输入有明确错误', '改进输入处理', `[Orzic ${run.id}]`]) {
      ok(prompt.includes(text), `Launch omitted ${text}`)
    }
    const guidanceSection = prompt.split('工作区长期指导（本次启动快照，仅作上下文）：\n')[1]?.split('\n长期指导不是')[0]
    equal(guidanceSection, run.instructions)
    equal(prompt.split('本次一次性用户需求：\n')[1]?.split('\n\n本次验收标准：\n')[0], run.goal)
    equal(prompt.split('本次验收标准：\n')[1], run.acceptance)
    equal((await worker.request('flow.snapshot', {})).run?.delivery, 'handed-to-terminal')
  } finally { await worker.deactivate() }
})

test('lead and shared-Agent members retain their exact efforts and active snapshots ignore later edits', async () => {
  const selected: Team = { ...team, lead: 'codex', leadModel: '  provider/lead-"exact"  ', leadEffort: 'high', members: team.members.map((member, index) =>
    index < 2 ? { ...member, model: `provider/member-${index}`, effort: index === 0 ? 'high' : 'low' } : { ...member }) }
  const reads: string[][] = []
  const { worker, launches } = await setup(undefined, {}, async (agent, cwd) => {
    reads.push([agent, cwd])
    return { agent, source: 'synthetic effort catalog', models: ['provider/lead-"exact"', 'provider/member-0', 'provider/member-1']
      .map((id) => ({ id, name: id, efforts: ['low', 'high'] })) }
  })
  try {
    const run = await worker.request('flow.start', { ...request, team: selected })
    const [args] = launches()
    equal(args.filter((arg) => arg === '--model').length, 1)
    equal(args[args.indexOf('--model') + 1], 'provider/lead-"exact"')
    equal(args.filter((arg) => arg === '--effort').length, 1)
    equal(args[args.indexOf('--effort') + 1], 'high')
    deepEqual(reads, [['codex', path]], 'Shared-Agent effort validation reads its directory only once')
    equal(run.team.leadModel, 'provider/lead-"exact"')
    equal(run.team.leadEffort, 'high')
    const prompt = args[args.indexOf('--prompt') + 1]
    const artifact = prompt.match(/```json\n([\s\S]*?)\n```/)
    ok(artifact)
    const roster = JSON.parse(artifact[1])
    deepEqual(roster.map((member: { 标识: string; startupArgs: string[] }) => [member.标识, member.startupArgs]), [
      ['[TF:app]', ['--agent', 'codex', '--model', 'provider/member-0', '--effort', 'high']],
      ['[TF:tests]', ['--agent', 'codex', '--model', 'provider/member-1', '--effort', 'low']],
      ['[TF:review]', ['--agent', 'opencode']]
    ])
    const edited: Team = { ...selected, leadModel: 'provider/new-lead', leadEffort: 'low', members: selected.members.map((member) =>
      ({ ...member, model: 'provider/new-member' })) }
    await worker.request('flow.save', edited)
    const view = await worker.request('flow.snapshot', {})
    equal(view.team.leadModel, 'provider/new-lead')
    equal(view.team.leadEffort, 'low')
    equal(view.run?.team.leadEffort, 'high')
    deepEqual(view.run?.team, run.team)
    equal(view.run?.instructions, run.instructions)
    equal(launches().length, 1)
  } finally { await worker.deactivate() }
})

test('host model and effort refusals stay actionable without retrying on default parameters', async () => {
  for (const code of ['invalid_model', 'invalid_effort']) {
    const { worker, launches } = await setup((args) => {
      if (args[1] === 'launch') throw Object.assign(new Error('selected configuration unavailable'), { code })
    }, {}, async (agent) => ({ agent, source: 'synthetic effort catalog', models: [{ id: 'provider/selected', name: 'Fixture', efforts: ['high'] }] }))
    try {
      const run = await worker.request('flow.start', { ...request, team: { ...team, leadModel: 'provider/selected', leadEffort: 'high' } })
      const view = await worker.request('flow.snapshot', {})
      equal(view.run?.id, run.id)
      equal(view.run?.status, 'attention')
      equal(view.run?.team.leadModel, 'provider/selected')
      equal(view.run?.team.leadEffort, 'high')
      ok(view.issue?.includes(code))
      equal(view.canStart, false)
      equal(launches().length, 1)
      const [args] = launches()
      equal(args[args.indexOf('--model') + 1], 'provider/selected')
      equal(args[args.indexOf('--effort') + 1], 'high')
    } finally { await worker.deactivate() }
  }
})

test('unsupported explicit member and lead models are rejected before writing a run or launching', async () => {
  const { worker, host, launches } = await setup((args) =>
    args[0] === 'agent' && args[1] === 'installed' ? { agents: [...agents, { id: 'codebuddy', name: 'CodeBuddy' }] } : undefined,
  { team })
  try {
    await rejects(worker.request('flow.start', { ...request, team: { ...team, lead: 'codebuddy', leadModel: 'provider/selected' } }), /codebuddy.*支持指定模型/)
    const members = team.members.map((member, index) => index === 0 ? { ...member, agent: 'codebuddy', model: 'provider/selected' } : member)
    await rejects(worker.request('flow.start', { ...request, team: { ...team, members } }), /codebuddy.*支持指定模型/)
    equal(host.data().storage[runKey], undefined)
    deepEqual(host.data().storage.team, team)
    deepEqual(launches(), [])
  } finally { await worker.deactivate() }
})

test('known unsupported model-effort combinations are rejected before changing config or creating a run', async () => {
  const { worker, host, launches } = await setup(undefined, { team }, async (agent) => ({ agent, source: 'synthetic limited catalog', models: [
    { id: 'fixture/limited', name: 'Limited', efforts: ['low'] },
    { id: 'fixture/no-reasoning', name: 'Nonreasoning', efforts: [] }
  ] }))
  try {
    await rejects(worker.request('flow.start', { ...request, team: { ...team, lead: 'codex', leadModel: 'fixture/limited', leadEffort: 'high' } }), /主脑.*目录未声明支持/)
    const members = team.members.map((member, index) => index === 0 ? { ...member, model: 'fixture/no-reasoning', effort: 'low' } : member)
    await rejects(worker.request('flow.start', { ...request, team: { ...team, members } }), /应用改动.*目录未声明支持/)
    await rejects(worker.request('flow.start', { ...request, team: { ...team, leadEffort: 'high' } }), /先为主脑指定模型/)
    await rejects(worker.request('flow.start', { ...request, team: { ...team, lead: 'opencode', leadModel: 'fixture/limited', leadEffort: 'low' } }), /opencode.*思考强度/)
    equal(host.data().storage[runKey], undefined)
    deepEqual(host.data().storage.team, team)
    deepEqual(launches(), [])
  } finally { await worker.deactivate() }
})

test('switching workspace during effort discovery cannot launch or persist a run for the previous project', async () => {
  const entered = deferred<void>()
  const pending = deferred<ModelCatalog>()
  const { worker, host, launches } = await setup(undefined, { team }, async () => { entered.resolve(); return pending.promise })
  const catalog: ModelCatalog = { agent: 'codex', source: 'synthetic delayed catalog', models: [{ id: 'fixture/model', name: 'Fixture', efforts: ['high'] }] }
  try {
    const response = worker.request('flow.start', { ...request, team: { ...team, lead: 'codex', leadModel: 'fixture/model', leadEffort: 'high' } })
    await entered.promise
    host.respond('workspace.readContext', { workspaceId: other, displayName: 'Other', branch: '', terminals: [] })
    host.respond('workspace.list', { workspaces: [{ ...target, id: other }], truncated: false })
    pending.resolve(catalog)
    await rejects(response, /工作区已切换/)
    equal(host.data().storage[runKey], undefined)
    deepEqual(host.data().storage.team, team)
    deepEqual(launches(), [])
  } finally { pending.resolve(catalog); await worker.deactivate() }
})

test('invalid workspace guidance is rejected before starting persistence, and blank guidance is allowed', async () => {
  const { worker, host, launches } = await setup(undefined, { team })
  try {
    await rejects(worker.request('flow.start', { ...request, instructions: '指'.repeat(maxTaskLength + 1) }), /长期指导.*4000/)
    await rejects(worker.request('flow.start', { ...request, instructions: undefined as unknown as string }), /长期指导必须是文本/)
    await rejects(worker.request('flow.start', { ...request, instructions: '指导\u0000内容' }), /空字符/)
    equal(host.data().storage[runKey], undefined)
    deepEqual(host.data().storage.team, team)
    deepEqual(launches(), [])
    const run = await worker.request('flow.start', { ...request, instructions: '   ' })
    equal(run.instructions, '')
    equal((host.data().storage[runKey] as Run).instructions, '')
    equal(launches().length, 1)
    await worker.request('flow.snapshot', {})
  } finally { await worker.deactivate() }
})

test('workspace guidance accepts the exact task-length boundary and survives later snapshots', async () => {
  const instructions = '指'.repeat(maxTaskLength)
  const { worker, launches } = await setup()
  try {
    const run = await worker.request('flow.start', { ...request, instructions })
    equal(run.instructions, instructions)
    equal((await worker.request('flow.snapshot', {})).run?.instructions, instructions)
    const [args] = launches()
    ok(args[args.indexOf('--prompt') + 1].includes(instructions))
    equal(launches().length, 1)
  } finally { await worker.deactivate() }
})

test('a stale workspace, missing inventory row, and non-local row all prevent start', async () => {
  const { worker, host, launches } = await setup()
  try {
    await rejects(worker.request('flow.start', { ...request, workspace: other }))
    host.respond('workspace.list', { workspaces: [], truncated: true })
    const missing = await worker.request('flow.snapshot', {})
    deepEqual([missing.path, missing.local, missing.canStart], [null, false, false])
    await rejects(worker.request('flow.start', request))
    host.respond('workspace.list', { workspaces: [{ ...target, hostId: 'ssh:remote' }], truncated: false })
    const remote = await worker.request('flow.snapshot', {})
    deepEqual([remote.path, remote.local, remote.canStart], [path, false, false])
    await rejects(worker.request('flow.start', request))
    deepEqual(launches(), [])
  } finally { await worker.deactivate() }
})

test('unknown legacy run blocks a stale start request even if persisted as completed', async () => {
  const { worker, launches, host } = await setup(undefined, {
    [runKey]: { id: 'legacy', status: 'completed', team: legacy, goal: 'unfinished old request' }
  })
  try {
    const view = await worker.request('flow.snapshot', {})
    equal(view.run?.status, 'unknown')
    equal(view.run?.team.members[1].id, 'diagnose')
    equal(view.run?.schemaVersion, undefined)
    equal(view.canStart, false)
    await rejects(worker.request('flow.start', request), /上一队伍/)
    deepEqual(launches(), [])
    equal((host.data().storage[runKey] as Run).id, 'legacy')
  } finally { await worker.deactivate() }
})

test('a done lead cannot hide active tasks or earlier attempts; confirmed completion permits the next run', async () => {
  let oldAttemptSettled = false
  let unmapped = true
  const { worker, calls, launches } = await setup((args) => {
    if (args[1] === 'task-list') return { tasks: unmapped ? [...tasks, { id: 'task_extra', title: 'Unmapped', status: 'ready' }] : tasks }
    if (args[1] === 'worker-list') return args.includes('--cursor') ? {
      workers: [{ taskId: 'task_app', dispatchId: 'ctx_old', state: oldAttemptSettled ? 'failed' : 'running', terminalState: oldAttemptSettled ? 'released' : 'active' }]
    } : {
      workers: [{ taskId: 'task_app', dispatchId: 'ctx_new', state: 'succeeded', terminalState: 'retained' }], nextCursor: 'second page'
    }
  }, { [runKey]: finished })
  try {
    let view = await worker.request('flow.snapshot', {})
    equal(view.steps[0].state, 'done')
    equal(view.canStart, false)
    await rejects(worker.request('flow.start', request), /上一队伍/)
    oldAttemptSettled = true
    equal((await worker.request('flow.snapshot', {})).canStart, false) // The unmapped task alone blocks start.
    oldAttemptSettled = false
    unmapped = false
    view = await worker.request('flow.snapshot', {})
    equal(view.canStart, false)
    equal(view.steps.find(({ memberId }) => memberId === 'app')?.dispatch, 'ctx_new')
    ok(calls.some((args) => args[1] === 'worker-list' && args.includes('100') && args.includes('second page')))
    oldAttemptSettled = true
    view = await worker.request('flow.snapshot', {})
    equal(view.run?.status, 'completed')
    equal(view.canStart, true)
    // A fresh read in the start handler must not trust even a just-rendered ready snapshot.
    oldAttemptSettled = false
    await rejects(worker.request('flow.start', request), /上一队伍/)
    deepEqual(launches(), [])
    oldAttemptSettled = true
    const next = await worker.request('flow.start', request)
    ok(next.id !== finished.id)
    equal(launches().length, 1)
    await worker.request('flow.snapshot', {})
  } finally { await worker.deactivate() }
})

test('an uncertain delivery receipt stays blocked but its lead output and terminal remain available', async () => {
  const { worker, launches } = await setup((args) => args[1] === 'launch' ? { outcome: launchReceipt.outcome } : undefined)
  try {
    const run = await worker.request('flow.start', request)
    const view = await worker.request('flow.snapshot', {})
    equal(view.run?.status, 'attention')
    equal(view.run?.leadTerminal, 'term_lead')
    match(view.issue ?? '', /尚未确认需求已送达/)
    equal(view.canStart, false)
    const selection = { workspace, runId: run.id, memberId: 'lead' }
    deepEqual(await worker.request('flow.detail', selection), { text: 'Lead console available', canOpen: true })
    deepEqual(await worker.request('flow.open', selection), { opened: true })
    await rejects(worker.request('flow.start', request), /上一队伍/)
    equal(launches().length, 1)
  } finally { await worker.deactivate() }
})

test('launch errors preserve operation ID and code; a late receipt merges with a discovered native run and rework IDs', async () => {
  const receipt = deferred<typeof launchReceipt>()
  let nativeRuns: { id: string; objective: string; coordinator_handle: string }[] = []
  let rework = false
  let queryFails = false
  const { worker, launches, host } = await setup((args) => {
    if (args[1] === 'launch') return receipt.promise
    if (args[1] === 'run-list') return { runs: nativeRuns }
    if (args[1] === 'task-list') {
      if (queryFails) throw new Error('transient error')
      return { tasks: rework ? [...tasks, { id: 'task_rework', title: '[TF:app] 返工', status: 'ready' }] : tasks }
    }
  })
  try {
    const run = await worker.request('flow.start', request)
    nativeRuns = [{ id: 'run_native', objective: `[Orzic ${run.id}]`, coordinator_handle: 'term_lead' }]
    const first = await worker.request('flow.snapshot', {})
    equal(first.run?.status, 'starting')
    equal(first.run?.taskIds?.app, 'task_app')
    rework = true
    const updated = await worker.request('flow.snapshot', {})
    equal(updated.run?.taskIds?.app, 'task_rework')
    ok(updated.syncedAt !== null)
    receipt.reject(Object.assign(new Error('launch receipt lost'), { code: 'launch_unknown', data: { operationId: 'op_123' } }))
    queryFails = true
    const uncertain = await worker.request('flow.snapshot', {})
    equal(uncertain.run?.status, 'attention')
    equal(uncertain.run?.operationId, 'op_123')
    match(uncertain.issue ?? '', /launch_unknown/)
    equal(uncertain.run?.nativeId, 'run_native')
    equal(uncertain.run?.leadTerminal, 'term_lead')
    equal(uncertain.run?.taskIds?.app, 'task_rework')
    equal(uncertain.syncedAt, updated.syncedAt)
    equal((host.data().storage[runKey] as Run).taskIds?.app, 'task_rework')
    await rejects(worker.request('flow.start', request), /上一队伍/)
    equal(launches().length, 1)
  } finally {
    receipt.resolve(launchReceipt)
    await worker.deactivate()
  }
})

test('a terminal-less member reads its own native dispatch, and missing archives are actionable', async () => {
  let archived = true
  const { worker, calls } = await setup((args) => {
    if (args[1] === 'worker-list') return { workers: [{ taskId: 'task_tests', dispatchId: 'ctx_tests', state: 'succeeded' }] }
    if (args[1] === 'worker-read') {
      equal(args[args.indexOf('--dispatch') + 1], 'ctx_tests')
      if (!archived) throw Object.assign(new Error('archive unavailable'), { code: 'archive_unavailable' })
      return { terminal: { tail: ['Regression passed'] } }
    }
  }, { [runKey]: finished })
  try {
    const selection = { workspace, runId: finished.id, memberId: 'tests' }
    deepEqual(await worker.request('flow.detail', selection), { text: 'Regression passed', canOpen: false })
    deepEqual(await worker.request('flow.open', selection), { opened: false })
    archived = false
    await rejects(worker.request('flow.detail', selection), /archive_unavailable.*原生任务结果/)
    await rejects(worker.request('flow.detail', { ...selection, runId: 'stale' }))
    ok(!calls.some((args) => args[1] === 'switch'))
  } finally { await worker.deactivate() }
})

test('a damaged configuration stays stored until explicit save and CLI inventories are activation-local', async () => {
  const invalid = { version: 7, lead: 'claude', members: [] }
  const first = await setup(undefined, { team: invalid })
  const differentAgents = [{ id: 'other-cli', name: 'Other CLI' }]
  const second = await setup((args) => args.join(' ') === 'agent installed' ? { agents: differentAgents } : undefined)
  try {
    const view = await first.worker.request('flow.snapshot', {})
    deepEqual(view.agents, agents)
    deepEqual([view.path, view.local, view.canStart], [path, true, false])
    match(view.issue ?? '', /未覆盖/)
    await rejects(first.worker.request('flow.start', request))
    deepEqual(first.host.data().storage.team, invalid)
    deepEqual(first.launches(), [])
    deepEqual((await second.worker.request('flow.snapshot', {})).agents, differentAgents)
    await first.worker.request('flow.save', team)
    const repaired = await first.worker.request('flow.snapshot', {})
    equal(repaired.canStart, true)
    deepEqual(repaired.team, team)
  } finally {
    await first.worker.deactivate()
    await second.worker.deactivate()
  }
})
