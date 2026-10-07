import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, afterEach, before, describe, it } from 'node:test'
import { apply, Config, DEFAULT_GATEWAY, mergeBody, providerFor } from '../index.js'

/** Echo server: replies with the method, path, content-length, and raw body it received. */
let server
let base
before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ method: req.method, path: req.url, length: req.headers['content-length'], raw }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

/** Resolve raw config through the real schema into plain values. */
function resolve(raw) {
  return Object.fromEntries(Object.entries(Config(raw)).map(([key, ref]) => [key, ref.get()]))
}

/**
 * Mount the plugin against a minimal ctx. Config fields are volatile-style
 * references over values that `update` replaces, the way a UI save does.
 */
const disposers = []
const printed = []
const consoleError = console.error
function mount(raw) {
  let current = resolve(raw)
  const config = Object.fromEntries(Object.keys(current).map(key => [key, { get: () => current[key] }]))
  const listeners = []
  console.error = line => printed.push(line)
  apply({
    effect: execute => disposers.push(execute()),
    on: (event, listener) => { if (event === 'loader/volatile-update') listeners.push(listener) },
  }, config)
  return {
    lines: printed,
    update(next) {
      current = resolve(next)
      for (const listener of listeners) listener()
    },
  }
}
afterEach(() => {
  while (disposers.length) disposers.pop()()
  console.error = consoleError
  printed.length = 0
})

async function post(url, body, init = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...init })
  return res.json()
}

/** POST a JSON body under the test gateway and return the body the server received. */
async function sent(body, path = '/v1/chat/completions') {
  return JSON.parse((await post(`${base}${path}`, JSON.stringify(body))).raw)
}

describe('mergeBody', () => {
  it('merges nested objects and lets the patch win conflicts', () => {
    const merged = mergeBody(
      { model: 'm', provider: { order: ['a'], min_privacy: 'any' }, tags: [1] },
      { provider: { min_privacy: 'confidential' }, tags: [2] },
    )
    assert.deepEqual(merged, { model: 'm', provider: { order: ['a'], min_privacy: 'confidential' }, tags: [2] })
  })
})

describe('providerFor', () => {
  const defaults = { min_privacy: 'zdr', only: ['a', 'b'] }
  const models = { 'z-ai/glm-5.3': { min_privacy: 'confidential', only: ['tinfoil'] }, 'z-ai/glm-5.3:floor': { sort: 'price' } }

  it('returns the defaults for a model without an override', () => {
    assert.deepEqual(providerFor('other/model', defaults, models), defaults)
  })

  it('merges the model override over the defaults, replacing lists', () => {
    assert.deepEqual(providerFor('z-ai/glm-5.3', defaults, models), { min_privacy: 'confidential', only: ['tinfoil'] })
  })

  it('falls back to the base model for a suffixed model, but an exact override wins', () => {
    assert.deepEqual(providerFor('z-ai/glm-5.3:nitro', defaults, models), { min_privacy: 'confidential', only: ['tinfoil'] })
    assert.deepEqual(providerFor('z-ai/glm-5.3:floor', defaults, models), { ...defaults, sort: 'price' })
  })

  it('ignores inherited object keys and non-string models', () => {
    assert.deepEqual(providerFor('constructor', defaults, models), defaults)
    assert.deepEqual(providerFor('toString:nitro', defaults, models), defaults)
    assert.deepEqual(providerFor(undefined, defaults, models), defaults)
  })
})

