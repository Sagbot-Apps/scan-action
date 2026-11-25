# SagBot AI-readiness scan action

Scans a deployed site with [SagBot](https://sagbot.app) and fails the job when it gets worse for AI agents and answer
engines: a check that passed before now fails, a score drops under your floor, or a check you require fails. Writes the
scores, what got worse and what got fixed to the job summary and to one pull request comment.

SagBot fetches the public site, so scan a deployment: a preview URL on a pull request, or production after a deploy.

## Usage

### Pull request preview vs production

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write # the PR comment
jobs:
  sagbot:
    runs-on: ubuntu-latest
    steps:
      # … deploy a preview first, e.g. Cloudflare Pages or Netlify, and expose its URL
      - uses: Sagbot-Apps/scan-action@v1
        with:
          token: ${{ secrets.SAGBOT_TOKEN }}
          url: ${{ steps.deploy.outputs.deployment-url }}
          baseline: example.com # production: the "before"
```

### After a deploy to production

```yaml
on:
  push:
    branches: [main]
jobs:
  sagbot:
    runs-on: ubuntu-latest
    steps:
      # … deploy
      - uses: Sagbot-Apps/scan-action@v1
        with:
          token: ${{ secrets.SAGBOT_TOKEN }}
          url: example.com # compared with its own previous scan
          min-agent-ready: 60
          require: agent-robots, seo-indexability
```

## Inputs

| Input | Default | |
|---|---|---|
| `token` | required | SagBot API token (`sgb_…`) from [sagbot.app/docs](https://sagbot.app/docs#token). Keep it in a secret |
| `url` | required | Domain or URL of the deployed site |
| `baseline` | `url` | Domain whose newest stored scan is the "before", usually production |
| `site-type` | `content` | `content` (blog, docs, marketing), `app` (SaaS, web app) or `shop` |
| `rescan` | `true` | Fresh scan; `false` may reuse a scan from the last 60 minutes |
| `min-agent-ready` | off | Fail under this Agent-ready score (0–100) |
| `min-answer-ready` | off | Fail under this Answer-ready score (0–100) |
| `require` | none | Check ids that must pass (comma, space or newline separated). The ids are in the scan report |
| `ignore` | none | Check ids never compared with the baseline |
| `fail-on-regression` | `true` | Fail when a check got worse than in the baseline |
| `fail-on-incomplete` | `true` | Fail when the site couldn't be fully scanned (down, blocked, behind a login) |
| `comment` | `true` | One PR comment, updated on every run (`pull_request` events) |
| `github-token` | `github.token` | Token for the comment; needs `pull-requests: write`. Only a bot's comment is updated: with a personal token the action posts a new comment each run |

Outputs: `agent-ready`, `answer-ready`, `report-url`, `scanned-at`, `regressions` and `fixed` (comma-separated check
ids), `passed`.

## Good to know

- **Cost.** Scans of your [verified domains](https://sagbot.app/dashboard) and their subdomains are free. Other sites,
  preview hosts like `*.pages.dev` or `*.vercel.app` included, get 3 free scans a day, then $0.06 each from your
  balance. Reading the baseline is free.
- **Previews behind a login** (Vercel Deployment Protection is on by default) can't be scanned: the scan ends
  incomplete. Scan a public preview, or production after the deploy.
- **Forks.** Pull requests from forks get no secrets: the action skips with a warning.
- **One scan per site every 2 minutes.** Right after another scan the action waits for a fresh one once.
- **Previews vs production.** Preview hosts send `X-Robots-Tag: noindex` and point canonical, hreflang and absolute
  links at production. When the scanned host differs from the baseline's, `seo-indexability`, `seo-canonical`,
  `seo-crawlable-links` and `seo-hreflang` aren't compared; they show under "Not compared".
- Regressions count only checks SagBot could decide in both scans; a check it couldn't verify is never a regression.
  When SagBot ran a different number of checks than in the baseline (it added checks), a check failing now that wasn't
  failing before is listed as "new or newly failing" and doesn't fail the job.
- `require` applies on every host: on a preview, `require: seo-indexability` always fails (previews send
  `noindex`). Require host-specific checks only where you scan production.
- `require` can't tell a mistyped id from a passing check (the API returns only failing checks): copy ids from the
  report.
- **`pull_request_target`.** There the action gets your secrets on pull requests from forks, so anyone opening one
  spends your SagBot balance, and a job that builds the fork's code to get a preview URL runs it with your secrets.
  Use `pull_request`, or gate the job behind an approval. Pin the action to a full commit SHA, not `@v1`.
