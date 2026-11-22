import type { ExecutionPolicy, Plan } from './protocol'

export const defaultPolicy: ExecutionPolicy = {
  allowedPaths: ['.'], allowNetwork: false, allowDependencies: false, allowDeletion: false, maxReworks: 2
}

const controls = /[\u0000-\u001f\u007f-\u009f]/
const policyKeys = ['allowedPaths', 'allowNetwork', 'allowDependencies', 'allowDeletion', 'maxReworks']
const planKeys = ['summary', 'steps', 'paths', 'checks', 'risks']

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${label}必须是对象`)
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new Error(`${label}包含不支持的字段；计划版本只能由服务端生成`)
  }
  return value as Record<string, unknown>
}

function protectedPath(parts: string[]): boolean {
  return parts.some((part, index) => {
    const name = part.toLowerCase()
    return ['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.direnv', '.envrc', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.dockercfg', '.htpasswd', '.pgpass', '.my.cnf', 'secrets', '.secrets'].includes(name) ||
      /^\.env(?:[.-]|$)/.test(name) ||
      /^(?:credentials?|secrets?|private[-_]keys?|service[-_]accounts?)(?:[._-]|$)/.test(name) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name) ||
      /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/.test(name) ||
      (index > 0 && parts[index - 1].toLowerCase() === '.docker' && name === 'config.json') ||
      (index > 0 && parts[index - 1].toLowerCase() === '.config' && name === 'gcloud')
  })
}

// Literal scope validation is not a filesystem/symlink sandbox; workers still need native permissions.
function relativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || controls.test(value)) {
    throw new Error(`${label}必须是 1～240 字的项目相对字面路径，且不能包含控制字符`)
  }
  const path = value.replace(/\\/g, '/')
  if (path.startsWith('/') || /[:*?<>|"%]/.test(path)) {
    throw new Error(`${label}不能使用绝对路径、盘符、ADS、通配符或编码路径`)
  }
  if (path === '.') return path
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part !== part.trim() || part.endsWith('.'))) {
    throw new Error(`${label}不能包含空路径段、.、..、首尾空格或尾随点`)
  }
  if (parts.some((part) => /~[0-9]/.test(part))) throw new Error(`${label}不能使用可能绕过范围或私密文件检查的 Windows 短文件名`)
  if (parts.some((part) => /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(part.split('.')[0].trimEnd()))) {
    throw new Error(`${label}不能包含 Windows 保留设备名`)
  }
  if (protectedPath(parts)) throw new Error(`${label}不能包含 .git、凭证、密钥或环境私密文件`)
  return path
}

function paths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error(`${label}必须包含 1～32 条路径`)
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const path = relativePath(entry, label)
    const identity = path.toLowerCase()
    if (seen.has(identity)) throw new Error(`${label}不能包含重复路径或仅大小写不同的路径`)
    seen.add(identity)
    result.push(path)
  }
  return result
}

export function validatePolicy(value?: unknown): ExecutionPolicy {
  if (value === undefined) return { ...defaultPolicy, allowedPaths: [...defaultPolicy.allowedPaths] }
  const policy = record(value, policyKeys, '执行边界')
  for (const key of ['allowNetwork', 'allowDependencies', 'allowDeletion'] as const) {
    if (typeof policy[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
  }
  if (typeof policy.maxReworks !== 'number' || !Number.isInteger(policy.maxReworks) || policy.maxReworks < 0 || policy.maxReworks > 5) {
    throw new Error('最大返工轮次必须是 0～5 的整数')
  }
  return {
    allowedPaths: paths(policy.allowedPaths, '授权路径'),
    allowNetwork: policy.allowNetwork as boolean,
    allowDependencies: policy.allowDependencies as boolean,
    allowDeletion: policy.allowDeletion as boolean,
    maxReworks: policy.maxReworks
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || controls.test(value)) {
    throw new Error(`${label}必须是 1～${max} 字的非空文本，且不能包含控制字符`)
  }
  return value.trim()
}

function texts(value: unknown, label: string, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > 16) throw new Error(`${label}必须包含 ${min}～16 项`)
  const result: string[] = []
  for (const entry of value) result.push(text(entry, label, 1000))
  return result
}

export function validatePlan(value: unknown, policy: ExecutionPolicy, revision: number): Plan {
  const plan = record(value, planKeys, '计划')
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('计划版本必须是服务端生成的正整数')
  const scope = validatePolicy(policy).allowedPaths
  const plannedPaths = paths(plan.paths, '计划修改路径')
  for (const path of plannedPaths) {
    // Case-sensitive matching deliberately rejects case aliases across Windows and other hosts.
    if (!scope.some((allowed) => allowed === '.' || path === allowed || path.startsWith(`${allowed}/`))) {
      throw new Error(`计划修改路径「${path}」超出授权目录；请先由用户修改执行边界`)
    }
  }
  return {
    revision,
    summary: text(plan.summary, '计划摘要', 2000),
    steps: texts(plan.steps, '实施步骤', 1),
    paths: plannedPaths,
    checks: texts(plan.checks, '验收验证', 1),
    risks: texts(plan.risks, '风险清单', 0)
  }
}
