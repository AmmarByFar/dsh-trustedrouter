# dsh-trustedrouter: plan

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that lets users choose [TrustedRouter](https://trustedrouter.com/docs/provider-routing) privacy and routing options **per model** from the dsh web UI. Anyone can install it from GitHub.

**Status (2026-10-07):** Phase 0 done; all four pass criteria met on dsh 0.2.0-rc.2 (see [Phase 0 results](#phase-0-results-2026-10-07)). **Next step is Phase 1 (host half).** The repo is private on GitHub with `main` only; the spike branch was deleted.

## Background: why a plugin

- TrustedRouter takes routing and privacy policy only from the request body, as a `provider` object (e.g. `{"provider": {"min_privacy": "confidential"}}`). It accepts no header or API-key default for this.
- dsh's pi-ai provider routes (`@deepseek-ai/dsh-llm-pi-ai`) accept extra `headers` but have **no body-field setting**:
  - pi-ai 0.87.1 has `onPayload`, `fetch` and `samplingParams`, but the dsh adapter (`packages/llm/llm-pi-ai/src/adapter.ts`, the `streamSimple(...)` call) passes none of them.
  - pi-ai's `compat.openRouterRouting` would send `provider`, but dsh marks it `withhold` in `catalog.ts`, so config refuses it.
- The DeepSeek body-extension registry (`ctx.deepseekLlmApiExtensions`) only applies to the official DeepSeek adapter.
- **Therefore the host half wraps `globalThis.fetch`.** This works because pi-ai builds a new OpenAI or Anthropic SDK client per request, and the SDK resolves the global `fetch` at construction.
  - Proven on dsh 0.2.0-rc.2: unit tests plus a headless end-to-end run against a mock.
  - In the maintainer's own use, the logs showed `provider` added to real chats.
- The working prototype lives outside this repo (see `CLAUDE.local.md`). Phase 1 grows it into this repo.

## Decisions

| # | Decision | Status |
|---|---|---|
| 1 | Repo `AmmarByFar/dsh-trustedrouter`, MIT licence, `dsh-plugin` GitHub topic | **Confirmed** (repo name and owner) |
| 2 | Models page offers: privacy floor, provider allow/block (`only`/`ignore`), `sort`, US-only (`jurisdiction`), billing (`usage`). Advanced fields (`max_price`, `order`, `allow_fallbacks`, raw JSON) go on the plugin's own Plugins page | Proposed; confirm with user |
| 3 | GitHub first; npm publish later | Proposed; confirm with user |
| 4 | Per-chat (composer) privacy override is **not** in v1 | Proposed; confirm with user |
| 5 | Public vs private repo during development | **Confirmed: private** until Phase 4. Created 2026-10-07. Git installs work on the maintainer's machine through gh's credential helper |

"Official" is not achievable. dsh's CONTRIBUTING.md says the team is not accepting outside PRs, and the Plugins page's "Official" group is a hard-coded list of plugins shipped with dsh. The sanctioned route is a public repo with the `dsh-plugin` topic, which community registries pick up automatically.

## Design

### Package layout: plain JS, no build step

```
package.json       exports {".": "./index.js", "./client": "./client.js", "./locale/*.json", "./icon", "./package.json"},
                   top-level "icon": "./icon.svg", dsh.bundle.patch, dsh.client {platform: "web", inject: [...]},
                   peerDependencies + devDependencies {"@deepseek-ai/schemastery"}
index.js           host half: volatile Config schema plus the fetch wrapper with per-model merge
client.js          browser half: window.__ModuleLoader__.load({ id, factory(require) {...} }), React via require('react')
cordis.patch.yml   bundle layer: inserts row `id: trustedrouter`, `name: dsh-trustedrouter` (the bare package name, needed for the client half)
locale/en.json     { "meta": { "title", "description" } } (zh.json optional)
icon.svg
test/              node:test unit tests, plus test/e2e (headless dsh against mock-openai.mjs)
```

- **No build step.** A git install then needs no `prepare` script, so pnpm doesn't ask for `allowBuilds`. Verified in Phase 0.
- **Template to copy.** dsh ships a plain-JS starter: `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/` (`package.json`, `cordis.patch.yml`, `index.js`, `client.js`, `locale/en.json`, `icon.svg`).
  - The same skill folder has `references/ui-plugin.md` and `references/practices.md`.
  - It is also present in the installed rc.2 copy at `node_modules/@deepseek-ai/dsh-agent-preset/skills/...`.
- **Dependencies.** Do not declare `@deepseek-ai/dsh*` peers. The install-time compatibility gate requires every `dsh*` peer range to satisfy the running version, and `^0.2.0` does not satisfy `0.2.0-rc.2`. `@deepseek-ai/schemastery` and `@deepseek-ai/cordis` are not gated.
  - **How the schemastery peer resolves (verified in Phase 0).** Profiles use `nodeLinker: hoisted` and `autoInstallPeers: false`, so pnpm installs no copy and prints only a peer warning. dsh's "runtime resolution" then answers the import from its own install.
  - **Path-mounted rows don't get that resolution.** A row like `name: /abs/path/index.js` fails with "failed to import". Local dev therefore needs schemastery in the repo's `node_modules`, for both `node --test` and path-mounted headless e2e. Make it a devDependency in Phase 1; Phase 0 used a symlink to rc.2's copy.
- **Client imports.** The client may `require` only the shell's shared modules:
  - `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`
  - `@deepseek-ai/cordis`
  - `@deepseek-ai/dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`
  
  The template's practices doc advises plain-JS plugins not to require `ui-primitives`; copy the markup and use `--dsw-alias-*` CSS tokens instead.
- **Boot risk.** A malformed `dsh.client` declaration or a missing `client.js` fails the client-modules fiber, which can break web boot. Test installs carefully.
- **`immediately`.** The template sets `dsh.client.immediately: true`, but dsh's AGENTS.md says it's for infrastructure rows only. Phase 0 works without it; leave it out.
- **`dsh.client.inject`.** `["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-plugin-manager", "@deepseek-ai/dsh-client-ui-settings-models"]` works on rc.2, following the agent-loop example.
- **Icon.** rc.2 reads a plugin icon only from the exported `./package.json`'s top-level `"icon"` field (`readPluginMeta` in `dsh-app-boot`). The `./icon` export fallback exists only in the 0.2.1-alpha source. The spike exported `./icon` alone and got the default artwork. Do both.

### Host half (`index.js`)

Config is a `@deepseek-ai/schemastery` schema. Its user-editable fields are `.volatile()`, so UI saves commit in place without a remount; read `config.x.get()` per request. Pattern: llm-pi-ai's `providers: z.dict(profile).default({}).volatile()`, and `docs/cookbook/adding-a-settings-card.md` §1 and §3.

```yaml
- id: trustedrouter
  name: dsh-trustedrouter
  config:
    gateways: [https://api.trustedrouter.com/v1]   # EU gateway: https://api-europe-west4.quillrouter.com/v1
    defaults: { min_privacy: zdr }                 # TrustedRouter `provider` fields for every model on those gateways
    models:                                        # per-model overrides, keyed by the request body's `model`
      z-ai/glm-5.3: { min_privacy: confidential, only: [tinfoil, privatemode] }
    rules: []        # generic escape hatch from the prototype: [{ baseURL, body }] deep-merged into any POST body
    log: false       # true prints "[trustedrouter] ..." lines to stderr (the dsh web terminal)
```

Request handling follows the prototype:
- Applies to POSTs whose URL falls under a gateway prefix (path-segment boundary).
- Parses the JSON body, sets `body.provider = merge(body.provider, defaults, models[body.model])`, removes any stale `content-length`, and forwards.
- Leaves GETs (model discovery) and other URLs alone.
- **Fails closed:** a matching POST whose body isn't a JSON object is rejected, never sent bare.
- **Logging goes to `console.error`, not `ctx.logger`.** Shipped dsh profiles mount no Cordis log exporter, so `ctx.logger` output is dropped.
- **Unloading:** restore the previous `globalThis.fetch` if ours is still on top; otherwise become a pass-through.

### Client half (`client.js`)

1. **Models page (main UX).** `ctx.slots.inject('settings.models.provider-card', ...)` registers a keyed entry under key **`llm-pi-ai`**, the settings namespace of pi-ai routes.
   - The slot lives in `packages/client/ui-settings-models/src/client/slot-contract.ts` and is present in rc.2. Nothing ships a registrant for it.
   - Props: `{ provider: { provider, displayName, settingsNs, settingsPath, active, declared?, error? }, configured, keyConfigured }`.
     - Seen on rc.2: `{"provider":"trustedrouter","displayName":"trustedrouter","settingsNs":"llm-pi-ai","settingsPath":["providers","trustedrouter"],"active":true,"declared":true}`.
     - The renderer kit adds `renderFactorySlot`, `usePanelInfo`, `useResource`, `useSessionRetainInfo`, `useSessionStatus`, `useSessions` and `useWorkspaces`, plus whatever the entry's `inject()` returns.
   - **Neither the props nor the provider's directory entry includes the baseURL.** Read it from `ctx.configForms.get('llm-pi-ai')`: snapshot `value.providers[route].baseURL` and `.models[].id`.
     - Verified in Phase 0: `status=ready`, `mode=host`, `writable=true`. The settings path is `props.provider.settingsPath`.
   - The entry renders on **every** pi-ai card. In Phase 0 that was both the TrustedRouter and mock routes, so filter by baseURL.
   - Render the section only when the baseURL is a configured gateway. Show one row per model:
     - privacy dropdown limited to the levels that model can reach, labelled with the qualifying providers;
     - provider allow/block lists;
     - sort;
     - US-only toggle;
     - billing (credits/BYOK).
   - There is **no per-model slot**, so the whole per-model table lives inside this provider-card area.
2. **Plugins page.** Register `plugins.row.config` keyed `dsh-trustedrouter#trustedrouter`, with `view: 'page'` for the form and `'summary'` for the card.
   - The page passes `form` (a `ConfigPageForm` with `state` and `mutate(ops, expectedRevision)`) only when the row id is a served settings namespace, i.e. Config has volatile fields.
   - Verified in Phase 0:
     - The row's `>` link opens the page, and `form` is present.
     - `form.mutate([{ op: 'set', path: ['minPrivacy'], value }], form.state.revision)` resolves `true`, and the profile patch gains the `trustedrouter` row.
     - The host gets `loader/volatile-update [["minPrivacy"]]` with no remount, and the next POSTs see the new value. It survives a restart.
     - None of this needs `patchReload: live`.
   - This page holds gateways, defaults, advanced fields, raw rules and the log toggle.
   - Do **not** use `plugins.item`; it's reserved for official pages.
3. **Saving.** `ctx.configForms.get('trustedrouter')` returns `getSnapshot()` (`status, value, base, user, revision, writable, mode`), `subscribe()`, `mutate([{op:'set'|'unset', path, value}], expectedRevision)`, `set` and `unset`.
   - Writes go through settings-controller, then `ctx.settings`, then `ctx.configEditor`, into the profile's `cordis.patch.yml`.
   - Writes only work on loopback pages.
   - The home patch and `--patch` overlays win, and a write they would shadow is refused.
   - There is no schema-to-form renderer; build the form by hand. The official example is `packages/client/ui-settings-agent-loop/src/client/*`.
4. **Text.** Register the dictionary, then register entries with `locale: NS` so components get `t`.
   - **The signature differs between versions.** rc.2 has `ctx.locale.register(ns, locale, dict)`; the 0.2.1-alpha source has `ctx.locale.register(ns, { en, zh })`. Feature-detect, e.g. on `register.length`, and test on both.
   - The spike used no locale, so this is untested at runtime.
5. **Model data.** `GET https://api.trustedrouter.com/v1/models` is public, needs no key, and sends `Access-Control-Allow-Origin: *`, so the browser can fetch it directly. Keep it a simple GET with no custom headers, because preflight OPTIONS returns 401. Cache it.
   - Each `data[i].trustedrouter` has `privacy_tier` and `privacy_tier_label` (the model's maximum) and `endpoints[]`.
   - Endpoint fields include `id`, `provider`, `provider_name`, `usage_type` (Credits/BYOK), `privacy_tier`, `privacy_tier_label`, `provider_confidential_compute`, `provider_e2ee`, `provider_zero_data_retention`, `provider_headquarters_country`, `provider_us_based`, `supported_parameters`.
   - Tiers: 0 Standard, 1 No-store, 2 Zero retention, 3 Confidential + E2EE + ZDR.
   - Assumed mapping to `min_privacy`: 1 → `no_store`, 2 → `zdr`, 3 → `confidential`. Unverified; confirm.
   - Example: `z-ai/glm-5.3` has 48 endpoints, and only `tinfoil` and `privatemode` are tier 3.
   - `/v1/models/{id}/endpoints` and `/v1/providers` need an API key; avoid them.
   - Treat the JSON as unversioned: tolerate missing fields, and show all levels with a warning for unknown models.
6. **Registration shape (verified in Phase 0).**
   - The factory returns `{ inject: ['slots', 'configForms'], apply(ctx) {...} }`.
   - Keyed entries use `ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, inject: () => ({ ... }) }, Component))`. The `inject()` result is spread into props.
   - Forms bind with `React.useSyncExternalStore(form.subscribe, form.getSnapshot)`. `ctx.configForms.describe()` gives the served-namespace mirror.

### TrustedRouter `provider` fields (from /docs/provider-routing)

- **Filtering and order:**
  - `only` / `ignore`: provider slugs, as an array or comma-separated string.
  - `order`: soft preference.
  - `allow_fallbacks`: default true.
  - `sort`: `price|latency|throughput` or `{by, partition}`.
- **Performance and cost:**
  - `max_price {prompt, completion}`
  - `preferred_max_latency`, `preferred_min_throughput`
  - `require_parameters`
- **Privacy:**
  - `min_privacy`: `any|no_store|zdr|confidential` (aliases `e2e`, `e2ee`). This is a hard floor; if nothing qualifies, the request gets a 400, never a downgrade.
  - `zdr: true`
  - `data_collection`: `allow|deny`
- **Billing and location:**
  - `usage`: `credits|byok`
  - `jurisdiction`: `us`

Model suffixes `:nitro` and `:floor` set `sort`. Aliases `trustedrouter/zdr`, `/e2e`, `/auto`, `/eu` and `/cheap` exist but pick the model for you.

## Phases

### Phase 0: spikes. DONE 2026-10-07; see results below.

Goal: prove the three risky pieces before writing the real plugin.

1. **Scaffold a throwaway bundle** from the dsh template (above):
   - Host `index.js` imports `@deepseek-ai/schemastery`, declares one `.volatile()` field (e.g. `minPrivacy`) and prints it per request.
   - `client.js` registers:
     - `settings.models.provider-card` (key `llm-pi-ai`), rendering the route id plus the baseURL and model ids read from `ctx.configForms.get('llm-pi-ai')`;
     - `plugins.row.config` (key `dsh-trustedrouter#trustedrouter`), rendering a select that saves via `props.form.mutate`.
2. **Push it to GitHub.** Ask the user whether to create `AmmarByFar/dsh-trustedrouter` public now or private, then use branch `spike/phase-0`. Private needs git credentials for the pnpm install.
3. **Install into a scratch dsh setup** without touching the user's real profile:
   - Use `DSH_HOME=<scratch>` and run `npx @deepseek-ai/dsh plugin --profile web add github:AmmarByFar/dsh-trustedrouter#spike/phase-0`.
   - dsh needs `pnpm` on PATH, and the machine only has `corepack`. Use a scratch-only shim: `mkdir <scratch>/bin && printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > <scratch>/bin/pnpm && chmod +x ...`, with `PATH=<scratch>/bin:$PATH`.
   - Don't run `corepack enable` globally without asking.
4. **Run a scratch web instance:** `DSH_HOME=<scratch> npx @deepseek-ai/dsh web --port 0 --no-open`. The real instance uses port 3080.
   - Add a pi-ai route with baseURL `https://api.trustedrouter.com/v1` (a dummy key is fine for UI checks) and check in a browser. Claude in Chrome can drive it.
5. **Pass criteria:**
   - (a) The git install succeeds with no build-permission prompt, and the bundle shows on the sidebar Plugins page.
   - (b) The Models-page section renders inside the TrustedRouter card and shows the baseURL and models.
   - (c) The Plugins-page config form appears; saving changes the value the host prints on the next request with no restart, and the value lands in `<scratch>/profiles/web/cordis.patch.yml`.
   - (d) The client loads and web boot stays healthy.
6. **Fallbacks:**
   - If (b) can't read the config, do per-model editing on the Plugins page only.
   - If (c) fails, keep YAML config, with the UI read-only plus copy-paste snippets.
7. **Record results in this file** (update Status and the relevant design notes), then delete the spike branch.

#### Phase 0 results (2026-10-07)

Setup:
- dsh 0.2.0-rc.2, pnpm 12.9.1 via the corepack shim, and a scratch `DSH_HOME` under the session scratchpad.
- Spike commit `ecdeb56`, on `spike/phase-0` (since deleted).
- Routes: a TrustedRouter pi-ai route with a dummy key, plus a mock route as the default model.
- The live profile and the 3080 server were not touched.

Results:
- **(a) Pass.**
  - `dsh plugin --profile web add github:AmmarByFar/dsh-trustedrouter#spike/phase-0` gave no build prompt. The only output was a schemastery peer warning.
  - The bundle appears under Plugins → Installed with its locale title and description.
  - The private repo installed through gh's credential helper.
- **(b) Pass.** The provider-card entry rendered inside each pi-ai card, with the route's baseURL and model ids read from `ctx.configForms.get('llm-pi-ai')`. Details are in Client half §1.
- **(c) Pass.** Save → patch → live volatile update → the next request prints the new value, with no restart. It survives a restart too. Details are in Client half §2.
- **(d) Pass.**
  - No console errors or warnings on boot or reload.
  - Turning the bundle off unhooks the fetch wrapper (chats reach the mock with no spike line), and the page stays healthy.
  - Turning it back on reloads the host half live with the saved value.
- **Headless.** A path-mounted spike row printed the volatile value on both POSTs, once schemastery was resolvable (see Dependencies).
- **Not yet checked:**
  - anything on 0.2.1-alpha (Phase 3);
  - the locale API at runtime (Client half §4);
  - the `view: 'summary'` fallback, which wasn't needed because the row has a description;
  - the add-provider draft card (`configured=false`).

### Phase 1: host half

- Start from the prototype's `index.js` and tests.
- Add `@deepseek-ai/schemastery` as a devDependency so `node --test` and path-mounted e2e rows can import it. Keep the peer.
- Switch Config to a volatile schemastery schema: gateways, defaults, models, rules, log.
- Add per-model merging. Keep fail-closed and the stderr logging.
- Tests:
  - unit tests (`node --test`);
  - headless end-to-end via `test/e2e/` asserting per-model `provider` values.

### Phase 2: client half

- Models-page section with model-aware dropdowns from the TrustedRouter model list.
- Plugins-page config page.
- Fix the icon: export `./package.json` and set `"icon": "./icon.svg"` (see Package layout).
- Locale registration that works on both rc.2 and 0.2.1-alpha.
- Locale text, icon and card metadata.

### Phase 3: packaging and verification

- README (install via UI and CLI, the pnpm/corepack note, verification steps), LICENSE (MIT), CHANGELOG.
- GitHub Actions:
  - unit tests plus headless end-to-end;
  - a weekly scheduled run against `@deepseek-ai/dsh@latest` and `@alpha` to catch the fetch wrapper silently breaking.
- Clean-install test into a fresh `DSH_HOME` (simulating another PC) on dsh 0.2.0-rc.2 and 0.2.1-alpha.1.

### Phase 4: publish

- Public repo, `dsh-plugin` topic, tagged release (`v0.1.0`).
- Install spec `github:AmmarByFar/dsh-trustedrouter#v0.1.0`.
- Optionally npm later.
- Optionally post a GitHub Discussion on dsh asking for a native `extraBody`/`onPayload` setting in llm-pi-ai, which would retire the fetch wrapper.

### Phase 5: migrate the maintainer's machine

- Install the release into the real `web` profile and move settings into the new `trustedrouter` row.
- Remove the prototype's `extra-body` insert row and `~/dsh-extra-body` only after verifying (see `CLAUDE.local.md`).

### Install flow for users (target)

1. Run `corepack enable pnpm` once if `pnpm` isn't on PATH.
2. dsh sidebar → **Plugins** → **Add plugin** → `https://github.com/AmmarByFar/dsh-trustedrouter`, or the CLI: `dsh plugin --profile web add github:AmmarByFar/dsh-trustedrouter#v0.1.0`.
3. Enable it.
4. Settings → Models → TrustedRouter card → **Privacy & routing**.

## Testing

- **Unit:** `node --test` covering merge, URL matching, fail-closed and config validation.
- **Host end-to-end:** `test/e2e/run-headless.sh`, i.e. `dsh --profile headless` in a scratch `DSH_HOME` against `test/e2e/mock-openai.mjs`, asserting the recorded request bodies.
  - Include a control run without the plugin.
  - `dsh headless` prints the plugin's stderr lines, which is useful for asserting logging.
- **UI:** a scratch `dsh web --port 0 --no-open` driven in a browser; screenshot the Models card and the Plugins page.
- **Live check:** with `log: true`, real chats print `added provider to POST https://api.trustedrouter.com/v1/chat/completions`.
  - Negative test: a Standard-tier model (e.g. `anthropic/claude-haiku-4.5`) with `min_privacy: confidential` should be refused by TrustedRouter.

## Risks

- **The fetch wrapper depends on pi-ai and SDK internals.** If it stops being called, requests go out **without** `provider` and no error. Mitigations: the weekly CI end-to-end run and a documented verification.
- **dsh is pre-stable.** Slot and API names may change, so the README lists tested dsh versions.
- **A broken client half can break web boot.** Clean-install test before every release.
- **Session attribution is unverified.** `ctx.on('llm/stream')` (read-only, frozen options) and `ctx.agents.currentInitiator()` (AsyncLocalStorage) exist, but propagation into pi-ai's fetch hasn't been tested. This only matters for per-chat overrides, which are out of v1.

## Reference: dsh source locations (0.2.1-alpha.1 clone; same in rc.2 unless noted)

- `docs/subsystems/client-modules.md` covers how the client half is discovered and served (`GET /plugins/??<pkg>/client.js&rev=`). It must be a prebuilt CJS-style factory; the host does not compile it.
- `docs/cookbook/adding-a-settings-card.md` §1, §3 and §5 cover volatile config, the settings card and the client package manifest.
- `packages/client/ui-plugin-manager/src/client/slot-contract.ts` declares `plugins.row.config`, `plugins.bundle.config` (no `form`; use `ctx.configForms.get`), `plugins.detail.*` and `plugins.item` (reserved).
- `packages/client/ui-settings/src/client/config-form*.ts` is the `ctx.configForms` API.
- `packages/client/ui-settings-agent-loop/` is the smallest official example with both halves.
- `docs/subsystems/settings.md` says forms expose only volatile fields of active, uniquely addressed profile rows, and writes validate the full Config and refuse stale revisions.
- `packages/boot/plugin-manager/src/build-approval.ts` handles the `allowBuilds` flow.
- `docs/user/develop/basic/publish.md` covers bundles, profiles, layer order and git installs.
- `docs/cookbook/adding-a-package.md#plugin-display-metadata` covers `locale/*.json` meta and `package.json` `icon` (SVG/PNG/JPEG/WebP up to 256 KiB). Keep the plugin at the package root, because subpath plugins read metadata differently in rc.2.
