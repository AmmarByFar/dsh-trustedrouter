import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { Config, mergeBody as hostMerge, providerFor as hostProviderFor } from '../index.js'

/**
 * Evaluate client.js the way the browser does, a classic script calling
 * `window.__ModuleLoader__.load`, and run its factory with a React stub. The
 * factory only defines components, so the stub is never rendered. It runs in
 * this realm: the client's plain-object check compares prototypes, which a
 * separate vm context would not share with the test's objects.
 */
function loadClient() {
  let registration
  globalThis.window = { __ModuleLoader__: { load: r => { registration = r } } }
  try {
    vm.runInThisContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { filename: 'client.js' })
  } finally {
    delete globalThis.window
  }
  assert.equal(registration.id, 'dsh-trustedrouter')
  const React = { createElement: () => null }
  return registration.factory((specifier) => {
    assert.equal(specifier, 'react', 'the client may only require shared shell modules')
    return React
  })
}

const client = loadClient()

/** Plain copies, so values made in the vm context compare by structure. */
const plain = value => JSON.parse(JSON.stringify(value))

const endpoint = (provider, tier, extra = {}) => ({
  provider, provider_name: provider[0].toUpperCase() + provider.slice(1), privacy_tier: tier,
  usage_type: 'Credits', provider_headquarters_country: 'US', provider_us_based: true, ...extra,
})
const catalog = client.indexCatalog({
  data: [
    {
      id: 'z-ai/glm-5.3',
      trustedrouter: {
        endpoints: [
          endpoint('zai', 0, { provider_headquarters_country: 'SG', provider_us_based: false }),
          endpoint('deepinfra', 1),
          endpoint('nebius', 2, { provider_headquarters_country: 'NL', provider_us_based: false }),
          endpoint('tinfoil', 3),
          endpoint('privatemode', 3, { provider_headquarters_country: 'DE', provider_us_based: false }),
          endpoint('tinfoil', 3, { usage_type: 'BYOK' }),
        ],
      },
    },
    { id: 'no-endpoints' },
    { name: 'no id' },
    'garbage',
  ],
})

describe('client registration', () => {
  it('injects the services it uses and registers both slots', () => {
    assert.deepEqual(plain(client.inject), ['slots', 'locale', 'configForms'])
    const registered = []
    const effects = []
    const forms = []
    client.apply({
      effect: run => effects.push(run()),
      locale: { register: (...args) => { registered.push(['locale', ...args.slice(0, 2)]); return () => {} } },
      configForms: { get: (ns) => { forms.push(ns); return { ns } } },
      slots: {
        inject: (name, install) => install(),
        register: (options) => { registered.push([options.name, options.key, options.locale, Object.keys(options.inject())]) },
      },
    })
    assert.deepEqual(plain(forms), ['llm-pi-ai', 'trustedrouter'])
    assert.deepEqual(plain(registered), [
      ['locale', 'dsh-trustedrouter', 'en'],
      ['settings.models.provider-card', 'llm-pi-ai', 'dsh-trustedrouter', ['routes', 'policy', 'catalogs']],
      ['plugins.row.config', 'dsh-trustedrouter#trustedrouter', 'dsh-trustedrouter', ['policy']],
    ])
    for (const dispose of effects) dispose?.()
  })
})

describe('host parity', () => {
  const defaults = { min_privacy: 'zdr', only: ['a'], max_price: { prompt: '1' } }
  const models = { 'z-ai/glm-5.3': { min_privacy: 'confidential', max_price: { completion: '2' } }, constructor: { sort: 'price' } }
  for (const model of ['z-ai/glm-5.3', 'z-ai/glm-5.3:nitro', 'z-ai/glm-5.3:nitro:floor', 'other', 'other:nitro', 'constructor', 'toString']) {
    it(`resolves ${model} as the host does`, () => {
      assert.deepEqual(plain(client.providerFor(model, defaults, models)), hostProviderFor(model, defaults, models))
    })
  }
  it('merges as the host does', () => {
    const target = { a: 1, nested: { x: 1, list: [1] } }
    const patch = { nested: { y: 2, list: [2] }, b: 3 }
    assert.deepEqual(plain(client.mergeBody(target, patch)), hostMerge(target, patch))
  })
  it('names the overriding key', () => {
    assert.equal(client.overrideKey('z-ai/glm-5.3:nitro', models), 'z-ai/glm-5.3')
    assert.equal(client.overrideKey('toString', models), undefined)
  })
})

