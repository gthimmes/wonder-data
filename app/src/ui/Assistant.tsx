import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import { useEffect, useState } from 'react'
import { compile } from '../core/compiler'
import { findDimension, findMeasure, findMetric, type SemanticModel } from '../core/model'
import { RELATIVE_DATES, emptyQuery, type Filter, type FilterOp, type QuerySpec } from '../core/query'
import { useStore } from './store'

/**
 * The assistant never writes SQL. It proposes a QuerySpec against the semantic
 * model (field references only), the compiler validates it, and the user sees
 * exactly which fields were picked as shelves. If the request is ambiguous or
 * names something the model does not have, it asks instead of guessing.
 *
 * Two backends, same contract (system prompt + conversation + JSON schema in,
 * one JSON object out):
 *  - local: the dev/preview server's /api/assistant, which runs the request
 *    through the Claude Code CLI on the developer's own login. No key needed.
 *  - key:   the Anthropic SDK straight from the browser with a user-supplied key.
 */

const KEY_STORAGE = 'wonder.anthropicKey'
const MODEL_ID = 'claude-opus-5-5'
const LOCAL_ENDPOINT = '/api/assistant'

type Backend = 'probing' | 'local' | 'key'

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'message', 'report', 'follow_ups'],
  properties: {
    kind: { type: 'string', enum: ['report', 'question'], description: 'report when you can build it; question when you must ask the user something first.' },
    message: { type: 'string', description: 'For report: one plain sentence describing what you built, naming the fields. For question: the clarifying question, with the options you considered.' },
    report: {
      type: 'object',
      additionalProperties: false,
      required: ['dimensions', 'measures', 'filters', 'sort_field', 'sort_dir', 'limit'],
      properties: {
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Dimension refs exactly as listed. Date dimensions must carry a grain suffix like __month.' },
        measures: { type: 'array', items: { type: 'string' }, description: 'Measure refs (table.measure) or metric names exactly as listed.' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['field', 'op', 'value', 'values'],
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'not_contains', 'starts_with', 'is_null', 'not_null', 'relative_date'] },
              value: { type: 'string', description: 'Single value as text (number, date YYYY-MM-DD, true/false, text, or a relative date preset). Empty string when unused.' },
              values: { type: 'array', items: { type: 'string' }, description: 'List for in/not_in/between. Empty otherwise.' },
            },
          },
        },
        sort_field: { type: 'string', description: 'A ref from dimensions or measures, or empty string.' },
        sort_dir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: 'Row limit, 1 to 2000. Use 500 unless the user asks for top N.' },
      },
    },
    follow_ups: { type: 'array', items: { type: 'string' }, description: 'Two or three short follow-up requests the user might ask next, phrased in their words.' },
  },
} as const

type AssistantReply = {
  kind: 'report' | 'question'
  message: string
  report: {
    dimensions: string[]
    measures: string[]
    filters: { field: string; op: FilterOp; value: string; values: string[] }[]
    sort_field: string
    sort_dir: 'asc' | 'desc'
    limit: number
  }
  follow_ups: string[]
}

function describeModel(model: SemanticModel): string {
  const lines: string[] = []
  lines.push(`Data model: ${model.name}`)
  for (const t of model.tables) {
    lines.push(`\n## ${t.label} (table "${t.name}")${t.description ? ': ' + t.description : ''}`)
    if (t.measures.length) {
      lines.push('Measures (numbers to show):')
      for (const m of t.measures) if (!m.hidden) lines.push(`- ${t.name}.${m.name}: "${m.label}"${m.description ? ' — ' + m.description : ''}`)
    }
    lines.push('Dimensions (fields to group or filter by):')
    for (const d of t.dimensions) if (!d.hidden) lines.push(`- ${t.name}.${d.name} [${d.type}]: "${d.label}"${d.description ? ' — ' + d.description : ''}`)
  }
  if (model.metrics?.length) {
    lines.push('\n## Key metrics (ratios; reference by bare name)')
    for (const m of model.metrics) lines.push(`- ${m.name}: "${m.label}"${m.description ? ' — ' + m.description : ''}`)
  }
  lines.push('\n## Relationships (which fields can be combined)')
  for (const r of model.relationships) lines.push(`- many ${r.from} → one ${r.to}`)
  return lines.join('\n')
}

