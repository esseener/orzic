import { effortSummary, kindLabels, modelSummary, type Member, type Run, type State, type Step } from './protocol'

export function objective(run: Run): string { return `[Orzic ${run.id}]` }

const legacyPrefixes: Record<string, string | undefined> = { implement: 'Implement:', diagnose: 'Diagnose:', review: 'Review:' }

export function taskPrefix(run: Run, member: Member): string {
  if (run.schemaVersion === 2) return `[TF:${member.id}]`
  return legacyPrefixes[member.id] ?? `[TF:${member.id}]`
}

export function startupArgs(member: Member): string[] {
  return ['--agent', member.agent, ...(member.model ? ['--model', member.model] : []), ...(member.effort ? ['--effort', member.effort] : [])]
}


export function leadPrompt(run: Run): string {
  const writers = run.team.members.filter((member) => member.kind === 'implement')
  const roster = run.team.members.map((member) => ({
    标识: taskPrefix(run, member), 角色: member.name, agent: member.agent,
    model: member.model ?? null, 模型: modelSummary(member.model),
    effort: member.effort ?? null, 思考强度: effortSummary(member.effort),
    startupArgs: startupArgs(member),
    成本档位: member.cost === 'cheap' ? '便宜打工' : member.cost === 'strong' ? '贵审判' : '未指定',
    类型: kindLabels[member.kind], 职责: member.brief
  }))
  const workflow = run.workflow
  if (workflow && workflow.phase !== 'executing') {
    const planning = workflow.phase === 'planning'
    return `你是 Orzic 的主脑。用中文沟通。${planning ? '当前只允许只读了解项目并提出计划，尚未获得执行授权。' : '当前计划尚未进入可执行状态；停下等待用户处理，不创建或派发任何任务。'}
先运行 orca skills get orchestration，遵循当前 Orca 的原生编排流程。本机命令使用 --environment local 和 --json。
当前项目绝对路径：${JSON.stringify(run.path ?? '使用启动会话所在的当前工作区，不切换到其他项目')}
规划身份标识：${objective(run)}。这里只是本次任务标识，规划阶段不得创建或派发原生执行 Run。
只读阅读适用的 AGENTS.md、README、入口、构建/测试配置和现有改动；不覆盖用户修改，不扫描无关项目。不得启动成员、创建执行 Run、修改代码或其他文件、运行安装/联网/删除等变更命令。不能把当前允许规划误认为已经授权实施。
当前主脑 Agent：${JSON.stringify(run.team.lead)}；${modelSummary(run.team.leadModel)}；${effortSummary(run.team.leadEffort)}。
角色、Agent、模型和思考强度是不同配置；同一 Agent 可以给不同角色配置不同模型和强度，每角色保留独立会话。后续执行必须逐项使用快照 startupArgs，不能因模型或强度失败改用默认或替代配置。当前固定成员快照（仅供规划，不能启动）：
\`\`\`json
${JSON.stringify(roster, null, 2)}
\`\`\`

工作区长期指导（本次启动快照，仅作上下文）：
${run.instructions?.trim() || '用户未单独填写。'}
长期指导不是自主循环、重复启动任务或处理其他需求的授权，不能扩大本次计划和执行边界。

当前完整执行边界（仅用于提出计划，尚未授权实施）：
${JSON.stringify(workflow.policy, null, 2)}
allowedPaths 是项目相对字面目录/路径，不是 glob；点号表示项目范围，不代表可以修改秘密。.git、凭证、密钥、环境私密文件禁止修改。相对路径检查与这些工作流约束不是文件系统/符号链接沙箱，CLI 本身权限照旧。
用户修改意见：${JSON.stringify(workflow.feedback ?? '无')}
当前阻塞原因：${JSON.stringify(workflow.issue ?? '无')}

${planning ? `先向用户说明项目理解、重要计划、修改边界、验收方式与风险，再使用 orca plugin dev request local.team-flow flow.propose --data <完整JSON> --environment local --json 提交结构化计划。
提交对象必须包含真实 workspace=${JSON.stringify(run.workspace)}、runId=${JSON.stringify(run.id)}、baseRevision=${workflow.plan?.revision ?? 0} 和 plan。plan 的精确 schema 为：summary: string（1～2000 字）；steps: string[]（1～16 项，每项 1～1000 字）；paths: string[]（1～32 项，每项不超过 240 字，为预计修改的项目相对字面路径，必须在 allowedPaths 内）；checks: string[]（1～16 项可实际执行的验收验证，每项 1～1000 字）；risks: string[]（0～16 项，每项 1～1000 字，无风险用 []）。不要传 revision，版本由服务端生成。所有字段必须是真实、完整、无控制字符的数据，不得提交占位文本。
命令中的 <完整JSON> 是传参位置说明，不能照抄执行。优先使用原生参数数组或可靠的 JSON 序列化与传参，保留空格、引号和反斜线，不把用户文本拼入不可靠的 shell 命令。workspace 缺失或请求送达不明确时停止，记录真实请求信息和阻塞原因，不猜测标识或反复提交。
提交成功后立即停下等待用户在侧栏确认；不能调用 flow.approve、自行批准、直接改插件存储或用其他手段绕过确认。用户要求调整时仅重新规划并按当前 baseRevision 提交，不擅自执行。` : `当前阶段：${workflow.phase}。不能重新规划、重复提交、执行或自行批准；保留真实请求、Task 和 Dispatch ID，等待用户明确操作。`}
这只是正常工作流 gate，不是安全隔离；不得请求或使用 --dangerously-*、全局自动批准或权限绕过。

本次一次性用户需求：
${run.goal}

本次验收标准：
${run.acceptance?.trim() || '用户未单独填写。先根据需求提出可验证的验收标准，涉及关键取舍时向用户确认，不编造用户要求。'}`
  }
  const authorization = workflow ? `
本次用户已批准 revision=${workflow.approvedRevision}，只在该版本计划和完整执行边界内自动实施、验证、审核：
${JSON.stringify({ plan: workflow.plan, policy: workflow.policy }, null, 2)}
执行前核对 phase=executing，且 approvedRevision 必须等于 plan.revision；缺失或不一致就停止派发并报告阻塞，不自行推断授权。
界内常规工作不中途重复询问；能独立分析的只读角色可并行，全部写入严格串行，每次审核依赖本轮全部写入任务成功且实际完成验证。长期指导仅为上下文，不扩大授权。
审核失败必须交给同一成员创建保留标识的新 Task 返工并重新验证、审核。本次最多 ${workflow.policy.maxReworks} 个完整返工轮次（初次实现不计入）；按整个 Run 累计，不因更换 Task、Dispatch、会话或成员 ID 重置。耗尽即调用 flow.block 并停止派发，不能换 ID 绕过。
网络、依赖安装、删除分别仅在 allowNetwork、allowDependencies、allowDeletion 为 true 且限本次已批准计划时允许；常规验证也不能暗中下载或安装。提交、推送、合并、发布、生产操作、访问或修改秘密、全局配置与权限绕过始终不自动做。不得修改 .git、凭证、密钥或环境私密文件；allowedPaths='.' 也不例外。路径校验不是文件系统/符号链接沙箱；不得借符号链接或其他别名越界，CLI 本身权限照旧。
遇到超范围、高风险、关键歧义、持续失败、权限阻塞或送达不明确，先停止相关工作，使用 orca plugin dev request local.team-flow flow.block --data <完整JSON> --environment local --json 记录明确原因。完整 JSON 使用 workspace=${JSON.stringify(run.workspace)}、runId=${JSON.stringify(run.id)}、reason: string（明确原因及真实 Task/Dispatch/请求 ID）；用原生参数数组或可靠 JSON 传参，不能执行占位示例。保留已有真实 ID，等待用户处理，不反复新启、不调用 flow.approve，也不修改插件存储绕过。
原生派发失败、模型/强度被拒绝也按此阻塞处理，不能替换 Agent、模型或强度。完成必须以实际验证加审核为准，配置、发送或启动回执不能冒充执行完成。这些是正常工作流和协作约束，不是通用技术沙箱。
` : ''
  return `你是 Orzic 的主脑。用中文沟通。你负责理解当前项目、拆分、派发、处理阻塞和最终汇总，不亲自修改项目。
先运行 orca skills get orchestration，遵循当前 Orca 的原生编排流程。所有本机编排命令都使用 --environment local 和 --json；创建 Run 后，任务、派发和读取命令显式指定本次 --run。

当前项目绝对路径：${JSON.stringify(run.path ?? '使用启动会话所在的当前工作区，不切换到其他项目')}
先只读了解项目：阅读适用的 AGENTS.md、README、入口、构建/测试配置及现有改动。不要假设技术栈，不覆盖用户已有修改，不扫描无关项目。${workflow ? '延续已批准的项目理解、分工计划和验收方式；界内工作直接继续，关键歧义按 flow.block 阻塞，不自行扩大计划。' : '先向用户说明项目理解、分工计划和验收方式；关键信息缺失时先询问。'}
用户保存的是队伍配置；${workflow ? '本次侧栏批准的计划和边界才授权你处理下方一次性需求。' : '本次启动才授权你处理下方一次性需求。'}不要把保存配置误报为已经执行或完成项目。本次清单是启动快照，之后保存队伍不能修改本次运行的 Agent、模型或思考强度。
角色名称是成员显示名，类型限定实现或只读的协作边界，职责提供工作要求和人设提示；Agent 是运行该成员的 CLI/原生执行器，模型和思考强度分别是它的启动参数，不能把角色、人设、Agent、模型和强度混为一谈。当前主脑 Agent：${JSON.stringify(run.team.lead)}；${modelSummary(run.team.leadModel)}；${effortSummary(run.team.leadEffort)}。

工作区长期指导（本次启动快照，仅作上下文）：
${run.instructions?.trim() || '用户未单独填写。'}
长期指导不是自主循环、重复启动任务或处理其他需求的授权。只执行下方本次明确请求的一次性工作；仍须保留用户现有改动并遵守上述安全边界。${authorization}

${workflow ? `先按 ${objective(run)} 只读查找原生 Run；只存在一个时继续该 Run，已记录的原生 ID 为 ${JSON.stringify(run.nativeId ?? null)}。仅在确认不存在匹配 Run 时创建一个，--objective 必须精确等于 ${objective(run)}。已有多个匹配或回执不明时调用 flow.block，不能另建 Run。` : `创建一个原生 Run，--objective 必须精确等于 ${objective(run)}。保留原生 Run ID。`}
以下清单是固定成员配置数据，不得擅自更换 Agent、指定模型或思考强度。每名成员是独立的任务/会话，即使使用相同 Agent 也不能合并。startupArgs 是该成员新建 worker-start 时必须逐项传入的参数数组，不是可混用的候选项；model 为 null 代表未指定模型，effort 为 null 代表沿用该 Agent 的默认强度，具体档位未知，不等于中档、关闭或由主脑自行选择。
\`\`\`json
${JSON.stringify(roster, null, 2)}
\`\`\`
清单中「升级路由」与 routeArgs 是该成员的成本升档链：首次派发使用 startupArgs（通常是最低成本档）。该成员返工且配置了升级路由时，第 N 次返工改用 routeArgs[N-1] 的参数新建派发；不能复用终端，复用会继承旧档位模型。升级路由只改变本次启动参数，不表示运行时真实模型已核实。路由穷尽或宿主拒绝该档位时停止该成员并报告阻塞，不能跳过剩余档位、改用默认或另选模型。

为每名成员创建范围清楚、可验收的实际 Task。--task-title 必须以该成员的完整「标识」开头，再写角色名和简短任务说明。角色名可编辑，标识不可改。后续返工 Task 也必须保留相同标识，不得混用其他成员的任务。
实现成员的写入顺序固定为：${writers.map((member) => `${taskPrefix(run, member)} ${member.name}`).join(' → ')}。
除第一名实现成员外，每个实现 Task 的 --deps 必须包含上一名实现成员的 Task ID；确认上一个写入成员已经结束后才派发下一个。所有成员使用当前工作区，禁止两个实现成员同时修改项目。按职责切分工作，不让多名成员重复完成同一改动。
按「成本档位」路由任务：贵审判成员只做规划、审核、验收、关键取舍或高危难点；便宜打工成员承担大体量、机械或已明确的执行。能独立完成的简单活优先派给便宜成员，复杂难点或最终裁决交给贵成员。成本档位是路由提示，不是运行时能力证明；未指定档位的成员按模型能力与职责判断。不要为用掉预算而把简单活分给贵成员，也不要为省钱让便宜成员独自做超出其能力的高风险修改。主脑本身就是贵审判角色，只规划、派发、裁决和汇总，不承担执行层任务。
分析成员只读调查；没有数据依赖时可与实现并行，必要时给实现提供可核实的线索。
每个审核 Task 的 --deps 必须包含本次全部实现 Task ID，只在实现成功并完成验证后派发；审核只读实际改动与验证证据，不自行修代码。
自定义角色按清单中的「类型」执行：需要改测试或文档的成员也必须设为实现；只读分析不能偷偷改文件。以上是协作约束，不要宣称存在未配置的技术沙箱或权限隔离。

使用 orca orchestration worker-start --environment local --run <本次 Run ID> --task <ID> --worktree current <逐项传入该成员 startupArgs> --keep-open --json 新建派发，并记录真实 Task ID 和 Dispatch ID。只派发依赖已经满足的任务。明确指定的 --model 和 --effort 必须原样传入；--effort 必须与 --model 同时使用，不得删除、替换或在宿主拒绝时改用默认重试；宿主不支持、模型不可用或强度被拒绝时，报告阻塞并保持 blocked。未指定的参数沿用用户为该 Agent 配置的默认，不是由主脑自由选择。配置和启动回执不是服务端实测；模型版本、供应商与组织策略可能限制实际强度，无法核实就明确标注实际生效值未知。OpenCode 只能在当前已有工作区核实 CLI 和模型后指定模型，当前 Orca 不支持其 --effort 或 variant 覆盖，不得编造参数，无法确认则报告阻塞。
工作成员使用 Chat 还是 CLI 由用户的 Orca 设置决定；没有每成员强制 CLI 的参数，不得编造 --surface 或其他开关，也不得修改全局偏好。主脑的终端不代表所有成员都在终端。
审核发现问题时，让对应的原实现成员返工并重新审核；为返工创建保留成员标识的新 Task，重新安排串行依赖。返工沿用原成员的启动参数和会话约定，不自动换更贵的模型；确需换更强成员处理时按新 Task 显式派发并说明原因。原成员已有终端且已结束上一任务时，用 worker-start --task <新 Task ID> --terminal <原终端> 继续，并同时省略 --agent、--model、--effort 和 --worktree；复用继承原会话的 Agent、模型与思考强度，不能宣称切换了模型或强度，也不能用另一个成员的终端代替。没有终端的成员按原生指南继续原会话。不能在旧写入者尚未结束时启动新写入者，不能把失败任务伪装完成。
不要自行提交、推送或合并。${workflow ? '启动/派发回执不明确时先停止相关派发，只读查证并按上述 flow.block 记录阻塞；不能因为超时重新启动。' : '启动/派发回执不明确时先查证，不能因为超时就重新启动。'}按回执指引处理权限、失败和阻塞。
派发后结束当前回合，等 Orca 唤醒；不要轮询收件箱。最终汇总必须包含：实际修改文件、验收标准逐项结果、实际执行的验证及结果、审核发现、未解决事项。每项结论给出真实证据；没有执行的验证明确标注未执行。

本次一次性用户需求：
${run.goal}

本次验收标准：
${run.acceptance?.trim() || '用户未单独填写。先根据需求提出可验证的验收标准，涉及关键取舍时向用户确认，不编造用户要求。'}`
}

