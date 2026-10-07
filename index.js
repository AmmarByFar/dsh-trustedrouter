/**
 * dsh-trustedrouter: per-model TrustedRouter routing and privacy settings for
 * DeepSeek Harness.
 *
 * TrustedRouter reads routing and privacy policy only from the request body's
 * `provider` object (e.g. `{"provider": {"min_privacy": "confidential"}}`).
 * dsh's pi-ai routes accept extra `headers` but no extra body fields, and
 * pi-ai's own `onPayload` hook is not reachable from configuration. So this
 * plugin wraps `globalThis.fetch`: a POST under a configured gateway gets
 * `provider` set from `defaults` plus the override for the body's `model`
 * before it leaves the process. Everything else passes through.
 *
 * This reaches pi-ai because the OpenAI and Anthropic SDKs resolve the global
 * `fetch` when a client is constructed, and pi-ai constructs one per request.
 *
 * Every Config field is volatile: a save from the web UI commits into the
 * running plugin without a remount, and each request reads the values once.
 *
 * A POST that needs fields but whose body is not a JSON object is rejected
 * rather than sent without them: a privacy floor that silently falls away is
 * worse than a visible request error.
 */
import z from '@deepseek-ai/schemastery'

export const name = 'trustedrouter'

export const DEFAULT_GATEWAY = 'https://api.trustedrouter.com/v1'

// schemastery fills a missing object field with `{}`; an unset nested object
// must stay absent so it never reaches TrustedRouter as an empty option.
const optionalObject = dict => z.object(dict).default(undefined)

const slugs = z.union([z.array(z.string()), z.string()])
const sortKey = z.union(['price', 'latency', 'throughput'])
const price = z.union([z.number(), z.string()])
const percentiles = z.union([z.number(), z.object({ p50: z.number(), p75: z.number(), p90: z.number(), p99: z.number() })])
const httpURL = z.string().pattern(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/)

/**
 * TrustedRouter's `provider` fields (trustedrouter.com/docs/provider-routing).
 * Known fields are type-checked so a bad value fails when it is saved. Unknown
 * keys pass through, because TrustedRouter answers an unknown option with a
 * 400 instead of ignoring it, and new options then need no plugin update.
 */
export const Provider = z.object({
  only: slugs,
  ignore: slugs,
  order: slugs,
  allow_fallbacks: z.boolean(),
  sort: z.union([sortKey, z.object({ by: sortKey, partition: z.union(['model', 'none']) })]),
  require_parameters: z.boolean(),
  max_price: optionalObject({ prompt: price, completion: price }),
  preferred_max_latency: percentiles,
  preferred_min_throughput: percentiles,
  zdr: z.boolean(),
  min_privacy: z.union(['any', 'no_store', 'zdr', 'confidential', 'e2e', 'e2ee']),
  data_collection: z.union(['allow', 'deny']),
  usage: z.union(['credits', 'byok', 'prepaid', 'bring-your-own-key']),
  jurisdiction: z.string(),
})

export const Config = z.object({
  gateways: z.array(httpURL).default([DEFAULT_GATEWAY])
    .description('Base URLs whose POSTs get the `provider` policy.')
    .volatile(),
  defaults: Provider.default({})
    .description('`provider` fields for every model on the gateways.')
    .volatile(),
  models: z.dict(Provider).default({})
    .description('Per-model `provider` overrides, keyed by the request body\'s `model`.')
    .volatile(),
  rules: z.array(z.object({ baseURL: httpURL.required(), body: z.dict(z.any()).required() })).default([])
    .description('Raw JSON deep-merged into the body of any POST under `baseURL`.')
    .volatile(),
  log: z.boolean().default(false)
    .description('Print each change to stderr (the dsh web terminal). Request bodies are never printed.')
    .volatile(),
})

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deep-merge `patch` into a copy of `target`. Nested objects merge key by key;
 * on any other conflict (scalars, arrays) the patch value wins.
 */
export function mergeBody(target, patch) {
  const out = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeBody(out[key], value) : value
  }
  return out
}

/**
 * The `provider` fields for one request: `defaults`, then the override for its
 * model. A model with a routing suffix (`z-ai/glm-5.3:nitro`) falls back to the
 * base model's override, so a floor set for a model also holds for its variants.
 */
export function providerFor(model, defaults, models) {
  if (typeof model !== 'string') return defaults
  const base = model.includes(':') ? model.slice(0, model.indexOf(':')) : undefined
  const key = Object.hasOwn(models, model) ? model : base !== undefined && Object.hasOwn(models, base) ? base : undefined
  return key === undefined ? defaults : mergeBody(defaults, models[key])
}

