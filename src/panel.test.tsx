import { assert, test, mount, mockHost, type TestPanel } from 'orca/testing'
import type { PluginRequestInput } from 'orca'
import * as panel from './panel'
import { mockModels, modelConfigured, modelRunning, noProject, otherProject, otherWorkspaceTask, ready, remote, running, unknown, workspaceTask } from './fixtures'
import { maxMembers, maxTaskLength, type ModelCatalog, type Run, type Snapshot, type Team } from './protocol'
import { defaultPolicy } from './workflow'
import { deliveryUnknown, planning, planReview } from './fixtures'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function optionsOf(view: TestPanel, label: string) {
  const field = view.find({ type: 'Select', label })
  assert.ok(field)
  assert.ok(Array.isArray(field.props.options))
  return field.props.options as { value: string; label: string }[]
}


test('member and lead output use their own member identifiers and terminal', async () => {
  const details: PluginRequestInput<'flow.detail'>[] = []
  const terminals: PluginRequestInput<'flow.open'>[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': running,
    'flow.detail': (input) => { details.push(input); return { text: `输出 ${input.memberId}`, canOpen: true } },
    'flow.open': (input) => { terminals.push(input); return { opened: true } }
  } }) })
  try {
    await view.press({ text: '查看实现' })
    assert.ok(view.find({ text: '输出 implement' }))
    await view.press({ text: '打开终端' })
    await view.press({ text: '查看主脑汇总' })
    assert.ok(view.find({ text: '输出 lead' }))
    assert.equal(view.find({ text: '输出 implement' }), null)
    const scope = { workspace: running.workspace, runId: running.run!.id }
    assert.deepEqual(details, [{ ...scope, memberId: 'implement' }, { ...scope, memberId: 'lead' }])
    assert.deepEqual(terminals, [{ ...scope, memberId: 'implement' }])
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('adding, editing and removing members saves the next team and launches it for the exact project with acceptance', async () => {
  let saved = ready.team
  let run: Run | null = null
  const starts: PluginRequestInput<'flow.start'>[] = []
  const queries: PluginRequestInput<'flow.models'>[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...ready, team: saved, run, canStart: !run }),
    'flow.models': (input) => { queries.push(input); return mockModels(input) },
    'flow.save': (team) => { saved = team; return team },
    'flow.start': (input) => {
      starts.push(input)
      run = { ...running.run!, status: 'starting', goal: input.goal, acceptance: input.acceptance, instructions: input.instructions, team: input.team }
      return run
    }
  } }) })
  try {
    assert.ok(view.find({ label: '当前项目' }))
    assert.ok(view.find({ text: ready.name }))
    assert.ok(view.find({ text: ready.path! }))
    assert.ok(view.find({ text: '启动队伍' })?.disabled)
    await view.type({ label: '任务需求' }, '  验证设置  ')
    await view.type({ label: '验收标准（选填）' }, '  表单保留错误提示  ')
    await view.type({ label: '工作区长期说明' }, '  保留原生组件和现有安全约束  ')
    assert.equal(view.find({ text: '启动队伍' })?.disabled, false)
    assert.deepEqual(queries, [])
    await view.press({ text: '队伍设置' })
    assert.ok(view.find({ text: '启动队伍' })?.disabled)
    assert.ok(view.find({ text: /请先保存或取消队伍编辑/ }))
    await view.select({ label: '主脑 Agent（CLI 终端）' }, 'opencode')
    await view.select({ label: '主脑模型' }, 'model:openai/gpt-5.1-codex')
    await view.select({ label: '成员 1 · 模型' }, 'model:gpt-5.1-codex')
    await view.type({ label: '成员 1 · 角色名称' }, '前端开发', { replace: true })
    await view.press({ text: '添加成员' })
    assert.ok(view.find({ text: /角色名称需要/ }))
    assert.ok(view.find({ text: '保存队伍' })?.disabled)
    await view.type({ label: '成员 3 · 角色名称' }, '后端开发')
    await view.type({ label: '成员 3 · 职责' }, '实现接口校验')
    await view.select({ label: '成员 3 · 模式' }, 'implement')
    await view.select({ label: '成员 3 · Agent' }, 'codex')
    await view.select({ label: '成员 3 · 模型' }, 'model:gpt-5-codex')
    await view.press({ text: '添加成员' })
    await view.type({ label: '成员 4 · 角色名称' }, '测试策划')
    await view.select({ label: '成员 4 · Agent' }, 'codex')
    await view.select({ label: '成员 4 · 模型' }, 'custom')
    assert.ok(view.find({ label: '成员 4 · 自定义模型 ID' }))
    await view.type({ label: '成员 4 · 自定义模型 ID' }, 'my custom model')
    assert.equal(view.valueOf({ label: '成员 1 · 模型' }), 'model:gpt-5.1-codex')
    assert.equal(view.valueOf({ label: '成员 3 · 模型' }), 'model:gpt-5-codex')
    assert.equal(view.find({ label: '成员 4 · 自定义模型 ID' })?.props.value, 'my custom model')
    assert.deepEqual(queries, ['claude', 'codex', 'opencode'].map((agent) => ({ workspace: ready.workspace, agent })))
    await view.press({ text: '添加成员' })
    assert.ok(view.find({ text: `协作成员 5 / ${maxMembers}（不含主脑）` }))
    await view.press({ text: '移除成员 5' })
    await view.press({ text: '保存队伍' })
    assert.equal(starts.length, 0)
    assert.ok(view.find({ text: /仅保存配置，尚未执行项目/ }))
    assert.equal(saved.lead, 'opencode')
    assert.equal(saved.leadModel, 'openai/gpt-5.1-codex')
    assert.equal(saved.members[0].model, 'gpt-5.1-codex')
    assert.equal(saved.members[2].model, 'gpt-5-codex')
    assert.equal(saved.members[3].model, 'my custom model')
    assert.ok(view.find({ text: '主脑 · OpenCode · 指定模型：openai/gpt-5.1-codex' }))
    assert.ok(view.find({ text: '指定模型：gpt-5.1-codex' }))
    assert.equal(saved.members[0].id, ready.team.members[0].id)
    assert.deepEqual(saved.members.map(({ name, agent, kind }) => ({ name, agent, kind })), [
      { name: '前端开发', agent: 'codex', kind: 'implement' }, { name: '审核', agent: 'opencode', kind: 'review' },
      { name: '后端开发', agent: 'codex', kind: 'implement' }, { name: '测试策划', agent: 'codex', kind: 'research' }
    ])
    assert.equal(saved.members[2].brief, '实现接口校验')
    assert.equal(new Set(saved.members.map(({ id }) => id)).size, 4)
    assert.ok(saved.members.every(({ id, name }) => id !== name))
    await view.press({ text: '启动队伍' })
    assert.deepEqual(starts, [{
      workspace: ready.workspace, goal: '验证设置', acceptance: '表单保留错误提示', instructions: '保留原生组件和现有安全约束', team: saved, policy: defaultPolicy
    }])
    assert.ok(view.find({ text: '运行流程' }))
    assert.equal(starts[0].team.members[3].model, 'my custom model')
    assert.ok(view.find({ text: /已受理启动请求，正在启动并等待回执/ }))
    assert.ok(view.find({ text: '启动队伍' })?.disabled)
    assert.equal(view.valueOf({ label: '任务需求' }), '  验证设置  ')
    assert.equal(view.valueOf({ label: '验收标准（选填）' }), '  表单保留错误提示  ')
    assert.equal(view.valueOf({ label: '工作区长期说明' }), '  保留原生组件和现有安全约束  ')
    assert.deepEqual(view.persisted.workspace, {
      'task.goal': '  验证设置  ', 'task.acceptance': '  表单保留错误提示  ', 'task.instructions': '  保留原生组件和现有安全约束  '
    })
    await view.type({ label: '工作区长期说明' }, '下一次启动采用新的长期说明', { replace: true })
    assert.equal(run!.instructions, '保留原生组件和现有安全约束')
    assert.ok(view.find({ text: '本次长期说明：保留原生组件和现有安全约束' }))
    assert.equal(view.persisted.workspace['task.instructions'], '下一次启动采用新的长期说明')
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('the displayed member limit disables further additions', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { 'flow.snapshot': {
    ...ready, team: { ...ready.team, members: [...ready.team.members, ...Array.from({ length: maxMembers - 2 }, (_, index) => ({
      id: `member-${index}`, name: `研究员 ${index + 1}`, agent: 'codex', kind: 'research' as const, brief: ''
    }))] }
  }, 'flow.models': mockModels } }) })
  try {
    await view.press({ text: '队伍设置' })
    assert.ok(view.find({ text: `协作成员 ${maxMembers} / ${maxMembers}（不含主脑）` }))
    assert.ok(view.find({ text: '添加成员' })?.disabled)
    await view.press({ text: `移除成员 ${maxMembers}` })
    assert.equal(view.find({ text: '添加成员' })?.disabled, false)
  } finally { await view.unmount() }
})