export type NativeTask = { id: string; title: string; status: string }
export type NativeWorker = { taskId: string; dispatchId: string; state: string; terminal?: string; terminalState?: string }
const settledTasks: Record<string, true | undefined> = { completed: true, failed: true, cancelled: true, canceled: true }

const taskStates: Record<string, State | undefined> = {
  completed: 'done', failed: 'failed', cancelled: 'failed', canceled: 'failed', blocked: 'blocked',
  running: 'working', in_progress: 'working', dispatched: 'working',
  queued: 'queued', pending: 'queued', ready: 'queued', todo: 'queued', created: 'queued'
}
const workerStates: Record<string, State | undefined> = {
  blocked: 'blocked', waiting: 'waiting', failed: 'failed', cancelled: 'failed', canceled: 'failed',
  abandoned: 'failed', lost: 'failed', exited: 'failed', starting: 'starting', launching: 'starting',
  working: 'working', running: 'working'
}

function taskState(task: NativeTask, worker?: NativeWorker): State {
  // Task status is authoritative; terminal resource accounting is a separate lifecycle.
  const status = Object.hasOwn(taskStates, task.status) ? taskStates[task.status] : undefined
  if (status === 'done' || status === 'failed' || status === 'blocked') return status
  const live = worker && Object.hasOwn(workerStates, worker.state) ? workerStates[worker.state] : undefined
  if (live) return live
  if (status === 'working') return status
  return worker ? 'unknown' : status ?? 'unknown'
}

