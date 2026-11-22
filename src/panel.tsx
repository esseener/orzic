import {
  atom, Badge, Box, Button, Card, Heading, IconButton, Input, on, plugin,
  Progress, read, RelativeTime, Row, Select, set, Stack, Text, Textarea, type PanelContext
} from 'orca'
import {
  effortLabel, effortLevels, effortSummary, supportsEffort,
  kindLabels, maxMembers, maxTaskLength, memberKinds, modelSummary, supportsModel, validateTeam,
  type Member, type MemberKind, type ModelCatalog, type RunStatus, type Snapshot, type State, type Team
} from './protocol'
import { defaultPolicy, validatePolicy } from './workflow'
import type { ExecutionPolicy } from './protocol'

const policyDraft = atom<ExecutionPolicy>('task.policy', defaultPolicy, { persist: 'workspace' })
const planFeedback = atom('')
const workflowAction = atom<object | null>(null)

function policyError() {
  try { validatePolicy(read(policyDraft)); return '' } catch (error) { return message(error) }
}

const data = atom<Snapshot | null>(null)
const goal = atom('task.goal', '', { persist: 'workspace' })
const acceptance = atom('task.acceptance', '', { persist: 'workspace' })
const instructions = atom('task.instructions', '', { persist: 'workspace' })
const draft = atom<Team | null>(null)
type CatalogState = { catalog?: ModelCatalog; loading?: boolean; error?: string }
type ModelEditor = {
  session: { workspace: string | null; signal: AbortSignal }
  catalogs: ReadonlyMap<string, CatalogState>
  custom: ReadonlySet<string>
  searches: ReadonlyMap<string, string>
}
const modelEditor = atom<ModelEditor | null>(null)
const defaultModelValue = 'default'
const customModelValue = 'custom'
const modelValue = (id: string) => `model:${id}`
const busy = atom(false)
const actionError = atom('')
const refreshError = atom('')
const notice = atom('')
const selected = atom<string | null>(null)
const detail = atom<{ text: string; canOpen: boolean } | null>(null)
const detailVersion = atom(0)
const abandonConfirm = atom(false)
const abandonReason = atom('')
const controller = atom<{
  refresh: (invalidate?: boolean) => void; scope: () => number; signal: AbortSignal
} | null>(null)
const stateLabel: Record<State, string> = {
  queued: '待派发', starting: '启动中', working: '进行中', waiting: '等待输入', blocked: '需处理',
  done: '已完成', failed: '有异常', unknown: '状态未同步'
}
const runLabel: Record<RunStatus, string> = {
  starting: '启动中', active: '运行中', attention: '需要处理', completed: '已完成', failed: '有异常', unknown: '状态未同步'
}
const tone = { working: 'accent', starting: 'accent', waiting: 'warning', blocked: 'warning', failed: 'danger', done: 'success' } as const
const modeLabel: Record<MemberKind, string> = {
  implement: '实现：可写，串行', research: '分析：只读，可并行', review: '审核：只读，实现后'
}
let memberSequence = 0

function message(error: unknown) { return error instanceof Error ? error.message : String(error) }

function checkTeam(team: Team, agents: Snapshot['agents']) {
  const catalogs = [...(read(modelEditor)?.catalogs.values() ?? [])].flatMap(({ catalog }) => catalog ? [catalog] : [])
  try { return { team: validateTeam(team, agents, catalogs), error: '' } }
  catch (error) { return { team: null, error: message(error) } }
}

function resetDetail() {
  set(detailVersion, read(detailVersion) + 1)
  set(selected, null)
  set(detail, null)
}

export function setup(ctx: PanelContext) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let queued = false
  let revision = 0
  let scope = 0
  let focus: string | null | undefined

  function changeProject() {
    ++scope
    resetDetail()
    set(workflowAction, null)
    set(planFeedback, '')
    closeEditor()
    set(actionError, '')
    set(notice, '')
    set(refreshError, '')
  }

  function refresh(invalidate = false) {
    if (ctx.signal.aborted) return
    if (invalidate) ++revision
    clearTimeout(timer)
    if (inFlight) { queued = true; return }
    inFlight = true
    const version = revision
    void plugin.request('flow.snapshot', {}, { signal: ctx.signal, timeoutMs: 30_000 }).then((next) => {
      if (ctx.signal.aborted || version !== revision) return
      const previous = read(data)
      if (previous && (previous.workspace !== next.workspace || previous.path !== next.path || previous.local !== next.local)) {
        changeProject()
      } else if (previous?.run?.id !== next.run?.id) {
        resetDetail()
        set(workflowAction, null)
        set(planFeedback, '')
      }
      focus = next.workspace
      set(data, next)
      set(refreshError, '')
    }).catch((error) => {
      if (!ctx.signal.aborted && version === revision) set(refreshError, message(error))
    }).finally(() => {
      inFlight = false
      if (ctx.signal.aborted) return
      if (queued) { queued = false; refresh(); return }
      const current = read(data)
      const run = current?.run
      // Native task/run changes do not always produce worker posts. A failed sync is not a terminal status.
      if (read(refreshError) || (run ? run.status !== 'completed' && run.status !== 'failed' : current?.issue)) {
        timer = setTimeout(refresh, 5000)
      }
    })
  }

  set(controller, { refresh, scope: () => scope, signal: ctx.signal })
  ctx.subscriptions.push(on('workspace.changed', ({ context }) => {
    const workspace = context?.workspaceId ?? null
    const changed = focus !== workspace
    if (changed) {
      focus = workspace
      changeProject()
      set(data, null)
    }
    refresh(changed)
  }), plugin.on('flow.changed', ({ workspace }) => {
    if (!workspace || focus === undefined || workspace === focus) refresh()
  }))
  if (!inFlight) refresh()
  return () => clearTimeout(timer)
}

function modelAgents(team: Team) {
  return [...new Set([team.lead, ...team.members.map(({ agent }) => agent)].filter(supportsModel))]
}

