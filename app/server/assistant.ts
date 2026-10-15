/**
 * Local assistant backend: runs the structured-output request through the
 * Claude Code CLI installed on this machine, so the assistant works on the
 * developer's existing Claude login with no API key in the browser.
 *
 * The browser never talks to Claude directly in this mode. It POSTs
 * {system, prompt, schema} to /api/assistant; this module spawns
 * `claude -p --json-schema …` and returns the `structured_output` field.
 *
 * Used by vite.config.ts for both `vite dev` and `vite preview`.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { delimiter, join } from 'node:path'
import type { Plugin } from 'vite'

export interface StructuredRequest {
  system: string
  prompt: string
  schema: Record<string, unknown>
  model?: string
  effort?: 'low' | 'medium' | 'high'
}

const DEFAULT_MODEL = 'claude-opus-5-5'
const TIMEOUT_MS = 120_000

/** Locate the Claude Code CLI. CLAUDE_PATH overrides; otherwise scan PATH. */
export function findClaude(): string | null {
  if (process.env.CLAUDE_PATH && existsSync(process.env.CLAUDE_PATH)) return process.env.CLAUDE_PATH
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    if (process.platform === 'win32') {
      // The npm shim (claude.cmd) just calls the native binary; spawn that directly so no shell quoting is involved.
      const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      if (existsSync(exe)) return exe
      const direct = join(dir, 'claude.exe')
      if (existsSync(direct)) return direct
    } else {
      const bin = join(dir, 'claude')
      if (existsSync(bin)) return bin
    }
  }
  return null
}

interface CliResult {
  is_error?: boolean
  result?: string
  structured_output?: unknown
  terminal_reason?: string
}

/** Run one structured-output turn through `claude -p`. Resolves to the parsed JSON object. */
export function runStructured(req: StructuredRequest): Promise<unknown> {
  const exe = findClaude()
  if (!exe) return Promise.reject(new Error('Claude Code CLI not found on PATH. Install it or set CLAUDE_PATH.'))
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--tools', '',
    '--model', req.model ?? DEFAULT_MODEL,
    '--effort', req.effort ?? 'medium',
    '--system-prompt', req.system,
    '--json-schema', JSON.stringify(req.schema),
  ]
  // Do not inherit the markers of an enclosing Claude Code session; the CLI would treat this as a nested session.
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_CHILD_SESSION
  delete env.CLAUDE_CODE_ENTRYPOINT

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('The assistant took too long to answer. Try again.'))
    }, TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed: CliResult | null = null
      try {
        parsed = JSON.parse(out) as CliResult
      } catch {
        /* fall through */
      }
      if (!parsed) return reject(new Error(`Claude CLI exited with code ${code}: ${(err || out).trim().slice(0, 400) || 'no output'}`))
      if (parsed.is_error) return reject(new Error(parsed.result?.trim() || `Claude CLI reported ${parsed.terminal_reason ?? 'an error'}`))
      if (parsed.structured_output === undefined) return reject(new Error('Claude CLI returned no structured output.'))
      resolve(parsed.structured_output)
    })
    child.stdin.end(req.prompt)
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

/** GET /api/assistant → availability; POST /api/assistant → structured reply. */
export function assistantHandler(): Middleware {
  return (req, res, next) => {
    if (!req.url?.startsWith('/api/assistant')) return next()
    if (req.method === 'GET') return send(res, 200, { available: findClaude() !== null, backend: 'claude-code' })
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
    void readBody(req)
      .then(async (raw) => {
        const body = JSON.parse(raw) as Partial<StructuredRequest>
        if (typeof body.system !== 'string' || typeof body.prompt !== 'string' || !body.schema || typeof body.schema !== 'object') {
          return send(res, 400, { error: 'Expected {system, prompt, schema}' })
        }
        const output = await runStructured({ system: body.system, prompt: body.prompt, schema: body.schema, model: body.model, effort: body.effort })
        send(res, 200, { output })
      })
      .catch((e: unknown) => send(res, 500, { error: (e as Error).message }))
  }
}

/** Vite plugin exposing the endpoint on both the dev and preview servers. */
export function assistantPlugin(): Plugin {
  return {
    name: 'wonder-assistant',
    configureServer(server) {
      server.middlewares.use(assistantHandler())
    },
    configurePreviewServer(server) {
      server.middlewares.use(assistantHandler())
    },
  }
}
