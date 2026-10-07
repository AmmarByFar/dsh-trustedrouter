# dsh-trustedrouter

A community DeepSeek Harness (dsh) plugin that adds TrustedRouter `provider` routing and privacy settings (e.g. `min_privacy`) to LLM request bodies, editable per model from the dsh web UI. Repo: `AmmarByFar/dsh-trustedrouter`.

**Where we are:** Phases 0 (spikes) and 1 (host half, `index.js`) are done; the results are in PLAN.md. **Pick up at Phase 2 (client half) in PLAN.md.** Update PLAN.md's Status line and design notes as phases complete, so the next session can resume from it.

If `CLAUDE.local.md` exists, read it at session start. It holds maintainer-machine notes: the live dsh setup, the working prototype's location, and accounts.

@PLAN.md

## Conventions

- Plain JavaScript ESM, **no build step and no runtime dependencies**. The only allowed peer is `@deepseek-ai/schemastery`, and never declare `@deepseek-ai/dsh*` peers. `client.js` follows dsh's plain-JS template (see PLAN.md).
- Code style follows the prototype: a short JSDoc header explaining *why*, small pure helpers (`isPlainObject`, `mergeBody`), and comments only where intent isn't obvious.
- Behaviour that must not regress:
  - Matching POSTs that can't be rewritten **fail closed**.
  - GETs and non-gateway URLs pass through untouched.
  - The plugin never logs request bodies; logs go to `console.error`, not `ctx.logger`.
- Tests:
  - Run `npm install` once; it installs the schemastery devDependency.
  - `npm test` for units. Not bare `node --test`, which also picks up the mock server and `.ref/`.
  - `test/e2e/run-all.sh` for real headless dsh runs against a mock: every `test/e2e/rows/*.yml` plus `--control`. Each row's `# expect-provider:` line is asserted.
  - `test/e2e/run-headless.sh <row.yml>` runs a single row.
  - `DSH_VERSION=0.2.0-rc.2|alpha|latest` picks the dsh build.

## Working against dsh

- For dsh source, clone it into the git-ignored `.ref/`: `git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git .ref/deepseek-harness`. PLAN.md's reference section lists the relevant files.
- **Never touch the maintainer's live dsh** (profile `~/.dsh/profiles/web`, server on 127.0.0.1:3080) during development. Use a scratch `DSH_HOME` with `npx @deepseek-ai/dsh web --port 0 --no-open`, or the headless harness.
- **Ask first** before:
  - creating the GitHub repo or pushing;
  - choosing public vs private;
  - running `corepack enable` globally;
  - editing the live profile;
  - publishing to npm.