function loadModels(agent: string, refresh = false) {
  const editor = read(modelEditor)
  if (!editor || editor.session.signal.aborted || !supportsModel(agent)) return
  const previous = editor.catalogs.get(agent)
  if (previous && (!refresh || previous.loading)) return
  const { session } = editor
  const { workspace, signal } = session
  function updateCatalog(entry: CatalogState) {
    if (signal.aborted) return
    const current = read(modelEditor)
    if (current?.session !== session) return
    const catalogs = new Map(current.catalogs)
    catalogs.set(agent, entry)
    set(modelEditor, { ...current, catalogs })
  }
  updateCatalog({ catalog: previous?.catalog, loading: true })
  void plugin.request('flow.models', { workspace, agent, ...(refresh ? { refresh: true } : {}) }, { signal, timeoutMs: 30_000 })
    .then((catalog) => {
      if (catalog.agent !== agent) throw new Error('返回的模型列表与请求的 Agent 不匹配。')
      updateCatalog({ catalog })
    })
    .catch((error) => updateCatalog({ catalog: previous?.catalog, error: message(error) }))
}

function openEditor() {
  const state = read(data)
  const sync = read(controller)
  if (!state || !sync || sync.signal.aborted || read(draft) || read(busy)) return
  set(actionError, '')
  set(modelEditor, { session: { workspace: state.workspace, signal: sync.signal }, catalogs: new Map<string, CatalogState>(), custom: new Set<string>(), searches: new Map<string, string>() })
  set(draft, { ...state.team, members: state.team.members.map((member) => ({ ...member })) })
  for (const agent of modelAgents(state.team)) loadModels(agent)
}

function closeEditor() {
  set(modelEditor, null)
  set(draft, null)
}

function setCustom(id: string, enabled: boolean) {
  const editor = read(modelEditor)
  if (!editor || editor.custom.has(id) === enabled) return
  const custom = new Set(editor.custom)
  if (enabled) custom.add(id)
  else custom.delete(id)
  set(modelEditor, { ...editor, custom })
}

function setModelSearch(agent: string, query: string) {
  const editor = read(modelEditor)
  if (!editor || editor.searches.get(agent) === query) return
  const searches = new Map(editor.searches)
  searches.set(agent, query)
  set(modelEditor, { ...editor, searches })
}

function setDraftModel(id: string, agent: string, model?: string) {
  const team = read(draft)
  if (!team || read(busy)) return
  if (id === 'lead') {
    if (team.lead === agent) {
      set(draft, { ...team, leadModel: model, ...(team.leadModel !== model ? { leadEffort: undefined } : {}) })
      if (team.leadModel !== model) {
        setCustom('effort:lead', false)
        set(notice, '模型已更改，已清空原思考强度；将沿用 Agent / CLI 设置，实际级别未知。')
      }
    }
  } else if (team.members.some((member) => member.id === id && member.agent === agent)) {
    const member = team.members.find((row) => row.id === id)!
    patchMember(id, { model, ...(member.model !== model ? { effort: undefined } : {}) })
    if (member.model !== model) {
      setCustom(`effort:${id}`, false)
      set(notice, '模型已更改，已清空原思考强度；将沿用 Agent / CLI 设置，实际级别未知。')
    }
  }
}

function patchMember(id: string, changes: Partial<Omit<Member, 'id'>>) {
  const team = read(draft)
  if (!team || read(busy)) return
  set(draft, { ...team, members: team.members.map((member) => member.id === id ? { ...member, ...changes } : member) })
}

function changeMemberAgent(id: string, agent: string) {
  patchMember(id, { agent, model: undefined, effort: undefined, cost: undefined })
  setCustom(id, false)
  setCustom(`effort:${id}`, false)
  loadModels(agent)
  set(notice, 'Agent 已更改，已清空原模型和思考强度；请重新选择，或沿用新 Agent / CLI 设置（实际级别未知）。')
}

function changeLeadAgent(lead: string) {
  const team = read(draft)
  if (!team || team.lead === lead || read(busy)) return
  set(draft, { ...team, lead, leadModel: undefined, leadEffort: undefined })
  setCustom('lead', false)
  setCustom('effort:lead', false)
  loadModels(lead)
  set(notice, 'Agent 已更改，已清空原模型和思考强度；请重新选择，或沿用新 Agent / CLI 设置（实际级别未知）。')
}

function taskScopeMatches(workspace: string | null | undefined, scope: number | undefined) {
  const state = read(data)
  const sync = read(controller)
  return Boolean(workspace && state?.workspace === workspace && state.local && state.path &&
    sync && !sync.signal.aborted && sync.scope() === scope && !read(busy))
}

function addMember() {
  const team = read(draft)
  const state = read(data)
  if (!team || !state || read(busy) || team.members.length >= maxMembers) return
  let id: string
  do { id = `member-${Date.now().toString(36)}-${(++memberSequence).toString(36)}` }
  while (team.members.some((member) => member.id === id) || state.run?.team.members.some((member) => member.id === id))
  const agent = state.agents.find(({ id }) => id === team.lead)?.id ?? state.agents[0]?.id ?? ''
  set(draft, { ...team, members: [...team.members, { id, name: '', agent, kind: 'research', brief: '' }] })
  loadModels(agent)
}

function removeMember(id: string) {
  const team = read(draft)
  if (!team || read(busy)) return
  set(draft, { ...team, members: team.members.filter((member) => member.id !== id) })
  setCustom(id, false)
}

async function save() {
  const team = read(draft)
  const current = read(data)
  const sync = read(controller)
  if (!team || !current || !sync || read(busy)) return
  const result = checkTeam(team, current.agents)
  if (!result.team) { set(actionError, result.error); return }
  const scope = sync.scope()
  set(busy, true)
  set(actionError, '')
  set(notice, '')
  try {
    const saved = await plugin.request('flow.save', result.team, { signal: sync.signal })
    if (sync.signal.aborted) return
    const latest = read(data)
    if (latest && sync.scope() === scope) {
      // The saved team is for the next run; never replace latest.run.team.
      set(data, { ...latest, team: saved })
      closeEditor()
      set(notice, '队伍已保存：仅保存配置，尚未执行项目。')
    }
    sync.refresh(true)
  } catch (error) {
    if (!sync.signal.aborted && sync.scope() === scope) set(actionError, message(error))
  } finally { if (!sync.signal.aborted) set(busy, false) }
}

function projectBlocker(state: Snapshot | null) {
  if (!state) return read(refreshError) ? '项目状态同步失败，暂时无法启动。' : '正在同步 Orca 项目状态，请稍候。'
  if (!state.workspace) return '未选择项目。请先在 Orca 打开目标本机项目。'
  if (!state.path) return '未能读取当前项目的完整路径，暂时无法启动。'
  if (!state.local) return '当前项目不在本机。请切换到本机项目后再启动。'
  return ''
}