test('saving a renamed role and new models does not replace the current run team or its output selection', async () => {
  let saved = modelRunning.team
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.models': mockModels,
    'flow.snapshot': () => ({ ...modelRunning, team: saved }),
    'flow.save': (team) => { saved = team; return team },
    'flow.detail': ({ memberId }) => ({ text: `当前运行输出 ${memberId}`, canOpen: true })
  } }) })
  try {
    await view.press({ text: '查看实现' })
    await view.press({ text: '队伍设置' })
    assert.deepEqual(optionsOf(view, '主脑模型'), [
      { value: 'default', label: '沿用 Agent 默认（不指定模型）' },
      { value: 'model:claude-sonnet-4-5', label: '示例 Sonnet · claude-sonnet-4-5' },
      { value: 'model:claude-opus-4-1', label: '示例 Opus · claude-opus-4-1' },
      { value: 'custom', label: '自定义模型 ID（高级）' }
    ])
    assert.ok(optionsOf(view, '成员 1 · 模型').some(({ value, label }) => value === 'model:gpt-5-codex' && label === '示例 Codex 备选 · gpt-5-codex'))
    assert.equal(view.find({ label: '主脑 · 自定义模型 ID' }), null)
    assert.ok(view.find({ text: 'Claude · 模型列表来源：测试夹具（非实时目录）' }))
    assert.ok(view.find({ text: 'Claude · 仅供界面测试，不代表实际可用模型。' }))
    await view.type({ label: '成员 1 · 角色名称' }, '下一次实现', { replace: true })
    await view.select({ label: '主脑模型' }, 'custom')
    assert.ok(view.find({ type: 'Input', label: '主脑 · 自定义模型 ID' }))
    await view.type({ label: '主脑 · 自定义模型 ID' }, 'claude-opus-4-1', { replace: true })
    await view.select({ label: '成员 1 · 模型' }, 'model:gpt-5-codex')
    await view.press({ text: '保存队伍' })
    assert.ok(view.find({ text: '下一次实现' }))
    assert.ok(view.find({ text: '查看实现' }))
    assert.ok(view.find({ text: '当前运行输出 implement' }))
    assert.equal(view.find({ text: '查看下一次实现' }), null)
    assert.equal(running.run!.team.members[0].name, '实现')
    assert.equal(saved.leadModel, 'claude-opus-4-1')
    assert.equal(saved.members[0].model, 'gpt-5-codex')
    assert.ok(view.find({ text: '主脑 · Claude · 指定模型：claude-opus-4-1' }))
    assert.ok(view.find({ text: '指定模型：claude-sonnet-4-5' }))
    assert.equal(view.findAll({ text: '指定模型：gpt-5.1-codex' }).length, 1)
    assert.equal(view.findAll({ text: '指定模型：gpt-5-codex' }).length, 1)
    assert.equal(modelRunning.run!.team.leadModel, 'claude-sonnet-4-5')
    assert.equal(modelRunning.run!.team.members[0].model, 'gpt-5.1-codex')
    assert.equal(view.host.callsOf('flow.start').length, 0)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('canceling edits launches the saved team with empty optional acceptance', async () => {
  const starts: PluginRequestInput<'flow.start'>[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => starts.length ? running : ready,
    'flow.models': mockModels,
    'flow.start': (input) => { starts.push(input); return { ...running.run!, goal: input.goal, acceptance: input.acceptance, instructions: input.instructions, team: input.team } }
  } }) })
  try {
    await view.type({ label: '任务需求' }, '修复设置')
    await view.press({ text: '队伍设置' })
    await view.press({ text: '添加成员' })
    assert.ok(view.find({ text: '启动队伍' })?.disabled)
    await view.press({ text: '取消编辑' })
    assert.equal(view.find({ text: '启动队伍' })?.disabled, false)
    assert.equal(view.host.callsOf('flow.save').length, 0)
    assert.equal(starts.length, 0)
    await view.press({ text: '启动队伍' })
    assert.deepEqual(starts, [{ workspace: ready.workspace, goal: '修复设置', acceptance: '', instructions: '', team: ready.team, policy: defaultPolicy }])
  } finally { await view.unmount() }
})