/** `origin + pathname` without trailing slashes, so prefixes compare on path segments. */
function urlPrefix(url) {
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** Whether `target` falls under `base` on a path-segment boundary; a `base` URL cannot parse matches nothing. */
function isUnder(target, base) {
  let prefix
  try {
    prefix = urlPrefix(new URL(base))
  } catch {
    return false
  }
  return target === prefix || target.startsWith(`${prefix}/`)
}

function bodyText(body) {
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  return undefined
}

/**
 * What to do with one request: `undefined` when it is not ours to touch,
 * otherwise what was added and, when anything was, the replacement
 * `[input, init]`. Throws when a POST needs fields but its body is not a JSON object.
 */
async function rewrite(settings, input, init) {
  const isRequest = input instanceof Request
  const url = isRequest ? input.url : String(input)
  const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase()
  if (method !== 'POST') return undefined
  let target
  try {
    target = urlPrefix(new URL(url))
  } catch {
    return undefined
  }
  const policy = settings.gateways.some(base => isUnder(target, base))
    && (Object.keys(settings.defaults).length > 0 || Object.keys(settings.models).length > 0)
  const rules = settings.rules.filter(rule => isUnder(target, rule.baseURL))
  if (!policy && rules.length === 0) return undefined

  const text = init?.body != null
    ? bodyText(init.body)
    : isRequest ? await input.clone().text() : undefined
  let parsed
  try {
    parsed = text === undefined ? undefined : JSON.parse(text)
  } catch {
    // fall through to the refusal below
  }
  if (!isPlainObject(parsed)) {
    const fields = new Set([...policy ? ['provider'] : [], ...rules.flatMap(rule => Object.keys(rule.body))])
    throw new TypeError(`trustedrouter: refusing POST ${url}: its body is not a JSON object, so ${[...fields].join(', ')} cannot be added`)
  }

  let body = parsed
  const provider = policy ? providerFor(parsed.model, settings.defaults, settings.models) : {}
  if (Object.keys(provider).length > 0) {
    // The configured policy is the authority: it wins over whatever the
    // request set, and a `provider` that is not an object is replaced.
    body = { ...body, provider: mergeBody(isPlainObject(body.provider) ? body.provider : {}, provider) }
  }
  for (const rule of rules) body = mergeBody(body, rule.body)
  const result = { url, model: parsed.model, provider, rules }
  if (body === parsed) return result

  const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined))
  headers.delete('content-length')
  const nextInit = { ...init, headers, body: JSON.stringify(body) }
  return { ...result, args: isRequest ? [new Request(input, nextInit)] : [input, nextInit] }
}

/**
 * Terminal output. Shipped dsh profiles mount no Cordis log exporter, so
 * `ctx.logger` messages are dropped; stderr is where `dsh web` prints its own lines.
 */
function print(message) {
  console.error(`[trustedrouter] ${message}`)
}

function describe(settings) {
  const overrides = Object.keys(settings.models)
  if (settings.gateways.length === 0) {
    print('no gateways configured; no provider policy is applied')
  } else {
    print(`provider policy for POSTs under ${settings.gateways.join(', ')}: defaults ${JSON.stringify(settings.defaults)}, `
      + `overrides for ${overrides.length > 0 ? overrides.join(', ') : 'no models'}`)
  }
  for (const rule of settings.rules) {
    print(`merging ${JSON.stringify(rule.body)} into POST bodies under ${rule.baseURL}`)
  }
}

function report(result) {
  const model = result.model ?? '(no model)'
  if (Object.keys(result.provider).length > 0) {
    print(`added provider to POST ${result.url} for ${model}: ${JSON.stringify(result.provider)}`)
  } else if (result.rules.length === 0) {
    print(`no provider policy for ${model}; POST ${result.url} sent unchanged`)
  }
  for (const rule of result.rules) {
    print(`added ${Object.keys(rule.body).join(', ')} to POST ${result.url} (rule for ${rule.baseURL})`)
  }
}

export function apply(ctx, config) {
  const read = () => ({
    gateways: config.gateways.get(),
    defaults: config.defaults.get(),
    models: config.models.get(),
    rules: config.rules.get(),
    log: config.log.get(),
  })
  const announce = () => {
    const settings = read()
    if (settings.log) describe(settings)
  }
  announce()
  ctx.on('loader/volatile-update', announce)

  ctx.effect(() => {
    const previous = globalThis.fetch
    // Another wrapper may sit on top of ours by the time we unload; then we
    // cannot unhook, so the flag turns ours into a pass-through instead.
    let active = true
    const wrapped = async (input, init) => {
      if (!active) return previous(input, init)
      const settings = read()
      let result
      try {
        result = await rewrite(settings, input, init)
      } catch (error) {
        print(error.message)
        throw error
      }
      if (result === undefined) return previous(input, init)
      if (settings.log) report(result)
      return result.args === undefined ? previous(input, init) : previous(...result.args)
    }
    globalThis.fetch = wrapped
    return () => {
      active = false
      if (globalThis.fetch === wrapped) globalThis.fetch = previous
    }
  })
}
