// SagBot scan GitHub Action (B-202). No dependencies: Node 24's fetch plus the runner's env files.
// Flow: read the baseline's newest stored scan (free) → scan the site → gate → job summary, outputs, PR comment.
import { appendFileSync, readFileSync } from 'node:fs'

const API = 'https://api.sagbot.app'
const UA = 'sagbot-scan-action/1'
export const MARKER = '<!-- sagbot-scan-action'
const SITE_TYPES = ['content', 'app', 'shop']
const CHECK_ID = /^(agent|seo|geo|aeo)-[a-z0-9-]+$/
const REPORT_URL = /^https:\/\/sagbot\.app\/d\/[a-z0-9.-]+$/i
const LIST_MAX = 20
/**
 * Checks that read the host itself. Preview deployments send `X-Robots-Tag: noindex` and point their canonical,
 * hreflang and absolute links at production, so on another host than the baseline these differ by design.
 */
export const HOST_BOUND = ['seo-indexability', 'seo-canonical', 'seo-crawlable-links', 'seo-hreflang']

/**
 * @typedef {{ id: string, title: string, status?: string, fix?: string }} Fix
 * @typedef {{ id: string, title: string }} Unknown
 * @typedef {{
 *   host: string, site_type: string, scanned_at: string, cached: boolean, rescan_in_seconds?: number,
 *   complete: boolean, fail_reason?: string, scores: { agent_ready: number | null, answer_ready: number | null },
 *   fixes: Fix[], could_not_verify: Unknown[], counts: { pass: number, info: number, na: number },
 *   report: string, cost_usd?: number
 * }} Scan
 * @typedef {{ regressions: Fix[], unsure: Fix[], fixed: Fix[] }} Delta
 * @typedef {ReturnType<typeof config>} Config
 * @typedef {{
 *   fetch: typeof fetch, sleep: (ms: number) => Promise<void>, now: () => number, out: (line: string) => void
 * }} Deps
 * @typedef {Record<string, string | undefined>} Env
 */

/** Action input as the runner passes it: `INPUT_<NAME>` with spaces → `_`, upper case. */
export const input = (/** @type {Env} */ env, /** @type {string} */ name) =>
  (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim()

/** Check ids from "a, b c" or one per line. */
export const list = (/** @type {string} */ s) => s.split(/[\s,]+/).filter(Boolean)

/** @param {Env} env @param {string} name @param {boolean} dflt */
function bool(env, name, dflt) {
  const v = input(env, name).toLowerCase()
  if (!v) return dflt
  if (v === 'true' || v === 'false') return v === 'true'
  throw new Error(`${name}: true or false`)
}

/** @param {Env} env @param {string} name @returns {number | null} */
function floor(env, name) {
  const v = input(env, name)
  if (!v) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`${name}: a whole number from 0 to 100`)
  return n
}

/** @param {Env} env @param {string} name */
function ids(env, name) {
  const all = list(input(env, name))
  const bad = all.filter((id) => !CHECK_ID.test(id))
  if (bad.length) throw new Error(`${name}: not a SagBot check id: ${bad.join(', ')} (ids look like agent-llms-txt)`)
  return all
}

/** @param {Env} env */
export function config(env) {
  const url = input(env, 'url')
  if (!url) throw new Error('url: required (the domain or URL of the deployed site)')
  const siteType = input(env, 'site-type') || 'content'
  if (!SITE_TYPES.includes(siteType)) throw new Error('site-type: content, app or shop')
  return {
    token: input(env, 'token'),
    url,
    baseline: input(env, 'baseline') || url,
    siteType,
    rescan: bool(env, 'rescan', true),
    minAgent: floor(env, 'min-agent-ready'),
    minAnswer: floor(env, 'min-answer-ready'),
    required: ids(env, 'require'),
    ignore: ids(env, 'ignore'),
    failOnRegression: bool(env, 'fail-on-regression', true),
    failOnIncomplete: bool(env, 'fail-on-incomplete', true),
    comment: bool(env, 'comment', true),
    githubToken: input(env, 'github-token'),
  }
}

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(`SagBot API ${status} ${code}: ${message}`)
    this.status = status
    this.code = code
  }
}

/** A 4xx other than 429: retrying won't help. @param {unknown} e */
const final = (e) => e instanceof ApiError && e.status < 500 && e.status !== 429
const why = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, ' ')

