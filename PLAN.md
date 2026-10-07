# dsh-trustedrouter: plan

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that lets users choose [TrustedRouter](https://trustedrouter.com/docs/provider-routing) privacy and routing options **per model** from the dsh web UI. Anyone can install it from GitHub.

**Status (2026-10-07):** Phases 0 to 3 done, except CI's first run on GitHub, which needs a push. The host half (`index.js`) and the client half (`client.js`) are built. 89 unit tests pass (27 host, 62 client), the headless e2e suite passes, a clean install from GitHub works, and the UI was checked in a browser, all on dsh 0.2.0-rc.2 and 0.2.1-alpha.1. README, LICENSE, CHANGELOG and the CI workflow are written (see [Phase 3 results](#phase-3-results-2026-10-07)). **Next: push (ask first) and watch the first CI run, then Phase 4 (publish).** All decisions are confirmed. The repo is private on GitHub.

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
| 2 | Models page offers: privacy floor, provider allow/block (`only`/`ignore`), `sort`, US-only (`jurisdiction`), billing (`usage`). Advanced fields (`max_price`, `order`, `allow_fallbacks`, raw JSON) go on the plugin's own Plugins page | **Confirmed** 2026-10-07 |
| 3 | GitHub first; npm publish later | **Confirmed** 2026-10-07 |
| 4 | Per-chat (composer) privacy override is **not** in v1 | **Confirmed** 2026-10-07. Wanted for v2 or later; see [Later (v2+)](#later-v2) |
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
test/              node:test unit tests (host and client), test/e2e (headless dsh against mock-openai.mjs),
                   test/ui/scratch-web.sh (a scratch `dsh web` with this repo installed by `link:`)
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
- **`dsh.client.inject`.** `["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-plugin-manager", "@deepseek-ai/dsh-client-ui-settings-models"]` works on rc.2 and alpha. The list follows the agent-loop example, plus the Models page; the entries only order activation.
- **Icon.** rc.2 reads a plugin icon only from the exported `./package.json`'s top-level `"icon"` field (`readPluginMeta` in `dsh-app-boot`). The `./icon` export fallback exists only in the 0.2.1-alpha source. The spike exported `./icon` alone and got the default artwork. Do both.

### Host half (`index.js`): built in Phase 1

Config is a `@deepseek-ai/schemastery` schema. Every field is `.volatile()`, so UI saves commit in place without a remount. Each request reads all five values once. Pattern: llm-pi-ai's `providers: z.dict(profile).default({}).volatile()`, and `docs/cookbook/adding-a-settings-card.md` §1 and §3.

```yaml
- id: trustedrouter
  name: dsh-trustedrouter
  config:
    gateways: [https://api.trustedrouter.com/v1]   # the default; EU gateway: https://api-europe-west4.quillrouter.com/v1
    defaults: { min_privacy: zdr }                 # `provider` fields for every model on those gateways; default {}
    models:                                        # per-model overrides, keyed by the request body's `model`; default {}
      z-ai/glm-5.3: { min_privacy: confidential, only: [tinfoil, privatemode] }
    rules: []        # escape hatch from the prototype: [{ baseURL, body }] deep-merged into any POST body
    log: false       # true prints "[trustedrouter] ..." lines to stderr (the dsh web terminal)
```

**Out of the box nothing changes.** The bundle row has no config, so the schema defaults apply: the TrustedRouter gateway, but no `defaults` and no `models`. Installing the plugin never starts producing 400s by itself; the user picks the policy.

**Schema (`Provider`).**
- The documented `provider` fields are type-checked, so a bad value fails at save time. Strict enums: `min_privacy` (with aliases `e2e` and `e2ee`), `sort`, `data_collection` and `usage` (with its aliases). `jurisdiction` is a free string so new jurisdictions need no update.
- **Unknown keys pass through.** schemastery's `object` keeps unknown keys and can't declaratively reject them. That's safe because TrustedRouter's docs say unknown options return 400: a misspelled key fails loudly at TrustedRouter instead of vanishing.
- **Gotcha:** schemastery fills a missing nested `object` field with `{}`. `max_price` therefore uses `.default(undefined)`; without it every request carried `max_price: {}`. Fields declared as unions (`sort`, the percentile fields, the lists) aren't filled in.
- URLs (`gateways`, `rules[].baseURL`) must match `^https?://host[/path]`, with no query or fragment. A URL that passes but that `new URL` still rejects matches nothing; it never refuses other traffic.
- **The schema survives the browser's JSON round trip.** The browser rebuilds it with `new Schema(json)` and validates values (checked in Node in Phase 1). Volatile `.get()` values are frozen and schemastery's dict resolver writes to its input, so never feed snapshots back through the schema.

**Request handling:**
- Only POSTs to a URL under a gateway (path-segment boundary) or under a rule's `baseURL` are considered. GETs (model discovery) and other URLs pass through untouched.
- **The provider policy applies only when there is one** (non-empty `defaults` or `models`). With none, gateway POSTs aren't even parsed.
- `provider = merge(defaults, models[model])`, and that result is merged over the request's own `provider`, so **the policy wins conflicts**. A non-object request `provider` is replaced. Arrays replace rather than concatenate.
- **Model lookup:** an exact key first. Then, for an id with a routing suffix (`z-ai/glm-5.3:nitro`), the base model's key, so a floor set for a model also holds for its variants. Lookups use `Object.hasOwn`, so ids like `constructor` don't hit prototype keys.
- **Rules:** every matching rule is deep-merged in order, after the provider policy, so rule fields win. The prototype applied only the first match.
- A body that ends up unchanged (e.g. its model has no policy) is forwarded with the original arguments, byte for byte. Otherwise the body is re-serialized and any stale `content-length` is removed.
- **Fails closed:** a POST that needs fields but whose body isn't a JSON object (including when the model can't be read) is rejected with `trustedrouter: refusing POST <url>: ... so provider cannot be added`. The refusal is always printed to stderr, even with `log: false`.
- **Logging goes to `console.error`, not `ctx.logger`.** Shipped dsh profiles mount no Cordis log exporter, so `ctx.logger` output is dropped. With `log: true`:
  - on load and on every `loader/volatile-update`: `provider policy for POSTs under <gateways>: defaults {...}, overrides for <model ids>`, plus one `merging {...} into POST bodies under <baseURL>` line per rule;
  - per request: `added provider to POST <url> for <model>: {...}`, or `no provider policy for <model>; POST <url> sent unchanged`, and `added <keys> to POST <url> (rule for <baseURL>)` per rule.
  
  Request bodies are never printed; the model id and the configured fields are.
- **Unloading:** restore the previous `globalThis.fetch` if ours is still on top; otherwise become a pass-through.

### Client half (`client.js`): built in Phase 2

One `window.__ModuleLoader__.load({ id: 'dsh-trustedrouter', factory })` script. The factory requires only `react`, renders with `createElement`, and returns `{ inject: ['slots', 'locale', 'configForms'], apply }` plus its pure helpers, which `test/client.test.js` imports, as the host half exports its own. Styles are a `<style>` element rendered by each entry, with classes prefixed `dshtr-`. They copy the Models page's card, editor, input, select and button CSS and the primitives' Switch and SettingsForm, using only `--dsw-alias-*` tokens.

1. **Models page (main UX).** An entry on `settings.models.provider-card`, keyed **`llm-pi-ai`** (pi-ai's settings namespace), so it renders on every pi-ai card.
   - The slot lives in `packages/client/ui-settings-models/src/client/slot-contract.ts`. Nothing else registers in it.
   - Props: `{ provider: { provider, displayName, settingsNs, settingsPath, active, declared?, error? }, configured, keyConfigured }`.
     - Seen on rc.2: `{"provider":"trustedrouter","displayName":"trustedrouter","settingsNs":"llm-pi-ai","settingsPath":["providers","trustedrouter"],"active":true,"declared":true}`.
     - The renderer kit adds `renderFactorySlot`, `usePanelInfo`, `useResource` and similar hooks, plus whatever the entry's `inject()` returns.
   - **Neither the props nor the provider's directory entry includes the baseURL.** It is read from `ctx.configForms.get('llm-pi-ai')`, as `value` at `props.provider.settingsPath`: `.baseURL` and `.models[].id`.
   - The entry renders nothing unless:
     - the card is saved (`configured`; the add-provider draft card has no route yet);
     - both forms are `ready`;
     - the route's baseURL falls under a configured gateway, by the host's path-segment rule (`routeCovered`).
   - It renders a "Privacy & routing" disclosure, closed by default, styled as the Models page's `.customized`.
     - The summary shows "N of M models customized", or the defaults' one-liner.
     - Opened, it shows the defaults, then one row per route model with its effective policy and a tag: Custom, `Uses <base model>` for a `:suffix` variant, or Defaults.
   - **Edit** opens a staged editor, with Cancel and Apply like the host's provider editor. Fields:
     - privacy floor, with options labelled by the providers that qualify;
     - only and ignore, as chips with a datalist of the model's providers;
     - prefer (`sort`);
     - billing (`usage`);
     - US-only switch (`jurisdiction: "us"`).
   - Each select's first option is "Default (<value>)" when the defaults set that field, or "Not set" otherwise.
   - A `:suffix` variant with no key of its own opens pre-filled from its base model's override. Applying writes the variant's key whole (the base override with the draft over it), because the host reads one key, never both. Otherwise editing `:nitro` would drop the base model's floor.
   - The editor also shows "N providers qualify: …", or a warning that TrustedRouter will refuse the model's requests.
   - **There is no per-model slot**, so the whole per-model list lives inside this one area.
2. **Plugins page.** An entry on `plugins.row.config`, keyed `dsh-trustedrouter#trustedrouter`. `view: 'page'` is a staged form with one Save (styled as SettingsForm) and a Discard. It has:
   - gateways, one URL per line;
   - the defaults (the same fields as a model);
   - advanced defaults: `order`, `allow_fallbacks`, and `max_price` prompt and completion in USD per million tokens;
   - per-model overrides as raw JSON;
   - rules as raw JSON;
   - the log switch.
   
   `view: 'summary'` is a one-liner. The page never asks for it, because the row has a description.
   - The page passes `form` (`ConfigPageForm`), but the entry uses the shared `ctx.configForms.get('trustedrouter')` for both views.
   - Client checks name the bad input before a save: gateway URLs, prices, JSON syntax, and known `provider` fields in the models JSON (`providerProblem` mirrors the host schema, and a test keeps them in agreement). The host still validates every write. A refused save shows "Not saved…" and keeps the draft.
   - Do **not** use `plugins.item`; it's reserved for official pages.
3. **Saving.** `ctx.configForms.get(ns)` returns `getSnapshot()` (`status, value, base, user, revision, writable, mode`), `subscribe()`, `mutate(ops, expectedRevision)`, `set` and `unset`.
   - Its methods are prototype methods, so bind them: `useSyncExternalStore(l => form.subscribe(l), () => form.getSnapshot())`.
   - Every save is one `mutate(ops, revision)`, where `revision` was read **when the editor opened** (the model editor) or **at the first staged edit** (the Plugins page), not at save time.
     - Otherwise, a save from another tab or another gateway's card would be silently undone for the fields the draft still holds.
     - When the snapshot's revision moves on, the editor says so and disables Apply/Save; the user reopens or discards.
     - Verified across two tabs on rc.2.
   - Writes go through settings-controller, `ctx.settings` and `ctx.configEditor` into the profile's `cordis.patch.yml`. They work only on loopback pages; elsewhere the form is `unavailable` and the section renders nothing. The home patch and `--patch` overlays win, and a write they would shadow is refused.
   - **Nested paths work (verified).** `{ op: 'set', path: ['models', 'z-ai/glm-5.3', 'min_privacy'], value }` creates `models` and the model entry (`applyPathOp` in `dsh-settings`). Path segments are array entries, so `/` and `.` in ids don't matter.
   - **Clearing a model.** `unset` of a model's last field would leave `{}` behind, so `modelOps` unsets `['models', id]` instead. Removing the last model leaves `models: {}`, which equals the default.
   - The model editor writes only the fields it changed. Fields it doesn't show (e.g. `max_price` set in the JSON) are kept.
   - `value` is the schema-resolved section; Provider fields have no defaults, so `value.models[id]` is exactly what was set. "Inherited from defaults" is shown from `value.defaults`, not from `base`/`user`.
4. **Text.** An inline English dictionary, registered with `ctx.locale.register('dsh-trustedrouter', 'en', EN)`. Entries register with `locale: NS` and get `t(key, params)`.
   - **Both rc.2 and alpha accept both signatures**: `register(ns, locale, dict)` and `register(ns, { en, zh })`. The PLAN's earlier note was wrong, and no feature detection is needed.
   - With only `en` registered, other locales fall back to English.
   - `locale/en.json` holds the Plugins-page title and description (`meta`).
5. **Model data.** `GET <route baseURL>/models` is fetched once per URL per page load, and only when a section is opened.
   - It is public, needs no key, and sends `Access-Control-Allow-Origin: *`. This holds for both `api.trustedrouter.com` and the EU gateway `api-europe-west4.quillrouter.com`.
   - Keep it a simple GET with no custom headers, because a preflight OPTIONS returns 401.
   - The reply is about 4.2 MB with `Cache-Control: public, max-age=60`. It is indexed to `{ provider, name, tier, usage, country, usBased }` per endpoint.
   - dsh web pages set no Content-Security-Policy, so `connect-src` doesn't block the fetch. The Electron desktop app is out of scope (`platform: "web"`).
   - Endpoint fields used: `provider`, `provider_name`, `privacy_tier`, `usage_type` (Credits/BYOK), `provider_headquarters_country` and `provider_us_based`. Tiers: 0 Standard, 1 No-store, 2 Zero retention, 3 Confidential + E2EE + ZDR.
   - **Mapping to `min_privacy`: 1 → `no_store`, 2 → `zdr`, 3 → `confidential` (confirmed 2026-10-07 with keyed requests).**
     - On `deepseek/deepseek-v4.1-flash`, `only` pinned one provider per tier: novita (0), deepinfra (1), nebius (2) and tinfoil (3).
     - Each provider was served at its own tier's floor and refused (400) one level up. `any` served novita, and `e2ee` served tinfoil like `confidential`.
     - `anthropic/claude-haiku-4.5` (Standard only) with `confidential` was refused.
     - `jurisdiction: "us"` refused nebius (NL) and served tinfoil (US), matching the client's headquarters-country filter.
     - Every refusal reads `{"error":{"message":"No route candidates match the requested provider filters","source":"router","status":400}}`.
     - TrustedRouter checks the API key before the policy, so these checks need a key.
   - Eligibility mirrors the routing docs: `only`, then `ignore`, `usage`, and `jurisdiction` against the headquarters country (or `provider_us_based` for `us`).
   - Missing fields are tolerated. A model the list doesn't know, or a failed fetch, offers every level with a note.
   - `/v1/models/{id}/endpoints` and `/v1/providers` need an API key; avoid them.
6. **Registration shape.** `ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, locale: NS, inject: () => ({ ... }) }, Component))`. The `inject()` result is spread into props. `ctx.configForms.describe()` gives the served-namespace mirror.

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

### Phase 1: host half. DONE 2026-10-07; see results below.

- Start from the prototype's `index.js` and tests.
- Add `@deepseek-ai/schemastery` as a devDependency so `node --test` and path-mounted e2e rows can import it. Keep the peer.
- Switch Config to a volatile schemastery schema: gateways, defaults, models, rules, log.
- Add per-model merging. Keep fail-closed and the stderr logging.
- Tests:
  - unit tests (`node --test`);
  - headless end-to-end via `test/e2e/` asserting per-model `provider` values.

#### Phase 1 results (2026-10-07)

- **`index.js`** is the prototype grown as designed in [Host half](#host-half-indexjs-built-in-phase-1). It exports `name`, `Config`, `Provider`, `DEFAULT_GATEWAY`, `mergeBody`, `providerFor` and `apply`.
- **Unit tests** (`npm test`, i.e. `node --test test/*.test.js`): 27 tests in `test/trustedrouter.test.js`. They cover merge, model lookup (suffix fallback, prototype keys), URL matching, multiple gateways, fail-closed with the stderr refusal, rules, live config updates without a remount, unload and pass-through, logging, and schema validation and absent-defaults.
  - Mutation-checked: removing `max_price`'s `.default(undefined)` fails 14 tests, and turning the refusal into a pass-through fails 2.
- **Headless e2e:** `test/e2e/run-all.sh` runs the control plus every `test/e2e/rows/*.yml`.
  - Each row declares `# expect-provider: <json|none>`, and `run-headless.sh` fails unless every POST the mock saw carried exactly that `provider`. A deliberately wrong expectation exits 1.
  - Rows: `per-model` (override merged over defaults), `defaults-only` (another model's override doesn't leak), `other-gateway` (a policy for the real gateway leaves the mock alone).
  - All pass on 0.2.0-rc.2 and on 0.2.1-alpha.1 (`DSH_VERSION=alpha`).
- **Dev setup:** `npm install` installs the schemastery devDependency. `package-lock.json` is git-ignored: the only dependency is that devDependency, and at runtime dsh supplies its own copy. Bare `node --test` would also pick up `test/e2e/mock-openai.mjs` and `.ref/`, so use `npm test`.
- **Not done here:** a git install of this version. devDependencies should not trigger pnpm's build approval without a `prepare` script, but that's checked in Phase 3's clean-install test.

### Phase 2: client half. DONE 2026-10-07; see results below.

- Dev loop: install by `link:`, script it as `test/ui/scratch-web.sh`.
- Package files: client exports, `dsh.client`, locale meta and icon.
- `client.js`: the Models-page section and the Plugins-page form, as designed in [Client half](#client-half-clientjs-built-in-phase-2).
- Verify on rc.2 and 0.2.1-alpha.1 in a browser, with unit tests for the pure client helpers.

#### Phase 2 results (2026-10-07)

- **Dev loop.** `dsh plugin --profile web add link:/abs/path/to/repo` works on both versions.
  - The profile symlinks to the repo and the row gets the bare package name, so the client half attaches.
  - pnpm warns that a linked package's peers don't resolve from the profile. That's harmless here: the repo's own `node_modules` has schemastery.
  - **Client edits hot-reload** into an open page (client-modules HMR). Host edits need a `dsh web` restart.
  - `test/ui/scratch-web.sh start|stop <dir>` scripts the whole recipe (see [Testing → UI](#testing)).
- **Package files.** Done as planned. `locale/en.json` titles the bundle "TrustedRouter privacy", and `icon.svg` is a shield. Both show on the Plugins page on rc.2, so the top-level `icon` field works.
- **`client.js`** is about 1,100 lines, built as described in [Client half](#client-half-clientjs-built-in-phase-2).
- **Unit tests** in `test/client.test.js` (62): `npm test` now runs 89.
  - Registration shape.
  - Host parity: `providerFor` and `mergeBody` against `index.js`, and `routeCovered` boundary cases.
  - Catalog indexing and the level/qualifying filters.
  - `modelOps` (writes only changed fields; unsets the model rather than leave `{}`), and `pageOps` with its validation.
  - `providerProblem` agreeing with the host schema.
  - The catalog store, and a dictionary check that every key the client asks for exists.
  - Mutation-checked: loosening the path-segment boundary, dropping the unset-the-model collapse, or using `>` for the tier filter each fails a test.
- **Browser checks (Claude in Chrome), rc.2:**
  - The section renders on the TrustedRouter and mock cards (both gateways) and not on the DeepSeek card.
  - Against the real model list, `z-ai/glm-5.3` offers "Confidential + E2EE + ZDR — Tinfoil, Privatemode", and 32 providers qualify with no floor.
  - Setting Confidential plus `only: tinfoil` wrote `models["z-ai/glm-5.3"]` into the patch. The host logged the new policy with no remount, and the `:nitro` row showed "Uses z-ai/glm-5.3". "Clear overrides" then removed the model key.
  - On the mock route:
    - BYOK billing disabled every floor above Any, and the editor warned that requests would be refused.
    - Zero retention plus US-only left only Tinfoil.
    - After Apply, a chat's two POSTs carried `{"min_privacy":"zdr","jurisdiction":"us"}`.
  - Plugins page:
    - Saving the defaults (Zero retention, sort by price, max prompt price 0.5) reached the patch and the host live.
    - An invalid price blocks Save.
    - `{"min_privacy":"bogus"}` in the JSON was refused by the host with the draft kept; the client now names that field before saving.
  - Disabling the bundle drops the client from the boot graph and keeps boot healthy, with no console messages. Re-enabling brings the section back live, with no page reload.
- **Browser checks, 0.2.1-alpha.1:** a Models-page edit (Confidential, `only` tinfoil + privatemode) and a Plugins-page save (`log` off) both landed in the patch, and the host picked them up. The locale call works there too.
- **e2e:** `test/e2e/run-all.sh` passes on both versions. The mock now answers GETs with a TrustedRouter-shaped model list, CORS-open, so the UI can use it as a gateway.
- **Code review** (a subagent read the client against the host and the configForms contract) found four bugs, all fixed with tests:
  - editing a `:nitro` variant dropped the floor inherited from its base model;
  - an editor left open could silently undo another save (the fence used the latest revision);
  - rebuilding `max_price` dropped sub-keys the page doesn't show;
  - a single slug entry could add duplicates.
  
  It also found an always-passing assertion (`JSON.stringify` of a Map) in the tests, now fixed.
  
  One disagreement is left as is: a gateway deeper than a route's baseURL (`…/v1/chat` vs `…/v1`) gets requests rewritten, but the Models page shows no section.
- **Open questions, answered:**
  - Nested-path writes: they work (Client half §3).
  - Form shape: use the resolved `value` (§3).
  - Draft card: render nothing (§1).
  - Locale on alpha: it works, and both signatures exist on both versions (§4).
- **Tier mapping confirmed** with keyed requests after the UI work (§5).
- **Still open:** screenshots of the final copy. The Chrome window was hidden for the last checks, so those were made through DOM reads, not screenshots. Done in Phase 3.

### Phase 3: packaging and verification. DONE 2026-10-07 (CI's first run pending a push); see results below.

- README: install via UI and CLI, the pnpm/corepack note, verification steps, and the tested dsh versions. Also LICENSE (MIT) and CHANGELOG.
- GitHub Actions:
  - `npm install && npm test` plus `test/e2e/run-all.sh`;
  - a weekly scheduled run against `@deepseek-ai/dsh@latest` and `@alpha` to catch the fetch wrapper silently breaking.
- Clean-install test into a fresh `DSH_HOME` (simulating another PC) on dsh 0.2.0-rc.2 and 0.2.1-alpha.1. Install with `github:AmmarByFar/dsh-trustedrouter#main`, not `link:`, and confirm:
  - the devDependency causes no build-approval prompt;
  - the client half loads from the installed copy.
- Screenshot the final Models section and Plugins page for the README, with the Chrome window visible.

#### Phase 3 results (2026-10-07)

- **README.md**, **LICENSE** (MIT, Ammar Mheir) and **CHANGELOG.md** (an "Unreleased (0.1.0)" entry) are written.
  - The README covers requirements, install by UI and CLI, both settings pages, the config row, checking it works, limitations, tested versions and development.
  - Screenshots are in `docs/`: `models-section.png`, `model-editor.png` and `plugins-page.png`. They are dark theme, from rc.2 running the git-installed copy. `docs/` is not in `files`, so it doesn't ship.
  - `npm pack` ships 8 files, 26 kB: README and LICENSE (npm adds them), `index.js`, `client.js`, `cordis.patch.yml`, `icon.svg`, `locale/en.json` and `package.json`.
- **CI:** `.github/workflows/test.yml`, lint-clean under actionlint 1.7.7. Not yet run on GitHub.
  - Job `unit`: `npm install && npm test` on Node 22.
  - Job `e2e`: `run-all.sh` plus `clean-install.sh`.
    - Pushes and PRs test 0.2.0-rc.2 and 0.2.1-alpha.1.
    - The weekly cron (Mondays 05:23 UTC) and manual runs test the `latest` and `alpha` dist-tags.
- **`test/e2e/clean-install.sh [spec]`** (new) installs into a fresh `DSH_HOME` the way a user would. The default spec is an `npm pack` of the checkout, so CI needs no git credentials for the private repo. It checks:
  1. the install asks for no build approval (`allowBuilds`);
  2. the profile holds a real copy (not a symlink) with both halves;
  3. a headless run through `run-headless.sh`, with the new `E2E_DSH_HOME`, against `test/e2e/installed.yml`, which configures the bundle's own row;
  4. `dsh web` lists `dsh-trustedrouter` in `__DSH_BOOT__`, and serves bytes identical to the installed `client.js` (plus a trailing sourceMappingURL).
- **`test/ui/scratch-web.sh`** takes `PLUGIN_SPEC` (default `link:<repo>`), so the UI can run from a git install.
- **Clean install results**, all with no build prompt and only the expected schemastery peer warning:
  - `clean-install.sh` passed on rc.2 with the packed tarball, and on alpha with `https://github.com/AmmarByFar/dsh-trustedrouter#main` (the form the UI takes).
  - `github:AmmarByFar/dsh-trustedrouter#main` passed by hand on rc.2, headless and web.
  - pnpm applies `files` to git installs: the installed copy has only the shipped files.
- **Browser checks** of the git-installed copy:
  - rc.2 and alpha: boot with no console messages, and the section renders on both gateway cards.
  - **Uninstall keeps settings.** On rc.2, the plugin page's Uninstall removed the dependency and the bundle but left the profile patch, including the `trustedrouter` row, unchanged.
  - **The UI install works.** Plugins → Add plugin with `https://github.com/AmmarByFar/dsh-trustedrouter#main`, then Install and Enable now. dsh records it as `github:AmmarByFar/dsh-trustedrouter#main`. The host reloaded the saved policy, and the Models section came back without a page reload.
  - On both versions, **Add plugin** opens the spec field directly. Alpha's split button has other methods in its dropdown. The "Install a third-party plugin" chooser strings in the alpha source aren't on the default path.
- **Screenshots work while the window is hidden.** `document.visibilityState` was `hidden`, yet `computer` screenshots and `zoom` with `save_to_disk` worked. `zoom` crops at the viewport's full resolution; the screenshot frame itself is downscaled.
- **Unit and e2e** re-run after the script changes: 89 unit tests, and `run-all.sh` on both versions.

### Phase 4: publish

Before starting:
1. Push `main` (ask first) and check that CI's first run passes.
2. Optionally trigger the workflow by hand (`workflow_dispatch`) to try the dist-tag matrix.

Steps:
- Bump `package.json` to `0.1.0`, and date the CHANGELOG entry.
- Make the repo public (ask first), and add the `dsh-plugin` topic.
- Tag `v0.1.0` and create a GitHub release from the CHANGELOG entry.
- Run `test/e2e/clean-install.sh github:AmmarByFar/dsh-trustedrouter#v0.1.0` on both versions. The README already uses that spec; it works only once the tag exists.
- On a public repo, GitHub disables scheduled workflows after 60 days with no repo activity, after warning by email. Re-enable the weekly run if that happens.
- Optionally npm later.
- Optionally post a GitHub Discussion on dsh asking for a native `extraBody`/`onPayload` setting in llm-pi-ai, which would retire the fetch wrapper.

### Phase 5: migrate the maintainer's machine

- Install the release into the real `web` profile and move settings into the new `trustedrouter` row.
- Remove the prototype's `extra-body` insert row and `~/dsh-extra-body` only after verifying (see `CLAUDE.local.md`).

### Later (v2+)

- **Per-chat privacy override** (Decision 4): a composer control that raises or changes the policy for one chat.
  - Needs session attribution inside the fetch wrapper, which is unverified (see Risks).
  - Candidates are `ctx.on('llm/stream')` (read-only, frozen options) and `ctx.agents.currentInitiator()` (AsyncLocalStorage). Check whether either propagates into pi-ai's `fetch` call.
- **npm publish** (Decision 3).
- **"Add as gateway" hint.** A pi-ai card whose baseURL looks like TrustedRouter but isn't under a gateway currently shows nothing. It could offer to add its baseURL to `gateways`.

### Install flow for users (as in the README)

1. Run `corepack enable pnpm` once if `pnpm` isn't on PATH.
2. dsh sidebar → **Plugins** → **Add plugin** → `https://github.com/AmmarByFar/dsh-trustedrouter#v0.1.0` → Install, or the CLI: `dsh plugin --profile web add github:AmmarByFar/dsh-trustedrouter#v0.1.0`.
3. **Enable now**. (Verified in Phase 3 with `#main`.)
4. Settings → Models → TrustedRouter card → **Privacy & routing**.

## Testing

- **Unit:** `npm test`.
  - Host (`test/trustedrouter.test.js`): merge, model lookup, URL matching, fail-closed, live updates, logging and config validation.
  - Client (`test/client.test.js`): evaluates `client.js` with a stub module loader and React, then tests its exported helpers.
- **Host end-to-end:** `test/e2e/run-headless.sh <row.yml>`, i.e. `dsh --profile headless` in a scratch `DSH_HOME` against `test/e2e/mock-openai.mjs`. It asserts the recorded request bodies against the row's `# expect-provider:` line.
  - `test/e2e/run-all.sh` runs every row in `test/e2e/rows/` plus the control run without the plugin (which expects no `provider`).
  - `dsh headless` prints the plugin's stderr lines, which is useful for asserting logging.
  - `E2E_DSH_HOME=<home>` boots an existing `DSH_HOME` instead of a throwaway one.
- **Clean install:** `test/e2e/clean-install.sh [spec]` (env `DSH_VERSION`). It installs `spec` the way a user would, then checks the installed copy headless and on `dsh web`; see [Phase 3 results](#phase-3-results-2026-10-07).
  - The default spec is an `npm pack` of the checkout. Before a release, pass `github:AmmarByFar/dsh-trustedrouter#<tag>`.
  - It doesn't open a browser. For that, run `PLUGIN_SPEC=<spec> test/ui/scratch-web.sh start <fresh dir>`.
- **UI:** `test/ui/scratch-web.sh start <dir>` (env `DSH_VERSION`, default `0.2.0-rc.2`; `PLUGIN_SPEC`, default `link:<repo>`) prints a scratch `dsh web` URL. Drive it in a browser (Claude in Chrome) and screenshot the Models card and the Plugins page. `test/ui/scratch-web.sh stop <dir>` stops it. What the script does:
  1. Shims `pnpm` through corepack under `<dir>/bin`. corepack downloads pnpm on first use; Phase 0 and 2 got 12.9.1.
  2. Installs this repo into `<dir>/home`, profile `web`, with `plugin --profile web add link:<repo>` (or `$PLUGIN_SPEC`). A `<dir>` that already has it installed is reused as is.
  3. Starts `test/e2e/mock-openai.mjs`.
  4. Writes the profile patch once. Later starts only repoint the mock's port, so UI saves survive restarts. The patch has:
     - `llm-pi-ai` with routes `trustedrouter` (the real gateway, a dummy key, models `z-ai/glm-5.3`, `anthropic/claude-haiku-4.5` and `z-ai/glm-5.3:nitro`) and `mockrouter` (the mock, `mock-model`);
     - `agent-default-model` pointing chats at the mock;
     - the `trustedrouter` row with both URLs as gateways and `log: true`.
  5. Starts `dsh web --port 0 --no-open` with its output in `<dir>/web.log`, including the plugin's stderr lines. The mock records requests in `<dir>/requests.jsonl`.
  6. Runs the mock and dsh with `setsid` and records their process groups, so `stop` kills only those, never the live dsh on 3080.
  
  Navigating the UI:
  - Opening the printed URL sets the auth cookie (a 303 to `./`). The first load shows a Preview Notice; click Continue.
  - Plugins: sidebar **Plugins** → Installed → TrustedRouter privacy (`aria-label` "View TrustedRouter privacy") → the component row's `>` ("Configure TrustedRouter privacy").
  - Models: **Settings** → **Models** → a gateway card → **Privacy & routing**.
  - In Phase 2, screenshots failed while the Chrome window was hidden (`document.visibilityState === 'hidden'`). In Phase 3 they worked in that state. If they fail, DOM reads and `element.click()` still work. React selects need the native value setter plus a `change` event.
  - For README images, use `computer` `zoom` with `save_to_disk` on a region, after moving the mouse out of it.
  - Editing the scratch profile's `cordis.patch.yml` by hand reloads live. Don't truncate it: dsh appends rows to it, e.g. `ui-settings-general` after the Preview Notice.
- **Live check:** with `log: true`, real chats print `added provider to POST https://api.trustedrouter.com/v1/chat/completions for <model>: {...}`.
  - Negative test: a Standard-tier model (e.g. `anthropic/claude-haiku-4.5`) with `min_privacy: confidential` is refused with a 400, as confirmed in Phase 2.
- **Direct API checks** (no dsh): POST `https://api.trustedrouter.com/v1/chat/completions` with `max_tokens: 5` and a `provider` object. `deepseek/deepseek-v4.1-flash` is cheap and has one provider at each tier (Client half §5).
  - They need a TrustedRouter key. Ask the maintainer for a disposable one, and never write a key into the repo, PLAN.md or the notes.

## Risks

- **The fetch wrapper depends on pi-ai and SDK internals.** If it stops being called, requests go out **without** `provider` and no error. Mitigations: the weekly CI end-to-end run and a documented verification.
- **dsh is pre-stable.** Slot and API names may change, so the README lists tested dsh versions.
- **A broken client half can break web boot.** Before every release, run `clean-install.sh` with the tag and load the page in a browser.
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