describe('routeCovered', () => {
  const gateways = ['https://api.trustedrouter.com/v1', 'not a url']
  const cases = [
    ['https://api.trustedrouter.com/v1', true],
    ['https://api.trustedrouter.com/v1/', true],
    ['https://api.trustedrouter.com/v1/extra', true],
    ['https://api.trustedrouter.com/v10', false],
    ['https://api.trustedrouter.com', false],
    ['http://api.trustedrouter.com/v1', false],
    ['https://api.trustedrouter.com:8443/v1', false],
    ['https://API.TrustedRouter.com/v1', true],
    ['nonsense', false],
  ]
  for (const [baseURL, expected] of cases) {
    it(`${baseURL} → ${expected}`, () => assert.equal(client.routeCovered(baseURL, gateways), expected))
  }
  it('matches nothing without gateways', () => assert.equal(client.routeCovered('https://api.trustedrouter.com/v1', []), false))
})

describe('catalog', () => {
  it('indexes only models with an id and tolerates missing fields', () => {
    assert.deepEqual([...catalog.keys()], ['z-ai/glm-5.3', 'no-endpoints'])
    assert.deepEqual(plain(catalog.get('no-endpoints')), { endpoints: [] })
    assert.equal(client.indexCatalog(null).size, 0)
    const [first] = client.indexCatalog({ data: [{ id: 'm', trustedrouter: { endpoints: [{ provider: 'p' }] } }] }).get('m').endpoints
    assert.equal(first.tier, 0)
  })
  it('falls back to the base model for a suffixed id', () => {
    assert.equal(client.catalogEntry(catalog, 'z-ai/glm-5.3:nitro'), catalog.get('z-ai/glm-5.3'))
    assert.equal(client.catalogEntry(catalog, 'unknown'), undefined)
    assert.equal(client.catalogEntry(undefined, 'z-ai/glm-5.3'), undefined)
  })
})

describe('levelChoices', () => {
  const entry = catalog.get('z-ai/glm-5.3')
  const names = (provider) => plain(client.levelChoices(entry, provider)).map(choice => [choice.level, choice.providers.map(p => p.provider)])

  it('lists the providers that meet each floor, one per provider', () => {
    assert.deepEqual(names({}), [
      ['any', ['zai', 'deepinfra', 'nebius', 'tinfoil', 'privatemode']],
      ['no_store', ['deepinfra', 'nebius', 'tinfoil', 'privatemode']],
      ['zdr', ['nebius', 'tinfoil', 'privatemode']],
      ['confidential', ['tinfoil', 'privatemode']],
    ])
  })
  it('applies only, ignore, usage and jurisdiction', () => {
    assert.deepEqual(names({ only: 'tinfoil, nebius', ignore: ['nebius'] }).map(([, p]) => p), [['tinfoil'], ['tinfoil'], ['tinfoil'], ['tinfoil']])
    assert.deepEqual(names({ usage: 'byok' }).map(([, p]) => p), [['tinfoil'], ['tinfoil'], ['tinfoil'], ['tinfoil']])
    assert.deepEqual(names({ usage: 'bring-your-own-key' }).map(([, p]) => p), [['tinfoil'], ['tinfoil'], ['tinfoil'], ['tinfoil']])
    assert.deepEqual(names({ jurisdiction: 'US' }).at(-1), ['confidential', ['tinfoil']])
    assert.deepEqual(names({ jurisdiction: 'nl' }).at(2), ['zdr', ['nebius']])
  })
  it('rules nothing out for a model the catalog does not know', () => {
    assert.deepEqual(plain(client.levelChoices(undefined, {})).map(choice => choice.providers), [undefined, undefined, undefined, undefined])
  })
  it('counts the providers that qualify under the floor and filters', () => {
    const qualifying = provider => plain(client.qualifyingProviders(entry, provider)).map(p => p.provider)
    assert.deepEqual(qualifying({ min_privacy: 'e2ee' }), ['tinfoil', 'privatemode'])
    assert.deepEqual(qualifying({ min_privacy: 'zdr', jurisdiction: 'us' }), ['tinfoil'])
    assert.deepEqual(qualifying({ min_privacy: 'confidential', only: ['zai'] }), [])
    assert.equal(client.qualifyingProviders(undefined, {}), undefined)
  })
  it('maps aliases to their levels', () => {
    assert.deepEqual(['any', 'no_store', 'zdr', 'confidential', 'e2e', 'e2ee', 'bogus', undefined].map(client.levelOf),
      ['any', 'no_store', 'zdr', 'confidential', 'confidential', 'confidential', undefined, undefined])
  })
})

