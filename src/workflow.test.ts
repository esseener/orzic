import { strict as assert } from 'node:assert'
import { test } from 'orca/testing'
import { defaultPolicy, validatePlan, validatePolicy } from './workflow'
import type { ExecutionPolicy } from './protocol'

function plan() {
  return { summary: '修复设置页', steps: ['修复表单校验'], paths: ['src/settings.ts'], checks: ['运行设置页单元测试'], risks: [] as string[] }
}

function policy(allowedPaths = ['.']): ExecutionPolicy { return { ...defaultPolicy, allowedPaths } }

function rejectsPath(path: string) {
  assert.throws(() => validatePolicy(policy([path])), Error, `policy path: ${JSON.stringify(path)}`)
  assert.throws(() => validatePlan({ ...plan(), paths: [path] }, policy(), 1), Error, `plan path: ${JSON.stringify(path)}`)
}

test('default policy is restrictive and each result owns independent mutable arrays', () => {
  const first = validatePolicy()
  const second = validatePolicy()
  assert.deepEqual(first, { allowedPaths: ['.'], allowNetwork: false, allowDependencies: false, allowDeletion: false, maxReworks: 2 })
  first.allowedPaths.push('src')
  first.maxReworks = 5
  assert.deepEqual(second, defaultPolicy)
  assert.notEqual(first.allowedPaths, second.allowedPaths)
  assert.notEqual(second.allowedPaths, defaultPolicy.allowedPaths)
})

test('policy rejects missing fields, coercions, unknown fields and invalid rework limits', () => {
  for (const value of [null, false, [], 'policy', {}, { ...policy(), extra: true }, { ...policy(), allowedPaths: undefined }]) {
    assert.throws(() => validatePolicy(value), Error)
  }
  for (const key of ['allowNetwork', 'allowDependencies', 'allowDeletion'] as const) {
    for (const value of [undefined, null, 0, 1, 'false', 'true']) {
      assert.throws(() => validatePolicy({ ...policy(), [key]: value }), /布尔值/)
    }
  }
  for (const value of [-1, 6, 0.5, NaN, Infinity, '2', null, undefined]) {
    assert.throws(() => validatePolicy({ ...policy(), maxReworks: value }), /返工/)
  }
  for (const maxReworks of [0, 5]) assert.equal(validatePolicy({ ...policy(), maxReworks }).maxReworks, maxReworks)
})

test('literal paths reject traversal, absolute and Windows aliases in both policy and plans', () => {
  for (const path of [
    '/src/file.ts', '\\src\\file.ts', '\\\\server\\share', 'C:/src', 'C:src', 'src/../private', '../src',
    'src/./file', './src', 'src//file', 'src/', 'src\\..\\private', 'src/file:stream', 'src/*', 'src/?.ts',
    'src/file\n.ts', 'src/file\u0000.ts', 'src/file\u007f.ts', 'src/file\u0085.ts',
    'src/file.', 'src/file ', ' src/file', 'src/ file', 'src/.. ', 'src/...',
    'src/CON', 'src/con.txt', 'src/con .txt', 'src/NUL.json', 'src/COM1', 'src/lpt9.log', 'src/COM¹.txt',
    'src/CONIN$', 'src/CONOUT$.txt', 'src/%2e%2e/private', 'src/<file>', 'ENV~1.PRO', 'src/PRIVAT~1.json'
  ]) rejectsPath(path)
})

test('protected metadata and common credential, private key and environment paths cannot be authorized', () => {
  for (const path of [
    '.git', '.GIT/config', 'nested/.git/hooks/pre-commit', '.env', '.ENV.local', 'src/.env.production', '.ssh/id_rsa',
    '.aws/credentials', '.azure/tokens.json', '.kube/config', '.gnupg/private-keys-v1.d', '.npmrc', '.pypirc', '.netrc',
    '.git-credentials', '.docker/config.json', '.config/gcloud/credentials.db', '.direnv/cache', '.envrc',
    'config/credentials.json', 'config/SECRETS.yaml', 'secrets/token.txt', 'id_ed25519', 'cert/private.KEY', 'cert/key.pfx',
    '.env-development', '.htpasswd', '.pgpass', '.my.cnf', 'config/private_key.json', 'config/service-account.json'
  ]) rejectsPath(path)
})