function systemPrompt(model: SemanticModel): string {
  return `You turn a business user's request into a report definition against a governed data model. You never write SQL. You only choose from the fields listed below, using their exact references.

${describeModel(model)}

Rules:
- Date dimensions used for grouping MUST carry a grain suffix: __day, __week, __month, __quarter or __year (e.g. invoices.issued_on__month). Filters on dates use the bare ref.
- Relative date filters: op "relative_date" with value one of: ${RELATIVE_DATES.map((r) => r.value).join(', ')}.
- A measure can only be grouped by fields reachable through "many → one" relationships from its table. Example: Total Billed (invoices) can be grouped by Client, Partner, Engagement or Service Line but not by Staff Member; Hours (time_entries) can be grouped by Staff Member, Engagement, Client or Partner. Number of Clients cannot be grouped by invoice or time fields.
- Prefer a key metric when the user uses a business word that matches its description (realization, collection rate, realized rate, over budget).
- "Top N" means sort descending by the main measure with limit N. "Lowest" means ascending.
- If the request names something not in the model, or two fields are both plausible, set kind to "question" and ask, listing the candidates. Never invent a field.
- Keep the user's existing report as the starting point when they say "add", "also", "change", "instead", or "remove".
- The message must be one plain sentence a non-technical reader understands; name the fields by their labels.`
}

function coerce(model: SemanticModel, f: AssistantReply['report']['filters'][number]): Filter {
  const metric = findMetric(model, f.field)
  let type: 'string' | 'number' | 'date' | 'boolean' = 'number'
  if (!metric) {
    try {
      type = findDimension(model, f.field).dim.type
    } catch {
      findMeasure(model, f.field) // throws if invalid
      type = 'number'
    }
  }
  const conv = (s: string): string | number | boolean => (type === 'number' ? Number(s) : type === 'boolean' ? /^(true|yes|1)$/i.test(s) : s)
  if (f.op === 'is_null' || f.op === 'not_null') return { field: f.field, op: f.op }
  if (f.op === 'relative_date') return { field: f.field, op: f.op, value: f.value }
  if (f.op === 'in' || f.op === 'not_in' || f.op === 'between') return { field: f.field, op: f.op, value: (f.values.length ? f.values : [f.value]).map(conv) }
  return { field: f.field, op: f.op, value: conv(f.value) }
}

function toQuery(model: SemanticModel, r: AssistantReply['report']): QuerySpec {
  const dims = r.dimensions.map((d) => {
    // Add a default grain if the assistant forgot one on a date dimension.
    try {
      const { dim, grain } = findDimension(model, d)
      return dim.type === 'date' && !grain ? `${d}__month` : d
    } catch {
      return d
    }
  })
  const q: QuerySpec = {
    ...emptyQuery(),
    dimensions: dims,
    measures: r.measures,
    filters: r.filters.map((f) => coerce(model, f)),
    sorts: r.sort_field ? [{ field: r.sort_field, dir: r.sort_dir }] : [],
    limit: Math.min(2000, Math.max(1, r.limit || 500)),
  }
  // The sort must reference a field in the report; the assistant may use a bare date ref.
  if (q.sorts.length && !q.dimensions.includes(q.sorts[0].field) && !q.measures.includes(q.sorts[0].field)) {
    const match = q.dimensions.find((d) => d.startsWith(q.sorts[0].field + '__'))
    q.sorts = match ? [{ ...q.sorts[0], field: match }] : []
  }
  return q
}

interface Turn {
  role: 'user' | 'assistant'
  text: string
  reply?: AssistantReply
  error?: string
}

type ChatMessage = { role: 'user' | 'assistant'; content: string }

/** Ask the local server, which runs the request through the Claude Code CLI. */
async function askLocal(system: string, messages: ChatMessage[]): Promise<AssistantReply> {
  const prompt = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
  const res = await fetch(LOCAL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, prompt, schema: responseSchema, model: MODEL_ID, effort: 'medium' }),
  })
  const data = (await res.json().catch(() => ({}))) as { output?: AssistantReply; error?: string }
  if (!res.ok || !data.output) throw new Error(data.error ?? `The local assistant service returned an error (${res.status}).`)
  return data.output
}