test('no launch for missing project, nonlocal project or unknown run status', async () => {
  for (const [snapshot, reason] of [
    [noProject, /未选择项目。请先/], [remote, /当前项目不在本机/], [unknown, /确认状态前不能启动新任务/]
  ] as const) {
    const view = await mount(panel, { host: mockHost({ requests: { 'flow.snapshot': snapshot } }) })
    try {
      assert.ok(view.find({ text: reason }))
      assert.ok(view.find({ text: '启动队伍' })?.disabled)
      if (snapshot.local) {
        await view.type({ label: '任务需求' }, '修复设置')
        await view.type({ label: '验收标准（选填）' }, '空名称不能保存')
        assert.ok(view.find({ text: '启动队伍' })?.disabled)
      }
      if (!snapshot.local) {
        assert.ok(view.find({ label: '任务需求' })?.disabled)
        assert.ok(view.find({ label: '验收标准（选填）' })?.disabled)
        assert.ok(view.find({ label: '工作区长期说明' })?.disabled)
        assert.deepEqual(view.persisted.workspace, {})
      }
      assert.equal(view.host.callsOf('flow.start').length, 0)
    } finally { await view.unmount() }
  }
})

test('a workspace event invalidates stale project, team draft and run output without deleting persisted tasks', async () => {
  let active = running
  let delayNext = false
  const requestStarted = deferred<void>()
  const previous = deferred<Snapshot>()
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => {
      if (!delayNext) return active
      delayNext = false
      requestStarted.resolve()
      return previous.promise
    },
    'flow.models': mockModels,
    'flow.detail': () => ({ text: '旧项目的输出', canOpen: true })
  } }) })
  try {
    await view.press({ text: '查看实现' })
    await view.type({ label: '任务需求' }, '旧项目的请求')
    await view.type({ label: '验收标准（选填）' }, '旧项目的验收')
    await view.type({ label: '工作区长期说明' }, '旧项目的长期约定')
    await view.press({ text: '队伍设置' })
    delayNext = true
    const refresh = view.press({ label: '刷新状态' })
    await requestStarted.promise
    active = otherProject
    const switched = view.emit('workspace.changed', { context: {
      workspaceId: otherProject.workspace!, displayName: otherProject.name, branch: '', terminals: []
    } })
    assert.ok(view.find({ text: '启动队伍' })?.disabled)
    previous.resolve(running)
    await Promise.all([refresh, switched])
    await view.settled()
    assert.ok(view.find({ text: otherProject.path! }))
    assert.equal(view.find({ text: running.path! }), null)
    assert.equal(view.find({ text: '旧项目的输出' }), null)
    assert.equal(view.find({ label: '编辑队伍' }), null)
    // This kit dispatches workspace events but does not send native live-switch hydration.
    // Assert preservation here; separate seeded remounts exercise actual scoped persisted values.
    assert.deepEqual(view.persisted.workspace, {
      'task.goal': '旧项目的请求', 'task.acceptance': '旧项目的验收', 'task.instructions': '旧项目的长期约定'
    })
  } finally { previous.resolve(running); await view.unmount() }
})

test('successful refresh clears only the stale refresh error', async () => {
  let failRefresh = false
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => {
      if (failRefresh) throw new Error('快照暂不可用')
      return running
    },
    'flow.detail': () => { throw new Error('输出暂不可用') }
  } }) })
  try {
    await view.press({ text: '查看实现' })
    failRefresh = true
    await view.press({ label: '刷新状态' })
    assert.ok(view.find({ text: /快照暂不可用/ }))
    assert.ok(view.find({ text: /输出暂不可用/ }))
    failRefresh = false
    await view.press({ label: '刷新状态' })
    assert.equal(view.find({ text: /快照暂不可用/ }), null)
    assert.ok(view.find({ text: /输出暂不可用/ }))
    assert.ok(view.find({ text: '运行流程' }))
  } finally { await view.unmount() }
})

test('workspace-native task seeds and actual edits survive close and remount without crossing workspace profiles', async () => {
  let savedA: Record<string, unknown> = {}
  let savedB: Record<string, unknown> = {}
  const first = await mount(panel, {
    persisted: { workspace: workspaceTask }, host: mockHost({ requests: { 'flow.snapshot': ready } })
  })
  try {
    assert.equal(first.valueOf({ label: '任务需求' }), workspaceTask['task.goal'])
    assert.equal(first.valueOf({ label: '验收标准（选填）' }), workspaceTask['task.acceptance'])
    assert.equal(first.valueOf({ label: '工作区长期说明' }), workspaceTask['task.instructions'])
    assert.ok(first.find({ text: `任务范围：${ready.name} · ${ready.path}` }))
    await first.type({ label: '任务需求' }, '工作区 A 的后续任务', { replace: true })
    await first.type({ label: '验收标准（选填）' }, '工作区 A 的新验收', { replace: true })
    await first.type({ label: '工作区长期说明' }, '工作区 A 的新约定', { replace: true })
    savedA = first.persisted.workspace
    assert.deepEqual(savedA, {
      'task.goal': '工作区 A 的后续任务', 'task.acceptance': '工作区 A 的新验收', 'task.instructions': '工作区 A 的新约定'
    })
    assert.deepEqual(first.persisted.plugin, {})
    assert.deepEqual(first.persisted.storage, {})
  } finally { await first.unmount() }

  const second = await mount(panel, {
    persisted: { workspace: otherWorkspaceTask }, host: mockHost({ requests: { 'flow.snapshot': otherProject } })
  })
  try {
    assert.equal(second.valueOf({ label: '任务需求' }), otherWorkspaceTask['task.goal'])
    assert.equal(second.valueOf({ label: '验收标准（选填）' }), otherWorkspaceTask['task.acceptance'])
    assert.equal(second.valueOf({ label: '工作区长期说明' }), otherWorkspaceTask['task.instructions'])
    assert.ok(second.find({ text: `任务范围：${otherProject.name} · ${otherProject.path}` }))
    await second.type({ label: '任务需求' }, '工作区 B 的后续任务', { replace: true })
    savedB = second.persisted.workspace
    assert.deepEqual(savedB, { ...otherWorkspaceTask, 'task.goal': '工作区 B 的后续任务' })
    assert.deepEqual(second.persisted.plugin, {})
    assert.deepEqual(second.persisted.storage, {})
  } finally { await second.unmount() }

  for (const [snapshot, persisted] of [[ready, savedA], [otherProject, savedB]] as const) {
    const reopened = await mount(panel, { persisted: { workspace: persisted }, host: mockHost({ requests: { 'flow.snapshot': snapshot } }) })
    try {
      assert.equal(reopened.valueOf({ label: '任务需求' }), persisted['task.goal'])
      assert.equal(reopened.valueOf({ label: '验收标准（选填）' }), persisted['task.acceptance'])
      assert.equal(reopened.valueOf({ label: '工作区长期说明' }), persisted['task.instructions'])
      assert.deepEqual(reopened.persisted.workspace, persisted)
      assert.deepEqual(reopened.errors, [])
    } finally { await reopened.unmount() }
  }
})