/**
 * @param {Deps} deps @param {string} token @param {'GET' | 'POST'} method @param {string} path
 * @param {object | undefined} body @param {number} timeoutMs @returns {Promise<Scan>}
 */
async function api(deps, token, method, path, body, timeoutMs) {
  const res = await deps.fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': UA },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  /** @type {any} */
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? text.slice(0, 200))
  return json
}

/** @param {Config} cfg @param {string} domain */
const latestPath = (cfg, domain) => `/v1/scans/latest?domain=${encodeURIComponent(domain)}&site_type=${cfg.siteType}`

/**
 * Newest stored scan of the baseline, read before scanning so it is the "before". Free. A read that fails for a
 * passing reason (5xx, 429, timeout) is retried once; after that it fails the run when regressions are gated, so the
 * gate never turns itself off silently.
 * @param {Deps} deps @param {Config} cfg @returns {Promise<Scan | null>}
 */
async function baselineScan(deps, cfg) {
  for (let i = 0; ; i++) {
    try {
      return await api(deps, cfg.token, 'GET', latestPath(cfg, cfg.baseline), undefined, 30_000)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      if (e instanceof ApiError && e.status === 403) {
        deps.out(cmd('warning', `No baseline: ${why(e)}`))
        return null
      }
      if (final(e)) throw e
      if (i === 0) {
        await deps.sleep(10_000)
        continue
      }
      if (cfg.failOnRegression)
        throw new Error(`Couldn't read the baseline scan, so regressions can't be checked: ${why(e)}`)
      deps.out(cmd('warning', `No baseline: ${why(e)}`))
      return null
    }
  }
}

/** At most 3 POSTs: one retry after a 429, one after the 2-minute rescan window. @param {Deps} deps @param {Config} cfg */
async function scanSite(deps, cfg) {
  const body = { domain: cfg.url, site_type: cfg.siteType, rescan: cfg.rescan }
  let rateLimited = false
  let waited = false
  for (;;) {
    const started = deps.now()
    /** @type {Scan} */
    let scan
    try {
      scan = await api(deps, cfg.token, 'POST', '/v1/scan', body, 100_000)
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && !rateLimited) {
        rateLimited = true
        deps.out('SagBot: rate limited, retrying in 60 s')
        await deps.sleep(60_000)
        continue
      }
      if (e instanceof ApiError && e.status < 500) throw e
      // Timeout, network error or 5xx: the scan may still finish (and be charged) server-side, and there is no
      // idempotency key. Read the stored result instead of posting (and paying) again.
      return readBack(deps, cfg, started, `The scan call failed (${why(e)})`)
    }
    const wait = scan.rescan_in_seconds
    if (wait === undefined || wait > 130 || waited) return scan
    // Scanned under 2 minutes ago (often a redeploy right after another): wait for a fresh scan once.
    waited = true
    deps.out(`SagBot: ${scan.host} was scanned under 2 minutes ago, waiting ${wait} s for a fresh scan`)
    await deps.sleep((wait + 2) * 1000)
  }
}

/** @param {Deps} deps @param {Config} cfg @param {number} started @param {string} reason @returns {Promise<Scan>} */
async function readBack(deps, cfg, started, reason) {
  for (let i = 0; i < 3; i++) {
    deps.out(`SagBot: ${reason}; reading the stored result in 30 s`)
    await deps.sleep(30_000)
    try {
      const s = await api(deps, cfg.token, 'GET', latestPath(cfg, cfg.url), undefined, 30_000)
      if (Date.parse(s.scanned_at) >= started - 5_000) return { ...s, cached: false }
    } catch (e) {
      if (final(e) && !(e instanceof ApiError && e.status === 404)) throw e
    }
  }
  throw new Error(`${reason}, and no new result was stored. Run the job again.`)
}

/** How many checks a complete scan ran: every one is in exactly one of these. @param {Scan} s */
const total = (s) => s.counts.pass + s.counts.info + s.counts.na + s.fixes.length + s.could_not_verify.length

/**
 * What changed between two complete scans, per check id. Regression: failing or partial now and passing (or not
 * applicable) before, or partial before and failing now. A check SagBot couldn't verify before isn't a regression.
 * Ids in `skip` aren't compared.
 * @param {Scan | null} before @param {Scan} now @param {Set<string>} [skip] @returns {Delta | null}
 */