describe('modelOps', () => {
  const empty = { min_privacy: '', only: [], ignore: [], sort: '', jurisdiction: '', usage: '' }
  const ops = (saved, draft) => plain(client.modelOps('z-ai/glm-5.3', saved, { ...empty, ...draft }))

  it('sets each changed field under the model id', () => {
    assert.deepEqual(ops(undefined, { min_privacy: 'confidential', only: ['tinfoil'] }), [
      { op: 'set', path: ['models', 'z-ai/glm-5.3', 'min_privacy'], value: 'confidential' },
      { op: 'set', path: ['models', 'z-ai/glm-5.3', 'only'], value: ['tinfoil'] },
    ])
  })
  it('writes nothing when nothing changed, including a comma string read back as a list', () => {
    assert.deepEqual(ops({ min_privacy: 'zdr', only: 'a, b' }, { min_privacy: 'zdr', only: ['a', 'b'] }), [])
  })
  it('unsets a cleared field while others remain', () => {
    assert.deepEqual(ops({ min_privacy: 'zdr', sort: 'price' }, { min_privacy: 'zdr' }), [
      { op: 'unset', path: ['models', 'z-ai/glm-5.3', 'sort'] },
    ])
  })
  it('unsets the model rather than leave {} behind', () => {
    assert.deepEqual(ops({ min_privacy: 'zdr', only: ['a'] }, {}), [{ op: 'unset', path: ['models', 'z-ai/glm-5.3'] }])
  })
  it('keeps the model when fields the page does not edit remain', () => {
    assert.deepEqual(ops({ min_privacy: 'zdr', max_price: { prompt: '1' } }, {}), [
      { op: 'unset', path: ['models', 'z-ai/glm-5.3', 'min_privacy'] },
    ])
  })
  it('writes a variant that inherits a base override as a whole key, keeping the base fields', () => {
    const inherited = { min_privacy: 'confidential', only: 'tinfoil', max_price: { prompt: '1' } }
    const variant = draft => plain(client.modelOps('z-ai/glm-5.3:nitro', undefined, { ...empty, ...draft }, inherited))
    // The editor starts from the inherited fields; unchanged, nothing is written.
    assert.deepEqual(variant({ min_privacy: 'confidential', only: ['tinfoil'] }), [])
    assert.deepEqual(variant({ min_privacy: 'confidential', only: ['tinfoil'], sort: 'price' }), [{
      op: 'set', path: ['models', 'z-ai/glm-5.3:nitro'],
      value: { min_privacy: 'confidential', only: ['tinfoil'], max_price: { prompt: '1' }, sort: 'price' },
    }])
    // Clearing every field still writes the key: {} there opts the variant out of the base settings.
    assert.deepEqual(variant({}), [{ op: 'set', path: ['models', 'z-ai/glm-5.3:nitro'], value: { max_price: { prompt: '1' } } }])
    assert.deepEqual(plain(client.modelOps('m:nitro', undefined, empty, { only: ['a'] })), [{ op: 'set', path: ['models', 'm:nitro'], value: {} }])
  })
  it('turns the US switch into jurisdiction "us"', () => {
    assert.deepEqual(ops(undefined, { jurisdiction: 'us' }), [{ op: 'set', path: ['models', 'z-ai/glm-5.3', 'jurisdiction'], value: 'us' }])
  })
})

