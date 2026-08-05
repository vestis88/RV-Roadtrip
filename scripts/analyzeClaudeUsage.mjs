#!/usr/bin/env node
/**
 * Turns the raw `claude_usage` log lines into a report about money.
 *
 * Reads Cloud Logging's JSON export on stdin (see
 * .github/workflows/usage-report.yml) and writes markdown on stdout.
 *
 * The logger records tokens, not cost, deliberately — tokens are a fact the
 * app observes, while cost is a function of a price list that changes
 * underneath it. Rates therefore live here, in one visible table, rather
 * than being baked into what gets written to the log: a price change means
 * editing this file and re-running, not losing history.
 */

/**
 * Per million tokens, USD. Sonnet 5's introductory rate runs through
 * 2026-08-31; `standard` is what applies afterwards, so a report run in
 * September gets the right answer by changing one word rather than four
 * numbers.
 *
 * The Anthropic Console's usage page is authoritative for what you are
 * actually billed. This is an estimate built from the app's own logs, and
 * it will drift from the invoice wherever these rates are stale.
 */
const RATES = {
  'claude-sonnet-5': { input: 2.0, output: 10.0, note: 'intro rate, through 2026-08-31' },
  'claude-sonnet-5-standard': { input: 3.0, output: 15.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
}
/** Standard prompt-caching multipliers against the model's input rate. */
const CACHE_WRITE_MULTIPLIER = 1.25
const CACHE_READ_MULTIPLIER = 0.1
/** Server-side web search, USD per 1,000 requests. */
const WEB_SEARCH_PER_1K = 10.0

function rateFor(model) {
  // An unrecognised model must not silently cost zero — that would report a
  // reassuring total for exactly the case where spend moved somewhere new.
  return RATES[model] ?? null
}

function costOf(row) {
  const rate = rateFor(row.model)
  if (!rate) return null
  const perToken = (n, r) => (n / 1_000_000) * r
  return (
    perToken(row.inputTokens, rate.input) +
    perToken(row.outputTokens, rate.output) +
    perToken(row.cacheCreationTokens, rate.input * CACHE_WRITE_MULTIPLIER) +
    perToken(row.cacheReadTokens, rate.input * CACHE_READ_MULTIPLIER) +
    (row.webSearchRequests / 1000) * WEB_SEARCH_PER_1K
  )
}

const usd = (n) => (n == null ? 'n/a' : `$${n.toFixed(4)}`)
const num = (n) => n.toLocaleString('en-US')

function percentile(sorted, p) {
  // Null, not 0, on an empty set. A latency of zero is a measurement; "we
  // have no measurements" is not, and printing the two the same way is how a
  // gap in the data gets read as a finding about the app.
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

function emptyTotals() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    retries: 0,
    cost: 0,
    unpriced: 0,
    elapsed: [],
  }
}

function add(totals, row) {
  totals.calls += 1
  totals.inputTokens += row.inputTokens
  totals.outputTokens += row.outputTokens
  totals.cacheCreationTokens += row.cacheCreationTokens
  totals.cacheReadTokens += row.cacheReadTokens
  totals.webSearchRequests += row.webSearchRequests
  if (row.attempt > 1) totals.retries += 1
  if (row.elapsedMs != null) totals.elapsed.push(row.elapsedMs)
  const cost = costOf(row)
  if (cost == null) totals.unpriced += 1
  else totals.cost += cost
}

function groupBy(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const name = key(row) ?? '(none)'
    if (!groups.has(name)) groups.set(name, emptyTotals())
    add(groups.get(name), row)
  }
  return groups
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (text += chunk))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', reject)
  })
}

const raw = (await readStdin()).trim()
const entries = raw === '' ? [] : JSON.parse(raw)

const rows = entries
  .map((entry) => {
    const p = entry.jsonPayload ?? {}
    return {
      timestamp: entry.timestamp ?? '',
      day: (entry.timestamp ?? '').slice(0, 10),
      callType: p.callType ?? '(unknown)',
      tripId: p.tripId ?? null,
      model: p.model ?? '(unknown)',
      attempt: Number(p.attempt ?? 1),
      // Null, not 0, when the field is absent. `elapsedMs` was added to the
      // logger partway through, so older entries simply don't have it —
      // reporting those as "0.0s" invents a measurement, and a latency table
      // reading zero across the board looks like a finding rather than a gap.
      elapsedMs: typeof p.elapsedMs === 'number' ? p.elapsedMs : null,
      inputTokens: Number(p.inputTokens ?? 0),
      outputTokens: Number(p.outputTokens ?? 0),
      cacheCreationTokens: Number(p.cacheCreationTokens ?? 0),
      cacheReadTokens: Number(p.cacheReadTokens ?? 0),
      webSearchRequests: Number(p.webSearchRequests ?? 0),
    }
  })
  .sort((a, b) => a.timestamp.localeCompare(b.timestamp))

const out = []
out.push('# Claude token spend')
out.push('')

if (rows.length === 0) {
  out.push('No `claude_usage` entries in the requested window.')
  out.push('')
  out.push(
    'That means either nothing has generated a plan in that period, or the ' +
      'log retention window (30 days by default) has aged the entries out.',
  )
  console.log(out.join('\n'))
  process.exit(0)
}

const overall = emptyTotals()
for (const row of rows) add(overall, row)

out.push(
  `**${usd(overall.cost)}** across **${num(overall.calls)} calls**, ` +
    `${rows[0].day} → ${rows[rows.length - 1].day}.`,
)
out.push('')
out.push(
  `Input ${num(overall.inputTokens)} · output ${num(overall.outputTokens)} · ` +
    `cache write ${num(overall.cacheCreationTokens)} · cache read ${num(overall.cacheReadTokens)} · ` +
    `web searches ${num(overall.webSearchRequests)}`,
)
out.push('')