test('explicit task clearing persists only empty goal and acceptance while preserving workspace guidance', async () => {
  const view = await mount(panel, {
    persisted: { workspace: workspaceTask }, host: mockHost({ requests: { 'flow.snapshot': ready } })
  })
  let persisted: Record<string, unknown> = {}
  try {
    await view.press({ text: '清空本次任务' })
    persisted = view.persisted.workspace
    assert.deepEqual(persisted, { ...workspaceTask, 'task.goal': '', 'task.acceptance': '' })
    assert.equal(view.valueOf({ label: '任务需求' }), '')
    assert.equal(view.valueOf({ label: '验收标准（选填）' }), '')
    assert.equal(view.valueOf({ label: '工作区长期说明' }), workspaceTask['task.instructions'])
    assert.ok(view.find({ text: '启动队伍' })?.disabled)
  } finally { await view.unmount() }
  const reopened = await mount(panel, { persisted: { workspace: persisted }, host: mockHost({ requests: { 'flow.snapshot': ready } }) })
  try {
    assert.deepEqual(reopened.persisted.workspace, persisted)
    assert.equal(reopened.valueOf({ label: '任务需求' }), '')
    assert.equal(reopened.valueOf({ label: '验收标准（选填）' }), '')
    assert.equal(reopened.valueOf({ label: '工作区长期说明' }), workspaceTask['task.instructions'])
  } finally { await reopened.unmount() }
})

test('refreshed run snapshots never replace the workspace task, acceptance or long-term guidance', async () => {
  let snapshot = running
  const view = await mount(panel, {
    persisted: { workspace: workspaceTask }, host: mockHost({ requests: { 'flow.snapshot': () => snapshot } })
  })
  try {
    await view.type({ label: '任务需求' }, '未启动的下一次任务', { replace: true })
    await view.type({ label: '验收标准（选填）' }, '下一次任务的验收', { replace: true })
    await view.type({ label: '工作区长期说明' }, '修改后仅用于下一次的约定', { replace: true })
    snapshot = { ...running, run: { ...running.run!, goal: '外部运行的任务', acceptance: '外部验收', instructions: '外部运行的约定' } }
    await view.press({ label: '刷新状态' })
    assert.deepEqual(view.persisted.workspace, {
      'task.goal': '未启动的下一次任务', 'task.acceptance': '下一次任务的验收', 'task.instructions': '修改后仅用于下一次的约定'
    })
    assert.equal(view.valueOf({ label: '任务需求' }), '未启动的下一次任务')
    assert.equal(view.valueOf({ label: '验收标准（选填）' }), '下一次任务的验收')
    assert.equal(view.valueOf({ label: '工作区长期说明' }), '修改后仅用于下一次的约定')
    assert.ok(view.find({ text: '本次长期说明：外部运行的约定' }))
  } finally { await view.unmount() }
})

test('a stale launch callback cannot overwrite the active workspace profile after switching and reopening', async () => {
  const started = deferred<void>()
  const response = deferred<Run>()
  let snapshot = ready
  const previous = await mount(panel, {
    persisted: { workspace: workspaceTask }, host: mockHost({ requests: {
      'flow.snapshot': () => snapshot,
      'flow.start': () => { started.resolve(); return response.promise }
    } })
  })
  const launch = previous.press({ text: '启动队伍' })
  await started.promise
  snapshot = otherProject
  const switching = previous.emit('workspace.changed', { context: {
    workspaceId: otherProject.workspace!, displayName: otherProject.name, branch: '', terminals: []
  } })
  await previous.unmount()
  const current = await mount(panel, {
    persisted: { workspace: otherWorkspaceTask }, host: mockHost({ requests: { 'flow.snapshot': otherProject } })
  })
  try {
    await current.type({ label: '任务需求' }, '当前工作区的新任务', { replace: true })
    await current.type({ label: '工作区长期说明' }, '当前工作区的新约定', { replace: true })
    response.resolve(running.run!)
    await Promise.all([launch, switching])
    await current.settled()
    assert.deepEqual(current.persisted.workspace, {
      ...otherWorkspaceTask, 'task.goal': '当前工作区的新任务', 'task.instructions': '当前工作区的新约定'
    })
    assert.equal(current.valueOf({ label: '任务需求' }), '当前工作区的新任务')
    assert.equal(current.valueOf({ label: '验收标准（选填）' }), otherWorkspaceTask['task.acceptance'])
    assert.equal(current.valueOf({ label: '工作区长期说明' }), '当前工作区的新约定')
    assert.equal(current.find({ text: '运行流程' }), null)
    assert.equal(current.find({ text: /已受理启动请求/ }), null)
    assert.deepEqual(current.errors, [])
  } finally {
    response.resolve(running.run!)
    await Promise.all([launch, switching])
    await current.unmount()
  }
})

