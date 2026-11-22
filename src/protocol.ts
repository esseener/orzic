export const memberKinds = ['implement', 'research', 'review'] as const
export type MemberKind = typeof memberKinds[number]
export const kindLabels: Record<MemberKind, string> = { implement: '实现', research: '分析', review: '审核' }
export type Member = { id: string; name: string; agent: string; kind: MemberKind; brief: string; model?: string; effort?: string; cost?: 'cheap' | 'strong' }
export type Team = { version: 2; lead: string; leadModel?: string; leadEffort?: string; members: Member[] }
export const maxMembers = 16
export const maxTaskLength = 4000
// Explicit --model support in this Orca launch contract, not a fabricated model catalog.
const modelAgents: Record<string, true | undefined> = {
  claude: true, codex: true, cursor: true, antigravity: true, grok: true, muse: true,
  omp: true, pi: true, opencode: true
}
export function supportsModel(agent: string): boolean { return modelAgents[agent] === true }
export function modelSummary(model?: string): string {
  return model ? `指定模型：${model}` : '沿用 Agent 默认（具体模型未知）'
}
// Confirmed Orca --effort routes; OpenCode variants are not launch effort support.
export function supportsEffort(agent: string): boolean {
  return agent === 'claude' || agent === 'codex' || agent === 'omp' || agent === 'pi'
}
const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const piEfforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const noEfforts: readonly string[] = []
const effortNames: Record<string, string | undefined> = {
  off: '关闭', none: '不推理', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限'
}
export function effortLevels(agent: string, model?: ModelOption): readonly string[] {
  if (!supportsEffort(agent)) return noEfforts
  if (model?.efforts !== undefined) return model.efforts
  return agent === 'claude' ? claudeEfforts : agent === 'pi' ? piEfforts : noEfforts
}
export function effortLabel(effort: string): string {
  const name = Object.hasOwn(effortNames, effort) ? effortNames[effort] : undefined
  return name ? `${name}（${effort}）` : effort
}
export function effortSummary(effort?: string): string {
  return effort ? `指定思考强度：${effortLabel(effort)}` : '沿用 Agent 默认思考强度（具体档位未知）'
}
function normalizedSetting(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label}必须是文本。`)
  return value.trim() || undefined
}
function checkModel(agent: string, model: string | undefined, label: string): void {
  if (!model) return
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model) || model.startsWith('-')) throw new Error(`${label}的模型标识不能超过 200 字、包含控制字符或以减号开头。`)
  if (!supportsModel(agent)) throw new Error(`当前 Orca 启动契约未确认 ${agent} 支持指定模型，请清空${label}的模型设置或选择受支持的 Agent。`)
}
function checkEffort(agent: string, model: string | undefined, effort: string | undefined, label: string): void {
  if (!effort) return
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(effort)) throw new Error(`${label}的思考强度必须是 1–64 位小写英文档位标识，不能包含空格或控制字符。`)
  if (!supportsEffort(agent)) throw new Error(`当前 Orca 启动契约未确认 ${agent} 支持指定思考强度，请清空${label}的思考强度设置。`)
  if (!model) throw new Error(`请先为${label}指定模型，再选择思考强度；Orca 的 --effort 需要 --model。`)
  if ((agent === 'claude' || agent === 'pi') && !effortLevels(agent).includes(effort)) throw new Error(`${label}的思考强度不在 ${agent} 已确认的档位中。`)
}
function checkCatalogEffort(catalogs: readonly ModelCatalog[], agent: string, model: string | undefined, effort: string, label: string): void {
  const option = catalogs.find((catalog) => catalog.agent === agent)?.models.find((item) => item.id === model)
  if (option?.efforts !== undefined && !option.efforts.includes(effort)) {
    throw new Error(`${label}的模型目录未声明支持思考强度 ${effort}，请重新选择或沿用默认。`)
  }
}
export function validateEffortCatalog(team: Team, catalogs: readonly ModelCatalog[]): void {
  if (team.leadEffort) checkCatalogEffort(catalogs, team.lead, team.leadModel, team.leadEffort, '主脑')
  for (const member of team.members) {
    if (member.effort) checkCatalogEffort(catalogs, member.agent, member.model, member.effort, `「${member.name}」`)
  }
}
export const defaultTeam: Team = {
  version: 2, lead: 'claude', members: [
    { id: 'implement', name: '实现', agent: 'codex', kind: 'implement', brief: '根据任务修改代码并提供验证证据。', cost: 'cheap' },
    { id: 'review', name: '审核', agent: 'opencode', kind: 'review', brief: '只读审核改动、验收标准和验证证据。', cost: 'strong' }
  ]
}

/** Read the old fixed-role format without discarding its selected agents. */
export function migrateTeam(value: unknown): Team {
  if (value == null) return { ...defaultTeam, members: defaultTeam.members.map((member) => ({ ...member })) }
  if (typeof value !== 'object') throw new Error('队伍配置损坏，请重新设置队伍。')
  const row = value as Record<string, unknown>
  if (row.version === 2) {
    if (typeof row.lead !== 'string' || !Array.isArray(row.members)) throw new Error('队伍配置格式无效。')
    const members = row.members.map((item: unknown): Member => {
      if (!item || typeof item !== 'object') throw new Error('成员配置格式无效。')
      const member = item as Record<string, unknown>
      if (typeof member.id !== 'string' || typeof member.name !== 'string' || typeof member.agent !== 'string' ||
        !memberKinds.includes(member.kind as MemberKind) || typeof member.brief !== 'string') throw new Error('成员配置格式无效。')
      const model = normalizedSetting(member.model, '模型标识')
      const effort = normalizedSetting(member.effort, '思考强度')
      const cost = member.cost === 'cheap' || member.cost === 'strong' ? member.cost : member.cost === undefined ? undefined : (() => { throw new Error(`「${member.name}」的成本档位必须是 cheap 或 strong。`) })()
      return { id: member.id, name: member.name, agent: member.agent, kind: member.kind as MemberKind, brief: member.brief,
        ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(cost ? { cost } : {}) }
    })
    const leadModel = normalizedSetting(row.leadModel, '模型标识')
    const leadEffort = normalizedSetting(row.leadEffort, '思考强度')
    return { version: 2, lead: row.lead, ...(leadModel ? { leadModel } : {}), ...(leadEffort ? { leadEffort } : {}), members }
  }
  if (row.version !== undefined) throw new Error('队伍配置版本不受支持，请更新插件或重新设置。')
  if (typeof row.lead !== 'string' || typeof row.implement !== 'string' || typeof row.review !== 'string' ||
    (row.diagnose !== undefined && typeof row.diagnose !== 'string')) throw new Error('队伍配置格式无效。')
  const members: Member[] = [
    { id: 'implement', name: '实现', agent: row.implement, kind: 'implement', brief: defaultTeam.members[0].brief, cost: 'cheap' }
  ]
  if (row.diagnose) members.push({ id: 'diagnose', name: '排查', agent: row.diagnose as string, kind: 'research', brief: '只读调查项目，提供可核实的线索。', cost: 'cheap' })
  members.push({ id: 'review', name: '审核', agent: row.review, kind: 'review', brief: defaultTeam.members[1].brief, cost: 'strong' })
  return { version: 2, lead: row.lead, members }
}

export function validateTeam(value: unknown, agents: readonly { id: string }[], catalogs?: readonly ModelCatalog[]): Team {
  const team = migrateTeam(value)
  if (!agents.some((agent) => agent.id === team.lead)) throw new Error('请为主脑选择已安装的 Agent。')
  checkModel(team.lead, team.leadModel, '主脑')
  checkEffort(team.lead, team.leadModel, team.leadEffort, '主脑')
  if (team.members.length < 2 || team.members.length > maxMembers) throw new Error(`队伍需要 2–${maxMembers} 名成员，至少包含一名实现和一名审核。`)
  const ids = new Set<string>()
  for (const member of team.members) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(member.id) || member.id === 'lead' || ids.has(member.id)) throw new Error('成员标识无效或重复，请删除后重新添加该成员。')
    ids.add(member.id)
    member.name = member.name.trim()
    member.brief = member.brief.trim()
    if (!member.name || member.name.length > 32 || /[\r\n]/.test(member.name)) throw new Error('角色名称需要 1–32 字，且不能换行。')
    if (member.brief.length > 1000) throw new Error(`「${member.name}」的职责不能超过 1000 字。`)
    if (!agents.some((agent) => agent.id === member.agent)) throw new Error(`请为「${member.name}」选择已安装的 Agent。`)
    const label = `「${member.name}」`
    checkModel(member.agent, member.model, label)
    checkEffort(member.agent, member.model, member.effort, label)
  }
  if (!team.members.some((member) => member.kind === 'implement')) throw new Error('至少保留一名实现成员。')
  if (!team.members.some((member) => member.kind === 'review')) throw new Error('至少保留一名审核成员。')
  if (catalogs?.length) validateEffortCatalog(team, catalogs)
  return team
}

export type State = 'queued' | 'starting' | 'working' | 'waiting' | 'blocked' | 'done' | 'failed' | 'unknown'
export type RunStatus = 'starting' | 'active' | 'attention' | 'completed' | 'failed' | 'unknown'
export type Step = { memberId: string; state: State; taskId?: string; task?: string; terminal?: string; dispatch?: string; issue?: string }
export type ExecutionPolicy = {
  allowedPaths: string[]; allowNetwork: boolean; allowDependencies: boolean; allowDeletion: boolean; maxReworks: number
}
export type Plan = { revision: number; summary: string; steps: string[]; paths: string[]; checks: string[]; risks: string[] }
export type Workflow = {
  phase: 'planning' | 'review' | 'approving' | 'executing' | 'blocked'; policy: ExecutionPolicy; plan?: Plan
  approvedRevision?: number; approvedAt?: number; feedback?: string; messageId?: string
  delivery?: 'sending' | 'accepted' | 'unknown'; issue?: string
}
export type Run = {
  schemaVersion?: 2; id: string; goal: string; acceptance?: string; instructions?: string; team: Team; status: RunStatus
  path?: string; startedAt?: number; leadTerminal?: string; nativeId?: string; issue?: string
  operationId?: string; delivery?: string; taskIds?: Record<string, string>
  workspace?: string; workflow?: Workflow
}
export type Snapshot = {
  workspace: string | null; name: string; path: string | null; local: boolean
  agents: { id: string; name: string }[]; team: Team; run: Run | null; steps: Step[]
  canStart: boolean; syncedAt: number | null; issue?: string
}
export type ModelOption = { id: string; name: string; efforts?: string[]; defaultEffort?: string }
export type ModelCatalog = { agent: string; models: ModelOption[]; source: string; notice?: string }

declare module 'orca' {
  interface PluginRequests {
    'flow.snapshot': { input: {}; output: Snapshot }
    'flow.save': { input: Team; output: Team }
    'flow.models': { input: { workspace: string | null; agent: string; refresh?: boolean }; output: ModelCatalog }
    'flow.start': { input: { workspace: string; goal: string; acceptance: string; instructions: string; team: Team; policy?: ExecutionPolicy }; output: Run }
    'flow.fusion': { input: { workspace: string; instructions?: string; team: Team; policy?: ExecutionPolicy }; output: Run }
    'flow.propose': { input: { workspace: string; runId: string; baseRevision: number; plan: Omit<Plan, 'revision'> }; output: Run }
    'flow.approve': { input: { workspace: string; runId: string; revision: number }; output: Run }
    'flow.revise': { input: { workspace: string; runId: string; revision: number; feedback: string; policy?: ExecutionPolicy }; output: Run }
    'flow.block': { input: { workspace: string; runId: string; reason: string }; output: Run }
    'flow.abandon': { input: { workspace: string; runId: string; reason?: string }; output: Run }
    'flow.detail': { input: { workspace: string; runId: string; memberId: string }; output: { text: string; canOpen: boolean } }
    'flow.open': { input: { workspace: string; runId: string; memberId: string }; output: { opened: boolean } }
  }
  interface PluginPanelEvents { 'flow.changed': { workspace: string | null } }
}