describe('fetch wrapper', () => {
  const gateway = () => `${base}/v1`

  it('sets provider from the defaults on a POST under a gateway', async () => {
    mount({ gateways: [gateway()], defaults: { min_privacy: 'zdr' } })
    const body = { model: 'z-ai/glm-5.3', messages: [], stream: true }
    assert.deepEqual(await sent(body), { ...body, provider: { min_privacy: 'zdr' } })
  })

  it('applies the per-model override on top of the defaults', async () => {
    mount({
      gateways: [`${gateway()}/`],
      defaults: { min_privacy: 'zdr', sort: 'price' },
      models: { 'z-ai/glm-5.3': { min_privacy: 'confidential', only: ['tinfoil', 'privatemode'] } },
    })
    assert.deepEqual((await sent({ model: 'z-ai/glm-5.3' })).provider,
      { min_privacy: 'confidential', sort: 'price', only: ['tinfoil', 'privatemode'] })
    assert.deepEqual((await sent({ model: 'anthropic/claude-haiku-4.5' })).provider, { min_privacy: 'zdr', sort: 'price' })
  })

  it('keeps provider keys the request set, with the policy winning conflicts', async () => {
    mount({ gateways: [gateway()], defaults: { min_privacy: 'confidential' } })
    assert.deepEqual(await sent({ provider: { only: ['tinfoil'], min_privacy: 'any' } }, '/v1/responses'),
      { provider: { only: ['tinfoil'], min_privacy: 'confidential' } })
    assert.deepEqual(await sent({ provider: 'tinfoil' }), { provider: { min_privacy: 'confidential' } })
  })

  it('sends the body untouched when its model has no policy', async () => {
    mount({ gateways: [gateway()], models: { 'z-ai/glm-5.3': { min_privacy: 'confidential' } } })
    const original = JSON.stringify({ model: 'other/model', messages: [] })
    assert.equal((await post(`${gateway()}/chat/completions`, original)).raw, original)
  })

  it('passes everything through when no policy or rule is configured', async () => {
    mount({ gateways: [gateway()] })
    assert.equal((await post(`${gateway()}/chat/completions`, 'not json')).raw, 'not json')
  })

  it('drops a stale content-length so the server reads the whole new body', async () => {
    mount({ gateways: [gateway()], defaults: { min_privacy: 'confidential' } })
    const original = JSON.stringify({ model: 'm' })
    const echo = await post(`${gateway()}/chat/completions`, original, { headers: { 'content-length': String(original.length) } })
    assert.equal(Number(echo.length), Buffer.byteLength(echo.raw))
    assert.deepEqual(JSON.parse(echo.raw), { model: 'm', provider: { min_privacy: 'confidential' } })
  })

  it('handles a Request object and a byte body', async () => {
    mount({ gateways: [gateway()], defaults: { min_privacy: 'confidential' } })
    const res = await fetch(new Request(`${gateway()}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm' }) }))
    assert.deepEqual(JSON.parse((await res.json()).raw), { model: 'm', provider: { min_privacy: 'confidential' } })
    const echo = await post(`${gateway()}/chat/completions`, new TextEncoder().encode(JSON.stringify({ model: 'b' })))
    assert.deepEqual(JSON.parse(echo.raw), { model: 'b', provider: { min_privacy: 'confidential' } })
  })

  it('leaves other URLs, sibling path prefixes, and GETs alone', async () => {
    mount({ gateways: [gateway()], defaults: { min_privacy: 'confidential' } })
    const body = JSON.stringify({ model: 'm' })
    assert.equal((await post(`${base}/v2/chat/completions`, body)).raw, body)
    assert.equal((await post(`${base}/v10/chat/completions`, body)).raw, body)
    const listing = await (await fetch(`${gateway()}/models`)).json()
    assert.equal(listing.method, 'GET')
    assert.equal(listing.raw, '')
  })

  it('matches any of several gateways', async () => {
    mount({ gateways: [DEFAULT_GATEWAY, `${base}/eu/v1`], defaults: { min_privacy: 'zdr' } })
    assert.deepEqual((await sent({ model: 'm' }, '/eu/v1/chat/completions')).provider, { min_privacy: 'zdr' })
    assert.equal((await sent({ model: 'm' })).provider, undefined)
  })

  it('refuses a matching POST whose body is not a JSON object, and says so on stderr', async () => {
    const { lines } = mount({ gateways: [gateway()], models: { m: { min_privacy: 'confidential' } } })
    await assert.rejects(post(`${gateway()}/chat/completions`, 'not json'), /refusing POST .*provider cannot be added/)
    await assert.rejects(post(`${gateway()}/chat/completions`, '[1,2]'), /not a JSON object/)
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^\[trustedrouter\] trustedrouter: refusing POST /)
  })

  it('merges rules after the provider policy, on any URL under their baseURL', async () => {
    mount({
      gateways: [gateway()],
      defaults: { min_privacy: 'zdr' },
      rules: [{ baseURL: base, body: { provider: { min_privacy: 'confidential' }, user: 'u1' } }],
    })
    assert.deepEqual(await sent({ model: 'm' }), { model: 'm', provider: { min_privacy: 'confidential' }, user: 'u1' })
    assert.deepEqual(await sent({ model: 'm' }, '/v2/chat'), { model: 'm', provider: { min_privacy: 'confidential' }, user: 'u1' })
    await assert.rejects(post(`${base}/v2/chat`, 'nope'), /refusing POST .*provider, user cannot be added/)
  })

  it('reads the config on every request, so a save applies without a remount', async () => {
    const plugin = mount({ gateways: [gateway()], defaults: { min_privacy: 'zdr' } })
    assert.deepEqual((await sent({ model: 'm' })).provider, { min_privacy: 'zdr' })
    plugin.update({ gateways: [gateway()], defaults: { min_privacy: 'zdr' }, models: { m: { min_privacy: 'confidential' } } })
    assert.deepEqual((await sent({ model: 'm' })).provider, { min_privacy: 'confidential' })
    plugin.update({ gateways: [], defaults: { min_privacy: 'zdr' } })
    assert.equal((await sent({ model: 'm' })).provider, undefined)
  })

  it('restores the original fetch on unload', () => {
    const original = globalThis.fetch
    mount({ defaults: { min_privacy: 'confidential' } })
    assert.notEqual(globalThis.fetch, original)
    disposers.pop()()
    assert.equal(globalThis.fetch, original)
  })

  it('becomes a pass-through when unloaded under another wrapper', async () => {
    const original = globalThis.fetch
    mount({ gateways: [gateway()], defaults: { min_privacy: 'confidential' } })
    const ours = globalThis.fetch
    globalThis.fetch = (input, init) => ours(input, init)
    try {
      disposers.pop()()
      const body = JSON.stringify({ model: 'm' })
      assert.equal((await post(`${gateway()}/chat/completions`, body)).raw, body)
    } finally {
      globalThis.fetch = original
    }
  })

  it('prints the policy and each change only when log is on, never the body', async () => {
    const plugin = mount({ log: true, gateways: [gateway()], defaults: { min_privacy: 'zdr' }, models: { 'z-ai/glm-5.3': { min_privacy: 'confidential' } } })
    await post(`${gateway()}/chat/completions`, JSON.stringify({ model: 'z-ai/glm-5.3', messages: [{ role: 'user', content: 'secret' }] }))
    plugin.update({ log: true, gateways: [gateway()], models: { 'z-ai/glm-5.3': { min_privacy: 'confidential' } } })
    await post(`${gateway()}/chat/completions`, JSON.stringify({ model: 'other', messages: [{ role: 'user', content: 'secret' }] }))
    assert.deepEqual(plugin.lines, [
      `[trustedrouter] provider policy for POSTs under ${gateway()}: defaults {"min_privacy":"zdr"}, overrides for z-ai/glm-5.3`,
      `[trustedrouter] added provider to POST ${gateway()}/chat/completions for z-ai/glm-5.3: {"min_privacy":"confidential"}`,
      `[trustedrouter] provider policy for POSTs under ${gateway()}: defaults {}, overrides for z-ai/glm-5.3`,
      `[trustedrouter] no provider policy for other; POST ${gateway()}/chat/completions sent unchanged`,
    ])
    assert.ok(plugin.lines.every(line => !line.includes('secret')))
  })

  it('prints rules and the absence of gateways when log is on', async () => {
    const { lines } = mount({ log: true, gateways: [], rules: [{ baseURL: `${base}/v1`, body: { user: 'u1' } }] })
    await post(`${gateway()}/chat/completions`, JSON.stringify({ model: 'm' }))
    assert.deepEqual(lines, [
      '[trustedrouter] no gateways configured; no provider policy is applied',
      `[trustedrouter] merging {"user":"u1"} into POST bodies under ${base}/v1`,
      `[trustedrouter] added user to POST ${gateway()}/chat/completions (rule for ${base}/v1)`,
    ])
  })

  it('prints nothing when log is off', async () => {
    const { lines } = mount({ gateways: [gateway()], defaults: { min_privacy: 'confidential' } })
    await post(`${gateway()}/chat/completions`, JSON.stringify({ model: 'm' }))
    assert.deepEqual(lines, [])
  })
})

describe('Config', () => {
  const message = (raw) => {
    try {
      Config(raw)
    } catch (thrown) {
      return thrown.message
    }
    return ''
  }

  it('defaults to the TrustedRouter gateway with no policy', () => {
    assert.deepEqual(resolve(undefined), { gateways: [DEFAULT_GATEWAY], defaults: {}, models: {}, rules: [], log: false })
  })

  it('keeps unset optional fields absent instead of filling them in', () => {
    assert.deepEqual(resolve({ defaults: { min_privacy: 'zdr' }, models: { m: { only: 'tinfoil' } } }).models, { m: { only: 'tinfoil' } })
    assert.deepEqual(resolve({ defaults: { min_privacy: 'zdr' } }).defaults, { min_privacy: 'zdr' })
  })

  it('accepts every documented provider field', () => {
    const provider = {
      only: ['tinfoil'], ignore: 'a,b', order: ['c'], allow_fallbacks: false,
      sort: { by: 'throughput', partition: 'none' }, require_parameters: true,
      max_price: { prompt: '0.15', completion: 0.4 }, preferred_max_latency: 2,
      preferred_min_throughput: { p50: 50, p75: 40, p90: 30, p99: 10 }, zdr: true,
      min_privacy: 'e2ee', data_collection: 'deny', usage: 'byok', jurisdiction: 'us',
    }
    assert.deepEqual(resolve({ defaults: provider }).defaults, provider)
  })

  it('passes unknown provider keys through for TrustedRouter to judge', () => {
    assert.deepEqual(resolve({ models: { m: { min_privacy: 'zdr', future_option: 1 } } }).models, { m: { min_privacy: 'zdr', future_option: 1 } })
  })

  it('rejects unusable values with a message naming the field', () => {
    assert.match(message({ defaults: { min_privacy: 'confidental' } }), /defaults\.min_privacy/)
    assert.match(message({ models: { m: { min_privacy: 'nope' } } }), /models\.m\.min_privacy/)
    assert.match(message({ models: { m: { only: 5 } } }), /models\.m\.only/)
    assert.match(message({ defaults: { sort: 'cheap' } }), /defaults\.sort/)
    assert.match(message({ defaults: { max_price: 5 } }), /defaults\.max_price/)
    assert.match(message({ gateways: ['api.trustedrouter.com/v1'] }), /gateways\[0\]/)
    assert.match(message({ gateways: ['https://api.trustedrouter.com/v1?x=1'] }), /gateways\[0\]/)
    assert.match(message({ rules: [{ baseURL: 'https://x/v1' }] }), /rules\[0\]\.body/)
    assert.match(message({ rules: [{ baseURL: 'ftp://x/v1', body: { a: 1 } }] }), /rules\[0\]\.baseURL/)
    assert.match(message({ log: 'yes' }), /log/)
    assert.match(message({ models: [] }), /models/)
  })
})