function startBlocker(state: Snapshot | null, teamError: string) {
  const noProject = projectBlocker(state)
  if (noProject || !state) return noProject
  if (read(draft)) return '请先保存或取消队伍编辑，然后再启动。'
  if (read(busy)) return '正在提交，请稍候。'
  if (read(refreshError)) return '状态同步失败，暂时无法确认是否可启动。'
  if (state.run?.workflow?.delivery === 'unknown') return '计划授权送达未核实，先检查主脑，勿重复确认或启动。'
  if (state.run?.workflow && ['planning', 'review', 'approving'].includes(state.run.workflow.phase)) return '当前任务正在规划或等待计划授权，请先处理当前计划。'
  const boundaryIssue = policyError()
  if (boundaryIssue) return boundaryIssue
  if (!state.canStart) {
    const status = state.run?.status
    if (status === 'starting' || status === 'active' || status === 'attention') return '当前队伍仍在启动、运行或等待输入，请先查看会话。'
    if (status === 'unknown' || (status && state.syncedAt === null) || state.steps.some((step) => step.state === 'unknown')) {
      return '当前运行状态未同步，确认状态前不能启动新任务。'
    }
    return state.issue || 'Orca 暂未允许在此项目启动任务。'
  }
  if (teamError) return teamError
  const task = read(goal)
  const criteria = read(acceptance)
  if (!task.trim() || task.length > maxTaskLength) return `请输入 1–${maxTaskLength} 字的具体任务需求。`
  if (criteria.length > maxTaskLength) return `验收标准不能超过 ${maxTaskLength} 字。`
  if (read(instructions).length > maxTaskLength) return `工作区长期说明不能超过 ${maxTaskLength} 字。`
  return ''
}

async function start() {
  const state = read(data)
  const sync = read(controller)
  if (!state?.workspace || !sync) return
  const result = checkTeam(state.team, state.agents)
  if (startBlocker(state, result.error) || !result.team) return
  const scope = sync.scope()
  const workspace = state.workspace
  set(busy, true)
  set(actionError, '')
  set(notice, '')
  try {
    const run = await plugin.request('flow.start', {
      workspace, team: result.team, goal: read(goal).trim(), acceptance: read(acceptance).trim(), instructions: read(instructions).trim(),
      policy: validatePolicy(read(policyDraft))
    }, { signal: sync.signal, timeoutMs: 30_000 })
    if (sync.signal.aborted) return
    const latest = read(data)
    if (latest && sync.scope() === scope) {
      if (latest.run?.id !== run.id) {
        resetDetail()
        set(data, { ...latest, run, steps: [], canStart: false })
      }
      set(notice, 'Orca 已受理启动请求，正在启动并等待回执。请查看运行状态和会话输出。')
    }
    sync.refresh(true)
  } catch (error) {
    if (!sync.signal.aborted && sync.scope() === scope) {
      set(actionError, message(error))
      const latest = read(data)
      if (latest?.canStart) set(data, { ...latest, canStart: false })
    }
    // A request can fail after reaching the worker; re-read instead of inferring the run's outcome.
    sync.refresh(true)
  } finally { if (!sync.signal.aborted) set(busy, false) }
}

async function fusion() {
  const state = read(data)
  const sync = read(controller)
  if (!state?.workspace || !sync) return
  const result = checkTeam(state.team, state.agents)
  if (startBlocker(state, result.error) || !result.team) return
  const scope = sync.scope()
  const workspace = state.workspace
  set(busy, true)
  set(actionError, '')
  set(notice, '')
  try {
    const run = await plugin.request('flow.fusion', {
      workspace, team: result.team, instructions: read(instructions).trim(), policy: validatePolicy(read(policyDraft))
    }, { signal: sync.signal, timeoutMs: 30_000 })
    if (sync.signal.aborted) return
    const latest = read(data)
    if (latest && sync.scope() === scope) {
      if (latest.run?.id !== run.id) {
        resetDetail()
        set(data, { ...latest, run, steps: [], canStart: false })
      }
      set(notice, '主脑路由会话已启动，请直接在该终端里发消息；每条消息会按队伍自动判断派发。')
    }
    sync.refresh(true)
  } catch (error) {
    if (!sync.signal.aborted && sync.scope() === scope) {
      set(actionError, message(error))
      const latest = read(data)
      if (latest?.canStart) set(data, { ...latest, canStart: false })
    }
    sync.refresh(true)
  } finally { if (!sync.signal.aborted) set(busy, false) }
}

async function inspect(memberId: string) {
  const state = read(data)
  const sync = read(controller)
  if (!state?.workspace || !state.run || !sync) return
  const version = read(detailVersion) + 1
  set(detailVersion, version)
  set(selected, memberId)
  set(detail, null)
  set(actionError, '')
  try {
    const answer = await plugin.request('flow.detail', { workspace: state.workspace, runId: state.run.id, memberId }, { signal: sync.signal, timeoutMs: 30_000 })
    if (!sync.signal.aborted && version === read(detailVersion)) set(detail, answer)
  } catch (error) {
    if (!sync.signal.aborted && version === read(detailVersion)) {
      set(detail, { text: '', canOpen: false })
      set(actionError, message(error))
    }
  }
}

async function open(memberId: string) {
  const state = read(data)
  const sync = read(controller)
  if (!state?.workspace || !state.run || !sync || read(selected) !== memberId) return
  const version = read(detailVersion)
  set(actionError, '')
  try {
    const answer = await plugin.request('flow.open', { workspace: state.workspace, runId: state.run.id, memberId }, { signal: sync.signal, timeoutMs: 30_000 })
    if (!sync.signal.aborted && version === read(detailVersion) && !answer.opened) set(actionError, '该终端当前不可打开。')
  } catch (error) {
    if (!sync.signal.aborted && version === read(detailVersion)) set(actionError, message(error))
  }
}

