import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { maxTaskLength, migrateTeam, supportsModel, validateEffortCatalog, validateTeam, type ModelCatalog, type Run, type Snapshot, type State, type Step, type Workflow } from './protocol'
import { leadPrompt, objective, projectSteps, taskPrefix, type NativeTask, type NativeWorker } from './flow'
import { readModelCatalog } from './model-catalog'
import { validatePlan, validatePolicy } from './workflow'

const executable = process.platform === 'win32' ? 'orca.exe' : 'orca'
const cliPath = process.env.ORCA_CLI_COMMAND || ([join(dirname(process.execPath), 'resources', 'bin', executable),
  join(dirname(process.execPath), '..', 'Resources', 'bin', executable)].find(existsSync) ??
  (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' ? 'orca-ide' : executable))

type Cli = <T>(...args: string[]) => Promise<T>
type ReceiptError = { message?: string; code?: string; data?: unknown }

function commandError(message: string, code?: string, data?: unknown): Error & ReceiptError {
  return Object.assign(new Error(message), { code, data })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function cli<T>(...args: string[]): Promise<T> {
  const env = { ...process.env }
  // The plugin worker's Windows environment omits the desktop's roaming profile path.
  if (process.platform === 'win32' && !env.APPDATA) env.APPDATA = join(homedir(), 'AppData', 'Roaming')
  return new Promise((resolve, reject) => {
    execFile(cliPath, [...args, '--environment', 'local', '--json'], {
      encoding: 'utf8', env, windowsHide: true, timeout: args[1] === 'launch' ? 120_000 : 12_000, maxBuffer: 4 * 1024 * 1024
    }, (error, stdout) => {
      let receipt: { ok?: boolean; result?: T; error?: ReceiptError } | null = null
      try { receipt = JSON.parse(stdout) } catch { /* the process may have lost its reply */ }
      if (receipt?.ok === true && receipt.result !== undefined) return resolve(receipt.result)
      if (receipt?.ok === false) {
        const failure = receipt.error
        return reject(commandError(failure?.message ?? 'Orca 命令失败', failure?.code, failure?.data))
      }
      const code = (error as NodeJS.ErrnoException | null)?.code
      reject(commandError(`无法读取 Orca ${args.slice(0, 2).join(' ')} 的结果${code ? `（${code}）` : ''}。CLI：${cliPath}`, typeof code === 'string' ? code : undefined))
    })
  })
}

type Installed = Snapshot['agents']
type WorkerRow = NativeWorker & { liveness?: string }
type Inventory = { tasks: NativeTask[]; workers: WorkerRow[] }
type Reconciliation = Pick<Snapshot, 'run' | 'steps' | 'canStart' | 'syncedAt' | 'issue'>
type LaunchResult = {
  outcome?: { kind?: string; handle?: string }; prompt?: { outcome?: string }
  operationId?: string; receipt?: { operationId?: string }
}
type PlannedRun = Run & { workspace: string; path: string; workflow: Workflow }

const terminalTasks = ['completed', 'failed', 'cancelled', 'canceled']
const terminalWorkers = ['succeeded', 'failed', 'cancelled', 'canceled', 'stopped', 'exited']

function classify(run: Run, lead: State, steps: Step[], data: Inventory | null): Run['status'] {
  if (run.issue || lead === 'blocked' || steps.some((step) => step.state === 'blocked' || step.issue)) return 'attention'
  if (run.workflow) {
    const { phase, issue } = run.workflow
    if (issue || phase === 'review' || phase === 'blocked') return 'attention'
    if (phase === 'planning') return lead === 'working' || lead === 'waiting' ? 'active' : 'attention'
    if (phase === 'approving') return 'active'
  }
  if (lead === 'working' || lead === 'waiting' || steps.some((step) => ['starting', 'working', 'waiting'].includes(step.state))) return 'active'
  if (!data || lead === 'unknown') return 'unknown'
  const mapped = new Set(data.tasks.filter((task) => run.team.members.some((member) =>
    run.taskIds?.[member.id] === task.id || task.title.toLowerCase().startsWith(taskPrefix(run, member).toLowerCase())
  )).map((task) => task.id))
  if (mapped.size !== data.tasks.length || data.workers.some((worker) => !mapped.has(worker.taskId))) return 'attention'
  // Inspect past attempts too. Retained/reclaimable terminals alone are not active work.
  if (data.workers.some((worker) => !terminalWorkers.includes(worker.state) ||
    (worker.liveness !== undefined && !['exited', 'live'].includes(worker.liveness)) ||
    (worker.terminalState !== undefined && !['retained', 'reclaimable', 'released'].includes(worker.terminalState)))) return 'attention'
  if (!data.tasks.every((task) => terminalTasks.includes(task.status)) || !steps.every((step) => step.state === 'done' || step.state === 'failed')) return 'attention'
  const selectedTasks = steps.filter((step) => step.memberId !== 'lead').map((step) => step.taskId)
  if (selectedTasks.some((id) => !id) || new Set(selectedTasks).size !== selectedTasks.length) return 'attention'
  return steps.some((step) => step.state === 'failed') ? 'failed' : 'completed'
}

function describe(error: unknown): string {
  const fields = record(error)
  const message = nonempty(fields?.message) ?? String(error)
  const code = nonempty(fields?.code)
  return code ? `${message}（${code}）` : message
}

function launchArgs(run: Run): string[] {
  const args = ['agent', 'launch', '--worktree', `id:${run.workspace}`, '--agent', run.team.lead, '--surface', 'terminal', '--prompt', leadPrompt(run)]
  if (run.team.leadModel) args.push('--model', run.team.leadModel)
  if (run.team.leadEffort) args.push('--effort', run.team.leadEffort)
  if (args.some((arg) => arg.includes('\0'))) throw new Error('启动内容不能含有空字符。')
  if (process.platform === 'win32') {
    // Upper-bound CreateProcessW's UTF-16 command line, including quoting and NUL.
    const length = [cliPath, ...args, '--environment', 'local', '--json'].reduce((sum, arg) =>
      sum + 3 + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&').length, 0)
    if (length > 32_767) throw new Error('启动内容超过 Windows 命令行长度限制，请缩短成员职责、长期指导、需求或验收标准。')
  }
  return args
}
type Terminal = { handle: string; tabId: string; leafId: string; worktreeId: string }
type Agent = { paneKey: string; worktreeId: string; state: string }
function liveState(value?: string): State {
  if (value === 'idle') return 'waiting'
  if (value === 'permission' || value === 'needs_input') return 'blocked'
  if (value === 'completed') return 'done'
  if (['working', 'blocked', 'waiting', 'done', 'failed'].includes(value ?? '')) return value as State
  return 'unknown'
}

function recentOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(recentOutput).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  for (const key of ['tail', 'text', 'content', 'output', 'lines', 'entries', 'messages', 'rows', 'items', 'transcript', 'terminal', 'page']) {
    const text = recentOutput(row[key])
    if (text) return text
  }
  return ''
}

export default function activate(orca: OrcaWorkerApi, command: Cli = cli,
  catalogReader: (agent: string, cwd: string, signal?: AbortSignal) => Promise<ModelCatalog> = readModelCatalog): void {
  const launches = new Map<string, string | null>()
  const queues = new Map<string, Promise<unknown>>()
  const synced = new Map<string, { runId: string; at: number; steps: Step[] }>()
  const mailings = new Set<string>()
  const senders = new Map<string, string>()
  let installedCache: { expires: number; agents: Installed } | undefined

  async function installed(refresh = false): Promise<Installed> {
    if (!refresh && installedCache && installedCache.expires > Date.now()) return installedCache.agents
    const { agents } = await command<{ agents: Installed }>('agent', 'installed')
    installedCache = { agents, expires: Date.now() + 30_000 }
    return agents
  }

  // Serialize reconciliation and commits, not the launch command. A snapshot can
  // still discover native IDs while a launch is waiting for its receipt.
  function inWorkspace<T>(workspace: string, work: () => Promise<T>): Promise<T> {
    const next = (queues.get(workspace) ?? Promise.resolve()).then(work, work)
    queues.set(workspace, next)
    return next.finally(() => { if (queues.get(workspace) === next) queues.delete(workspace) })
  }

  async function storedRun(workspace: string): Promise<Run | null> {
    const run = await orca.storage.get(`run:${workspace}`) as Run | null
    if (!run || run.schemaVersion === 2) return run
    return { ...run, team: migrateTeam(run.team), status: 'unknown' }
  }

  async function activeWorkspace() {
    const [context, listed] = await Promise.all([
      orca.host.call('workspace.readContext'),
      orca.host.call('workspace.list').catch((error) => { orca.log(describe(error)); return null })
    ])
    const workspace = context?.workspaceId ?? null
    const target = workspace ? listed?.workspaces.find((row) => row.id === workspace) : undefined
    const path = target?.path ?? null
    const local = Boolean(target && (target.hostId === 'local' || target.hostId === null) && path && isAbsolute(path) && !path.includes('\0'))
    return {
      workspace, name: context?.displayName ?? '未选择工作区', path, local,
      issue: workspace && !target ? '无法确认当前工作区的位置。请重新选择工作区后刷新。' : undefined
    }
  }

  async function leadState(run: Run, terminalHandle?: string): Promise<State> {
    if (!terminalHandle) return 'unknown'
    const selector = `id:${run.workspace}`
    const [{ terminals }, { agents, truncated }] = await Promise.all([
      command<{ terminals: Terminal[] }>('terminal', 'list', '--worktree', selector),
      command<{ agents: Agent[]; truncated?: boolean }>('agent', 'list', '--worktree', selector)
    ])
    const terminal = terminals.find((row) => row.handle === terminalHandle)
    if (!terminal) return 'unknown'
    const agent = agents.find((row) => row.worktreeId === terminal.worktreeId && row.paneKey === `${terminal.tabId}:${terminal.leafId}`)
    if (!agent && truncated) throw new Error('主脑状态可能被列表截断。')
    return liveState(agent?.state)
  }

  async function listWorkers(nativeId: string): Promise<WorkerRow[]> {
    const rows: WorkerRow[] = []
    const visited = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await command<{ workers: WorkerRow[]; nextCursor?: string | null }>(
        'orchestration', 'worker-list', '--run', nativeId, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])
      )
      if (!Array.isArray(page.workers) || page.workers.some((row) => !row || !nonempty(row.taskId) || !nonempty(row.dispatchId) || typeof row.state !== 'string')) {
        throw new Error('Orca 返回了不完整的派发列表。')
      }
      if (page.nextCursor != null && !nonempty(page.nextCursor)) throw new Error('Orca 返回了无效的 worker-list 游标。')
      // Append in CLI order, newest first even across cursor pages.
      for (const row of page.workers) rows.push(row)
      cursor = page.nextCursor ?? undefined
      if (cursor && visited.has(cursor)) throw new Error('Orca 返回了重复的 worker-list 游标。')
      if (cursor) visited.add(cursor)
    } while (cursor)
    return rows
  }

  async function inventory(nativeId: string): Promise<Inventory> {
    const [{ tasks }, workers] = await Promise.all([
      command<{ tasks: NativeTask[] }>('orchestration', 'task-list', '--run', nativeId, '--brief'), listWorkers(nativeId)
    ])
    if (!Array.isArray(tasks) || tasks.some((task) => !task || !nonempty(task.id) || typeof task.title !== 'string' || typeof task.status !== 'string')) {
      throw new Error('Orca 返回了不完整的任务列表。')
    }
    return { tasks, workers }
  }

  async function inspect(workspace: string, path: string | null): Promise<Reconciliation> {
    const previous = await storedRun(workspace)
    // 'failed' is a terminal state (including manual abandon): never re-classify it.
    if (!previous) return { run: null, steps: [], syncedAt: null, canStart: Boolean(path) }
    if (previous.status === 'failed') return { run: previous, steps: [], syncedAt: null, canStart: Boolean(path) }
    const cached = synced.get(workspace)
    const last = cached?.runId === previous.id ? cached : undefined
    const pending = previous.status === 'starting' && launches.get(workspace) === previous.id
    let run = previous
    if (run.workflow?.delivery === 'sending' && !mailings.has(workspace)) {
      run = { ...run, workflow: { ...run.workflow, phase: 'blocked', delivery: 'unknown',
        issue: '上次确认或修改请求的送达尚未核实。请先检查主脑会话，勿重复发送。' } }
    }
    let lead: State = pending ? 'starting' : 'unknown'
    let data: Inventory | null = null
    let issue: string | undefined
    let success = false
    if (path && (!run.path || run.path === path)) {
      try {
        if (!run.nativeId) {
          const { runs } = await command<{ runs: { id: string; objective: string; coordinator_handle?: string }[] }>(
            'orchestration', 'run-list', '--limit', '100', '--full'
          )
          const found = runs.filter((row) => row.objective === objective(run))
          if (found.length > 1) throw new Error('存在多个匹配的 Orca Run，请在主脑会话核实。')
          if (found[0]) {
            const handle = found[0].coordinator_handle
            run = { ...run, nativeId: found[0].id, ...(!run.leadTerminal && handle?.startsWith('term_') ? { leadTerminal: handle } : {}) }
          }
        }
        const [leadResult, workerResult] = await Promise.allSettled([
          leadState(run, run.leadTerminal), run.nativeId ? inventory(run.nativeId) : Promise.resolve(null)
        ])
        if (!pending && leadResult.status === 'fulfilled') lead = leadResult.value
        if (workerResult.status === 'fulfilled') data = workerResult.value
        if (leadResult.status === 'rejected') throw leadResult.reason
        if (workerResult.status === 'rejected') throw workerResult.reason
        success = true
      } catch (error) {
        issue = `暂时无法同步 Orca 状态：${describe(error)}`
      }
    } else if (path) {
      issue = '工作区路径已变更，无法核实此运行是否结束。'
    }

    const steps = projectSteps(run, lead, data?.tasks, data?.workers).map((step) => {
      if (step.memberId === 'lead' || data) return step
      const old = last?.steps.find((row) => row.memberId === step.memberId)
      const taskId = run.taskIds && Object.hasOwn(run.taskIds, step.memberId) ? run.taskIds[step.memberId] : undefined
      const state = issue || !path || run.issue ? 'unknown' : step.state
      return { ...step, ...(old && old.taskId === taskId ? old : {}), ...(taskId ? { taskId } : {}), state }
    })
    const taskIds = { ...run.taskIds }
    let bindingsChanged = false
    if (data) for (const step of steps) {
      if (step.taskId && taskIds[step.memberId] !== step.taskId && !steps.some((other) => other !== step && other.taskId === step.taskId)) {
        taskIds[step.memberId] = step.taskId
        bindingsChanged = true
      }
    }
    // Evaluate every native row against the original bindings before replacing
    // them with this observation's selected (possibly newer) member tasks.
    const status = pending ? 'starting' : issue ? (run.issue ? 'attention' : 'unknown') : classify(run, lead, steps, data)
    run = { ...run, status, ...(bindingsChanged ? { taskIds } : {}) }
    const current = await storedRun(workspace)
    if (current?.id !== previous.id) {
      return { run: current && { ...current, status: 'unknown' }, steps: [], syncedAt: null, canStart: false, issue: '运行已切换，请刷新。' }
    }
    if (run.nativeId !== previous.nativeId || run.leadTerminal !== previous.leadTerminal || bindingsChanged ||
      run.workflow !== previous.workflow || (run.schemaVersion === 2 && previous.status !== status)) {
      await orca.storage.set(`run:${workspace}`, run)
    }
    // A partial read must not advance the clock or erase last known handles.
    const sync = success ? { runId: run.id, at: Date.now(), steps } : last
    if (success && sync) synced.set(workspace, sync)
    return { run, steps, syncedAt: sync?.at ?? null, canStart: success && (status === 'completed' || status === 'failed'), issue: run.issue ?? run.workflow?.issue ?? issue }
  }

  async function snapshot(): Promise<Snapshot> {
    const [active, config, available] = await Promise.all([
      activeWorkspace(), orca.storage.get('team'),
      installed().catch((error) => { orca.log(describe(error)); return null })
    ])
    const { workspace, name, path, local } = active
    let team: Snapshot['team']
    let configIssue: string | undefined
    try { team = migrateTeam(config) } catch (error) {
      team = migrateTeam(null)
      configIssue = `${describe(error)} 原配置未加载、未覆盖；当前显示默认草稿，请在队伍设置中修复后保存。`
    }
    const state = workspace
      ? await inWorkspace(workspace, () => inspect(workspace, local ? path : null))
      : { run: null, steps: [], syncedAt: null, canStart: false, issue: undefined }
    return {
      workspace, name, path, local, agents: available ?? [], team, ...state,
      canStart: state.canStart && available !== null && !configIssue && Boolean(workspace && !launches.has(workspace)),
      issue: configIssue ?? state.issue ?? active.issue ?? (available ? undefined : '无法读取本机 CLI 列表。')
    }
  }

  orca.panels.handle('flow.snapshot', async () => JSON.parse(JSON.stringify(await snapshot())) as Snapshot)
  orca.panels.handle('flow.models', async ({ workspace, agent }, { signal }) => {
    const [active, agents] = await Promise.all([activeWorkspace(), installed()])
    signal.throwIfAborted()
    if (active.workspace !== workspace) throw new Error('工作区已切换，未读取其他项目的模型目录。')
    if (!agents.some((row) => row.id === agent)) throw new Error('请选择已安装的 Agent 后读取模型列表。')
    if (!supportsModel(agent)) return { agent, models: [], source: '当前 Orca 不支持显式模型参数', notice: '此 Agent 只能沿用自己的默认模型。' }
    if (!active.local || !active.path) return { agent, models: [], source: '尚未读取本机目录', notice: '请先打开目标本机工作区，再读取模型列表。' }
    const result = await catalogReader(agent, active.path, signal)
    signal.throwIfAborted()
    const latest = await activeWorkspace()
    if (latest.workspace !== workspace || latest.path !== active.path || !latest.local) throw new Error('工作区已切换，已丢弃原项目的模型目录。')
    return result
  })
  orca.panels.handle('flow.save', async (input) => {
    const team = validateTeam(input, await installed(true))
    await orca.storage.set('team', team)
    return team
  })

  async function workflowTarget(workspace: string, runId: string, signal: AbortSignal, userAction: boolean): Promise<PlannedRun> {
    const run = await storedRun(workspace)
    if (!run || run.id !== runId || run.workspace !== workspace || !run.path || !run.workflow ||
      !['planning', 'review', 'approving', 'executing', 'blocked'].includes(run.workflow.phase)) {
      throw new Error('运行已切换或没有可确认的计划，请刷新。')
    }
    if (userAction) {
      const active = await activeWorkspace()
      if (active.workspace !== workspace || !active.local || active.path !== run.path) throw new Error('工作区已切换，未确认其他项目的计划。')
    } else {
      // A background planner may report while another project is focused.
      const listed = await orca.host.call('workspace.list')
      const target = listed.workspaces.find((row) => row.id === workspace)
      if (!target || target.path !== run.path || (target.hostId !== null && target.hostId !== 'local')) {
        throw new Error('原运行的本机工作区位置已无法核实。')
      }
    }
    validatePolicy(run.workflow.policy)
    signal.throwIfAborted()
    return run as PlannedRun
  }

  async function saveWorkflow(run: PlannedRun, workflow: Workflow): Promise<PlannedRun> {
    const status = run.issue || workflow.issue || workflow.phase === 'review' || workflow.phase === 'blocked' ? 'attention' : 'active'
    const stored: Workflow & Record<string, unknown> = { ...workflow }
    // The host accepts JSON values, not properties whose value is undefined.
    for (const key in stored) if (stored[key] === undefined) delete stored[key]
    const next = { ...run, workflow: stored, status } as PlannedRun
    await orca.storage.set(`run:${run.workspace}`, next)
    orca.panels.post('flow.changed', { workspace: run.workspace })
    return next
  }

  function panelAction(panel: { surface: string; contributionId: string }): void {
    // Keep decisions on this panel's route, not an editor's. This is not human authentication:
    // Orca's dev bridge may supply the same panel identity, including for CLI calls.
    if (panel.surface !== 'panel' || panel.contributionId !== 'team-flow') throw new Error('请在 Orzic 侧栏确认或修改计划。')
  }

  function feedbackText(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new Error('请填写 1–2000 字的修改意见或阻塞原因。')
    }
    return value.trim()
  }

  function revisionMatches(run: PlannedRun, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== (run.workflow.plan?.revision ?? 0)) {
      throw new Error('计划版本已变化，请刷新并重新阅读后确认。')
    }
  }

  orca.panels.handle('flow.propose', ({ workspace, runId, baseRevision, plan: input }, { signal }) => inWorkspace(workspace, async () => {
    const run = await workflowTarget(workspace, runId, signal, false)
    revisionMatches(run, baseRevision)
    if (!['planning', 'review'].includes(run.workflow.phase) || run.workflow.approvedRevision !== undefined) {
      throw new Error('当前计划已经确认或需要人工处理，不能自行覆盖授权。')
    }
    const plan = validatePlan(input, run.workflow.policy, baseRevision + 1)
    return saveWorkflow(run, { ...run.workflow, phase: 'review', plan, delivery: undefined, messageId: undefined, issue: undefined })
  }))

  // Commit the decision before sending. A lost receipt must never result in an
  // automatic second send, including after this worker has restarted.
  async function sendInstruction(before: PlannedRun, pending: PlannedRun, subject: string, body: string): Promise<Run> {
    let directory: string | undefined
    let submitted = false
    let result: unknown
    let failure: unknown
    try {
      directory = await mkdtemp(join(tmpdir(), 'team-flow-'))
      const file = join(directory, 'instruction.txt')
      await writeFile(file, body, { encoding: 'utf8', mode: 0o600 })
      submitted = true
      let from = senders.get(pending.workspace)
      if (!from) {
        // orchestration send needs a sender handle; reuse one worker-owned terminal per workspace.
        const made = await command<{ terminal?: { handle?: string } }>('terminal', 'create',
          '--worktree', `id:${pending.workspace}`, '--title', 'Orzic 授权').catch(() => undefined)
        const handle = nonempty(made?.terminal?.handle)
        if (handle?.startsWith('term_')) { senders.set(pending.workspace, handle); from = handle }
      }
      result = await command('orchestration', 'send', '--to', pending.leadTerminal!,
        ...(from ? ['--from', from] : []),
        '--subject', subject,
        '--type', 'status', '--thread-id', `team-flow:${pending.id}:plan:${pending.workflow.plan?.revision ?? 0}`, '--body-file', file, '--full')
    } catch (error) { failure = error }
    finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch((error) => orca.log(`清理授权临时文件失败：${describe(error)}`))
    }
    try {
      const updated = await inWorkspace(pending.workspace, async () => {
        const current = await storedRun(pending.workspace)
        if (!current || current.id !== pending.id || !current.workflow ||
          current.workflow.plan?.revision !== pending.workflow.plan?.revision || current.workflow.delivery !== 'sending') return current ?? pending
        const run = current as PlannedRun
        if (failure && !submitted) return saveWorkflow(run, before.workflow)
        const receipt = record(result)
        const messageId = nonempty(receipt?.messageId) ?? nonempty(receipt?.id) ?? nonempty(record(receipt?.message)?.id)
        const issue = failure ? `确认或修改请求的送达尚未核实：${describe(failure)}。请先检查原主脑，勿重复发送。` : run.workflow.issue
        return saveWorkflow(run, { ...run.workflow, delivery: failure ? 'unknown' : 'accepted',
          phase: failure ? 'blocked' : run.workflow.phase === 'approving' ? 'executing' : run.workflow.phase,
          ...(messageId ? { messageId } : {}), issue })
      })
      if (failure && !submitted) throw new Error(`消息尚未发送：${describe(failure)}`)
      return updated
    } finally { mailings.delete(pending.workspace) }
  }

  orca.panels.handle('flow.approve', async ({ workspace, runId, revision }, { panel, signal }) => {
    panelAction(panel)
    const prepared = await inWorkspace(workspace, async () => {
      const run = await workflowTarget(workspace, runId, signal, true)
      revisionMatches(run, revision)
      if (run.workflow.approvedRevision === revision && ['approving', 'executing'].includes(run.workflow.phase)) return { run }
      if (run.workflow.phase !== 'review' || !run.workflow.plan || run.workflow.delivery === 'unknown' || mailings.has(workspace)) {
        throw new Error('当前没有可以确认的计划，或上次送达尚未核实；请先检查主脑。')
      }
      if (run.issue || !run.leadTerminal?.startsWith('term_')) throw new Error('尚未核实原主脑会话，不能放行执行。请先打开主脑检查。')
      validatePlan({ summary: run.workflow.plan.summary, steps: run.workflow.plan.steps, paths: run.workflow.plan.paths,
        checks: run.workflow.plan.checks, risks: run.workflow.plan.risks }, run.workflow.policy, revision)
      const pending = await saveWorkflow(run, { ...run.workflow, phase: 'approving', approvedRevision: revision,
        approvedAt: Date.now(), delivery: 'sending', messageId: undefined, issue: undefined })
      mailings.add(workspace)
      return { run, pending }
    })
    if (!prepared.pending) return prepared.run
    const executing = { ...prepared.pending, workflow: { ...prepared.pending.workflow, phase: 'executing' as const } }
    return sendInstruction(prepared.run, prepared.pending, `Orzic：批准计划 v${revision}`, leadPrompt(executing))
  })

  orca.panels.handle('flow.revise', async ({ workspace, runId, revision, feedback: input, policy }, { panel, signal }) => {
    panelAction(panel)
    const feedback = feedbackText(input)
    const prepared = await inWorkspace(workspace, async () => {
      const run = await workflowTarget(workspace, runId, signal, true)
      revisionMatches(run, revision)
      if (!['review', 'blocked'].includes(run.workflow.phase) || run.workflow.delivery === 'unknown' || mailings.has(workspace)) {
        throw new Error('当前不能退回计划。送达不明确时先检查主脑，不能重复发送。')
      }
      if (run.issue || !run.leadTerminal?.startsWith('term_')) throw new Error('尚未核实原主脑会话，不能发送修改要求。')
      const pending = await saveWorkflow(run, { ...run.workflow, phase: 'planning', policy: validatePolicy(policy ?? run.workflow.policy),
        approvedRevision: undefined, approvedAt: undefined, feedback, issue: undefined, delivery: 'sending', messageId: undefined })
      mailings.add(workspace)
      return { run, pending }
    })
    return sendInstruction(prepared.run, prepared.pending, `Orzic：修改计划 v${revision}`, leadPrompt(prepared.pending))
  })

  orca.panels.handle('flow.block', ({ workspace, runId, reason }, { signal }) => inWorkspace(workspace, async () => {
    const run = await workflowTarget(workspace, runId, signal, false)
    return saveWorkflow(run, { ...run.workflow, phase: 'blocked', issue: feedbackText(reason) })
  }))

  orca.panels.handle('flow.abandon', async ({ workspace, runId, reason }, { panel }) => {
    panelAction(panel)
    return inWorkspace(workspace, async () => {
      const run = await storedRun(workspace)
      if (!run || run.id !== runId || run.workspace !== workspace) throw new Error('运行已切换，请刷新。')
      if (run.status === 'completed' || run.status === 'failed') return run
      const active = await activeWorkspace()
      if (active.workspace !== workspace) throw new Error('工作区已切换，未作废其他项目的运行。')
      await orca.storage.set(`run:${workspace}`, { ...run, status: 'failed',
        issue: reason ? `已由你作废：${feedbackText(reason)}` : '已由你作废本次运行。' })
      orca.panels.post('flow.changed', { workspace })
      return { ...run, status: 'failed' }
    })
  })

  orca.panels.handle('flow.start', async ({ workspace, goal, acceptance, instructions, team: input, policy: inputPolicy }, { signal }) => {
    if (typeof goal !== 'string' || !goal.trim() || goal.length > maxTaskLength) throw new Error(`请输入 1–${maxTaskLength} 字的需求。`)
    if (typeof acceptance !== 'string' || acceptance.length > maxTaskLength) throw new Error(`验收标准不能超过 ${maxTaskLength} 字。`)
    if (typeof instructions !== 'string' || instructions.length > maxTaskLength) throw new Error(`工作区长期指导必须是文本，且不能超过 ${maxTaskLength} 字。`)
    const policy = validatePolicy(inputPolicy)
    if (!workspace || launches.has(workspace)) throw new Error('该工作区正在启动队伍。')
    launches.set(workspace, null)
    let handedOff = false
    try {
      const [active, agents] = await Promise.all([activeWorkspace(), installed(true)])
      if (active.workspace !== workspace || !active.local || !active.path) throw new Error('请选择当前本机工作区，再启动队伍。')
      const path = active.path
      const team = validateTeam(input, agents)
      if (team.leadEffort || team.members.some((member) => member.effort)) {
        const targets = new Set<string>()
        if (team.leadEffort) targets.add(team.lead)
        for (const member of team.members) if (member.effort) targets.add(member.agent)
        const catalogs = await Promise.all([...targets].map(async (agent) => {
          const catalog = await catalogReader(agent, path, signal)
          if (catalog.agent !== agent) throw new Error('模型目录与请求的 Agent 不一致，未确认思考强度。')
          return catalog
        }))
        signal.throwIfAborted()
        validateEffortCatalog(team, catalogs)
      }
      return await inWorkspace(workspace, async () => {
        const previous = await inspect(workspace, path)
        if (!previous.canStart) throw new Error('无法确认上一队伍已结束。请刷新或先检查 Orca 会话，勿重复启动。')
        // Checking the old run can take time; revalidate the exact launch target.
        const latest = await activeWorkspace()
        if (latest.workspace !== workspace || !latest.local || latest.path !== path) throw new Error('工作区已切换，请重新确认后启动。')
        const [current, config] = await Promise.all([storedRun(workspace), orca.storage.get('team')])
        if (current?.id !== previous.run?.id) throw new Error('运行已切换，请刷新后重试。')
        migrateTeam(config) // A damaged config must be explicitly repaired using Save.
        signal.throwIfAborted()
        const run: Run = { schemaVersion: 2, id: randomUUID().slice(0, 12), goal: goal.trim(), acceptance: acceptance.trim(),
          instructions: instructions.trim(), team, path, workspace, status: 'starting', startedAt: Date.now(),
          workflow: { phase: 'planning', policy } }
        const args = launchArgs(run)
        await orca.storage.set('team', team)
        await orca.storage.set(`run:${workspace}`, run)
        launches.set(workspace, run.id)
        handedOff = true
        void launch(workspace, run.id, args).catch((error) => orca.log(describe(error)))
        orca.panels.post('flow.changed', { workspace })
        return run
      })
    } finally {
      if (!handedOff) launches.delete(workspace)
    }
  })

  async function launch(workspace: string, runId: string, args: string[]): Promise<void> {
    let result: LaunchResult | undefined
    let failure: string | undefined
    try {
      result = await command<LaunchResult>(...args)
    } catch (error) {
      const data = record(record(error)?.data)
      result = data as LaunchResult | undefined
      failure = `未能确认主脑启动或需求送达：${describe(error)}。请先检查 Orca 中是否已打开主脑，不要重新启动。`
    }
    const handle = nonempty(result?.outcome?.handle)
    const leadTerminal = result?.outcome?.kind === 'terminal' && handle?.startsWith('term_') ? handle : undefined
    const delivery = nonempty(result?.prompt?.outcome)
    const operationId = nonempty(result?.operationId) ?? nonempty(result?.receipt?.operationId)
    const issue = failure ?? (!leadTerminal ? 'Orca 没有确认主脑终端，请检查是否已启动。' :
      delivery !== 'journaled' && delivery !== 'handed-to-terminal' ? '主脑终端已启动，但 Orca 尚未确认需求已送达。请打开会话检查。' : undefined)
    try {
      await inWorkspace(workspace, async () => {
        const current = await storedRun(workspace)
        if (current?.id !== runId) return
        await orca.storage.set(`run:${workspace}`, { ...current, status: issue ? 'attention' : 'active',
          ...(leadTerminal ? { leadTerminal } : {}), ...(delivery ? { delivery } : {}),
          ...(operationId ? { operationId } : {}), ...(issue ? { issue } : {}) })
      })
    } finally {
      launches.delete(workspace)
      orca.panels.post('flow.changed', { workspace })
    }
  }

  async function selected(workspace: string, runId: string, memberId: string) {
    const state = await snapshot()
    const [active, current] = await Promise.all([activeWorkspace(), storedRun(workspace)])
    if (active.workspace !== workspace || !active.local || state.workspace !== workspace || state.path !== active.path ||
      state.run?.id !== runId || current?.id !== runId || (current.path && current.path !== active.path)) {
      throw new Error('运行或工作区已切换，请重选成员。')
    }
    const step = state.steps.find((row) => row.memberId === memberId)
    if (!step) throw new Error('成员不存在。')
    return step
  }

  orca.panels.handle('flow.detail', async ({ workspace, runId, memberId }) => {
    const step = await selected(workspace, runId, memberId)
    const terminal = step.terminal?.startsWith('term_') ? step.terminal : undefined
    let failure: unknown
    if (step.dispatch) {
      try {
        const text = recentOutput(await command('orchestration', 'worker-read', '--dispatch', step.dispatch, '--limit', '40', '--full'))
        if (text) return { text: text.slice(-8_000), canOpen: Boolean(terminal) }
        failure = new Error('Orca 未返回可读取的工作成员输出。')
      } catch (error) { failure = error }
    }
    if (terminal) {
      try {
        const text = recentOutput(await command('terminal', 'read', '--terminal', terminal, '--limit', '40'))
        if (text || !step.dispatch) return { text: text.slice(-8_000), canOpen: true }
      } catch (error) { failure ??= error }
    }
    if (failure) throw new Error(`${describe(failure)} ${terminal ? '请打开终端，或查看原生任务结果。' : '请在主脑会话中查看原生任务结果。'}`)
    if (step.taskId && step.state !== 'queued') throw new Error('Orca 未返回可读取的派发输出。请在主脑会话中查看原生任务结果。')
    return { text: '', canOpen: false }
  })

  orca.panels.handle('flow.open', async ({ workspace, runId, memberId }) => {
    const step = await selected(workspace, runId, memberId)
    if (!step.terminal?.startsWith('term_')) return { opened: false }
    const result = await command<{ navigated?: boolean }>('terminal', 'switch', '--terminal', step.terminal)
    return { opened: result.navigated !== false }
  })

  let eventTimer: NodeJS.Timeout | undefined
  let changedWorkspace: string | null
  orca.events.on('agent.status.changed', ({ workspaceId, workspaceListId }) => {
    const workspace = workspaceId && workspaceListId && workspaceId !== workspaceListId ? null : workspaceListId ?? workspaceId
    if (eventTimer) {
      if (changedWorkspace !== workspace) changedWorkspace = null
      return
    }
    changedWorkspace = workspace
    eventTimer = setTimeout(() => {
      eventTimer = undefined
      orca.panels.post('flow.changed', { workspace: changedWorkspace })
    }, 400)
  })
}