test('changing either Agent explicitly clears its old model and requires model reselection', async () => {
  let saved = modelConfigured.team
  const queried: string[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...modelConfigured, agents: [...modelConfigured.agents, { id: 'pi', name: 'Pi' }], team: saved }),
    'flow.models': (input) => { queried.push(input.agent); return mockModels(input) },
    'flow.save': (team) => { saved = team; return team }
  } }) })
  try {
    await view.press({ text: '队伍设置' })
    assert.equal(view.valueOf({ label: '主脑模型' }), 'model:claude-sonnet-4-5')
    assert.equal(view.valueOf({ label: '成员 1 · 模型' }), 'model:gpt-5.1-codex')
    await view.select({ label: '主脑模型' }, 'custom')
    await view.select({ label: '成员 1 · 模型' }, 'custom')
    assert.equal(view.valueOf({ label: '主脑 · 自定义模型 ID' }), 'claude-sonnet-4-5')
    assert.equal(view.valueOf({ label: '成员 1 · 自定义模型 ID' }), 'gpt-5.1-codex')
    await view.select({ label: '主脑 Agent（CLI 终端）' }, 'opencode')
    assert.equal(view.valueOf({ label: '主脑模型' }), 'default')
    assert.equal(view.find({ label: '主脑 · 自定义模型 ID' }), null)
    assert.equal(view.valueOf({ label: '成员 1 · 自定义模型 ID' }), 'gpt-5.1-codex')
    assert.ok(view.find({ text: /已清空原模型.*思考强度.*重新选择/ }))
    await view.select({ label: '成员 1 · Agent' }, 'pi')
    assert.equal(view.valueOf({ label: '成员 1 · 模型' }), 'default')
    assert.equal(view.find({ label: '成员 1 · 自定义模型 ID' }), null)
    assert.ok(optionsOf(view, '成员 1 · 模型').some(({ value }) => value === 'model:fixture/alternate'))
    await view.select({ label: '成员 1 · Agent' }, 'claude')
    assert.equal(view.valueOf({ label: '成员 1 · 模型' }), 'default')
    assert.deepEqual(queried, ['claude', 'codex', 'opencode', 'pi'])
    await view.select({ label: '主脑模型' }, 'model:openai/gpt-5.1-codex')
    await view.select({ label: '成员 1 · 模型' }, 'model:claude-sonnet-4-5')
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadModel, 'openai/gpt-5.1-codex')
    assert.equal(saved.members[0].model, 'claude-sonnet-4-5')
    assert.equal(saved.members[1].model, 'openai/gpt-5.1-codex')
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('unsupported Agent model fields explain the limitation and allow clearing invalid stored selections', async () => {
  let saved: Team = {
    ...ready.team, lead: 'codebuddy', leadModel: 'claude-sonnet-4-5',
    members: ready.team.members.map((member, index) => index === 0 ? { ...member, agent: 'codebuddy', model: 'gpt-5.1-codex' } : member)
  }
  const queried: string[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...ready, team: saved }),
    'flow.models': (input) => { queried.push(input.agent); return mockModels(input) },
    'flow.save': (team) => { saved = team; return team }
  } }) })
  try {
    await view.press({ text: '队伍设置' })
    assert.ok(view.find({ label: '主脑模型' })?.disabled)
    assert.ok(view.find({ label: '成员 1 · 模型' })?.disabled)
    for (const label of ['主脑模型', '成员 1 · 模型']) {
      assert.equal(view.find({ label })?.props.value, 'default')
      assert.deepEqual(optionsOf(view, label), [{ value: 'default', label: '沿用 Agent 默认（不指定模型）' }])
    }
    assert.ok(view.find({ text: '主脑模型 · 已保存（不受支持）：claude-sonnet-4-5' }))
    assert.ok(view.find({ text: '成员 1 · 模型 · 已保存（不受支持）：gpt-5.1-codex' }))
    assert.deepEqual(queried, ['opencode'])
    assert.ok(view.find({ text: /未确认此主脑 Agent 支持指定模型/ }))
    assert.ok(view.find({ text: /未确认此成员 Agent 支持指定模型/ }))
    assert.ok(view.find({ text: '保存队伍' })?.disabled)
    await view.press({ text: '清空主脑模型' })
    assert.equal(view.find({ label: '主脑模型' })?.props.value, 'default')
    assert.equal(view.find({ text: '主脑模型 · 已保存（不受支持）：claude-sonnet-4-5' }), null)
    assert.ok(view.find({ text: '保存队伍' })?.disabled)
    await view.press({ text: '清空成员 1 模型' })
    assert.equal(view.find({ label: '成员 1 · 模型' })?.props.value, 'default')
    assert.equal(view.find({ text: '成员 1 · 模型 · 已保存（不受支持）：gpt-5.1-codex' }), null)
    assert.equal(view.find({ text: '保存队伍' })?.disabled, false)
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadModel, undefined)
    assert.equal(saved.members[0].model, undefined)
    assert.ok(view.find({ text: '主脑 · CodeBuddy · 沿用 Agent 默认（具体模型未知）' }))
    assert.ok(view.find({ text: /宿主未公开具体默认模型或运行时实际生效模型/ }))
    assert.equal(view.host.callsOf('flow.start').length, 0)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('oversized persisted guidance blocks launch without discarding the actual workspace value', async () => {
  const persisted = { ...workspaceTask, 'task.instructions': '约'.repeat(maxTaskLength + 1) }
  const view = await mount(panel, { persisted: { workspace: persisted }, host: mockHost({ requests: { 'flow.snapshot': ready } }) })
  try {
    assert.ok(view.find({ text: `工作区长期说明不能超过 ${maxTaskLength} 字。` }))
    assert.ok(view.find({ text: '启动队伍' })?.disabled)
    assert.equal(view.find({ label: '工作区长期说明' })?.props.maxLength, maxTaskLength)
    assert.equal(view.persisted.workspace['task.instructions'], persisted['task.instructions'])
    assert.equal(view.host.callsOf('flow.start').length, 0)
  } finally { await view.unmount() }
})
test('default stays available during catalog loading and saved model survives failed and changed refreshes', async () => {
  const lead = { label: '主脑模型' }
  const member = { label: '成员 1 · 模型' }
  const pending = deferred<ModelCatalog>()
  const requested = deferred<void>()
  let saved: Team = { ...modelConfigured.team, members: modelConfigured.team.members.map((row) => ({ ...row, agent: 'claude' })) }
  const initial = mockModels({ agent: 'claude' })
  const queries: PluginRequestInput<'flow.models'>[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...modelConfigured, team: saved }),
    'flow.models': (input) => {
      queries.push(input)
      if (queries.length === 1) { requested.resolve(); return pending.promise }
      if (queries.length === 2) throw new Error('目录暂时不可用')
      return { ...initial, models: initial.models.filter(({ id }) => id !== modelConfigured.team.leadModel) }
    },
    'flow.save': (team) => { saved = team; return team }
  } }) })
  const opening = view.press({ text: '队伍设置' })
  try {
    await requested.promise
    const redrawing = view.rerender()
    assert.ok(view.find({ text: 'Claude · 正在加载模型列表…' }))
    assert.equal(view.find(member)?.disabled, false)
    assert.ok(optionsOf(view, lead.label).some(({ label }) => label === '已保存或自定义（未列出）· claude-sonnet-4-5'))
    const selectingDefault = view.select(member, 'default')
    pending.resolve(initial)
    await Promise.all([opening, selectingDefault, redrawing])
    assert.equal(view.valueOf(member), 'default')
    assert.equal(view.valueOf(lead), 'model:claude-sonnet-4-5')
    assert.equal(queries.length, 1)
    await view.press({ text: '刷新模型列表' })
    assert.ok(view.find({ text: /模型列表加载失败：.*目录暂时不可用/ }))
    assert.ok(view.find({ text: 'Claude · 上次列表来源：测试夹具（非实时目录）' }))
    assert.equal(view.valueOf(lead), 'model:claude-sonnet-4-5')
    await view.press({ text: '刷新模型列表' })
    assert.equal(view.find({ text: /模型列表加载失败/ }), null)
    assert.equal(view.valueOf(lead), 'model:claude-sonnet-4-5')
    assert.ok(optionsOf(view, lead.label).some(({ value, label }) => value === 'model:claude-sonnet-4-5' && label.includes('未列出')))
    assert.ok(optionsOf(view, lead.label).some(({ value }) => value === 'model:claude-opus-4-1'))
    const scope = { workspace: modelConfigured.workspace, agent: 'claude' }
    assert.deepEqual(queries, [scope, { ...scope, refresh: true }, { ...scope, refresh: true }])
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadModel, 'claude-sonnet-4-5')
    assert.equal(saved.members[0].model, undefined)
    assert.equal(saved.members[1].model, 'openai/gpt-5.1-codex')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { pending.resolve(initial); await opening; await view.unmount() }
})

