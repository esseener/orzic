import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ModelCatalog, ModelOption } from './protocol'

export type CatalogIo = {
  codexCache: (signal?: AbortSignal) => Promise<string>
  list: (agent: 'codex' | 'opencode' | 'omp', cwd: string, signal?: AbortSignal) => Promise<string>
}

const runFile = promisify(execFile)
const commands = {
  codex: ['debug', 'models'],
  opencode: ['models', '--pure'],
  omp: ['models', '--json', '--no-extensions']
}
const executables: Partial<Record<keyof typeof commands, string>> = {}
function executable(agent: keyof typeof commands, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return agent
  const cached = executables[agent]
  if (cached && existsSync(cached)) return cached
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const vendor = join(`codex-win32-${process.arch}`, 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe')
  const dirs = [...(env.PATH || env.Path || '').split(';'), join(env.APPDATA!, 'npm'), join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'omp')]
  for (const entry of dirs) {
    const dir = entry.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    const candidates = [join(dir, `${agent}.exe`)]
    if (agent === 'opencode') candidates.push(join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
    if (agent === 'codex') {
      candidates.push(join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', vendor))
      candidates.push(join(dir, 'node_modules', '@openai', vendor))
    }
    const found = candidates.find(existsSync)
    if (found) { executables[agent] = found; return found }
    if (existsSync(join(dir, `${agent}.cmd`))) break
  }
  throw new Error(`未能识别 ${agent} 的原生可执行文件，请确认本机 CLI 安装；不会改用其他程序。`)
}
const nativeIo: CatalogIo = {
  codexCache: (signal) => readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), { encoding: 'utf8', signal }),
  list: async (agent, cwd, signal) => {
    const spec = commands[agent]
    const windows = process.platform === 'win32'
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
    if (windows && !env.APPDATA) env.APPDATA = join(homedir(), 'AppData', 'Roaming')
    // Execute native programs directly: cancellation must not orphan a .cmd launcher child.
    try {
      const { stdout } = await runFile(executable(agent, env), spec,
        { cwd, env, signal, encoding: 'utf8', timeout: 12_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
      return stdout
    } catch (error) {
      signal?.throwIfAborted()
      const failure = error as NodeJS.ErrnoException & { killed?: boolean }
      const code = typeof failure.code === 'string' && /^[A-Z_]+$/.test(failure.code) ? failure.code : failure.killed ? 'timeout' : 'command_failed'
      // Provider stderr can contain private configuration; never send it to a panel.
      throw new Error(`读取 ${agent} 模型目录失败（${code}），请确认本机 CLI 可用后重新读取。`)
    }
  }
}

const accountNotice = '目录来自本机 CLI，不是账号权限或运行时生效证明；Orca 托管账号、Chat 模式及模型权限仍由启动时校验。'
const claudeAliases: ModelOption[] = [
  { id: 'sonnet', name: 'Claude Sonnet（官方别名）' },
  { id: 'opus', name: 'Claude Opus（官方别名）' },
  { id: 'haiku', name: 'Claude Haiku（官方别名）' }
]

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith('-')
}
function effort(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
}
function options(rows: { id: unknown; name?: unknown; efforts?: unknown; defaultEffort?: unknown }[]): ModelOption[] {
  const seen = new Set<string>()
  const result: ModelOption[] = []
  for (const row of rows) {
    if (!identifier(row.id) || seen.has(row.id)) continue
    seen.add(row.id)
    const name = typeof row.name === 'string' && row.name.trim() && !/[\u0000-\u001f\u007f]/.test(row.name) ? row.name.trim() : row.id
    const model: ModelOption = { id: row.id, name }
    if (Array.isArray(row.efforts)) {
      model.efforts = [...new Set(row.efforts.filter(effort))]
      if (effort(row.defaultEffort) && model.efforts.includes(row.defaultEffort)) model.defaultEffort = row.defaultEffort
    }
    result.push(model)
  }
  return result
}
function json(text: string, source: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(`${source}模型目录不是有效 JSON，请在对应 CLI 更新目录后重新读取。`) }
  const row = object(value)
  if (!row || !Array.isArray(row.models)) throw new Error(`${source}模型目录格式不受支持，未猜测或替换模型。`)
  return row
}

/** Catalog discovery never submits prompts or starts agent sessions. */
export async function readModelCatalog(agent: string, cwd: string, signal?: AbortSignal, io: CatalogIo = nativeIo): Promise<ModelCatalog> {
  signal?.throwIfAborted()
  if (agent === 'claude') return {
    agent, models: claudeAliases.map((model) => ({ ...model })), source: 'Claude 官方模型别名',
    notice: '别名由 Claude 映射到对应版本，并非本机账号可用性检查；思考强度选项是官方预设，并非本机能力检测，提供商、版本和组织策略可能改变实际生效强度；可在高级选项保留自定义模型。'
  }
  if (agent === 'codex') {
    let text: string
    let cached = false
    try { text = await io.list(agent, cwd, signal) } catch {
      signal?.throwIfAborted()
      try { text = await io.codexCache(signal); cached = true } catch (error) {
        signal?.throwIfAborted()
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {
          agent, models: [], source: 'Codex 目录暂不可读取',
          notice: 'CLI 模型目录读取失败，且没有已有缓存。请确认本机 Codex 可用后重新读取；未猜测模型。'
        }
        throw new Error('无法读取 Codex 目录或本机模型缓存，请检查该 CLI 与目录访问权限。')
      }
    }
    signal?.throwIfAborted()
    const rows = json(text, 'Codex').models as unknown[]
    const models = options(rows.flatMap((value) => {
      const row = object(value)
      return row && row.hidden !== true && (row.visibility === undefined || row.visibility === 'list')
        ? [{ id: row.slug, name: row.display_name,
          efforts: Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map((level) => object(level)?.effort) : undefined,
          defaultEffort: row.default_reasoning_level }] : []
    }))
    return { agent, models, source: cached ? 'Codex 本机模型缓存' : 'Codex CLI 模型目录',
      notice: `${cached ? 'CLI 目录读取失败，当前显示已有缓存；可修复 CLI 后重新读取。' : 'CLI 可能使用缓存或内置目录；该命令不启动会话或 app-server。'}${accountNotice}` }
  }
  if (agent === 'opencode') {
    const text = await io.list(agent, cwd, signal)
    signal?.throwIfAborted()
    const models = options(text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
      .map((line) => line.trim()).filter((line) => /^[\w.-]+\/[^\s]+$/.test(line)).map((id) => ({ id })))
    return { agent, models, source: 'OpenCode CLI 模型目录', notice: `按当前项目配置读取，未加载外部插件。${accountNotice}` }
  }
  if (agent === 'omp') {
    const text = await io.list(agent, cwd, signal)
    signal?.throwIfAborted()
    const rows = json(text, 'OMP').models as unknown[]
    const models = options(rows.flatMap((value) => {
      const row = object(value)
      if (!row) return []
      const efforts = row.reasoning === false ? [] : row.thinking
      if (identifier(row.selector)) return [{ id: row.selector, name: row.name, efforts }]
      return identifier(row.provider) && identifier(row.id) ? [{ id: `${row.provider}/${row.id}`, name: row.name, efforts }] : []
    }))
    return { agent, models, source: 'OMP CLI 模型目录', notice: `未加载外部扩展；扩展独有模型可用高级选项保留。${accountNotice}` }
  }
  return { agent, models: [], source: '暂无受支持的自动模型目录', notice: '未猜测该 Agent 的模型列表；可以沿用默认，或在支持模型参数时使用高级选项。' }
}
