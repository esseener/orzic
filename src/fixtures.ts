import { defaultTeam, type ModelCatalog, type Run, type Snapshot, type Team } from './protocol'
import { defaultPolicy } from './workflow'

export const ready: Snapshot = {
  workspace: 'demo::workspace', name: '示例工作区', path: 'C:\\Projects\\orca-settings-demo', local: true,
  team: defaultTeam, run: null, steps: [], canStart: true, syncedAt: Date.now(),
  agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' },
    { id: 'codebuddy', name: 'CodeBuddy' }, { id: 'opencode', name: 'OpenCode' }]
}

const run: Run = {
  schemaVersion: 2, id: 'demo', goal: '修复设置页保存空名称时的错误提示。',
  acceptance: '空名称无法保存，并在输入框下显示错误提示。', team: ready.team,
  status: 'attention', path: ready.path!, startedAt: ready.syncedAt!, leadTerminal: 'term_lead', nativeId: 'native-demo'
}
export const running: Snapshot = {
  ...ready, run, canStart: false,
  steps: [
    { memberId: 'lead', state: 'waiting', terminal: 'term_lead' },
    { memberId: 'implement', state: 'working', task: '修正空名称校验和错误提示', terminal: 'term_code', dispatch: 'ctx_code' },
    { memberId: 'review', state: 'queued', task: '检查错误提示和回归测试' }
  ]
}

const extendedTeam: Team = {
  ...ready.team,
  members: [
    { ...ready.team.members[0], name: '前端开发', brief: '更新设置界面和表单交互。' },
    { id: 'member-api', name: '后端开发', agent: 'codex', kind: 'implement', brief: '完善设置保存接口的校验。' },
    { id: 'member-docs', name: '文档维护', agent: 'codex', kind: 'implement', brief: '更新用户指南。' },
    { id: 'member-test', name: '测试策划', agent: 'codebuddy', kind: 'research', brief: '调查覆盖缺口，提出测试建议。' },
    { ...ready.team.members[1], name: '发布审核' }
  ]
}
export const extended: Snapshot = { ...ready, team: extendedTeam }

export const unknown: Snapshot = {
  ...running, run: { ...run, status: 'unknown' }, steps: [{ memberId: 'lead', state: 'unknown', terminal: 'term_lead' }],
  syncedAt: null, issue: '暂时无法同步 Orca 任务状态。'
}

export const noProject: Snapshot = {
  ...ready, workspace: null, name: '未选择项目', path: null, local: false, canStart: false, syncedAt: null
}

export const remote: Snapshot = {
  ...ready, workspace: 'remote::workspace', name: '远程工作区', path: '/projects/remote-settings', local: false, canStart: false, syncedAt: null
}

export const otherProject: Snapshot = {
  ...ready, workspace: 'demo::other-workspace', name: '另一个本机工作区', path: 'C:\\Projects\\orca-other-demo'
}

export const workspaceTask = {
  'task.goal': '修复工作区设置的空名称校验。',
  'task.acceptance': '保留输入并展示可访问的错误提示。',
  'task.instructions': '遵循现有原生组件和测试约定；未经明确请求不执行发布。'
}

export const otherWorkspaceTask = {
  'task.goal': '补充另一个工作区的接口校验。',
  'task.acceptance': '无效输入返回明确错误。',
  'task.instructions': '此工作区只处理接口层，保持现有兼容行为。'
}

export const modelConfigured: Snapshot = {
  ...ready, team: {
    ...ready.team, leadModel: 'claude-sonnet-4-5',
    members: ready.team.members.map((member, index) => ({
      ...member, model: index === 0 ? 'gpt-5.1-codex' : 'openai/gpt-5.1-codex'
    }))
  }
}

export const modelRunning: Snapshot = {
  ...running, team: modelConfigured.team,
  run: { ...run, team: modelConfigured.team, instructions: workspaceTask['task.instructions'] }
}

// Synthetic host responses for test/check scenarios only, not live availability data.
const mockModelOptions: Record<string, ModelCatalog['models'] | undefined> = {
  claude: [{ id: 'claude-sonnet-4-5', name: '示例 Sonnet' }, { id: 'claude-opus-4-1', name: '示例 Opus' }],
  codex: [{ id: 'gpt-5.1-codex', name: '示例 Codex' }, { id: 'gpt-5-codex', name: '示例 Codex 备选' }, { id: 'custom', name: '示例标识冲突' }],
  opencode: [{ id: 'openai/gpt-5.1-codex', name: '示例 OpenCode' }],
  pi: [{ id: 'fixture/alternate', name: '示例 Pi' }]
}

export function mockModels({ agent }: { agent: string }): ModelCatalog {
  const models = mockModelOptions[agent]
  if (!models) throw new Error(`测试未为 Agent ${agent} 配置模型列表。`)
  return { agent, models, source: '测试夹具（非实时目录）', notice: '仅供界面测试，不代表实际可用模型。' }
}

export const planning: Snapshot = {
  ...running, run: { ...run, workspace: ready.workspace!, workflow: { phase: 'planning', policy: defaultPolicy } },
  steps: [{ memberId: 'lead', state: 'working', terminal: 'term_lead', task: '只读了解项目并提出计划' }]
}
export const planReview: Snapshot = {
  ...planning, run: { ...planning.run!, workflow: { phase: 'review', policy: defaultPolicy, plan: {
    revision: 2, summary: '沿用现有表单约定修复空名称校验', steps: ['检查表单与测试', '修复校验并补充回归测试', '只读审核变更'],
    paths: ['src/settings'], checks: ['运行表单回归测试'], risks: ['确认空白名称的既有兼容要求']
  } } }
}
export const deliveryUnknown: Snapshot = {
  ...planReview, run: { ...planReview.run!, workflow: { ...planReview.run!.workflow!, phase: 'blocked', delivery: 'unknown', issue: '原生授权发送未返回可核实回执。' } }
}

export const executing: Snapshot = {
  ...running,
  run: { ...run, workspace: ready.workspace!, status: 'active',
    workflow: { phase: 'executing', policy: defaultPolicy, plan: {
      revision: 1, summary: '修复空名称校验', steps: ['修复校验', '补回归测试', '只读审核'],
      paths: ['src/settings'], checks: ['回归测试'], risks: ['兼容性']
    }, delivery: 'accepted', approvedRevision: 1 } },
  steps: [
    { memberId: 'lead', state: 'done', terminal: 'term_lead' },
    { memberId: 'implement', state: 'done', task: '修复空名称校验', terminal: 'term_code', dispatch: 'ctx_code' },
    { memberId: 'review', state: 'working', task: '只读审核改动与证据' }
  ]
}