test('late former-workspace catalog cannot replace the active workspace model choices', async () => {
  const requested = deferred<void>()
  const pending = deferred<ModelCatalog>()
  const oldCatalog = { agent: 'claude', models: [{ id: 'fixture/old', name: '旧工作区测试模型' }], source: '旧工作区测试夹具' }
  const newCatalog = { agent: 'claude', models: [{ id: 'fixture/new', name: '当前工作区测试模型' }], source: '当前工作区测试夹具' }
  let active = ready
  const queries: PluginRequestInput<'flow.models'>[] = []
  const previous = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => active,
    'flow.models': (input) => {
      queries.push(input)
      if (input.agent === 'claude') { requested.resolve(); return pending.promise }
      return mockModels(input)
    }
  } }) })
  const opening = previous.press({ text: '队伍设置' })
  await requested.promise
  active = otherProject
  const switching = previous.emit('workspace.changed', { context: {
    workspaceId: otherProject.workspace!, displayName: otherProject.name, branch: '', terminals: []
  } })
  await previous.unmount()
  const current = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': otherProject,
    'flow.models': (input) => { queries.push(input); return input.agent === 'claude' ? newCatalog : mockModels(input) }
  } }) })
  try {
    await current.press({ text: '队伍设置' })
    await current.select({ label: '主脑模型' }, 'model:fixture/new')
    const options = optionsOf(current, '主脑模型')
    pending.resolve(oldCatalog)
    await Promise.all([opening, switching])
    await current.settled()
    assert.deepEqual(optionsOf(current, '主脑模型'), options)
    assert.ok(!options.some(({ value }) => value === 'model:fixture/old'))
    assert.equal(current.valueOf({ label: '主脑模型' }), 'model:fixture/new')
    assert.ok(current.find({ text: 'Claude · 模型列表来源：当前工作区测试夹具' }))
    assert.deepEqual(queries.filter(({ agent }) => agent === 'claude'), [
      { workspace: ready.workspace, agent: 'claude' }, { workspace: otherProject.workspace, agent: 'claude' }
    ])
    assert.deepEqual(current.errors, [])
    assert.deepEqual(current.warnings, [])
    assert.deepEqual(current.refusals, [])
  } finally { pending.resolve(oldCatalog); await Promise.all([opening, switching]); await current.unmount() }
})