if (overall.unpriced > 0) {
  out.push(
    `> ⚠️ ${overall.unpriced} call(s) used a model with no rate in this ` +
      `script's table, so their cost is **missing from every total below**. ` +
      `Add it to RATES in scripts/analyzeClaudeUsage.mjs.`,
  )
  out.push('')
}

function table(title, groups, label) {
  const sorted = [...groups.entries()].sort((a, b) => b[1].cost - a[1].cost)
  out.push(`## ${title}`)
  out.push('')
  out.push(`| ${label} | Calls | Input | Output | Cache read | Searches | Est. cost | Share |`)
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const [name, t] of sorted) {
    const share = overall.cost > 0 ? ((t.cost / overall.cost) * 100).toFixed(1) : '0.0'
    out.push(
      `| ${name} | ${num(t.calls)} | ${num(t.inputTokens)} | ${num(t.outputTokens)} ` +
        `| ${num(t.cacheReadTokens)} | ${num(t.webSearchRequests)} | ${usd(t.cost)} | ${share}% |`,
    )
  }
  out.push('')
}

table('Where the money goes', groupBy(rows, (r) => r.callType), 'Call type')

const byTrip = groupBy(
  rows.filter((r) => r.tripId),
  (r) => r.tripId,
)
if (byTrip.size > 0) {
  const top = new Map(
    [...byTrip.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10),
  )
  table('Most expensive trips', top, 'Trip')
}

out.push('## Per day')
out.push('')
out.push('| Day | Calls | Est. cost |')
out.push('| --- | ---: | ---: |')
for (const [day, t] of [...groupBy(rows, (r) => r.day).entries()].sort()) {
  out.push(`| ${day} | ${num(t.calls)} | ${usd(t.cost)} |`)
}
out.push('')

out.push('## Waste and latency')
out.push('')
const retryCost = rows
  .filter((r) => r.attempt > 1)
  .reduce((sum, r) => sum + (costOf(r) ?? 0), 0)
out.push(
  `**Retries:** ${num(overall.retries)} of ${num(overall.calls)} calls were a ` +
    `second or later attempt, costing ${usd(retryCost)}. A retry is a call ` +
    `whose first attempt was paid for and thrown away.`,
)
out.push('')
const billableInput = overall.inputTokens + overall.cacheCreationTokens
const cacheTotal = billableInput + overall.cacheReadTokens
// Two different situations produce a 0% cache rate, and they call for
// opposite responses, so the report has to tell them apart rather than
// printing one sentence that guesses.
//
// Nothing written AND nothing read means no call in the window asked to
// cache anything — only one call site in this app attaches a cache_control
// breakpoint (the multi-chunk detail loop), so a window of rescans and
// highlights reports 0% while behaving exactly as designed. Saying "the
// prefix is being invalidated" there names a cause that never applied, and
// sends someone hunting a bug in code that is doing what it says.
//
// Tokens written but few read is the real symptom: caching was requested
// and isn't paying off. Even then the cause is not in this data — an
// invalidated prefix, a prefix under the model's minimum cacheable size,
// and calls spaced beyond the TTL all look identical here — so this states
// what happened and leaves the diagnosis to someone reading the call site.
if (overall.cacheCreationTokens === 0 && overall.cacheReadTokens === 0) {
  out.push(
    '**Cache:** no call in this window attached a cache breakpoint, so ' +
      'nothing was written or read. That is a fact about which call types ' +
      'ran, not evidence that caching is broken.',
  )
} else {
  const hitRate =
    cacheTotal > 0 ? ((overall.cacheReadTokens / cacheTotal) * 100).toFixed(1) : '0.0'
  out.push(
    `**Cache:** ${hitRate}% of prompt tokens were served from cache at a ` +
      `tenth of the price, against ${num(overall.cacheCreationTokens)} tokens ` +
      `written at 1.25x. Higher is better — a write with little read back ` +
      `means the cached prefix is not being reused, which the call site will ` +
      `explain and this report cannot.`,
  )
}
out.push('')
const byTypeForLatency = groupBy(rows, (r) => r.callType)
const timedCalls = [...byTypeForLatency.values()].reduce((n, t) => n + t.elapsed.length, 0)

if (timedCalls === 0) {
  // `elapsedMs` was added to the logger after some of these entries were
  // written, so a window that predates it has nothing to time. Say that,
  // rather than printing a table of zeroes that reads like the app is
  // answering instantly.
  out.push('**Latency:** not recorded for any call in this window.')
  out.push('')
} else {
  out.push('| Call type | Median | p95 | Slowest | Timed |')
  out.push('| --- | ---: | ---: | ---: | ---: |')
  for (const [name, t] of byTypeForLatency) {
    const sorted = [...t.elapsed].sort((a, b) => a - b)
    const s = (ms) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`)
    out.push(
      `| ${name} | ${s(percentile(sorted, 50))} | ${s(percentile(sorted, 95))} ` +
        `| ${s(sorted[sorted.length - 1] ?? null)} | ${num(sorted.length)} of ${num(t.calls)} |`,
    )
  }
  out.push('')
}
out.push(
  '---\n\nEstimated from the app\'s own logs using the rates in ' +
    '`scripts/analyzeClaudeUsage.mjs`. The Anthropic Console\'s usage page is ' +
    'authoritative for what you are actually billed.',
)

console.log(out.join('\n'))