export function delta(before, now, skip = new Set()) {
  if (!before?.complete || !now.complete) return null
  const was = new Map(before.fixes.map((f) => [f.id, f.status]))
  const wasUnknown = new Set(before.could_not_verify.map((c) => c.id))
  // ponytail: the API lists only checks that didn't pass, so "absent before" means passed, n/a or not a check yet.
  // Equal check counts stand for the same check set; otherwise (a SagBot release in between) a check absent before
  // is "new or newly failing" and doesn't gate. Exact once the API returns every check id.
  const sameChecks = total(before) === total(now)
  /** @type {Delta} */
  const d = { regressions: [], unsure: [], fixed: [] }
  for (const f of now.fixes) {
    if (skip.has(f.id)) continue
    if (was.has(f.id)) {
      if (was.get(f.id) === 'partial' && f.status === 'fail') d.regressions.push(f)
    } else if (!wasUnknown.has(f.id)) (sameChecks ? d.regressions : d.unsure).push(f)
  }
  const isNow = new Set([...now.fixes, ...now.could_not_verify].map((c) => c.id))
  d.fixed = before.fixes.filter((f) => !isNow.has(f.id) && !skip.has(f.id))
  return d
}

/** @param {Config} cfg @param {Scan} scan @param {Delta | null} d */
export function gate(cfg, scan, d) {
  /** @type {string[]} */
  const failures = []
  /** @type {string[]} */
  const warnings = []
  if (!scan.complete) {
    // Nothing else to judge: an incomplete scan has no scores and no checks.
    const msg = `Couldn't fully scan ${scan.host}: ${scan.fail_reason ?? 'unknown reason'}`
    ;(cfg.failOnIncomplete ? failures : warnings).push(msg)
    return { failures, warnings }
  }
  /** @param {string} label @param {number | null} n @param {number | null} min */
  const atLeast = (label, n, min) => {
    if (min !== null && (n === null || n < min)) failures.push(`${label} is ${n ?? 'not scored'}, below ${min}`)
  }
  atLeast('Agent-ready', scan.scores.agent_ready, cfg.minAgent)
  atLeast('Answer-ready', scan.scores.answer_ready, cfg.minAnswer)
  for (const id of cfg.required) {
    const f = scan.fixes.find((x) => x.id === id)
    if (f) failures.push(`Required check ${id} (${f.title}) is ${f.status ?? 'failing'}`)
    else if (scan.could_not_verify.some((x) => x.id === id)) warnings.push(`Required check ${id} couldn't be verified`)
  }
  if (cfg.failOnRegression && d)
    for (const f of d.regressions) failures.push(`Got worse: ${f.id} (${f.title}) is now ${f.status ?? 'failing'}`)
  return { failures, warnings }
}

/**
 * Inline Markdown from untrusted text (it can quote the scanned site): no markup, HTML, entities, math, @mentions,
 * issue references, autolinks or bidi overrides; one line.
 */
export const md = (/** @type {unknown} */ s) =>
  String(s)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\\`*_[\]<>|#~!&$]/g, (c) => `\\${c}`)
    .replace(/[@#:]/g, (c) => `${c}\u200b`)
    .replace(/www\./gi, (w) => `${w.slice(0, 3)}\u200b.`)
    .replace(/\bGH-/gi, (w) => `${w.slice(0, 2)}\u200b-`)
    .replace(/\\\$/g, () => '\u200b\\$\u200b')

/** Inline code for our own ids and hostnames: no backticks or spaces to break out with. */
const code = (/** @type {unknown} */ s) => `\`${String(s).replace(/[`\s]/g, '')}\``

/** A fenced block that the text can't close. @param {string} text */
function fence(text) {
  const run = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(run + 1)
  return `${f}text\n${text}\n${f}`
}

/** @param {number | null} now @param {number | null | undefined} before */
function change(now, before) {
  if (now === null || before === null || before === undefined) return ''
  const n = now - before
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0'
}

