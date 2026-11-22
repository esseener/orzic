import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { readModelCatalog, type CatalogIo } from './model-catalog'

function io(overrides: Partial<CatalogIo> = {}): CatalogIo {
  return {
    codexCache: async () => { throw new Error('Unexpected cache read') },
    list: async () => { throw new Error('Unexpected CLI query') },
    ...overrides
  }
}

test('Codex exposes visible canonical IDs and names without leaking instruction metadata or inferring entitlement', async () => {
  const catalog = await readModelCatalog('codex', '/project', undefined, io({ list: async () => JSON.stringify({ models: [
    { slug: 'canonical-model', display_name: 'Friendly Model', visibility: 'list', supported_in_api: false, base_instructions: 'private_instruction_metadata' },
    { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
    { slug: 'none-model', visibility: 'none' },
    { slug: 'canonical-model', display_name: 'Duplicate', visibility: 'list' },
    { slug: '-invalid-option', visibility: 'list' },
    { slug: 'bad\nmodel', visibility: 'list' }
  ] }) }))
  deepEqual(catalog.models, [{ id: 'canonical-model', name: 'Friendly Model' }])
  equal(catalog.source, 'Codex CLI 模型目录')
  match(catalog.notice ?? '', /不是账号权限/)
  equal(JSON.stringify(catalog).includes('private_instruction_metadata'), false)
})

test('synthetic Codex effort metadata preserves ordered known and future levels without leaking nested fields', async () => {
  const boundary = 'a'.repeat(64)
  const catalog = await readModelCatalog('codex', '/project', undefined, io({ list: async () => JSON.stringify({ models: [{
    slug: 'synthetic-reasoning-model', display_name: 'Synthetic reasoning model',
    supported_reasoning_levels: [
      { effort: 'low', description: 'private_level_description' }, { effort: 'high' }, { effort: 'xhigh' },
      { effort: 'max' }, { effort: 'ultra' }, { effort: 'future-level_2' }, { effort: boundary }, { effort: 'low' },
      { effort: 'HIGH' }, { effort: '-high' }, { effort: ' high' }, { effort: 'high\n' },
      { effort: 'a'.repeat(65) }, { effort: '' }, { effort: 5 }, {}, null, 'medium'
    ],
    default_reasoning_level: 'ultra', base_instructions: 'private_model_instructions', api_key: 'private_credential'
  }] }) }))
  deepEqual(catalog.models, [{
    id: 'synthetic-reasoning-model', name: 'Synthetic reasoning model',
    efforts: ['low', 'high', 'xhigh', 'max', 'ultra', 'future-level_2', boundary], defaultEffort: 'ultra'
  }])
  equal(JSON.stringify(catalog).includes('private_'), false)
})

test('synthetic Codex metadata distinguishes unknown and empty support and includes only supported valid defaults', async () => {
  const catalog = await readModelCatalog('codex', '/project', undefined, io({ codexCache: async () => JSON.stringify({ models: [
    { slug: 'synthetic-unknown', default_reasoning_level: 'high' },
    { slug: 'synthetic-malformed', supported_reasoning_levels: {}, default_reasoning_level: 'high' },
    { slug: 'synthetic-empty', supported_reasoning_levels: [], default_reasoning_level: 'high' },
    { slug: 'synthetic-unsupported-default', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'high' },
    { slug: 'synthetic-invalid-default', supported_reasoning_levels: [{ effort: 'high\n' }, { effort: 'high' }], default_reasoning_level: 'high\n' },
    { slug: 'synthetic-invalid-levels', supported_reasoning_levels: [null, { effort: 1 }, { effort: 'HIGH' }] }
  ] }) }))
  deepEqual(catalog.models, [
    { id: 'synthetic-unknown', name: 'synthetic-unknown' },
    { id: 'synthetic-malformed', name: 'synthetic-malformed' },
    { id: 'synthetic-empty', name: 'synthetic-empty', efforts: [] },
    { id: 'synthetic-unsupported-default', name: 'synthetic-unsupported-default', efforts: ['low'] },
    { id: 'synthetic-invalid-default', name: 'synthetic-invalid-default', efforts: ['high'] },
    { id: 'synthetic-invalid-levels', name: 'synthetic-invalid-levels', efforts: [] }
  ])
})

test('a genuine Codex cache is a labeled fallback, never presented as a successful live query', async () => {
  const catalog = await readModelCatalog('codex', '/project', undefined, io({
    codexCache: async () => JSON.stringify({ models: [{ slug: 'cached-model', display_name: 'Cached Model', visibility: 'list' }] })
  }))
  deepEqual(catalog.models, [{ id: 'cached-model', name: 'Cached Model' }])
  equal(catalog.source, 'Codex 本机模型缓存')
  match(catalog.notice ?? '', /CLI 目录读取失败/)
  const absent = await readModelCatalog('codex', '/project', undefined, io({
    codexCache: async () => { throw Object.assign(new Error('Absent'), { code: 'ENOENT' }) }
  }))
  deepEqual(absent.models, [])
  match(absent.notice ?? '', /未猜测模型/)
})

test('OpenCode keeps exact provider-qualified options while excluding terminal decoration and unrelated output', async () => {
  const catalog = await readModelCatalog('opencode', '/project', undefined, io({ list: async () => [
    '\u001b[32mprovider/model-a\u001b[0m', 'provider/model-a', '', 'Loading catalog...',
    'https://not-a-model.example/catalog', 'other-provider/nested/model-b', 'not-a-model'
  ].join('\r\n') }))
  deepEqual(catalog.models, [
    { id: 'provider/model-a', name: 'provider/model-a' },
    { id: 'other-provider/nested/model-b', name: 'other-provider/nested/model-b' }
  ])
})

test('OMP choices retain provider identity, including model IDs that already contain a slash', async () => {
  const catalog = await readModelCatalog('omp', '/project', undefined, io({ list: async () => JSON.stringify({ models: [
    { provider: 'direct', id: 'model-a', name: 'Model A' },
    { provider: 'router', id: 'vendor/model-a', selector: 'router/exact-model-selection', name: 'Model A via router' },
    { provider: 'other', id: 'model-a', name: 'Other Model A' },
    { provider: 'direct', id: 'model-a', name: 'Duplicate' },
    { provider: 'missing-id' }
  ] }) }))
  deepEqual(catalog.models, [
    { id: 'direct/model-a', name: 'Model A' },
    { id: 'router/exact-model-selection', name: 'Model A via router' },
    { id: 'other/model-a', name: 'Other Model A' }
  ])
})

test('synthetic OMP thinking metadata respects explicit no-reasoning and preserves selectors without inference', async () => {
  const catalog = await readModelCatalog('omp', '/project', undefined, io({ list: async () => JSON.stringify({ models: [
    { provider: 'synthetic-router', id: 'vendor/model', selector: 'synthetic-router/exact:variant', name: 'Synthetic model',
      reasoning: true, thinking: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'future_2', 'high', 'HIGH', '', null, 3, 'high\n'],
      description: 'private_description', instructions: 'private_instructions', apiKey: 'private_credential' },
    { provider: 'synthetic', id: 'no-reasoning', reasoning: false, thinking: ['high'] },
    { provider: 'synthetic', id: 'no-reasoning-null', reasoning: false, thinking: null },
    { provider: 'synthetic', id: 'unknown-expensive-high', cost: { input: 999 } },
    { provider: 'synthetic', id: 'reasoning-unknown', reasoning: true, thinking: null },
    { provider: 'synthetic', id: 'empty', reasoning: true, thinking: [] },
    { provider: 'synthetic', id: 'malformed', thinking: 'high' },
    { provider: 'synthetic-router', id: 'vendor/model', selector: 'synthetic-router/exact:variant', thinking: ['low'] }
  ] }) }))
  deepEqual(catalog.models, [
    { id: 'synthetic-router/exact:variant', name: 'Synthetic model', efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'future_2'] },
    { id: 'synthetic/no-reasoning', name: 'synthetic/no-reasoning', efforts: [] },
    { id: 'synthetic/no-reasoning-null', name: 'synthetic/no-reasoning-null', efforts: [] },
    { id: 'synthetic/unknown-expensive-high', name: 'synthetic/unknown-expensive-high' },
    { id: 'synthetic/reasoning-unknown', name: 'synthetic/reasoning-unknown' },
    { id: 'synthetic/empty', name: 'synthetic/empty', efforts: [] },
    { id: 'synthetic/malformed', name: 'synthetic/malformed' }
  ])
  equal(JSON.stringify(catalog).includes('private_'), false)
})