describe('pageOps', () => {
  const settings = plain(Object.fromEntries(Object.entries(Config({ defaults: { max_price: { prompt: '1' } } })).map(([key, ref]) => [key, ref.get()])))

  it('writes gateways one per line', () => {
    const { ops, errors } = client.pageOps(settings, { gateways: ' https://a.example/v1 \n\nhttps://b.example/v1\n' })
    assert.deepEqual(plain(errors), {})
    assert.deepEqual(plain(ops), [{ op: 'set', path: ['gateways'], value: ['https://a.example/v1', 'https://b.example/v1'] }])
  })
  it('refuses a gateway the host schema would refuse', () => {
    assert.deepEqual(plain(client.pageOps(settings, { gateways: 'https://a.example/v1?x=1' }).errors), { gateways: ['page.invalidURL'] })
  })
  it('sets and unsets defaults field by field', () => {
    const { ops } = client.pageOps(settings, { min_privacy: 'zdr', only: 'tinfoil, privatemode', ignore: '', allow_fallbacks: 'false', jurisdiction: true, sort: '' })
    assert.deepEqual(plain(ops), [
      { op: 'set', path: ['defaults', 'min_privacy'], value: 'zdr' },
      { op: 'set', path: ['defaults', 'only'], value: ['tinfoil', 'privatemode'] },
      { op: 'unset', path: ['defaults', 'ignore'] },
      { op: 'set', path: ['defaults', 'allow_fallbacks'], value: false },
      { op: 'set', path: ['defaults', 'jurisdiction'], value: 'us' },
      { op: 'unset', path: ['defaults', 'sort'] },
    ])
  })
  it('writes max_price whole from its two inputs', () => {
    assert.deepEqual(plain(client.pageOps(settings, { max_completion: '0.4' }).ops), [
      { op: 'set', path: ['defaults', 'max_price'], value: { prompt: '1', completion: '0.4' } },
    ])
    assert.deepEqual(plain(client.pageOps(settings, { max_prompt: '' }).ops), [{ op: 'unset', path: ['defaults', 'max_price'] }])
    assert.deepEqual(plain(client.pageOps(settings, { max_prompt: '1e3' }).errors), { max_prompt: ['page.invalidPrice'] })
  })
  it('keeps max_price sub-keys the page does not show', () => {
    const withRequest = { ...settings, defaults: { max_price: { prompt: '1', request: '0.01' } } }
    assert.deepEqual(plain(client.pageOps(withRequest, { max_completion: '0.4' }).ops), [
      { op: 'set', path: ['defaults', 'max_price'], value: { prompt: '1', request: '0.01', completion: '0.4' } },
    ])
    assert.deepEqual(plain(client.pageOps(withRequest, { max_prompt: '' }).ops), [
      { op: 'set', path: ['defaults', 'max_price'], value: { request: '0.01' } },
    ])
  })
  it('checks the JSON fields and names a bad provider field', () => {
    const errors = edits => plain(client.pageOps(settings, edits).errors)
    assert.deepEqual(errors({ models: '{' }), { models: ['page.invalidJSON'] })
    assert.deepEqual(errors({ models: '[]' }), { models: ['page.invalidModels'] })
    assert.deepEqual(errors({ models: '{"m": {"min_privacy": "bogus"}}' }).models[1], { where: 'm', field: 'min_privacy', expected: 'one of any, no_store, zdr, confidential' })
    assert.deepEqual(errors({ rules: '[{"baseURL": "https://a.example/v1"}]' }), { rules: ['page.invalidRule', { index: 1 }] })
    assert.deepEqual(errors({ models: '{"m": {"min_privacy": "e2ee", "sort": {"by": "price", "partition": "none"}, "custom_option": 1}}' }), {})
  })
  it('clears models and rules with an empty box', () => {
    assert.deepEqual(plain(client.pageOps(settings, { models: ' ', rules: '' }).ops), [
      { op: 'set', path: ['models'], value: {} },
      { op: 'set', path: ['rules'], value: [] },
    ])
  })
})

