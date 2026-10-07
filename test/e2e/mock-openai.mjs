// Minimal OpenAI-compatible Chat Completions server for end-to-end checks.
// Appends every request it receives to <log> as JSON lines and streams the reply "pong".
// Usage: node mock-openai.mjs <log.jsonl> <port-file>   (listens on a free port, written to <port-file>)
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [log, portFile] = process.argv.slice(2)

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    appendFileSync(log, `${JSON.stringify({ method: req.method, url: req.url, body })}\n`)
    if (req.method !== 'POST') {
      res.setHeader('content-type', 'application/json')
      return res.end('{"data":[{"id":"mock-model"}]}')
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
