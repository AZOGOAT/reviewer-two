# Reviewer Two

[![CI](https://github.com/AZOGOAT/reviewer-two/actions/workflows/ci.yml/badge.svg)](https://github.com/AZOGOAT/reviewer-two/actions/workflows/ci.yml)
[![Marketplace](https://img.shields.io/github/v/release/AZOGOAT/reviewer-two?label=marketplace&logo=github)](https://github.com/marketplace/actions/reviewer-two-ai)
[![License: MIT](https://img.shields.io/github/license/AZOGOAT/reviewer-two)](LICENSE)

Named for academia's Reviewer #2: reads everything, questions everything, approves nothing.

A GitHub Action that reviews pull requests and posts the result as a normal GitHub review: inline comments, suggestion blocks where the fix is obvious, and a COMMENT or REQUEST_CHANGES verdict. It never approves, and it cannot touch your code: the token only gets contents read and pull-requests write.

Before commenting it explores the repo with read-only tools, then re-checks its findings and drops the ones it cannot defend. The bias is fewer, better comments: nits fold into the review body instead of inline noise, anything a linter would catch is skipped, and each finding cites the rule it breaks.

Works with any language. Conventions come from your repo, not the tool.

## Where it fits

There are plenty of AI code review tools out there. Here is what makes this one worth your workflow file:

- **No platform, no server, no subscription.** One Action, one workflow file, done. You bring your own API key and pay your own bill, which for a mid-size PR is the price of a coffee, not a seat license.
- **It reviews where your team already argues about code.** Commit-time CLIs and editor plugins catch things early on your machine; Reviewer Two shows up on the PR page as a reviewer you request like any other, and its verdict lands in the same place a human's would.
- **Invited, never uninvited.** No drive-by comments on every push. It runs when someone asks, double-checks every finding before posting, and a re-request picks up where it left off instead of repeating itself.

Want dashboards, metrics, and lint-as-you-type? Not this tool. This one does what Reviewer #2 has always done: show up when summoned, read everything, and say exactly what is wrong.

## Setup

Two ways to run it.

### Label trigger (solo)

Reviews post as github-actions. Add `.github/workflows/ai-review.yml`:

```yaml
name: AI review
on:
  pull_request:
    types: [labeled]
  workflow_dispatch:
    inputs:
      pull_number:
        required: true
concurrency:
  group: ai-review-${{ inputs.pull_number || github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'ai-review'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: read
    steps:
      - name: Validate PR number
        if: github.event_name == 'workflow_dispatch'
        env:
          PULL_NUMBER: ${{ inputs.pull_number }}
        run: |
          [[ "$PULL_NUMBER" =~ ^[0-9]+$ ]] || { echo "pull_number must be numeric"; exit 1; }
      - uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ inputs.pull_number || github.event.pull_request.number }}/head
      - uses: azogoat/reviewer-two@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          pull_number: ${{ inputs.pull_number || github.event.pull_request.number }}
```

Set the `ANTHROPIC_API_KEY` secret. Then label a PR with `ai-review`, or run the workflow manually with a PR number.

### Review request trigger (team)

Reviews post from a machine account that your team creates and owns, so you request and re-request it exactly like a human reviewer.

1. Create a machine GitHub account under any name you like, and add it to the repo as a collaborator.
2. Give it a fine-grained PAT with Contents: read and Pull requests: read and write. Add Issues: read if you want issues linked in PR descriptions used as context. Store it as the `AI_REVIEWER_TOKEN` secret.
3. Add `.github/workflows/ai-review.yml`, with `reviewer_login` set to your account's login:

```yaml
name: AI review
on:
  pull_request:
    types: [review_requested]
jobs:
  review:
    uses: azogoat/reviewer-two/.github/workflows/review.yml@v1
    with:
      reviewer_login: your-review-bot
    secrets:
      ai_reviewer_token: ${{ secrets.AI_REVIEWER_TOKEN }}
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Requesting a review from that account triggers a run under its identity. Re-requesting runs an incremental pass: it reads its earlier inline threads, replies included. Anything someone replied to or resolved, or that would not block the merge, is never brought up again; an unanswered blocking finding comes back only if the code still has the problem. Draft PRs are skipped.

## Rules and context

Zero config works: README.md, AGENTS.md (at the root or under .kimi-code/), CLAUDE.md, CONTRIBUTING.md, .cursor/rules, and agent skills in .agents/skills/ or .kimi-code/skills/ (each skill's SKILL.md, or a flat .md file) are picked up automatically. Issues referenced in the PR description (`#123`, `owner/repo#123`, or full URLs) are fetched with their comment threads; refs the token cannot read are skipped.

For per-path rules, add `.github/ai-review/manifest.yml`:

```yaml
context: description.md
always: [rules.md]
rules:
  - file: rules-python.md
    paths: ["**/*.py"]
```

Only rule files matching the PR's changed paths are loaded.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| model | claude-opus-4-8 | Any claude-* or gpt-*/o* model id, or an org/model id from an OpenAI-compatible endpoint |
| max_tool_calls | 50 | Exploration cap; a runaway guard, raise it for large repos |
| exploration_token_budget | 5000000 | Total token cap; when spent, the review wraps up early with what it has found |
| context_window_tokens | 200000 | Context window of the model; sets how much diff goes in the prompt (when the diff is larger, the biggest files are left to the exploration tools), and exploration wraps up 50k tokens before it fills. When you raise it, raise exploration_token_budget too: every step re-sends the prompt and counts against that budget |
| reasoning_effort | unset | How hard the model reasons: none, minimal, low, medium, high, xhigh or max. Unset keeps the model's default. Claude takes low to max as its effort setting, OpenAI reasoning models take it as their reasoning effort and other OpenAI models ignore it, and OpenAI-compatible servers get it as reasoning_effort and decide what each value means. A value the model refuses fails the review with the provider's error |
| max_inline_comments | 15 | Extra findings collapse into the review body |
| inline_severity_threshold | minor | Minimum severity posted inline; nits never post inline |
| request_changes_threshold | major | Minimum severity for a REQUEST_CHANGES verdict |
| reviewer_login | unset | Login of your machine account; required for team mode |
| dry_run | false | Log the review instead of posting it |

`github_token`, `anthropic_api_key`, `openai_api_key`, `openai_compatible_base_url`, `openai_compatible_api_key`, and `pull_number` appear in the examples above; see [action.yml](action.yml) for details.

## Model and cost

The default is the strongest Claude model because review quality is the whole point; a deep review of a mid-size PR lands around 1 to 3 USD. Any repo can set a cheaper `model`. GPT models need only the model id and an `openai_api_key` secret; there are no separate code paths. Self-hosted or third-party OpenAI-compatible servers (vLLM and friends) work the same way: use the model id the server exposes (they look like org/model), point `openai_compatible_base_url` at its `/v1` URL, and put its key in `openai_compatible_api_key`.

## Contributing

Bug reports and PRs welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