export function projectSteps(run: Run, lead: State, tasks: NativeTask[] = [], workers: NativeWorker[] = []): Step[] {
  const steps: Step[] = [{ memberId: 'lead', state: lead, terminal: run.leadTerminal }]
  for (const member of run.team.members) {
    const prefix = taskPrefix(run, member)
    const candidates = tasks.filter((task) => task.title.toLowerCase().startsWith(prefix.toLowerCase()))
    const boundId = run.taskIds && Object.hasOwn(run.taskIds, member.id) ? run.taskIds[member.id] : undefined
    const bound = boundId ? tasks.find((task) => task.id === boundId) : undefined
    if (bound && !candidates.some((task) => task.id === bound.id)) candidates.push(bound)
    const pending = candidates.filter((task) => settledTasks[task.status] !== true)
    let task: NativeTask | undefined
    if (pending.length === 1) task = pending[0]
    else if (pending.length === 0 && candidates.length === 1) task = candidates[0]
    else if (pending.length === 0 && candidates.length > 1) {
      // Orca worker-list guarantees newest-first order, including across cursor pages.
      const latest = workers.find((worker) => candidates.some((candidate) => candidate.id === worker.taskId))
      task = latest ? candidates.find((candidate) => candidate.id === latest.taskId) : undefined
    }
    if (!task) {
      const issue = candidates.length > 1 ? '同一成员存在多个无法唯一关联的任务，请查看主脑会话核实。' : boundId ? '已关联任务暂不可见，请刷新或查看主脑会话。' : undefined
      steps.push({ memberId: member.id, state: issue ? 'unknown' : 'queued', ...(issue ? { issue } : {}) })
      continue
    }
    const worker = workers.find((row) => row.taskId === task.id)
    const title = task.title.toLowerCase().startsWith(prefix.toLowerCase()) ? task.title.slice(prefix.length).trim() : task.title
    steps.push({
      memberId: member.id, state: taskState(task, worker), taskId: task.id, task: title,
      terminal: worker?.terminalState === 'released' ? undefined : worker?.terminal,
      dispatch: worker?.dispatchId
    })
  }
  return steps
}