describe('providerProblem agrees with the host schema', () => {
  const samples = [
    { min_privacy: 'confidential' }, { min_privacy: 'e2e' }, { min_privacy: 'nope' },
    { usage: 'prepaid' }, { usage: 'free' }, { sort: 'latency' }, { sort: 'cheapest' },
    { sort: { by: 'price', partition: 'model' } }, { sort: { by: 'price', partition: 'all' } },
    { only: 'a,b' }, { only: ['a', 1] }, { allow_fallbacks: 'yes' }, { data_collection: 'deny' },
    { max_price: { prompt: 1, completion: '2' } }, { max_price: { prompt: true } }, { unknown_field: [1] },
  ]
  for (const provider of samples) {
    it(JSON.stringify(provider), () => {
      let hostAccepts = true
      try {
        Config({ models: { m: provider } })
      } catch {
        hostAccepts = false
      }
      assert.equal(client.providerProblem(provider) === undefined, hostAccepts)
    })
  }
})

describe('createCatalogs', () => {
  it('fetches each URL once and publishes the index', async () => {
    const fetched = []
    const catalogs = client.createCatalogs(async (url) => {
      fetched.push(url)
      return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) }
    })
    let published = 0
    catalogs.subscribe(() => { published += 1 })
    catalogs.load('https://a.example/v1/models')
    catalogs.load('https://a.example/v1/models')
    assert.equal(catalogs.get('https://a.example/v1/models').status, 'loading')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(fetched, ['https://a.example/v1/models'])
    assert.equal(catalogs.get('https://a.example/v1/models').status, 'ready')
    assert.ok(catalogs.get('https://a.example/v1/models').models.has('m'))
    assert.equal(published, 2)
  })
  it('records a failure and stops publishing once disposed', async () => {
    const catalogs = client.createCatalogs(async () => ({ ok: false, status: 503 }))
    catalogs.load('https://a.example/v1/models')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(plain(catalogs.get('https://a.example/v1/models')), { status: 'error', error: 'HTTP 503' })
    catalogs.dispose()
    catalogs.load('https://b.example/v1/models')
    assert.equal(catalogs.get('https://b.example/v1/models'), undefined)
  })
})

describe('routeModels and valueAt', () => {
  it('reads model ids from a pi-ai route', () => {
    assert.deepEqual(plain(client.routeModels({ models: [{ id: 'a' }, 'b', { id: 'a' }, {}, null] })), ['a', 'b'])
    assert.deepEqual(plain(client.routeModels(undefined)), [])
  })
  it('walks own keys only', () => {
    const root = { providers: { trustedrouter: { baseURL: 'x' } } }
    assert.deepEqual(plain(client.valueAt(root, ['providers', 'trustedrouter'])), { baseURL: 'x' })
    assert.equal(client.valueAt(root, ['providers', 'constructor']), undefined)
  })
})

describe('copy', () => {
  it('has every key the client asks for', () => {
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const keys = new Set([...source.matchAll(/\bt\(\s*'([a-zA-Z.]+)'/g)].map(match => match[1]))
    for (const key of [...source.matchAll(/'((?:page|editor|section|summary)\.[a-zA-Z]+)'/g)].map(match => match[1])) keys.add(key)
    for (const level of client.LEVELS) keys.add(`level.${level}`)
    const missing = [...keys].filter(key => !Object.hasOwn(client.EN, key))
    assert.deepEqual(missing, [])
  })
})