async function submitPlan(action: 'approve' | 'revise') {
  const state = read(data)
  const sync = read(controller)
  const run = state?.run
  const workflow = run?.workflow
  if (!state?.workspace || !run || !sync || !workflow || (action === 'approve' && !workflow.plan) || read(workflowAction) ||
    workflow.delivery === 'unknown' || (workflow.phase !== 'review' && !(action === 'revise' && workflow.phase === 'blocked'))) return
  const feedback = read(planFeedback).trim()
  if (action === 'revise' && (!feedback || feedback.length > 2000)) return
  const token = {}
  const scope = sync.scope()
  const workspace = state.workspace
  const revision = workflow.plan?.revision ?? 0
  const current = () => !sync.signal.aborted && sync.scope() === scope && read(data)?.workspace === workspace &&
    read(data)?.run?.id === run.id && (read(data)?.run?.workflow?.plan?.revision ?? 0) === revision && read(workflowAction) === token
  set(workflowAction, token)
  set(actionError, '')
  set(notice, '')
  try {
    const updated = action === 'approve'
      ? await plugin.request('flow.approve', { workspace, runId: run.id, revision }, { signal: sync.signal, timeoutMs: 30_000 })
      : await plugin.request('flow.revise', { workspace, runId: run.id, revision, feedback }, { signal: sync.signal, timeoutMs: 30_000 })
    if (!current()) return
    const latest = read(data)
    if (latest) set(data, { ...latest, run: updated })
    set(planFeedback, '')
    sync.refresh(true)
  } catch (error) {
    if (!current()) return
    set(actionError, message(error))
    sync.refresh(true)
  } finally {
    if (!sync.signal.aborted && sync.scope() === scope && read(workflowAction) === token) set(workflowAction, null)
  }
}

async function abandon() {
  const state = read(data)
  const sync = read(controller)
  const run = state?.run
  if (!state?.workspace || !run || !sync || read(workflowAction) || run.status === 'completed' || run.status === 'failed') return
  const token = {}
  const scope = sync.scope()
  const workspace = state.workspace
  const current = () => !sync.signal.aborted && sync.scope() === scope && read(data)?.workspace === workspace && read(data)?.run?.id === run.id
  set(workflowAction, token)
  set(actionError, '')
  try {
    const reason = read(abandonReason).trim()
    const result = await plugin.request('flow.abandon', { workspace, runId: run.id, ...(reason ? { reason } : {}) }, { signal: sync.signal, timeoutMs: 30_000 })
    if (!current()) return
    set(abandonConfirm, false)
    set(abandonReason, '')
    set(notice, '本次运行已结束。')
    sync.refresh(true)
  } catch (error) {
    if (!current()) return
    set(actionError, message(error))
    sync.refresh(true)
  } finally {
    if (!sync.signal.aborted && sync.scope() === scope && read(workflowAction) === token) set(workflowAction, null)
  }
}