test('a model beyond the native dropdown limit remains available for client-side name filtering', async () => {
  const models = Array.from({ length: 601 }, (_, index) => ({ provider: 'provider', id: `model-${index}`, name: `Model ${index}` }))
  const catalog = await readModelCatalog('omp', '/project', undefined, io({ list: async () => JSON.stringify({ models }) }))
  deepEqual(catalog.models.find((model) => model.id === 'provider/model-600'), { id: 'provider/model-600', name: 'Model 600' })
})

test('malformed structured catalogs fail explicitly and a cancelled query cannot return stale choices', async () => {
  await rejects(readModelCatalog('omp', '/project', undefined, io({ list: async () => '{invalid' })), /不是有效 JSON/)
  await rejects(readModelCatalog('codex', '/project', undefined, io({ list: async () => '{"models":{}}' })), /格式不受支持/)
  const controller = new AbortController()
  await rejects(readModelCatalog('opencode', '/project', controller.signal, io({ list: async () => {
    controller.abort(new Error('catalog cancelled'))
    return 'provider/late-model'
  } })), /catalog cancelled/)
})

test('Claude aliases are explicit non-entitlement presets and unknown Agents get no invented models', async () => {
  const claude = await readModelCatalog('claude', '/project', undefined, io())
  deepEqual(claude.models.map((model) => model.id), ['sonnet', 'opus', 'haiku'])
  match(claude.source, /官方模型别名/)
  match(claude.notice ?? '', /并非本机账号可用性检查/)
  match(claude.notice ?? '', /官方预设，并非本机能力检测/)
  match(claude.notice ?? '', /提供商、版本和组织策略可能改变实际生效强度/)
  ok(claude.models.every((model) => model.efforts === undefined && model.defaultEffort === undefined))
  const unknown = await readModelCatalog('unrecognized-agent', '/project', undefined, io())
  deepEqual(unknown.models, [])
  ok(unknown.notice?.includes('未猜测'))
})