/** @param {string} label @param {Fix[]} fixes */
function idList(label, fixes) {
  if (!fixes.length) return []
  const shown = fixes.slice(0, LIST_MAX).map((f) => `${code(f.id)} ${md(f.title)}`)
  const more = fixes.length > LIST_MAX ? [`and ${fixes.length - LIST_MAX} more`] : []
  return [`**${label} (${fixes.length}):** ${[...shown, ...more].join(' · ')}`, '']
}

/** The one PR comment per baseline and site type, so two scan steps keep two comments. @param {Config} cfg */
export const marker = (cfg) =>
  `${MARKER} ${cfg.baseline
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9.\-/]/g, '')
    .replace(/\/+$/, '')} ${cfg.siteType} -->`

/**
 * @typedef {{ cfg: Config, scan: Scan, base: Scan | null, d: Delta | null, note: string | null, skipped: Fix[],
 *   failures: string[], warnings: string[], reportUrl: string }} View
 */

/**
 * Markdown for the job summary (`full`: every fix with its text) or the PR comment (no fix text: it quotes the site).
 * @param {View} v @param {boolean} full
 */
export function render(v, full) {
  const { scan, base, d, failures, warnings } = v
  const ok = failures.length === 0
  const when = `${scan.scanned_at.slice(0, 16).replace('T', ' ')} UTC`
  const lines = [
    marker(v.cfg),
    `### ${ok ? '✅' : '❌'} SagBot AI-readiness: ${ok ? 'passed' : 'failed'}`,
    '',
    `${code(scan.host)} · ${md(scan.site_type)} · scanned ${when}${scan.cached ? ' (stored result)' : ''}`,
    '',
  ]
  if (scan.complete) {
    const withBase = d !== null && base !== null
    lines.push(
      withBase ? '| Score | Now | Before | Change |' : '| Score | Now |',
      withBase ? '|---|--:|--:|--:|' : '|---|--:|',
    )
    for (const [label, key] of /** @type {const} */ ([
      ['Agent-ready', 'agent_ready'],
      ['Answer-ready', 'answer_ready'],
    ])) {
      const now = scan.scores[key]
      const cells = [label, now ?? '–']
      if (withBase) cells.push(base.scores[key] ?? '–', change(now, base.scores[key]))
      lines.push(`| ${cells.join(' | ')} |`)
    }
    lines.push('')
    if (withBase) lines.push(`Before: scan of ${code(base.host)} from ${base.scanned_at.slice(0, 10)}`, '')
    if (v.note) lines.push(v.note, '')
    if (d)
      lines.push(
        ...idList('Got worse', d.regressions),
        ...idList('New or newly failing, not gated (SagBot added checks since the baseline)', d.unsure),
        ...idList('Fixed', d.fixed),
      )
    if (d && v.skipped.length) lines.push(...idList('Not compared (host-specific or ignored)', v.skipped))
  }
  if (failures.length) lines.push('**Gate**', '', ...failures.map((f) => `- ${md(f)}`), '')
  if (warnings.length) lines.push(...warnings.map((w) => `- ⚠️ ${md(w)}`), '')
  if (v.reportUrl) lines.push(`[Full report on sagbot.app](${v.reportUrl})`, '')
  if (full && scan.fixes.length) {
    lines.push(`<details><summary>All ${scan.fixes.length} fixes, for a coding agent</summary>`, '')
    for (const f of scan.fixes)
      lines.push(
        `**${md(f.title)}** (${code(f.id)}, ${md(f.status ?? 'failing')})`,
        '',
        fence(String(f.fix ?? '').slice(0, 4000)),
        '',
      )
    lines.push('</details>', '')
  }
  if (full && scan.cost_usd) lines.push(`Cost: $${scan.cost_usd.toFixed(2)}`, '')
  return lines.join('\n')
}

/** Workflow command line (`::error::…`) with the runner's escaping. @param {'error' | 'warning' | 'notice'} kind @param {string} msg */
export const cmd = (kind, msg) => `::${kind}::${msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`

/**
 * Create or update this step's comment on the pull request. Only a bot's comment counts (github.token posts as
 * github-actions[bot]), so a person can't plant the marker and take the comment over.
 * @param {Deps} deps @param {Env} env @param {string} token @param {string} mark @param {string} body
 */