test('custom unlisted model round-trips and default can clear it', async () => {
  const lead = { label: '主脑模型' }
  const custom = { label: '主脑 · 自定义模型 ID' }
  let saved = ready.team
  const lookups: string[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...ready, team: saved }),
    'flow.models': (input) => { lookups.push(input.agent); return mockModels(input) },
    'flow.save': (team) => { saved = team; return team }
  } }) })
  try {
    await view.press({ text: '队伍设置' })
    assert.equal(view.valueOf(lead), 'default')
    assert.equal(view.find(custom), null)
    await view.select(lead, 'custom')
    await view.type(custom, 'model:fixture/off-menu')
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadModel, 'model:fixture/off-menu')
    await view.press({ text: '队伍设置' })
    assert.deepEqual(lookups, ['claude', 'codex', 'opencode', 'claude', 'codex', 'opencode'])
    assert.equal(view.valueOf(lead), 'model:model:fixture/off-menu')
    assert.ok(optionsOf(view, lead.label).some(({ value, label }) => value === 'model:model:fixture/off-menu' && label.includes('未列出')))
    assert.equal(view.find(custom), null)
    await view.select(lead, 'custom')
    assert.equal(view.valueOf(custom), 'model:fixture/off-menu')
    await view.select(lead, 'default')
    assert.equal(view.find(custom), null)
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadModel, undefined)
    assert.ok(view.find({ text: '主脑 · Claude · 沿用 Agent 默认（具体模型未知）' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('large catalogs stay within native Select limits and name filtering can select the final model', async () => {
  let saved = ready.team
  const models = Array.from({ length: 601 }, (_, index) => ({ id: `provider/model-${index}`, name: `目录模型 ${index}` }))
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...ready, team: saved }),
    'flow.models': (input) => input.agent === 'codex' ? { agent: 'codex', models, source: '测试目录，非实时可用性数据' } : mockModels(input),
    'flow.save': (team) => { saved = team; return team }
  } }) })
  try {
    await view.press({ text: '队伍设置' })
    assert.ok(optionsOf(view, '成员 1 · 模型').length <= 500)
    const search = { label: 'Codex · 搜索模型名称或 ID' }
    await view.type(search, '目录模型 600', { replace: true })
    assert.ok(optionsOf(view, '成员 1 · 模型').some(({ value }) => value === 'model:provider/model-600'))
    await view.select({ label: '成员 1 · 模型' }, 'model:provider/model-600')
    await view.type(search, '', { replace: true })
    assert.equal(optionsOf(view, '成员 1 · 模型').length, 500)
    assert.equal(view.valueOf({ label: '成员 1 · 模型' }), 'model:provider/model-600')
    await view.press({ text: '保存队伍' })
    assert.equal(saved.members[0].model, 'provider/model-600')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('synthetic effort metadata keeps shared-Agent roles independent and freezes the launched team', async () => {
  let saved: Team = { ...ready.team, lead: 'codex', leadModel: 'fixture/reasoning', members: ready.team.members.map((row) => ({ ...row, agent: 'codex', model: 'fixture/reasoning' })) }
  let run: Run | null = null
  const starts: PluginRequestInput<'flow.start'>[] = []
  const catalog: ModelCatalog = { agent: 'codex', source: '合成测试夹具，非实时能力', models: [
    { id: 'fixture/reasoning', name: '合成推理模型', efforts: ['low', 'high', 'future-level'], defaultEffort: 'high' },
    { id: 'fixture/plain', name: '合成非推理模型', efforts: [] }
  ] }
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...ready, team: saved, run, canStart: !run }),
    'flow.models': (input) => input.agent === 'codex' ? catalog : mockModels(input),
    'flow.save': (team) => { saved = team; return team },
    'flow.start': (input) => {
      starts.push(input)
      run = { ...running.run!, team: input.team, goal: input.goal }
      return run
    }
  } }) })
  try {
    await view.press({ text: '队伍设置' })
    assert.equal(view.valueOf({ label: '主脑思考强度' }), 'default')
    assert.ok(optionsOf(view, '主脑思考强度')[0].label.includes('实际级别未知'))
    await view.select({ label: '主脑思考强度' }, 'effort:future-level')
    await view.select({ label: '成员 1 · 思考强度' }, 'effort:low')
    assert.equal(view.valueOf({ label: '主脑思考强度' }), 'effort:future-level')
    assert.equal(view.valueOf({ label: '成员 2 · 思考强度' }), 'default')
    await view.press({ text: '刷新模型列表' })
    assert.equal(view.valueOf({ label: '主脑思考强度' }), 'effort:future-level')
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadEffort, 'future-level')
    assert.equal(saved.members[0].effort, 'low')
    await view.type({ label: '任务需求' }, '合成强度测试', { replace: true })
    await view.press({ text: '启动队伍' })
    assert.equal(starts[0].team.leadEffort, 'future-level')
    assert.equal(starts[0].team.members[0].effort, 'low')
    await view.press({ text: '队伍设置' })
    await view.select({ label: '主脑模型' }, 'model:fixture/plain')
    assert.equal(view.find({ label: '主脑思考强度' })?.props.value, 'default')
    assert.ok(view.find({ label: '主脑思考强度' })?.disabled)
    await view.select({ label: '成员 1 · Agent' }, 'opencode')
    assert.equal(view.find({ label: '成员 1 · 思考强度' })?.props.value, 'default')
    assert.ok(view.find({ label: '成员 1 · 思考强度' })?.disabled)
    await view.select({ label: '成员 2 · 模型' }, 'default')
    assert.ok(view.find({ label: '成员 2 · 思考强度' })?.disabled)
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadEffort, undefined)
    assert.equal(saved.members[0].effort, undefined)
    assert.equal(run!.team.leadEffort, 'future-level')
    assert.equal(run!.team.members[0].effort, 'low')
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('unknown effort metadata supports explicit raw input and changed catalogs preserve invalid saved effort until cleared', async () => {
  let saved: Team = { ...ready.team, lead: 'codex', leadModel: 'fixture/unknown', leadEffort: 'future-level' }
  let refresh = 0
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...ready, team: saved }),
    'flow.models': (input) => {
      if (input.agent !== 'codex') return mockModels(input)
      if (input.refresh && ++refresh === 1) throw new Error('合成目录失败')
      return { agent: 'codex', source: '合成测试夹具', models: [{ id: 'fixture/unknown', name: '合成未知模型', ...(refresh > 1 ? { efforts: [] } : {}) }] }
    },
    'flow.save': (team) => { saved = team; return team }
  } }) })
  try {
    await view.press({ text: '队伍设置' })
    assert.ok(view.find({ text: /高级自定义原始值须由宿主校验/ }))
    const raw = { label: '主脑思考强度 · 自定义原始值' }
    await view.type(raw, '', { replace: true })
    assert.equal(view.valueOf(raw), '', 'Clearing an existing custom effort must keep its input mounted')
    await view.type(raw, 'ultra', { replace: true })
    assert.equal(view.valueOf({ label: '主脑思考强度' }), 'effort:ultra')
    await view.press({ text: '刷新模型列表' })
    assert.equal(view.valueOf({ label: '主脑思考强度' }), 'effort:ultra')
    await view.press({ text: '刷新模型列表' })
    assert.equal(view.find({ label: '主脑思考强度' })?.props.value, 'effort:ultra')
    assert.ok(view.find({ label: '主脑思考强度' })?.disabled)
    assert.ok(view.find({ text: '保存队伍' })?.disabled)
    await view.press({ text: '清空主脑思考强度' })
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadEffort, undefined)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('canceling effort edits discards the draft and reopening loads only saved settings', async () => {
  let saved: Team = { ...ready.team, lead: 'codex', leadModel: 'fixture/model', leadEffort: 'low' }
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => ({ ...ready, team: saved }),
    'flow.models': (input) => input.agent === 'codex'
      ? { agent: 'codex', source: '合成测试夹具', models: [{ id: 'fixture/model', name: '合成模型', efforts: ['low', 'high'] }] }
      : mockModels(input),
    'flow.save': (team) => { saved = team; return team }
  } }) })
  try {
    await view.press({ text: '队伍设置' })
    await view.select({ label: '主脑思考强度' }, 'effort:high')
    await view.press({ text: '取消编辑' })
    await view.press({ text: '队伍设置' })
    assert.equal(view.valueOf({ label: '主脑思考强度' }), 'effort:low')
    assert.equal(saved.leadEffort, 'low')
    await view.select({ label: '主脑思考强度' }, 'effort:high')
    await view.press({ text: '保存队伍' })
    assert.equal(saved.leadEffort, 'high')
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('planning never exposes execution approval and unknown delivery cannot repeat approval or launch', async () => {
  for (const snapshot of [planning, deliveryUnknown]) {
    let approvals = 0
    const view = await mount(panel, { host: mockHost({ requests: {
      'flow.snapshot': snapshot,
      'flow.approve': () => { ++approvals; throw new Error('An unconfirmed workflow requested approval') }
    } }) })
    try {
      assert.ok(!view.find({ text: '确认计划并执行' }) || view.find({ text: '确认计划并执行' })?.disabled)
      assert.ok(view.find({ text: '启动队伍' })?.disabled)
      assert.equal(approvals, 0)
      if (snapshot === deliveryUnknown) assert.ok(view.find({ text: /送达未核实，先检查主脑/ }))
    } finally { await view.unmount() }
  }
})

test('approval submits only the displayed revision and revision feedback retains the current run boundary', async () => {
  let snapshot = planReview
  let approvals = 0
  let revisions = 0
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => snapshot,
    'flow.approve': (input) => {
      ++approvals
      assert.deepEqual(input, { workspace: planReview.workspace, runId: planReview.run!.id, revision: 2 })
      snapshot = { ...planReview, run: { ...planReview.run!, workflow: { ...planReview.run!.workflow!, phase: 'executing' } } }
      return snapshot.run!
    },
    'flow.revise': (input) => {
      ++revisions
      assert.deepEqual(input, { workspace: planReview.workspace, runId: planReview.run!.id, revision: 2, feedback: '补充边界风险' })
      snapshot = planning
      return snapshot.run!
    }
  } }) })
  try {
    assert.ok(view.find({ text: '要求修改计划' })?.disabled)
    await view.type({ label: '允许修改的项目相对路径（每行一条）' }, 'docs', { replace: true })
    await view.type({ label: '计划修改反馈' }, '补充边界风险')
    await view.press({ text: '要求修改计划' })
    assert.equal(revisions, 1)
    snapshot = planReview
    await view.press({ label: '刷新状态' })
    await view.press({ text: '确认计划并执行' })
    assert.equal(approvals, 1)
    assert.equal(view.find({ text: '确认计划并执行' }), null)
  } finally { await view.unmount() }
})

