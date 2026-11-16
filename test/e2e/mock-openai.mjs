// Minimal OpenAI-compatible Chat Completions server for end-to-end checks.
// Appends every request it receives to <log> as JSON lines and streams the reply "pong".
// GETs get a TrustedRouter-shaped model list (CORS-open), so the web UI can use the mock as a gateway.
// Like TrustedRouter since 2026-11, the per-provider `endpoints` list is only included with `?include=endpoints`.
// Usage: node mock-openai.mjs <log.jsonl> <port-file>   (listens on a free port, written to <port-file>)
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [log, portFile] = process.argv.slice(2)

const endpoint = (provider, name, tier, label, usage, country) => ({
  provider, provider_name: name, privacy_tier: tier, privacy_tier_label: label, usage_type: usage,
  provider_headquarters_country: country, provider_us_based: country === 'US',
})
const endpoints = [
  endpoint('tinfoil', 'Tinfoil', 3, 'Confidential + E2EE + ZDR', 'Credits', 'US'),
  endpoint('nebius', 'Nebius', 2, 'Zero retention', 'Credits', 'NL'),
  endpoint('deepinfra', 'DeepInfra', 1, 'No-store', 'Credits', 'US'),
  endpoint('novita', 'Novita', 0, 'Standard', 'BYOK', 'US'),
]
// Without endpoints, a model carries only its default route's fields.
const route = { provider: 'tinfoil', privacy_tier: 3, privacy_tier_label: 'Confidential + E2EE + ZDR' }
const models = withEndpoints => JSON.stringify({
  data: [{ id: 'mock-model', trustedrouter: withEndpoints ? { ...route, endpoints } : route }],
})
const wantsEndpoints = url => new URL(url, 'http://mock').searchParams.getAll('include')
  .some(value => value.split(',').map(part => part.trim()).includes('endpoints'))

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    appendFileSync(log, `${JSON.stringify({ method: req.method, url: req.url, body })}\n`)
    if (req.method !== 'POST') {
      res.setHeader('content-type', 'application/json')
      res.setHeader('access-control-allow-origin', '*')
      return res.end(models(wantsEndpoints(req.url)))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (choices, usage) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices, ...usage ? { usage } : {} })}\n\n`
    res.write(chunk([{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }]))
    res.write(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]))
    res.write(chunk([], { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }))
    res.end('data: [DONE]\n\n')
  })
})

server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)))