async function upsertComment(deps, env, token, mark, body) {
  const event = JSON.parse(readFileSync(/** @type {string} */ (env.GITHUB_EVENT_PATH), 'utf8'))
  const pr = event.pull_request?.number
  if (!pr) return
  const repo = `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}`
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': UA }
  /** @type {number | undefined} */
  let id
  for (let page = 1; page <= 10 && id === undefined; page++) {
    const r = await deps.fetch(`${repo}/issues/${pr}/comments?per_page=100&page=${page}`, { headers })
    if (!r.ok) throw new Error(`GitHub ${r.status} listing PR comments`)
    /** @type {{ id: number, body?: string, user?: { type?: string } }[]} */
    const items = await r.json()
    id = items.find((c) => c.user?.type === 'Bot' && c.body?.startsWith(mark))?.id
    if (items.length < 100) break
  }
  const r = await deps.fetch(id === undefined ? `${repo}/issues/${pr}/comments` : `${repo}/issues/comments/${id}`, {
    method: id === undefined ? 'POST' : 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  if (!r.ok) throw new Error(`GitHub ${r.status} writing the PR comment (needs permissions: pull-requests: write)`)
}

/** @type {Deps} */
const runtime = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  out: (line) => console.log(line),
}

/** Runs the action; resolves to the exit code. @param {Env} env @param {Deps} [deps] */
export async function run(env, deps = runtime) {
  // Before reading the other inputs: on a fork PR the deploy step that sets `url` is skipped too.
  if (!input(env, 'token')) {
    deps.out(cmd('warning', 'No SagBot token, scan skipped. Pull requests from forks get no secrets.'))
    return 0
  }
  const cfg = config(env)
  const base = await baselineScan(deps, cfg)
  const scan = await scanSite(deps, cfg)

  const same = base !== null && base.host === scan.host && base.scanned_at === scan.scanned_at
  const otherType = scan.site_type !== cfg.siteType
  const skip = new Set([...cfg.ignore, ...(base && base.host !== scan.host ? HOST_BOUND : [])])
  const d = same || otherType ? null : delta(base, scan, skip)
  const { failures, warnings } = gate(cfg, scan, d)
  if (otherType)
    warnings.push(`Got a ${scan.site_type} scan, not ${cfg.siteType} (scanned under 2 minutes ago), so no comparison`)
  else if (scan.rescan_in_seconds !== undefined)
    warnings.push(`Another scan of ${scan.host} ran under 2 minutes ago: this is that stored scan, not a fresh one`)
  const note = !base
    ? 'No baseline to compare with yet.'
    : same
      ? 'No change to show: the baseline is this same scan.'
      : !base.complete
        ? 'The baseline scan was incomplete, so there is nothing to compare with.'
        : null
  const reportUrl = REPORT_URL.test(scan.report) ? scan.report : ''
  const skipped = scan.fixes.filter((f) => skip.has(f.id))
  /** @type {View} */
  const view = { cfg, scan, base: same ? null : base, d, note, skipped, failures, warnings, reportUrl }

  if (env.GITHUB_OUTPUT) {
    const outputs = {
      'agent-ready': scan.scores.agent_ready ?? '',
      'answer-ready': scan.scores.answer_ready ?? '',
      'report-url': reportUrl,
      'scanned-at': scan.scanned_at,
      regressions: d?.regressions.map((f) => f.id).join(',') ?? '',
      fixed: d?.fixed.map((f) => f.id).join(',') ?? '',
      passed: String(failures.length === 0),
    }
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([k, val]) => `${k}=${String(val).replace(/[\r\n]+/g, ' ')}\n`)
        .join(''),
    )
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${render(view, true)}\n`)
  if (cfg.comment && cfg.githubToken && env.GITHUB_EVENT_PATH && env.GITHUB_REPOSITORY) {
    try {
      await upsertComment(deps, env, cfg.githubToken, marker(cfg), render(view, false))
    } catch (e) {
      deps.out(cmd('warning', `PR comment skipped: ${why(e)}`))
    }
  }
  const s = scan.scores
  deps.out(
    `SagBot ${scan.host}: Agent-ready ${s.agent_ready ?? '–'}, Answer-ready ${s.answer_ready ?? '–'} ${reportUrl}`,
  )
  for (const w of warnings) deps.out(cmd('warning', w))
  for (const f of failures) deps.out(cmd('error', f))
  return failures.length ? 1 : 0
}