test('a blocked planner without a plan can receive clarification without execution approval', async () => {
  let snapshot: Snapshot = { ...planning, run: { ...planning.run!, workflow: { ...planning.run!.workflow!,
    phase: 'blocked', issue: '需要说明错误提示位置。' } } }
  let received: unknown
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => snapshot,
    'flow.revise': (input) => { received = input; snapshot = planning; return snapshot.run! }
  } }) })
  try {
    assert.equal(view.find({ text: '确认计划并执行' }), null)
    await view.type({ label: '计划修改反馈' }, '使用表单顶部的既有错误区域。')
    await view.press({ text: '要求修改计划' })
    assert.deepEqual(received, { workspace: planning.workspace, runId: planning.run!.id, revision: 0,
      feedback: '使用表单顶部的既有错误区域。' })
    assert.ok(view.find({ text: '只读规划中' }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('a late approval receipt cannot replace the newly selected workspace', async () => {
  const started = deferred<void>()
  const response = deferred<Run>()
  let snapshot = planReview
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': () => snapshot,
    'flow.approve': () => { started.resolve(); return response.promise }
  } }) })
  const approval = view.press({ text: '确认计划并执行' })
  await started.promise
  try {
    snapshot = otherProject
    const switching = view.emit('workspace.changed', { context: { workspaceId: otherProject.workspace!, displayName: otherProject.name, branch: '', terminals: [] } })
    response.resolve(planReview.run!)
    await Promise.all([approval, switching])
    await view.settled()
    assert.equal(view.find({ text: '运行流程' }), null)
    assert.ok(view.find({ text: otherProject.path! }))
    assert.deepEqual(view.errors, [])
  } finally { response.resolve(planReview.run!); await approval; await view.unmount() }
})

test('ending a run asks for confirmation before calling flow.abandon', async () => {
  let calls: PluginRequestInput<'flow.abandon'>[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': running,
    'flow.abandon': (input) => { calls.push(input); return { ...running.run!, status: 'failed' } }
  } }) })
  try {
    assert.equal(view.find({ text: '确认结束' }), null)
    await view.press({ text: '结束本次运行' })
    assert.ok(view.find({ text: '确认结束' }))
    assert.equal(calls.length, 0)
    await view.press({ text: '确认结束' })
    assert.deepEqual(calls, [{ workspace: running.workspace, runId: running.run!.id }])
    assert.ok(view.find({ text: '本次运行已结束。' }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('a cancelled abandon keeps the run open', async () => {
  let called = false
  const view = await mount(panel, { host: mockHost({ requests: {
    'flow.snapshot': running,
    'flow.abandon': () => { called = true; return running.run! }
  } }) })
  try {
    await view.press({ text: '结束本次运行' })
    await view.press({ text: '取消' })
    assert.equal(called, false)
    assert.ok(view.find({ text: '运行流程' }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