/** Ask the Anthropic API directly from the browser with the user's key. */
async function askWithKey(apiKey: string, system: string, messages: ChatMessage[]): Promise<AssistantReply> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  const res = await client.messages.parse({
    model: MODEL_ID,
    max_tokens: 4000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: { effort: 'medium', format: jsonSchemaOutputFormat(responseSchema) },
  })
  if (res.stop_reason === 'refusal') throw new Error('The assistant declined this request.')
  const parsed = res.parsed_output as AssistantReply | null
  if (!parsed) throw new Error('The assistant returned something I could not read. Try rephrasing.')
  return parsed
}

export function Assistant() {
  const model = useStore((s) => s.model)
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const setChart = useStore((s) => s.setChart)
  const toggle = useStore((s) => s.toggleAssistant)
  const [backend, setBackend] = useState<Backend>('probing')
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem(KEY_STORAGE) ?? ''
    } catch {
      return ''
    }
  })
  const [keyDraft, setKeyDraft] = useState('')
  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)

  // Prefer the local endpoint (developer's Claude login) when the server offers it.
  useEffect(() => {
    let cancelled = false
    fetch(LOCAL_ENDPOINT)
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((j: { available?: boolean }) => !cancelled && setBackend(j.available ? 'local' : 'key'))
      .catch(() => !cancelled && setBackend('key'))
    return () => {
      cancelled = true
    }
  }, [])

  const saveKey = () => {
    const k = keyDraft.trim()
    setApiKey(k)
    try {
      localStorage.setItem(KEY_STORAGE, k)
    } catch {
      /* best effort */
    }
  }

  const ask = async (text: string) => {
    if (!text.trim() || busy) return
    setBusy(true)
    setInput('')
    const history: Turn[] = [...turns, { role: 'user', text }]
    setTurns(history)
    const system = systemPrompt(model)
    const messages: ChatMessage[] = history.map((t) => ({
      role: t.role,
      content: t.role === 'assistant' && t.reply ? JSON.stringify(t.reply) : t.text,
    }))
    // Current report context travels with the latest user message, never in the cached system prompt.
    messages[messages.length - 1] = {
      role: 'user',
      content: `Current report (JSON): ${JSON.stringify(query)}\n\nRequest: ${text}`,
    }

    const attempt = (extra?: string): Promise<AssistantReply> => {
      const msgs = extra ? [...messages, { role: 'assistant' as const, content: '(previous attempt)' }, { role: 'user' as const, content: extra }] : messages
      return backend === 'local' ? askLocal(system, msgs) : askWithKey(apiKey, system, msgs)
    }

    try {
      let reply = await attempt()
      if (reply.kind === 'report') {
        let q: QuerySpec
        try {
          q = toQuery(model, reply.report)
          compile(model, q)
        } catch (e) {
          // One corrective round-trip with the compiler's own message.
          reply = await attempt(`That report definition was rejected by the validator: ${(e as Error).message}. Fix it or ask a question instead.`)
          if (reply.kind === 'report') {
            q = toQuery(model, reply.report)
            compile(model, q) // throws to the outer catch if still wrong
          } else {
            setTurns([...history, { role: 'assistant', text: reply.message, reply }])
            return
          }
        }
        setQuery(q)
        setChart('auto')
      }
      setTurns([...history, { role: 'assistant', text: reply.message, reply }])
    } catch (e) {
      let msg = (e as Error).message
      if (e instanceof Anthropic.AuthenticationError) msg = 'That API key was rejected. Check it and try again.'
      else if (e instanceof Anthropic.RateLimitError) msg = 'Rate limited. Wait a moment and try again.'
      else if (e instanceof Anthropic.APIError) msg = `The assistant service returned an error (${e.status}): ${e.message}`
      setTurns([...history, { role: 'assistant', text: msg, error: msg }])
    } finally {
      setBusy(false)
    }
  }

  const last = turns[turns.length - 1]
  const pickedLabels = (r: AssistantReply['report']) => {
    const labels: { kind: string; label: string }[] = []
    for (const d of r.dimensions) {
      try {
        labels.push({ kind: 'dim', label: findDimension(model, d).dim.label })
      } catch {
        labels.push({ kind: 'dim', label: d })
      }
    }
    for (const m of r.measures) {
      const metric = findMetric(model, m)
      if (metric) labels.push({ kind: 'metric', label: metric.label })
      else {
        try {
          labels.push({ kind: 'measure', label: findMeasure(model, m).measure.label })
        } catch {
          labels.push({ kind: 'measure', label: m })
        }
      }
    }
    return labels
  }

  const needsKey = backend === 'key' && !apiKey

  return (
    <div className="rightpanel assistant">
      <div className="ph">
        Ask for a report
        <button className="btn" onClick={toggle}>Close</button>
      </div>
      <div className="body">
        {backend === 'probing' ? (
          <p className="hint">Connecting…</p>
        ) : needsKey ? (
          <>
            <p className="hint">
              The assistant turns a sentence into a report using only the governed fields; it never writes SQL and every result is checked by the same validator as the builder. It needs an Anthropic API key, stored only in this browser.
            </p>
            <div className="keyrow">
              <input type="password" placeholder="sk-ant-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveKey()} />
              <button className="btn primary" onClick={saveKey} disabled={!keyDraft.trim()}>Use key</button>
            </div>
          </>
        ) : (
          <>
            <textarea
              placeholder="e.g. Realization by partner for last quarter, lowest first"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void ask(input)
                }
              }}
              disabled={busy}
            />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
              <button className="btn primary" onClick={() => void ask(input)} disabled={busy || !input.trim()}>
                {busy ? <span className="spinner" /> : 'Build it'}
              </button>
              <span className="hint">Enter to send</span>
              <span className="spacer" style={{ flex: 1 }} />
              {backend === 'local' ? (
                <span className="hint" title="Requests go to the local dev server, which runs them through the Claude Code CLI on this machine's login.">Using your Claude login</span>
              ) : (
                <button
                  className="btn"
                  onClick={() => {
                    setApiKey('')
                    try {
                      localStorage.removeItem(KEY_STORAGE)
                    } catch {
                      /* ignore */
                    }
                  }}
                  title="Forget the API key"
                >
                  Change key
                </button>
              )}
            </div>
            {turns.length === 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="hint" style={{ marginBottom: 4 }}>Try one:</div>
                {['Which clients have the most unbilled WIP?', 'Hours by staff member this year, with billable hours', 'Collections by month for the last 12 months', 'Realization by service line by quarter'].map((s) => (
                  <button key={s} className="suggest" onClick={() => void ask(s)}>{s}</button>
                ))}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`answer ${t.role === 'user' ? '' : t.reply?.kind === 'question' ? 'q' : ''}`} style={t.role === 'user' ? { background: 'transparent', border: 'none', padding: '6px 0', color: 'var(--muted)' } : undefined}>
                {t.role === 'user' ? <>“{t.text}”</> : <>{t.text}</>}
                {t.role === 'assistant' && t.reply?.kind === 'report' && (
                  <div className="chips">
                    {pickedLabels(t.reply.report).map((l, j) => (
                      <span key={j} className={`pill ${l.kind}`}>{l.label}</span>
                    ))}
                    {t.reply.report.filters.length > 0 && <span className="pill filter">{t.reply.report.filters.length} filter{t.reply.report.filters.length === 1 ? '' : 's'}</span>}
                  </div>
                )}
              </div>
            ))}
            {last?.reply?.follow_ups?.length ? (
              <div style={{ marginTop: 8 }}>
                {last.reply.follow_ups.map((s) => (
                  <button key={s} className="suggest" onClick={() => void ask(s)} disabled={busy}>{s}</button>
                ))}
              </div>
            ) : null}
            {last?.reply?.kind === 'report' && <p className="hint" style={{ marginTop: 8 }}>Check the shelves above: that is exactly what was chosen. Open “How is this calculated?” to verify any number.</p>}
          </>
        )}
      </div>
    </div>
  )
}