export default function Panel() {
  const state = read(data)
  const run = state?.run
  const team = state?.team
  const draftTeam = read(draft)
  const editor = read(modelEditor)
  const catalogAgents = draftTeam ? modelAgents(draftTeam) : []
  const pending = read(busy)
  const currentMember = read(selected)
  const output = read(detail)
  const syncIssue = read(refreshError)
  const actionIssue = read(actionError)
  const success = read(notice)
  const snapshotIssue = state?.issue ?? run?.issue
  const cliOptions = (state?.agents ?? []).map(({ id, name }) => ({ value: id, label: name }))
  const draftError = draftTeam && state ? checkTeam(draftTeam, state.agents).error : ''
  const teamError = team && state ? checkTeam(team, state.agents).error : ''
  const disabledReason = startBlocker(state, teamError)
  const projectIssue = projectBlocker(state)
  const agentName = (id: string) => state?.agents.find((agent) => agent.id === id)?.name ?? (id || '未配置')
  const taskWorkspace = state?.workspace
  const taskScope = read(controller)?.scope()
  const canEditTask = () => taskScopeMatches(taskWorkspace, taskScope)
  const workflow = run?.workflow
  const boundary = read(policyDraft)
  const acting = Boolean(read(workflowAction))
  const workflowCurrent = () => canEditTask() && read(data)?.run?.id === run?.id &&
    read(data)?.run?.workflow?.plan?.revision === workflow?.plan?.revision

  function modelOptionsFor(agent: string, saved?: string) {
    const modelChoices = new Map<string, string>()
    const catalog = editor?.catalogs.get(agent)?.catalog
    const allModels = catalog?.models ?? []
    const search = editor?.searches.get(agent)?.trim().toLocaleLowerCase() ?? ''
    const matchingModels = search
      ? allModels.filter(({ id, name }) => id.toLocaleLowerCase().includes(search) || name.toLocaleLowerCase().includes(search))
      : allModels
    const options = [{ value: defaultModelValue, label: '沿用 Agent 默认（不指定模型）' }]
    for (const item of matchingModels.slice(0, 497)) {
      const value = modelValue(item.id)
      if (modelChoices.has(value)) continue
      modelChoices.set(value, item.id)
      options.push({ value, label: item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id })
    }
    if (saved && !modelChoices.has(modelValue(saved))) {
      modelChoices.set(modelValue(saved), saved)
      options.push({ value: modelValue(saved), label: `已保存或自定义（未列出）· ${saved}` })
    }
    return { options, modelChoices }
  }

  function modelPicker(id: string, agent: string, model: string | undefined, label: string, customLabel: string, clearLabel: string) {
    const fallbackOptions = [{ value: defaultModelValue, label: '沿用 Agent 默认（不指定模型）' }]
    const isCurrent = () => Boolean(editor && !editor.session.signal.aborted && read(modelEditor)?.session === editor.session)
    if (!supportsModel(agent)) return <>
      <Select label={label} value={defaultModelValue} options={fallbackOptions} disabled />
      <Text size="xs" tone="warning">{`当前 Orca 启动契约未确认此${id === 'lead' ? '主脑' : '成员'} Agent 支持指定模型；只能沿用默认。`}</Text>
      {model && <>
        <Text size="xs" tone="warning">{`${label} · 已保存（不受支持）：${model}`}</Text>
        <Button size="xs" variant="ghost" disabled={pending} onPress={() => {
          if (isCurrent()) setDraftModel(id, agent)
        }}>{clearLabel}</Button>
      </>}
    </>

    const { options, modelChoices } = modelOptionsFor(agent, model)
    options.push({ value: customModelValue, label: '自定义模型 ID（高级）' })
    const custom = editor?.custom.has(id)
    return <>
      <Select label={label} value={custom ? customModelValue : model ? modelValue(model) : defaultModelValue}
        options={options} disabled={pending} onChange={(value) => {
          if (!isCurrent() || read(busy)) return
          if (value === customModelValue) { setCustom(id, true); return }
          if (value !== defaultModelValue && !modelChoices.has(value)) return
          setCustom(id, false)
          setDraftModel(id, agent, modelChoices.get(value))
        }} />
      {custom && <Input label={customLabel} value={model ?? ''} maxLength={200} placeholder="输入自定义模型 ID" disabled={pending}
        onChange={(value) => { if (isCurrent()) setDraftModel(id, agent, value) }} />}
    </>
  }

  function costPicker(member: Member, index: number) {
    const cost = member.cost
    return <>
      <Select label={`成员 ${index + 1} · 成本档位`} value={cost ?? 'standard'} disabled={pending}
        options={[
          { value: 'cheap', label: '便宜打工（默认执行层）' },
          { value: 'standard', label: '未指定（按模型能力）' },
          { value: 'strong', label: '贵审判（规划／审核／验收）' }
        ]}
        onChange={(value) => {
          if (!editor || editor.session.signal.aborted || read(modelEditor)?.session !== editor.session || read(busy)) return
          patchMember(member.id, { cost: value === 'standard' ? undefined : value as Member['cost'] })
        }} />
      <Text size="xs" muted>成本档位决定派工优先级：贵模型只做规划、审核、验收类审判；便宜模型承担大体量执行。档位是路由提示，不代表运行时能力已核实。</Text>
    </>
  }



  function effortPicker(id: string, agent: string, model: string | undefined, effort: string | undefined, label: string) {
    const metadata = editor?.catalogs.get(agent)?.catalog?.models.find((item) => item.id === model)
    const levels = effortLevels(agent, metadata)
    const reason = !supportsEffort(agent) ? '当前 Orca 启动契约不支持此 Agent 指定思考强度。'
      : !model?.trim() ? '请先选择明确的模型，才能指定思考强度。'
      : metadata?.efforts?.length === 0 ? '模型目录明确标记此模型不支持指定思考强度。' : ''
    const custom = !reason && metadata?.efforts === undefined && levels.length === 0
    const update = (value?: string, editingCustom = false) => {
      if (!editor || editor.session.signal.aborted || read(modelEditor)?.session !== editor.session || read(busy)) return
      const current = read(draft)
      if (!current) return
      if (id === 'lead') {
        if (current.lead !== agent || current.leadModel !== model) return
      } else {
        const member = current.members.find((row) => row.id === id)
        if (!member || member.agent !== agent || member.model !== model) return
      }
      setCustom(`effort:${id}`, editingCustom)
      if (id === 'lead') set(draft, { ...current, leadEffort: value })
      else patchMember(id, { effort: value })
    }
    const options = [{ value: defaultModelValue, label: '沿用 Agent / CLI 设置（实际级别未知）' },
      ...levels.slice(0, 497).map((level) => ({ value: `effort:${level}`, label: effortLabel(level) }))]
    if (effort && !levels.includes(effort)) options.push({ value: `effort:${effort}`, label: `已保存或自定义（未列出）· ${effort}` })
    if (custom) options.push({ value: customModelValue, label: '自定义原始强度（高级）' })
    return <>
      <Select label={label} value={effort ? `effort:${effort}` : defaultModelValue} options={options} disabled={pending || !!reason}
        onChange={(value) => {
          if (reason || !editor || editor.session.signal.aborted || read(modelEditor)?.session !== editor.session) return
          if (value === defaultModelValue) update()
          else if (value === customModelValue && custom) setCustom(`effort:${id}`, true)
          else if (levels.some((level) => `effort:${level}` === value)) update(value.slice(7))
        }} />
      {reason && <Text size="xs" tone="warning">{reason}</Text>}
      {metadata?.defaultEffort && <Text size="xs" muted>{`目录推荐强度：${effortLabel(metadata.defaultEffort)}；不是测得的默认值或实际生效值。`}</Text>}
      {!reason && metadata?.efforts === undefined && levels.length > 0 && <Text size="xs" muted>{agent === 'claude' ? '以下为官方文档预设，不代表本地模型、账号或运行时能力；宿主可能限制或调整强度。' : '以下为 Pi CLI 预设，不代表本地模型或运行时能力；由宿主校验。'}</Text>}
      {custom && <>
        <Text size="xs" tone="warning">目录未公开此模型的强度选项；高级自定义原始值须由宿主校验，不保证可用。</Text>
        {(editor?.custom.has(`effort:${id}`) || effort) && <Input label={`${label} · 自定义原始值`} value={effort ?? ''} maxLength={64}
          placeholder="输入 Agent 原始强度值" disabled={pending} onChange={(value) => update(value || undefined, true)} />}
      </>}
      {effort && <>
        <Text size="xs" tone={reason || (metadata?.efforts !== undefined && !levels.includes(effort)) ? 'warning' : undefined}>{effortSummary(effort)}</Text>
        <Button size="xs" variant="ghost" disabled={pending} onPress={() => update()}>{`清空${label}`}</Button>
      </>}
    </>
  }

  function runCard(memberId: string, name: string, agent: string, model?: string, kind?: MemberKind, brief?: string, effort?: string, cost?: Member['cost']) {
    const step = state?.steps.find((row) => row.memberId === memberId)
    const status = step?.state ?? (run?.status === 'starting' ? 'starting' : 'unknown')
    const selectable = Boolean(step?.terminal || step?.dispatch || (memberId === 'lead' && run?.leadTerminal))
    return (
      <Box key={memberId} gap="xs" padding="sm" radius="md" background="card" border={status === 'working' ? 'accent' : true}>
        <Row justify="between" gap="xs" wrap>
          <Text weight="semibold">{name}</Text>
          <Badge tone={status === 'unknown' ? 'warning' : tone[status as keyof typeof tone] ?? 'neutral'}>{stateLabel[status]}</Badge>
        </Row>
        <Text size="xs" muted>{agentName(agent)}{kind ? ` · ${kindLabels[kind]}` : ''}</Text>
        <Text size="xs" muted>{modelSummary(model)}</Text>
        <Text size="xs" muted>{effortSummary(effort)}</Text>
        {cost ? <Text size="xs" muted>{`成本档位：${cost === 'cheap' ? '便宜打工' : '贵审判'}`}</Text> : null}
        <Text size="sm">{step?.task || brief || (memberId === 'lead' ? '拆分任务并汇总结果' : '暂无任务说明')}</Text>
        {step?.issue && <Text size="xs" tone="warning">{step.issue}</Text>}
        {selectable && <Button size="xs" variant="ghost" icon="open-external" onPress={() => inspect(memberId)}>
          {memberId === 'lead' ? '查看主脑汇总' : `查看${name}`}
        </Button>}
        {currentMember === memberId && <Card title={`${name} · 最近输出`}>
          <Stack gap="sm">
            <Row gap="xs" wrap>
              {output?.canOpen && <Button size="sm" onPress={() => open(memberId)}>打开终端</Button>}
              <Button size="sm" variant="ghost" onPress={() => inspect(memberId)}>刷新输出</Button>
              <Button size="sm" variant="ghost" onPress={resetDetail}>关闭</Button>
            </Row>
            <Box maxHeight={240} scroll="y" padding="sm" background="muted" radius="sm">
              <Text size="xs">{output ? output.text || '暂时没有可读取的输出。' : '正在读取会话…'}</Text>
            </Box>
          </Stack>
        </Card>}
      </Box>
    )
  }

  return (
    <Stack gap="md">
      <Row justify="between">
        <Row align="center" gap="xs"><Heading>Orzic</Heading><Text size="sm" muted>· Team Flow</Text></Row>
        <IconButton label="刷新状态" icon="refresh" variant="ghost" onPress={() => read(controller)?.refresh()} />
      </Row>
      {syncIssue && <Text tone="warning">{`状态刷新失败：${syncIssue}`}</Text>}
      {snapshotIssue && <Text tone="warning">{snapshotIssue}</Text>}
      {actionIssue && <Text tone="danger">{actionIssue}</Text>}
      {success && <Text tone="success">{success}</Text>}
      <Card title="当前项目">
        <Stack gap="xs">
          {state && <Text weight="semibold">{state.name}</Text>}
          {state?.path && <Text size="xs" muted>{state.path}</Text>}
          {state?.syncedAt != null && <Text size="xs" muted>最近成功同步：<RelativeTime at={state.syncedAt} /></Text>}
          {projectIssue && <Text size="sm" muted>{projectIssue}</Text>}
        </Stack>
      </Card>
      <Card title="快速开始">
        <Stack gap="xs">
          <Text size="sm">1. 在 Orca 打开目标本机项目。</Text>
          <Text size="sm">2. 配置并保存队伍；保存本身不会执行任务。</Text>
          <Text size="sm">3. 填写任务、验收与执行边界，启动队伍先只读了解项目并提出计划。</Text>
          <Text size="sm">4. 确认计划后自动推进；查看成员输出，需要权限确认或输入时打开对应终端。</Text>
        </Stack>
      </Card>
      {team && <Card title={draftTeam ? '编辑队伍' : '已保存队伍'}>
        <Stack gap="sm">
          <Text size="xs" muted>多个角色可共用同一 Agent / harness，各自选择模型与强度，仍保留独立会话。</Text>
          <Text size="xs" muted>设置仅用于下一次启动，不会更改已有运行的队伍。</Text>
          <Text size="xs" muted>读写限制由提示词约定，并非权限隔离。实现成员在同一项目中串行写入；审核在所有实现完成后进行。</Text>
          <Text size="xs" muted>主脑通过 CLI 终端启动；协作成员遵循 Orca 的 Chat/CLI 偏好，本面板不修改全局设置。</Text>
          <Text size="xs" muted>从模型列表中选择，或沿用 Agent 默认；仅高级自定义需要输入模型 ID。宿主未公开具体默认模型或运行时实际生效模型；指定值不是运行时验证结果。</Text>
          <Text size="xs" muted>{`协作成员 ${(draftTeam ?? team).members.length} / ${maxMembers}（不含主脑）`}</Text>
          {draftTeam ? <>
            <Text size="xs" muted>角色名称可自定义，例如前端、后端、测试或文档。需要写入的成员请选择「实现」模式。</Text>
            <Select label="主脑 Agent（CLI 终端）" value={draftTeam.lead} placeholder="选择 Agent" options={cliOptions} disabled={pending}
              onChange={changeLeadAgent} />
            {modelPicker('lead', draftTeam.lead, draftTeam.leadModel, '主脑模型', '主脑 · 自定义模型 ID', '清空主脑模型')}
            {effortPicker('lead', draftTeam.lead, draftTeam.leadModel, draftTeam.leadEffort, '主脑思考强度')}
            {draftTeam.members.map((member, index) => (
              <Box key={member.id} gap="xs" padding="sm" radius="md" background="card" border>
                <Row justify="between" gap="xs" wrap>
                  <Text weight="semibold">{`成员 ${index + 1}`}</Text>
                  <Button size="xs" variant="ghost" disabled={pending} onPress={() => removeMember(member.id)}>{`移除成员 ${index + 1}`}</Button>
                </Row>
                <Input label={`成员 ${index + 1} · 角色名称`} value={member.name} placeholder="例如：前端开发" disabled={pending}
                  onChange={(name) => patchMember(member.id, { name })} />
                <Select label={`成员 ${index + 1} · Agent`} value={member.agent} placeholder="选择 Agent" options={cliOptions} disabled={pending}
                  onChange={(agent) => changeMemberAgent(member.id, agent)} />
                {modelPicker(member.id, member.agent, member.model, `成员 ${index + 1} · 模型`,
                  `成员 ${index + 1} · 自定义模型 ID`, `清空成员 ${index + 1} 模型`)}
                {effortPicker(member.id, member.agent, member.model, member.effort, `成员 ${index + 1} · 思考强度`)}
                {costPicker(member, index)}
                <Select label={`成员 ${index + 1} · 模式`} value={member.kind} disabled={pending}
                  options={memberKinds.map((kind) => ({ value: kind, label: modeLabel[kind] }))}
                  onChange={(kind) => patchMember(member.id, { kind: kind as MemberKind })} />
                <Textarea label={`成员 ${index + 1} · 职责`} value={member.brief} rows={2} placeholder="描述该成员负责的工作（选填）" disabled={pending}
                  onChange={(brief) => patchMember(member.id, { brief })} />
              </Box>
            ))}
            {catalogAgents.length > 0 && <Stack gap="xs">
              <Button size="xs" variant="ghost" icon="refresh" disabled={pending || catalogAgents.every((agent) => editor?.catalogs.get(agent)?.loading)}
                onPress={() => {
                  const current = read(draft)
                  if (current && !read(busy)) for (const agent of modelAgents(current)) loadModels(agent, true)
                }}>刷新模型列表</Button>
              {catalogAgents.map((agent) => {
                const entry = editor?.catalogs.get(agent)
                const catalog = entry?.catalog
                const label = agentName(agent)
                return <Stack key={agent} gap="xs">
                  {entry?.loading && <Text size="xs" muted>{`${label} · 正在加载模型列表…`}</Text>}
                  {entry?.error && <Text size="xs" tone="warning">{`${label} · 模型列表加载失败：${entry.error}`}</Text>}
                  {catalog && <Text size="xs" muted>{`${label} · ${entry?.loading || entry?.error ? '上次列表来源' : '模型列表来源'}：${catalog.source}`}</Text>}
                  {catalog?.notice && <Text size="xs" muted>{`${label} · ${catalog.notice}`}</Text>}
                  {catalog && catalog.models.length > 497 && <>
                    <Input label={`${label} · 搜索模型名称或 ID`} value={editor?.searches.get(agent) ?? ''} placeholder="筛选模型列表" disabled={pending}
                      onChange={(query) => { if (editor && !editor.session.signal.aborted && read(modelEditor)?.session === editor.session) setModelSearch(agent, query) }} />
                    <Text size="xs" muted>{`共 ${catalog.models.length} 个，当前下拉最多显示 497 个，请按名称筛选。`}</Text>
                  </>}
                  {catalog && catalog.models.length === 0 && <Text size="xs" muted>{`${label} · 模型列表未返回可选项。`}</Text>}
                </Stack>
              })}
            </Stack>}
            <Button variant="ghost" disabled={pending || draftTeam.members.length >= maxMembers} onPress={addMember}>添加成员</Button>
            {draftError && <Text size="sm" tone="warning">{draftError}</Text>}
            <Row gap="xs" wrap>
              <Button tone="accent" disabled={pending || !!draftError} onPress={save}>保存队伍</Button>
              <Button variant="ghost" disabled={pending} onPress={() => { closeEditor(); set(actionError, '') }}>取消编辑</Button>
            </Row>
          </> : <>
            <Text size="sm">{`主脑 · ${agentName(team.lead)} · ${modelSummary(team.leadModel)}`}</Text>
            <Text size="xs" muted>{effortSummary(team.leadEffort)}</Text>
            {team.members.map(({ id, name, agent, model, effort, kind, brief, cost }) => (
              <Box key={id} gap="xs" padding="sm" radius="md" background="card" border>
                <Text weight="semibold">{name}</Text>
                <Text size="xs" muted>{`${agentName(agent)} · ${kindLabels[kind]}`}</Text>
                <Text size="xs" muted>{modelSummary(model)}</Text>
                <Text size="xs" muted>{effortSummary(effort)}</Text>
                {cost ? <Text size="xs" muted>{`成本档位：${cost === 'cheap' ? '便宜打工' : '贵审判'}`}</Text> : null}
                {!run && brief && <Text size="sm">{brief}</Text>}
              </Box>
            ))}
            {teamError && <Text size="sm" tone="warning">{teamError}</Text>}
            <Button variant="ghost" icon="settings" disabled={pending} onPress={openEditor}>队伍设置</Button>
          </>}
        </Stack>
      </Card>}
      <Card title="开始任务">
        <Stack gap="sm">
          <Text size="sm" weight="semibold">{state?.workspace && state.path ? `任务范围：${state.name} · ${state.path}` : '任务范围：尚未选择可用本机工作区'}</Text>
          <Text size="xs" muted>任务和验收标准按工作区自动保存，关闭面板或重启后保留；切换工作区会恢复对应任务。队伍配置全局复用。</Text>
          <Textarea label="任务需求" value={projectIssue ? '' : read(goal)} rows={3} maxLength={maxTaskLength} disabled={pending || !!projectIssue}
            placeholder="描述要做的具体改动…" onChange={(value) => { if (canEditTask()) set(goal, value) }} />
          <Textarea label="验收标准（选填）" value={projectIssue ? '' : read(acceptance)} rows={2} maxLength={maxTaskLength} disabled={pending || !!projectIssue}
            placeholder="列出可检查的结果；留空时由主脑先提出验收标准。" onChange={(value) => { if (canEditTask()) set(acceptance, value) }} />
          <Textarea label="工作区长期说明" value={projectIssue ? '' : read(instructions)} rows={3} maxLength={maxTaskLength} disabled={pending || !!projectIssue}
            placeholder="记录本工作区可重复使用的约定、背景和限制（选填）" onChange={(value) => { if (canEditTask()) set(instructions, value) }} />
          <Text size="xs" muted>长期说明按工作区自动保存，并附加到每次明确启动的任务；不是自动循环任务。修改仅影响下一次启动，不改变当前运行。</Text>
          <Box gap="xs" padding="sm" radius="md" background="card" border>
            <Text weight="semibold">执行边界 · 下一次任务</Text>
            <Text size="xs" muted>按工作区保存；不会改变当前运行边界。这是流程约束，不替代 CLI 权限或技术沙箱。</Text>
            <Textarea label="允许修改的项目相对路径（每行一条）" rows={2} value={boundary.allowedPaths.join('\n')} disabled={pending || !!projectIssue}
              onChange={(value) => { if (canEditTask()) set(policyDraft, { ...read(policyDraft), allowedPaths: value.split('\n') }) }} />
            {(['allowNetwork', 'allowDependencies', 'allowDeletion'] as const).map((key) => (
              <Select key={key} label={{ allowNetwork: '允许项目联网', allowDependencies: '允许新增/安装依赖', allowDeletion: '允许删除项目文件' }[key]}
                value={boundary[key] ? 'yes' : 'no'} options={[{ value: 'no', label: '不允许' }, { value: 'yes', label: '允许' }]} disabled={pending || !!projectIssue}
                onChange={(value) => { if (canEditTask() && (value === 'yes' || value === 'no')) set(policyDraft, { ...read(policyDraft), [key]: value === 'yes' }) }} />
            ))}
            <Select label="最多自动返工次数" value={String(boundary.maxReworks)} options={[0, 1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }))}
              disabled={pending || !!projectIssue} onChange={(value) => { if (canEditTask() && /^[0-5]$/.test(value)) set(policyDraft, { ...read(policyDraft), maxReworks: Number(value) }) }} />
          </Box>
          <Text size="xs" muted>启动队伍先只读了解项目并生成计划 → 你确认计划与边界 → 授权范围内实现、验证、审核和有限返工。</Text>
          <Button variant="ghost" disabled={pending || !!projectIssue} onPress={() => {
            if (!canEditTask()) return
            set(goal, '')
            set(acceptance, '')
          }}>清空本次任务</Button>
          {disabledReason && disabledReason !== projectIssue && <Text size="xs" muted>{disabledReason}</Text>}
          <Row gap="xs" wrap>
            <Button tone="accent" icon="play" disabled={!!disabledReason} onPress={() => { if (canEditTask()) return start() }}>启动队伍</Button>
            <Button variant="ghost" icon="bot" disabled={!!disabledReason} onPress={() => { if (canEditTask()) return fusion() }}>自由协作</Button>
          </Row>
          <Text size="xs" muted>「自由协作」起主脑常驻路由会话：你在它的终端里随时发消息，每条由主脑自行判断派给谁；执行边界同上。</Text>
        </Stack>
      </Card>
      {run && <Stack gap="xs">
        <Row justify="between" gap="xs" wrap>
          <Heading level={2}>运行流程</Heading>
          <Row gap="xs" align="center">
            <Badge tone={run.status === 'unknown' || run.status === 'attention' ? 'warning' : run.status === 'failed' ? 'danger' : run.status === 'completed' ? 'success' : 'accent'}>
              {runLabel[run.status]}
            </Badge>
            {run.status !== 'completed' && run.status !== 'failed' && !read(abandonConfirm) &&
              <Button size="xs" variant="ghost" disabled={acting || pending} onPress={() => set(abandonConfirm, true)}>结束本次运行</Button>}
          </Row>
        </Row>
        {read(abandonConfirm) && <Stack gap="xs">
          <Text size="sm" tone="warning">结束后本次运行标记为已结束并释放「启动队伍」，不可恢复；未完成的成员任务不会自动续跑。确认结束？</Text>
          <Textarea label="结束原因（可选）" value={read(abandonReason)} rows={1} maxLength={300} placeholder="例如：规划与实际不符 / 已人工完成"
            onChange={(value) => set(abandonReason, value)} />
          <Row gap="xs" wrap>
            <Button tone="danger" size="sm" disabled={acting} onPress={() => { if (canEditTask()) return abandon() }}>确认结束</Button>
            <Button variant="ghost" size="sm" disabled={acting} onPress={() => { set(abandonConfirm, false); set(abandonReason, '') }}>取消</Button>
          </Row>
        </Stack>}
        <Text size="xs" muted>以下队伍为本次运行启动时的配置。</Text>
        <Text size="sm">{run.goal}</Text>
        {run.acceptance && <Text size="sm" muted>{`验收标准：${run.acceptance}`}</Text>}
        {run.instructions && <Text size="sm" muted>{`本次长期说明：${run.instructions}`}</Text>}
        {workflow && <Card title="计划与授权">
          <Stack gap="sm">
            <Badge tone={run.status === 'completed' ? 'success' : workflow.phase === 'executing' ? 'accent' : 'warning'}>{run.status === 'completed' ? '已确认完成' : run.status === 'failed' ? '执行已结束（有异常）' : ({ planning: '只读规划中', review: '等待确认计划', approving: '正在送达授权', executing: '授权执行中', blocked: '流程已阻塞' })[workflow.phase]}</Badge>
            <Text size="xs" muted>{`本次允许路径：${workflow.policy.allowedPaths.join('、')}；联网：${workflow.policy.allowNetwork ? '允许' : '不允许'}；依赖：${workflow.policy.allowDependencies ? '允许' : '不允许'}；删除：${workflow.policy.allowDeletion ? '允许' : '不允许'}；最多返工：${workflow.policy.maxReworks} 次`}</Text>
            {workflow.phase === 'planning' && <Text size="sm">等待主脑只读了解项目并提交计划；确认前不授权实现。</Text>}
            {workflow.phase === 'approving' && <Text size="sm">授权正在送达主脑，请勿重复确认。</Text>}
            {workflow.delivery === 'unknown' && <Text size="sm" tone="warning">送达未核实，先检查主脑，勿重复确认；不可自动重发或启动新任务。</Text>}
            {workflow.issue && <Text size="sm" tone="warning">{workflow.issue}</Text>}
            {workflow.feedback && <Text size="sm">{`修改反馈：${workflow.feedback}`}</Text>}
            {workflow.plan && <>
              <Text weight="semibold">{`计划第 ${workflow.plan.revision} 版 · ${workflow.plan.summary}`}</Text>
              {([['步骤', workflow.plan.steps], ['涉及路径', workflow.plan.paths], ['验证方式', workflow.plan.checks], ['风险', workflow.plan.risks]] as const).map(([label, items]) => (
                <Stack key={label} gap="xs"><Text size="sm" weight="semibold">{label}</Text>{items.length ? items.map((item, index) => <Text key={index} size="sm">{`${index + 1}. ${item}`}</Text>) : <Text size="xs" muted>无</Text>}</Stack>
              ))}
            </>}
            {((workflow.phase === 'review' && workflow.plan) || workflow.phase === 'blocked') && <>
              <Textarea label="计划修改反馈" value={read(planFeedback)} rows={2} maxLength={2000}
                disabled={acting || workflow.delivery === 'unknown'} placeholder="说明需要调整的步骤、验收或风险。"
                onChange={(value) => { if (workflowCurrent() && !read(workflowAction)) set(planFeedback, value) }} />
              <Text size="xs" muted>退回重规划沿用本次运行边界，不采用下次任务草稿。</Text>
              <Row gap="xs" wrap>
                {workflow.phase === 'review' && workflow.plan && <Button tone="accent" disabled={acting || pending || !!syncIssue || workflow.delivery === 'unknown'} onPress={() => { if (workflowCurrent()) return submitPlan('approve') }}>确认计划并执行</Button>}
                <Button variant="ghost" disabled={acting || pending || !!syncIssue || !read(planFeedback).trim() || workflow.delivery === 'unknown'} onPress={() => { if (workflowCurrent()) return submitPlan('revise') }}>要求修改计划</Button>
              </Row>
            </>}
            {(workflow.phase === 'blocked' || workflow.delivery === 'unknown') && <Button variant="ghost" onPress={() => { if (workflowCurrent()) return open('lead') }}>打开原主脑</Button>}
          </Stack>
        </Card>}
        {(run.status === 'starting' || run.status === 'active') && <Progress label="队伍正在运行" labelHidden />}
        {runCard('lead', '主脑', run.team.lead, run.team.leadModel, undefined, undefined, run.team.leadEffort)}
        {run.team.members.map(({ id, name, agent, model, effort, kind, brief, cost }) => runCard(id, name, agent, model, kind, brief, effort, cost))}
      </Stack>}
    </Stack>
  )
}