test('scope containment uses path segments and conservative case matching, not string prefixes', () => {
  const scope = policy(['src', 'docs/reference'])
  assert.deepEqual(validatePlan({ ...plan(), paths: ['src', 'src/nested/file.ts', 'docs\\reference\\intro.txt'] }, scope, 4).paths,
    ['src', 'src/nested/file.ts', 'docs/reference/intro.txt'])
  for (const path of ['src-other/file.ts', 'docs/references/file.ts', 'docs', '.', 'SRC/file.ts', 'src/../docs/file.ts']) {
    assert.throws(() => validatePlan({ ...plan(), paths: [path] }, scope, 1), Error)
  }
  assert.equal(validatePlan({ ...plan(), paths: ['README.md'] }, policy(), 1).paths[0], 'README.md')
})

test('path lists enforce limits and reject duplicates, including Windows case collisions', () => {
  for (const paths of [[], Array.from({ length: 33 }, (_, n) => `src/file${n}.ts`), ['src', 'src'], ['src', 'SRC'], [null], [5], ['x'.repeat(241)]]) {
    assert.throws(() => validatePolicy({ ...policy(), allowedPaths: paths }), Error)
    assert.throws(() => validatePlan({ ...plan(), paths }, policy(), 1), Error)
  }
  const paths = Array.from({ length: 32 }, (_, n) => `src/file${n}.ts`)
  assert.equal(validatePolicy(policy(paths)).allowedPaths.length, 32)
  assert.equal(validatePlan({ ...plan(), paths }, policy(), 1).paths.length, 32)
  assert.equal(validatePolicy(policy(['x'.repeat(240)])).allowedPaths[0].length, 240)
})

test('plans require real implementation steps and acceptance checks, with explicit risk lists', () => {
  for (const key of ['summary', 'steps', 'paths', 'checks', 'risks'] as const) {
    const value: Record<string, unknown> = plan()
    delete value[key]
    assert.throws(() => validatePlan(value, policy(), 1), Error)
  }
  for (const key of ['steps', 'checks', 'risks'] as const) {
    for (const value of [null, 'not an array', [null], [''], ['   '], ['x'.repeat(1001)], ['line\ntext'], Array(17).fill('text')]) {
      assert.throws(() => validatePlan({ ...plan(), [key]: value }, policy(), 1), Error)
    }
  }
  for (const key of ['steps', 'checks']) assert.throws(() => validatePlan({ ...plan(), [key]: [] }, policy(), 1), Error)
  for (const summary of ['', ' ', 1, 'x'.repeat(2001), 'text\u0000']) {
    assert.throws(() => validatePlan({ ...plan(), summary }, policy(), 1), Error)
  }
  assert.deepEqual(validatePlan(plan(), policy(), 1).risks, [])
  assert.equal(validatePlan({ ...plan(), summary: 'x'.repeat(2000), steps: Array(16).fill('x'.repeat(1000)), checks: Array(16).fill('验收'), risks: Array(16).fill('风险') }, policy(), 1).steps.length, 16)
})

test('plan revisions are server-owned and malformed plan envelopes never silently pass', () => {
  for (const value of [null, [], false, 'plan', { ...plan(), revision: 999 }, { ...plan(), hiddenPermission: true }]) {
    assert.throws(() => validatePlan(value, policy(), 1), Error)
  }
  for (const revision of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validatePlan(plan(), policy(), revision), /版本/)
  }
  assert.equal(validatePlan(plan(), policy(), 7).revision, 7)
})

test('normalization and returned plans never mutate or retain caller-owned arrays', () => {
  const inputPolicy = Object.freeze({ ...policy(), allowedPaths: Object.freeze(['src\\nested']) })
  const validatedPolicy = validatePolicy(inputPolicy)
  assert.deepEqual(validatedPolicy.allowedPaths, ['src/nested'])
  assert.deepEqual(inputPolicy.allowedPaths, ['src\\nested'])
  const input = Object.freeze({ ...plan(), paths: Object.freeze(['src\\nested\\settings.ts']), steps: Object.freeze(['修改']), checks: Object.freeze(['测试']), risks: Object.freeze(['回归风险']) })
  const result = validatePlan(input, validatedPolicy, 3)
  result.paths.push('src/nested/other.ts')
  result.steps.push('额外步骤')
  result.checks.push('额外检查')
  result.risks.push('额外风险')
  validatedPolicy.allowedPaths.push('docs')
  assert.deepEqual(input.paths, ['src\\nested\\settings.ts'])
  assert.deepEqual(input.steps, ['修改'])
  assert.deepEqual(input.checks, ['测试'])
  assert.deepEqual(input.risks, ['回归风险'])
  assert.deepEqual(inputPolicy.allowedPaths, ['src\\nested'])
})
