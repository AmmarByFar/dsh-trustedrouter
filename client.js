/**
 * dsh-trustedrouter, browser half: edits the host half's `trustedrouter`
 * settings namespace from two places.
 *
 * - Settings → Models: a "Privacy & routing" section inside every pi-ai
 *   provider card whose baseURL falls under a configured gateway, with one
 *   row per model of that route (privacy floor, providers, sort, US only,
 *   billing). pi-ai's card props carry no baseURL, so it is read from the
 *   `llm-pi-ai` form at the card's settings path.
 * - Plugins → this bundle's row: gateways, defaults including the advanced
 *   fields, the raw per-model and rule JSON, and the log switch.
 *
 * The privacy-floor choices come from TrustedRouter's public model list
 * (`GET <gateway>/models`: no key, CORS-open), fetched once per gateway per page.
 * The list is only advice: the host half sends whatever is saved, and
 * TrustedRouter refuses (400) a floor that no provider meets.
 *
 * Plain JS with no build step: one factory that requires only the shell's
 * shared React and renders with `createElement`. Controls copy the host's
 * markup and `--dsw-alias-*` tokens instead of requiring ui-primitives, whose
 * exports change without notice.
 */
window.__ModuleLoader__.load({
  id: 'dsh-trustedrouter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace of this plugin's copy. */
    const NS = 'dsh-trustedrouter'
    /** The host row id, which is also its settings namespace. */
    const POLICY_NS = 'trustedrouter'
    /** pi-ai's settings namespace, which keys its provider cards. */
    const ROUTES_NS = 'llm-pi-ai'
    const ROW_KEY = 'dsh-trustedrouter#trustedrouter'

    /** `min_privacy` values by the endpoint `privacy_tier` that meets them. */
    const LEVELS = ['any', 'no_store', 'zdr', 'confidential']
    const LEVEL_ALIASES = { e2e: 'confidential', e2ee: 'confidential' }
    const SORTS = ['price', 'latency', 'throughput']
    const USAGES = ['credits', 'byok']
    const USAGE_ALIASES = { prepaid: 'credits', 'bring-your-own-key': 'byok' }
    /** The `provider` fields the Models page edits per model; the rest stay as they are. */
    const MODEL_FIELDS = ['min_privacy', 'only', 'ignore', 'sort', 'jurisdiction', 'usage']
    /** The host half's URL rule: http(s), a host, an optional path, no query or fragment. */
    const HTTP_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/

    // ---------------------------------------------------------------- helpers

    function isPlainObject(value) {
      if (value === null || typeof value !== 'object') return false
      const proto = Object.getPrototypeOf(value)
      return proto === Object.prototype || proto === null
    }

    /** The host half's merge: nested objects merge key by key, anything else is replaced. */
    function mergeBody(target, patch) {
      const out = { ...target }
      for (const [key, value] of Object.entries(patch)) {
        out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeBody(out[key], value) : value
      }
      return out
    }

    /**
     * Which `models` key applies to a model id, as the host half looks it up:
     * the exact id, else the id without its routing suffix (`:nitro`).
     */
    function overrideKey(model, models) {
      if (Object.hasOwn(models, model)) return model
      const base = model.includes(':') ? model.slice(0, model.indexOf(':')) : undefined
      return base !== undefined && Object.hasOwn(models, base) ? base : undefined
    }

    /** The `provider` fields the host half sends for one model. */
    function providerFor(model, defaults, models) {
      const key = overrideKey(model, models)
      return key === undefined ? defaults : mergeBody(defaults, models[key])
    }

    /** `origin + pathname` without trailing slashes, or undefined for a URL that does not parse. */
    function urlPrefix(url) {
      try {
        const parsed = new URL(url)
        return parsed.origin + parsed.pathname.replace(/\/+$/, '')
      } catch {
        return undefined
      }
    }

    /** Whether requests to a route at `baseURL` fall under one of `gateways`, on a path-segment boundary. */
    function routeCovered(baseURL, gateways) {
      const target = urlPrefix(baseURL)
      if (target === undefined) return false
      return gateways.some((gateway) => {
        const prefix = urlPrefix(gateway)
        return prefix !== undefined && (target === prefix || target.startsWith(`${prefix}/`))
      })
    }

    /** A slug list as TrustedRouter takes it, an array or a comma-separated string, as an array. */
    function slugList(value) {
      const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
      return items.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    }

    /** The canonical `min_privacy` for a saved value, or undefined for none or one this version does not know. */
    function levelOf(value) {
      const level = typeof value === 'string' ? LEVEL_ALIASES[value] ?? value : undefined
      return LEVELS.includes(level) ? level : undefined
    }

    function usageOf(value) {
      const usage = typeof value === 'string' ? USAGE_ALIASES[value] ?? value : undefined
      return USAGES.includes(usage) ? usage : undefined
    }

    /**
     * Index TrustedRouter's `/models` reply by model id, keeping only what
     * the privacy choices need. The reply is unversioned, so every field is
     * optional and an endpoint without a tier counts as Standard.
     */
    function indexCatalog(json) {
      const index = new Map()
      const data = isPlainObject(json) && Array.isArray(json.data) ? json.data : []
      for (const model of data) {
        if (!isPlainObject(model) || typeof model.id !== 'string') continue
        const info = isPlainObject(model.trustedrouter) ? model.trustedrouter : {}
        const endpoints = (Array.isArray(info.endpoints) ? info.endpoints : []).filter(isPlainObject).map(endpoint => ({
          provider: typeof endpoint.provider === 'string' ? endpoint.provider : '',
          name: typeof endpoint.provider_name === 'string' ? endpoint.provider_name : endpoint.provider,
          tier: Number.isInteger(endpoint.privacy_tier) ? endpoint.privacy_tier : 0,
          usage: typeof endpoint.usage_type === 'string' ? endpoint.usage_type.toLowerCase() : undefined,
          country: typeof endpoint.provider_headquarters_country === 'string' ? endpoint.provider_headquarters_country.toLowerCase() : undefined,
          usBased: endpoint.provider_us_based === true,
        })).filter(endpoint => endpoint.provider !== '')
        index.set(model.id, { endpoints })
      }
      return index
    }

    /** The catalog entry for a model id, falling back to the id without its routing suffix. */
    function catalogEntry(catalog, model) {
      if (catalog === undefined) return undefined
      if (catalog.has(model)) return catalog.get(model)
      return model.includes(':') ? catalog.get(model.slice(0, model.indexOf(':'))) : undefined
    }

    /**
     * The endpoints of a catalog entry that the `provider` fields other than
     * `min_privacy` leave eligible: `only`, then `ignore`, `usage` and
     * `jurisdiction`, as TrustedRouter's provider-routing docs describe them.
     */
    function eligible(entry, provider) {
      const only = slugList(provider.only)
      const ignore = slugList(provider.ignore)
      const usage = usageOf(provider.usage)
      const jurisdiction = typeof provider.jurisdiction === 'string' ? provider.jurisdiction.toLowerCase() : undefined
      return entry.endpoints.filter(endpoint => (only.length === 0 || only.includes(endpoint.provider))
        && !ignore.includes(endpoint.provider)
        && (usage === undefined || endpoint.usage === usage)
        && (jurisdiction === undefined || endpoint.country === jurisdiction || (jurisdiction === 'us' && endpoint.usBased)))
    }

    /** Distinct providers among endpoints, in catalog order, as `{ provider, name, tier }` with each provider's best tier. */
    function providersOf(endpoints) {
      const byProvider = new Map()
      for (const endpoint of endpoints) {
        const known = byProvider.get(endpoint.provider)
        if (known === undefined) byProvider.set(endpoint.provider, { provider: endpoint.provider, name: endpoint.name, tier: endpoint.tier })
        else known.tier = Math.max(known.tier, endpoint.tier)
      }
      return [...byProvider.values()]
    }

    /**
     * One choice per privacy level for a model: the providers that would serve
     * it at that floor given the other fields. `providers` is undefined when the
     * catalog does not know the model, so nothing can be ruled out.
     */
    function levelChoices(entry, provider) {
      const candidates = entry === undefined ? undefined : eligible(entry, provider)
      return LEVELS.map((level, tier) => ({
        level,
        providers: candidates === undefined ? undefined : providersOf(candidates.filter(endpoint => endpoint.tier >= tier)),
      }))
    }

    /** The providers TrustedRouter could route a model to under `provider`, or undefined when the catalog does not know it. */
    function qualifyingProviders(entry, provider) {
      if (entry === undefined) return undefined
      const floor = levelOf(provider.min_privacy)
      const tier = floor === undefined ? 0 : LEVELS.indexOf(floor)
      return providersOf(eligible(entry, provider).filter(endpoint => endpoint.tier >= tier))
    }

    /** A Models-page field value normalized for comparison and saving: empty lists are absent. */
    function normalizeField(field, value) {
      if (field === 'only' || field === 'ignore') {
        const list = slugList(value)
        return list.length === 0 ? undefined : list
      }
      return value === '' || value === null ? undefined : value
    }

    function sameValue(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /** A `provider` object with the Models-page fields normalized, the empty ones dropped. */
    function normalizeProvider(provider) {
      const out = { ...provider }
      for (const field of MODEL_FIELDS) {
        const value = normalizeField(field, out[field])
        if (value === undefined) delete out[field]
        else out[field] = value
      }
      return out
    }

    /**
     * The settings ops that turn a model's saved override into `draft` for the
     * Models-page fields. Fields the page does not edit are left alone. When
     * nothing would remain, the model's key is unset rather than left as `{}`.
     *
     * A model with no key of its own may inherit a base model's override
     * (`inherited`, for a `:nitro` variant). The host reads one key, never
     * both, so the variant's new key is written whole: the base override with
     * the draft over it. An empty result is still written, since `{}` there
     * means "defaults only" rather than the base model's settings.
     */
    function modelOps(model, saved, draft, inherited) {
      if (!isPlainObject(saved) && isPlainObject(inherited)) {
        const next = { ...inherited }
        for (const field of MODEL_FIELDS) {
          const value = normalizeField(field, draft[field])
          if (value === undefined) delete next[field]
          else next[field] = value
        }
        return sameValue(next, normalizeProvider(inherited)) ? [] : [{ op: 'set', path: ['models', model], value: next }]
      }
      const current = isPlainObject(saved) ? saved : {}
      const ops = []
      const next = { ...current }
      for (const field of MODEL_FIELDS) {
        const before = normalizeField(field, current[field])
        const after = normalizeField(field, draft[field])
        if (after === undefined) delete next[field]
        else next[field] = after
        if (sameValue(before, after) && (after !== undefined || !Object.hasOwn(current, field))) continue
        ops.push(after === undefined
          ? { op: 'unset', path: ['models', model, field] }
          : { op: 'set', path: ['models', model, field], value: after })
      }
      if (ops.length > 0 && Object.keys(next).length === 0) return [{ op: 'unset', path: ['models', model] }]
      return ops
    }

    /** Read a value at a settings path (`['providers', 'trustedrouter']`). */
    function valueAt(root, path) {
      let node = root
      for (const key of path) {
        if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined
        node = node[key]
      }
      return node
    }

    /** The model ids a pi-ai route lists, deduplicated, in order. */
    function routeModels(route) {
      const models = isPlainObject(route) && Array.isArray(route.models) ? route.models : []
      const ids = models.map(model => typeof model === 'string' ? model : model?.id).filter(id => typeof id === 'string' && id !== '')
      return [...new Set(ids)]
    }

    // ---------------------------------------------------------------- catalog

    /**
     * TrustedRouter model lists by gateway URL, each fetched at most once per
     * page and published to subscribers. A failed fetch stays failed until the
     * page reloads; the UI then offers every level.
     */
    function createCatalogs(fetchImpl) {
      const states = new Map()
      const listeners = new Set()
      let disposed = false
      const publish = (url, state) => {
        if (disposed) return
        states.set(url, state)
        for (const listener of listeners) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        get(url) {
          return states.get(url)
        },
        load(url) {
          if (states.has(url)) return
          publish(url, { status: 'loading' })
          // A plain GET with no custom headers: TrustedRouter answers a CORS
          // preflight with 401, so the request must not need one.
          fetchImpl(url)
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json()
            })
            .then(json => publish(url, { status: 'ready', models: indexCatalog(json) }))
            .catch(error => publish(url, { status: 'error', error: error instanceof Error ? error.message : String(error) }))
        },
        dispose() {
          disposed = true
          listeners.clear()
        },
      }
    }

    function catalogURL(baseURL) {
      return `${baseURL.replace(/\/+$/, '')}/models`
    }

    // ---------------------------------------------------------------- hooks

    /** A ConfigForm's snapshot. Its methods are prototype methods, so they are called on the form. */
    function useForm(form) {
      const subscribe = React.useCallback(listener => form.subscribe(listener), [form])
      return React.useSyncExternalStore(subscribe, () => form.getSnapshot())
    }

    function useCatalog(catalogs, url, enabled) {
      const subscribe = React.useCallback(listener => catalogs.subscribe(listener), [catalogs])
      const state = React.useSyncExternalStore(subscribe, () => catalogs.get(url))
      React.useEffect(() => {
        if (enabled) catalogs.load(url)
      }, [catalogs, url, enabled])
      return state
    }

    // ---------------------------------------------------------------- text

    function levelLabel(t, level) {
      return t(`level.${level}`)
    }

    function namesOf(providers, t) {
      const names = providers.map(provider => provider.name)
      return names.length <= 3 ? names.join(', ') : t('providers.more', { names: names.slice(0, 3).join(', '), count: names.length - 3 })
    }

    /** One line describing a `provider` object, or undefined when it is empty. */
    function describeProvider(t, provider) {
      const parts = []
      const known = new Set(MODEL_FIELDS)
      const level = levelOf(provider.min_privacy)
      if (level !== undefined) parts.push(levelLabel(t, level))
      else if (provider.min_privacy !== undefined) parts.push(t('summary.floor', { value: String(provider.min_privacy) }))
      const only = slugList(provider.only)
      if (only.length > 0) parts.push(t('summary.only', { list: only.join(', ') }))
      const ignore = slugList(provider.ignore)
      if (ignore.length > 0) parts.push(t('summary.ignore', { list: ignore.join(', ') }))
      if (typeof provider.sort === 'string') parts.push(t('summary.sort', { by: t(`sort.${provider.sort}`) }))
      else if (isPlainObject(provider.sort) && typeof provider.sort.by === 'string') parts.push(t('summary.sort', { by: t(`sort.${provider.sort.by}`) }))
      if (typeof provider.jurisdiction === 'string') {
        parts.push(provider.jurisdiction.toLowerCase() === 'us' ? t('summary.us') : t('summary.jurisdiction', { value: provider.jurisdiction }))
      }
      const usage = usageOf(provider.usage)
      if (usage !== undefined) parts.push(t(`usage.${usage}`))
      const rest = Object.keys(provider).filter(key => !known.has(key))
      if (rest.length > 0) parts.push(rest.join(', '))
      return parts.length === 0 ? undefined : parts.join(' · ')
    }

    // ---------------------------------------------------------------- controls

    function cx(...names) {
      return names.filter(Boolean).join(' ')
    }

    function Field({ label, htmlFor, hint, warning, children }) {
      return h('div', { className: 'dshtr-field' },
        h('label', { className: 'dshtr-field-label', htmlFor }, label),
        children,
        warning ? h('p', { className: 'dshtr-warning', role: 'status' }, warning) : null,
        hint ? h('p', { className: 'dshtr-hint' }, hint) : null)
    }

    /** A native select styled as the Models page's enum pickers. `options` are `{ value, label, disabled? }`. */
    function Select({ id, value, options, disabled, onChange }) {
      return h('select', {
        id, className: 'dshtr-input dshtr-select', value, disabled,
        onChange: event => onChange(event.target.value),
      }, options.map(option => h('option', { key: option.value, value: option.value, disabled: option.disabled }, option.label)))
    }

    /** The host Switch: a button with `role="switch"`, its look keyed off `aria-checked`. */
    function Switch({ id, checked, label, disabled, onChange }) {
      return h('button', {
        id, type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled,
        className: 'dshtr-switch', onClick: () => onChange(!checked),
      }, h('span', { className: 'dshtr-thumb' }))
    }

    /**
     * Provider slugs as removable chips plus a text input that suggests the
     * model's providers. Enter, a comma or leaving the input adds what was typed.
     * `onChange` receives an updater, so a blur's add and a chip's removal in
     * the same tick both apply.
     */
    function SlugList({ id, value, suggestions, placeholder, disabled, removeLabel, onChange }) {
      const [text, setText] = React.useState('')
      const listId = `${id}-suggestions`
      const append = (raw) => {
        const added = [...new Set(slugList(raw))]
        if (added.length > 0) onChange(list => [...list, ...added.filter(slug => !list.includes(slug))])
      }
      const add = () => {
        setText('')
        append(text)
      }
      return h('div', { className: cx('dshtr-slugs', disabled && 'dshtr-disabled') },
        value.map(slug => h('span', { key: slug, className: 'dshtr-chip' },
          slug,
          h('button', {
            type: 'button', className: 'dshtr-chip-remove', disabled,
            'aria-label': removeLabel(slug), onClick: () => onChange(list => list.filter(item => item !== slug)),
          }, '×'))),
        h('input', {
          id, className: 'dshtr-slug-input', value: text, disabled, list: suggestions.length > 0 ? listId : undefined,
          placeholder: value.length === 0 ? placeholder : '', autoComplete: 'off', spellCheck: false,
          onChange: (event) => {
            const next = event.target.value
            // A datalist pick replaces the text in one step (no `inputType`, or
            // `insertReplacementText`); typing a slug that happens to match one stays text.
            const inputType = event.nativeEvent?.inputType
            const picked = (inputType === undefined || inputType === 'insertReplacementText') && suggestions.some(item => item.value === next)
            if (!picked && !next.includes(',')) {
              setText(next)
              return
            }
            setText('')
            append(next)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            } else if (event.key === 'Backspace' && text === '' && value.length > 0) {
              onChange(list => list.slice(0, -1))
            }
          },
          onBlur: add,
        }),
        suggestions.length > 0
          ? h('datalist', { id: listId }, suggestions.map(item => h('option', { key: item.value, value: item.value }, item.label)))
          : null)
    }

    // ---------------------------------------------------------------- Models page

    /** The Models-page fields of a saved override, as editor state. */
    function draftOf(saved) {
      const current = isPlainObject(saved) ? saved : {}
      return {
        min_privacy: current.min_privacy ?? '',
        only: slugList(current.only),
        ignore: slugList(current.ignore),
        sort: current.sort ?? '',
        jurisdiction: current.jurisdiction ?? '',
        usage: current.usage ?? '',
      }
    }

    /** The draft as `provider` fields, the empty ones left out. */
    function draftProvider(draft) {
      const out = {}
      for (const field of MODEL_FIELDS) {
        const value = normalizeField(field, draft[field])
        if (value !== undefined) out[field] = value
      }
      return out
    }

    function inheritedOption(t, inherited) {
      return inherited === undefined ? t('field.notSet') : t('field.inherit', { value: inherited })
    }

    /** Privacy-floor options: unreachable levels are disabled unless selected, and an unknown saved value stays listed. */
    function privacyOptions(t, choices, selected, defaults) {
      const inherited = levelOf(defaults.min_privacy)
      const options = [{ value: '', label: inheritedOption(t, inherited === undefined ? undefined : levelLabel(t, inherited)) }]
      for (const choice of choices) {
        let label = levelLabel(t, choice.level)
        if (choice.providers !== undefined && choice.level !== 'any') {
          label = choice.providers.length === 0
            ? t('level.none', { level: label })
            : t('level.with', { level: label, providers: namesOf(choice.providers, t) })
        }
        options.push({ value: choice.level, label, disabled: choice.providers !== undefined && choice.providers.length === 0 && selected !== choice.level })
      }
      if (typeof selected === 'string' && selected !== '' && !options.some(option => option.value === selected)) {
        // An alias (`e2ee`) or a value this version does not know: keep it selectable as saved.
        options.push({ value: selected, label: levelOf(selected) === undefined ? selected : `${levelLabel(t, levelOf(selected))} (${selected})` })
      }
      return options
    }

    function sortOptions(t, saved, defaults) {
      const inherited = typeof defaults.sort === 'string' ? t(`sort.${defaults.sort}`) : isPlainObject(defaults.sort) ? JSON.stringify(defaults.sort) : undefined
      const options = [{ value: '', label: inheritedOption(t, inherited) }, ...SORTS.map(sort => ({ value: sort, label: t(`sort.${sort}`) }))]
      if (isPlainObject(saved)) options.push({ value: JSON.stringify(saved), label: JSON.stringify(saved) })
      return options
    }

    function usageOptions(t, saved, defaults) {
      const inherited = usageOf(defaults.usage)
      const options = [{ value: '', label: inheritedOption(t, inherited === undefined ? undefined : t(`usage.${inherited}`)) }, ...USAGES.map(usage => ({ value: usage, label: t(`usage.${usage}`) }))]
      if (typeof saved === 'string' && saved !== '' && !USAGES.includes(saved)) options.push({ value: saved, label: saved })
      return options
    }

    /** The editor for one model's override: staged edits, applied together as one mutation. */
    function ModelEditor({ t, model, saved, inherited, inheritedFrom, defaults, entry, catalogState, state, policy, onClose }) {
      const [draft, setDraft] = React.useState(() => draftOf(saved ?? inherited))
      // The revision the draft was read at: a save from elsewhere since then
      // makes the draft stale, and the fence refuses it instead of undoing that save.
      const [revision] = React.useState(() => state.revision)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const stale = state.revision !== revision
      const id = React.useId()
      const set = (field, value) => setDraft(previous => ({ ...previous, [field]: typeof value === 'function' ? value(previous[field]) : value }))
      const disabled = busy || !state.writable
      const effective = mergeBody(defaults, draftProvider(draft))
      const ops = modelOps(model, saved, draft, inherited)
      const choices = levelChoices(entry, { ...effective, min_privacy: undefined })
      const qualifying = qualifyingProviders(entry, effective)
      const suggestions = entry === undefined
        ? []
        : providersOf(entry.endpoints).map(provider => ({ value: provider.provider, label: `${provider.name} · ${levelLabel(t, LEVELS[Math.min(provider.tier, 3)])}` }))
      const sortValue = isPlainObject(draft.sort) ? JSON.stringify(draft.sort) : draft.sort
      const inheritedUs = typeof defaults.jurisdiction === 'string' && defaults.jurisdiction.toLowerCase() === 'us'
      const otherJurisdiction = typeof draft.jurisdiction === 'string' && draft.jurisdiction !== '' && draft.jurisdiction.toLowerCase() !== 'us'

      const apply = async () => {
        setBusy(true)
        setFailed(false)
        let accepted = false
        try {
          accepted = await policy.mutate(ops, revision)
        } catch {
          accepted = false
        }
        setBusy(false)
        if (accepted) onClose()
        else setFailed(true)
      }
      const clear = () => {
        setDraft(draftOf(undefined))
      }

      let note
      if (catalogState?.status === 'loading') note = t('catalog.loading')
      else if (catalogState?.status === 'error') note = t('catalog.failed', { error: catalogState.error })
      else if (catalogState?.status === 'ready' && entry === undefined) note = t('catalog.unknownModel')

      return h('div', { className: 'dshtr-editor' },
        inheritedFrom !== undefined && saved === undefined ? h('p', { className: 'dshtr-hint' }, t('editor.inherits', { model: inheritedFrom })) : null,
        note ? h('p', { className: 'dshtr-hint' }, note) : null,
        h('div', { className: 'dshtr-grid' },
          h(Field, {
            label: t('field.privacy'), htmlFor: `${id}-privacy`,
            hint: t('field.privacyHint'),
          }, h(Select, {
            id: `${id}-privacy`, value: draft.min_privacy, disabled,
            options: privacyOptions(t, choices, draft.min_privacy, defaults),
            onChange: value => set('min_privacy', value),
          })),
          h(Field, { label: t('field.sort'), htmlFor: `${id}-sort` }, h(Select, {
            id: `${id}-sort`, value: sortValue, disabled,
            options: sortOptions(t, isPlainObject(saved?.sort) ? saved.sort : undefined, defaults),
            onChange: value => set('sort', value.startsWith('{') ? JSON.parse(value) : value),
          })),
          h(Field, {
            label: t('field.only'), htmlFor: `${id}-only`,
            hint: draft.only.length === 0 && slugList(defaults.only).length > 0 ? t('field.inheritList', { list: slugList(defaults.only).join(', ') }) : t('field.onlyHint'),
          }, h(SlugList, {
            id: `${id}-only`, value: draft.only, suggestions, disabled, placeholder: t('field.anyProvider'),
            removeLabel: slug => t('field.remove', { slug }), onChange: value => set('only', value),
          })),
          h(Field, {
            label: t('field.ignore'), htmlFor: `${id}-ignore`,
            hint: draft.ignore.length === 0 && slugList(defaults.ignore).length > 0 ? t('field.inheritList', { list: slugList(defaults.ignore).join(', ') }) : t('field.ignoreHint'),
          }, h(SlugList, {
            id: `${id}-ignore`, value: draft.ignore, suggestions, disabled, placeholder: t('field.noProvider'),
            removeLabel: slug => t('field.remove', { slug }), onChange: value => set('ignore', value),
          })),
          h(Field, { label: t('field.usage'), htmlFor: `${id}-usage` }, h(Select, {
            id: `${id}-usage`, value: draft.usage, disabled,
            options: usageOptions(t, saved?.usage, defaults),
            onChange: value => set('usage', value),
          })),
          h(Field, {
            label: t('field.us'), htmlFor: `${id}-us`,
            hint: inheritedUs ? t('field.usInherited') : otherJurisdiction ? t('field.jurisdictionOther', { value: draft.jurisdiction }) : t('field.usHint'),
          }, h('div', { className: 'dshtr-switch-row' }, h(Switch, {
            id: `${id}-us`, label: t('field.us'), disabled: disabled || inheritedUs,
            checked: inheritedUs || (typeof draft.jurisdiction === 'string' && draft.jurisdiction.toLowerCase() === 'us'),
            onChange: checked => set('jurisdiction', checked ? 'us' : ''),
          })))),
        qualifying === undefined
          ? null
          : qualifying.length === 0
            ? h('p', { className: 'dshtr-warning', role: 'status' }, t('editor.noProvider'))
            : h('p', { className: 'dshtr-hint' }, t(qualifying.length === 1 ? 'editor.qualifyingOne' : 'editor.qualifying', { count: qualifying.length, providers: namesOf(qualifying, t) })),
        h('div', { className: 'dshtr-actions' },
          Object.values(draftProvider(draft)).length > 0
            ? h('button', { type: 'button', className: 'dshtr-link-button', disabled, onClick: clear }, t('editor.clear'))
            : null,
          stale
            ? h('p', { className: 'dshtr-error', role: 'alert' }, t('editor.stale'))
            : failed ? h('p', { className: 'dshtr-error', role: 'alert' }, t('editor.failed')) : null,
          h('span', { className: 'dshtr-spacer' }),
          h('button', { type: 'button', className: 'dshtr-secondary-button', disabled: busy, onClick: onClose }, t('editor.cancel')),
          h('button', {
            type: 'button', className: 'dshtr-primary-button', disabled: disabled || stale || ops.length === 0, onClick: apply,
          }, busy ? t('editor.applying') : t('editor.apply'))))
    }

    function ModelRow({ t, model, settings, editing, onEdit, children }) {
      const key = overrideKey(model, settings.models)
      const effective = providerFor(model, settings.defaults, settings.models)
      const summary = describeProvider(t, effective)
      let tag
      if (key === model) tag = t('model.override')
      else if (key !== undefined) tag = t('model.inherits', { model: key })
      else if (Object.keys(settings.defaults).length > 0) tag = t('model.defaults')
      return h('li', { className: 'dshtr-model' },
        h('div', { className: 'dshtr-model-head' },
          h('div', { className: 'dshtr-model-identity' },
            h('span', { className: 'dshtr-model-id' }, model),
            tag ? h('span', { className: 'dshtr-tag' }, tag) : null),
          editing
            ? null
            : h('button', { type: 'button', className: 'dshtr-secondary-button dshtr-compact', onClick: onEdit, 'aria-label': t('model.editLabel', { model }) }, t('model.edit'))),
        h('p', { className: 'dshtr-model-summary' }, summary ?? t('model.none')),
        children)
    }

    /** The section body: defaults line, catalog state, and the route's models. */
    function SectionBody({ t, models, settings, state, policy, catalogs, url }) {
      const [editing, setEditing] = React.useState(undefined)
      const catalogState = useCatalog(catalogs, url, true)
      const catalog = catalogState?.status === 'ready' ? catalogState.models : undefined
      const defaults = describeProvider(t, settings.defaults)
      return h('div', { className: 'dshtr-body' },
        h('p', { className: 'dshtr-hint' }, defaults === undefined ? t('section.noDefaults') : t('section.defaults', { summary: defaults })),
        !state.writable ? h('p', { className: 'dshtr-hint', role: 'status' }, t('section.readOnly')) : null,
        models.length === 0
          ? h('p', { className: 'dshtr-empty' }, t('section.noModels'))
          : h('ul', { className: 'dshtr-models' }, models.map(model => h(ModelRow, {
            key: model, t, model, settings, editing: editing === model, onEdit: () => setEditing(model),
          }, editing === model
            ? h(ModelEditor, {
              t, model, saved: Object.hasOwn(settings.models, model) ? settings.models[model] : undefined,
              inheritedFrom: overrideKey(model, settings.models) === model ? undefined : overrideKey(model, settings.models),
              inherited: overrideKey(model, settings.models) === model ? undefined : settings.models[overrideKey(model, settings.models)],
              defaults: settings.defaults, entry: catalogEntry(catalog, model), catalogState, state, policy,
              onClose: () => setEditing(undefined),
            })
            : null))))
    }

    /** The provider-card entry: renders only on a saved pi-ai route whose baseURL is under a gateway. */
    function ProviderCardSection(props) {
      const { t, routes, policy, catalogs } = props
      const routeState = useForm(routes)
      const state = useForm(policy)
      const [open, setOpen] = React.useState(false)
      if (!props.configured || routeState.status !== 'ready' || state.status !== 'ready') return null
      const route = valueAt(routeState.value, props.provider.settingsPath ?? ['providers', props.provider.provider])
      const baseURL = isPlainObject(route) && typeof route.baseURL === 'string' ? route.baseURL : undefined
      const settings = state.value
      if (baseURL === undefined || !routeCovered(baseURL, settings.gateways)) return null
      const models = routeModels(route)
      const overridden = models.filter(model => overrideKey(model, settings.models) !== undefined).length
      const meta = overridden > 0
        ? t(overridden === 1 ? 'section.overriddenOne' : 'section.overridden', { count: overridden, total: models.length })
        : describeProvider(t, settings.defaults) ?? t('section.off')
      return h('details', { className: 'dshtr-section', open, onToggle: event => setOpen(event.currentTarget.open) },
        h(Styles),
        h('summary', { className: 'dshtr-summary' },
          h('span', null, t('section.title')),
          h('span', { className: 'dshtr-summary-meta' }, meta)),
        open
          ? h(SectionBody, { t, models, settings, state, policy, catalogs, url: catalogURL(baseURL) })
          : null)
    }

    // ---------------------------------------------------------------- Plugins page

    /** The text a Plugins-page field starts from, read from the saved settings. */
    function pageText(settings, key) {
      const defaults = settings.defaults
      switch (key) {
        case 'gateways': return settings.gateways.join('\n')
        case 'models': return Object.keys(settings.models).length === 0 ? '' : JSON.stringify(settings.models, null, 2)
        case 'rules': return settings.rules.length === 0 ? '' : JSON.stringify(settings.rules, null, 2)
        case 'log': return settings.log
        case 'only': case 'ignore': case 'order': return slugList(defaults[key]).join(', ')
        case 'allow_fallbacks': return typeof defaults.allow_fallbacks === 'boolean' ? String(defaults.allow_fallbacks) : ''
        case 'sort': return isPlainObject(defaults.sort) ? JSON.stringify(defaults.sort) : defaults.sort ?? ''
        case 'jurisdiction': return typeof defaults.jurisdiction === 'string' && defaults.jurisdiction.toLowerCase() === 'us'
        case 'max_prompt': return defaults.max_price?.prompt === undefined ? '' : String(defaults.max_price.prompt)
        case 'max_completion': return defaults.max_price?.completion === undefined ? '' : String(defaults.max_price.completion)
        default: return defaults[key] ?? ''
      }
    }

    const PRICE = /^\d+(\.\d+)?$/

    /**
     * The first problem with a `provider` object's known fields, as
     * `[field, expected]`, or undefined. It mirrors the host schema so the
     * page can name the field; the host still validates every write, and
     * unknown keys pass here as they do there.
     */
    function providerProblem(provider) {
      const isSlugs = value => typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'))
      const isPrice = value => typeof value === 'number' || typeof value === 'string'
      const checks = {
        only: [isSlugs, 'a list of provider slugs'],
        ignore: [isSlugs, 'a list of provider slugs'],
        order: [isSlugs, 'a list of provider slugs'],
        allow_fallbacks: [value => typeof value === 'boolean', 'true or false'],
        require_parameters: [value => typeof value === 'boolean', 'true or false'],
        zdr: [value => typeof value === 'boolean', 'true or false'],
        min_privacy: [value => levelOf(value) !== undefined, `one of ${LEVELS.join(', ')}`],
        usage: [value => usageOf(value) !== undefined, `one of ${USAGES.join(', ')}`],
        data_collection: [value => value === 'allow' || value === 'deny', 'allow or deny'],
        jurisdiction: [value => typeof value === 'string', 'a string such as "us"'],
        sort: [value => SORTS.includes(value) || (isPlainObject(value) && SORTS.includes(value.by) && [undefined, 'model', 'none'].includes(value.partition)), `one of ${SORTS.join(', ')}`],
        max_price: [value => isPlainObject(value) && Object.values(value).every(isPrice), '{ "prompt": "0.15", "completion": "0.40" }'],
      }
      for (const [field, value] of Object.entries(provider)) {
        if (Object.hasOwn(checks, field) && !checks[field][0](value)) return [field, checks[field][1]]
      }
      return undefined
    }

    /** What is wrong with a parsed `models` value, as locale key and params, or undefined. */
    function modelsProblem(value) {
      if (!isPlainObject(value) || !Object.values(value).every(isPlainObject)) return ['page.invalidModels']
      for (const [model, provider] of Object.entries(value)) {
        const problem = providerProblem(provider)
        if (problem !== undefined) return ['page.invalidField', { where: model, field: problem[0], expected: problem[1] }]
      }
      return undefined
    }

    function rulesProblem(value) {
      if (!Array.isArray(value)) return ['page.invalidRules']
      const index = value.findIndex(rule => !isPlainObject(rule) || typeof rule.baseURL !== 'string' || !HTTP_URL.test(rule.baseURL) || !isPlainObject(rule.body))
      return index === -1 ? undefined : ['page.invalidRule', { index: index + 1 }]
    }

    /**
     * Parse the Plugins page's staged edits into settings ops, plus a problem
     * (locale key and params) per invalid field. Each edited field becomes one
     * `set` or `unset`; `max_price` is written whole from its two inputs.
     */
    function pageOps(settings, edits) {
      const ops = []
      const errors = {}
      const defaultsOp = (field, value) => ops.push(value === undefined
        ? { op: 'unset', path: ['defaults', field] }
        : { op: 'set', path: ['defaults', field], value })
      for (const [key, raw] of Object.entries(edits)) {
        switch (key) {
          case 'gateways': {
            const lines = raw.split('\n').map(line => line.trim()).filter(Boolean)
            if (lines.some(line => !HTTP_URL.test(line))) errors[key] = ['page.invalidURL']
            else ops.push({ op: 'set', path: ['gateways'], value: lines })
            break
          }
          case 'models': case 'rules': {
            let value
            try {
              value = raw.trim() === '' ? (key === 'models' ? {} : []) : JSON.parse(raw)
            } catch {
              errors[key] = ['page.invalidJSON']
              break
            }
            const problem = key === 'models' ? modelsProblem(value) : rulesProblem(value)
            if (problem !== undefined) errors[key] = problem
            else ops.push({ op: 'set', path: [key], value })
            break
          }
          case 'log':
            ops.push({ op: 'set', path: ['log'], value: raw })
            break
          case 'only': case 'ignore': case 'order':
            defaultsOp(key, normalizeField('only', raw))
            break
          case 'allow_fallbacks':
            defaultsOp(key, raw === '' ? undefined : raw === 'true')
            break
          case 'sort':
            defaultsOp(key, raw === '' ? undefined : raw.startsWith('{') ? JSON.parse(raw) : raw)
            break
          case 'jurisdiction':
            defaultsOp(key, raw ? 'us' : undefined)
            break
          case 'max_prompt': case 'max_completion':
            if (raw.trim() !== '' && !PRICE.test(raw.trim())) errors[key] = ['page.invalidPrice']
            break
          default:
            defaultsOp(key, raw === '' ? undefined : raw)
        }
      }
      if (Object.hasOwn(edits, 'max_prompt') || Object.hasOwn(edits, 'max_completion')) {
        const prompt = (Object.hasOwn(edits, 'max_prompt') ? edits.max_prompt : pageText(settings, 'max_prompt')).trim()
        const completion = (Object.hasOwn(edits, 'max_completion') ? edits.max_completion : pageText(settings, 'max_completion')).trim()
        // Start from the saved object, so sub-keys the page does not show are kept.
        const price = isPlainObject(settings.defaults.max_price) ? { ...settings.defaults.max_price } : {}
        if (prompt === '') delete price.prompt
        else price.prompt = prompt
        if (completion === '') delete price.completion
        else price.completion = completion
        defaultsOp('max_price', Object.keys(price).length === 0 ? undefined : price)
      }
      return { ops, errors }
    }

    /** The Plugins-page form: staged edits over the saved settings, written by one Save. */
    function PluginPage({ t, policy }) {
      const state = useForm(policy)
      const [edits, setEdits] = React.useState({})
      // The revision the first staged edit was made at; see ModelEditor.
      const [since, setSince] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const id = React.useId()
      if (state.status === 'loading') return h('div', null, h(Styles))
      if (state.status !== 'ready') return h('div', null, h(Styles), h('p', { className: 'dshtr-hint', role: 'status' }, t('page.unavailable')))
      const settings = state.value
      const value = key => Object.hasOwn(edits, key) ? edits[key] : pageText(settings, key)
      const edit = (key, next) => {
        setFailed(false)
        setSince(previous => previous ?? state.revision)
        setEdits(previous => ({ ...previous, [key]: next }))
      }
      const discard = () => {
        setEdits({})
        setSince(undefined)
        setFailed(false)
      }
      const stale = since !== undefined && since !== state.revision
      const { ops, errors } = pageOps(settings, edits)
      const invalid = Object.keys(errors).length > 0
      const disabled = busy || !state.writable
      const save = async () => {
        setBusy(true)
        let accepted = false
        try {
          accepted = await policy.mutate(ops, since ?? state.revision)
        } catch {
          accepted = false
        }
        setBusy(false)
        if (accepted) discard()
        else setFailed(true)
      }
      const error = key => errors[key] === undefined ? undefined : t(...errors[key])
      const text = (key, options = {}) => h(options.multiline ? 'textarea' : 'input', {
        id: `${id}-${key}`, className: cx('dshtr-input', options.multiline && 'dshtr-textarea', options.mono && 'dshtr-mono'),
        value: value(key), disabled, placeholder: options.placeholder, spellCheck: false,
        rows: options.multiline ? options.rows ?? 4 : undefined, 'aria-invalid': errors[key] === undefined ? undefined : true,
        onChange: event => edit(key, event.target.value),
      })
      const select = (key, options) => h(Select, { id: `${id}-${key}`, value: value(key), disabled, options, onChange: next => edit(key, next) })
      const field = (key, label, control, hint) => h(Field, { label, htmlFor: `${id}-${key}`, hint, warning: error(key) }, control)
      const notSet = { value: '', label: t('field.notSet') }

      return h('div', { className: 'dshtr-page' },
        h(Styles),
        !state.writable ? h('p', { className: 'dshtr-hint', role: 'status' }, t('section.readOnly')) : null,
        h('h3', { className: 'dshtr-page-heading' }, t('page.where')),
        field('gateways', t('page.gateways'), text('gateways', { multiline: true, rows: 2, mono: true }), t('page.gatewaysHint')),
        h('h3', { className: 'dshtr-page-heading' }, t('page.defaults')),
        h('p', { className: 'dshtr-hint' }, t('page.defaultsHint')),
        h('div', { className: 'dshtr-grid' },
          field('min_privacy', t('field.privacy'), select('min_privacy', [notSet, ...LEVELS.map(level => ({ value: level, label: levelLabel(t, level) })),
            ...typeof value('min_privacy') === 'string' && value('min_privacy') !== '' && !LEVELS.includes(value('min_privacy')) ? [{ value: value('min_privacy'), label: value('min_privacy') }] : []])),
          field('sort', t('field.sort'), select('sort', [notSet, ...SORTS.map(sort => ({ value: sort, label: t(`sort.${sort}`) })),
            ...value('sort').startsWith('{') ? [{ value: value('sort'), label: value('sort') }] : []])),
          field('only', t('field.only'), text('only', { placeholder: t('page.slugsPlaceholder') }), t('field.onlyHint')),
          field('ignore', t('field.ignore'), text('ignore', { placeholder: t('page.slugsPlaceholder') }), t('field.ignoreHint')),
          field('usage', t('field.usage'), select('usage', [notSet, ...USAGES.map(usage => ({ value: usage, label: t(`usage.${usage}`) })),
            ...value('usage') !== '' && !USAGES.includes(value('usage')) ? [{ value: value('usage'), label: value('usage') }] : []])),
          field('jurisdiction', t('field.us'), h('div', { className: 'dshtr-switch-row' }, h(Switch, {
            id: `${id}-jurisdiction`, label: t('field.us'), checked: value('jurisdiction'), disabled, onChange: next => edit('jurisdiction', next),
          })), typeof settings.defaults.jurisdiction === 'string' && settings.defaults.jurisdiction.toLowerCase() !== 'us' && !Object.hasOwn(edits, 'jurisdiction')
            ? t('field.jurisdictionOther', { value: settings.defaults.jurisdiction })
            : t('field.usHint'))),
        h('h3', { className: 'dshtr-page-heading' }, t('page.advanced')),
        h('div', { className: 'dshtr-grid' },
          field('order', t('page.order'), text('order', { placeholder: t('page.slugsPlaceholder') }), t('page.orderHint')),
          field('allow_fallbacks', t('page.fallbacks'), select('allow_fallbacks', [notSet, { value: 'true', label: t('page.yes') }, { value: 'false', label: t('page.no') }]), t('page.fallbacksHint')),
          field('max_prompt', t('page.maxPrompt'), text('max_prompt', { placeholder: '0.15' }), t('page.maxPriceHint')),
          field('max_completion', t('page.maxCompletion'), text('max_completion', { placeholder: '0.40' }), t('page.maxPriceHint'))),
        field('models', t('page.models'), text('models', { multiline: true, rows: 6, mono: true, placeholder: '{ "z-ai/glm-5.3": { "min_privacy": "confidential" } }' }), t('page.modelsHint')),
        field('rules', t('page.rules'), text('rules', { multiline: true, rows: 4, mono: true, placeholder: '[{ "baseURL": "https://…/v1", "body": { … } }]' }), t('page.rulesHint')),
        h('div', { className: 'dshtr-field' },
          h('div', { className: 'dshtr-switch-line' },
            h('label', { className: 'dshtr-field-label', htmlFor: `${id}-log` }, t('page.log')),
            h(Switch, { id: `${id}-log`, label: t('page.log'), checked: value('log'), disabled, onChange: next => edit('log', next) })),
          h('p', { className: 'dshtr-hint' }, t('page.logHint'))),
        h('div', { className: 'dshtr-page-footer' },
          stale
            ? h('p', { className: 'dshtr-error', role: 'alert' }, t('page.stale'))
            : failed ? h('p', { className: 'dshtr-error', role: 'alert' }, t('page.saveFailed')) : null,
          h('span', { className: 'dshtr-spacer' }),
          Object.keys(edits).length > 0
            ? h('button', { type: 'button', className: 'dshtr-secondary-button', disabled: busy, onClick: discard }, t('page.discard'))
            : null,
          h('button', {
            type: 'button', className: 'dshtr-save', disabled: disabled || invalid || stale || ops.length === 0, onClick: save,
          }, busy ? t('page.saving') : t('page.save'))))
    }

    function PluginRowConfig(props) {
      const { t, policy } = props
      const state = useForm(policy)
      if (props.view === 'summary') {
        if (state.status !== 'ready') return t('meta.description')
        const defaults = describeProvider(t, state.value.defaults)
        const models = Object.keys(state.value.models).length
        return defaults === undefined && models === 0
          ? t('summary.off')
          : t(models === 1 ? 'summary.onOne' : 'summary.on', { defaults: defaults ?? t('summary.noDefaults'), count: models })
      }
      return h(PluginPage, { t, policy })
    }

    // ---------------------------------------------------------------- styles

    /** Copied from the Models page and settings-form primitives, under this plugin's prefix. */
    const CSS = `
.dshtr-section { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 10px; }
.dshtr-summary { display: flex; align-items: center; gap: 6px; width: fit-content; max-width: 100%; padding: 2px 4px; margin-left: -4px; border-radius: var(--dsw-radius-sm); cursor: pointer; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); list-style: none; }
.dshtr-summary::-webkit-details-marker { display: none; }
.dshtr-summary::before { content: ''; flex: none; width: 5px; height: 5px; border-right: 1.5px solid currentcolor; border-bottom: 1.5px solid currentcolor; transform: rotate(-45deg) translate(-1px, -1px); transition: transform 120ms ease; }
.dshtr-section[open] > .dshtr-summary::before { transform: rotate(45deg) translate(-1px, -1px); }
.dshtr-summary:hover { color: var(--dsw-alias-label-primary); }
.dshtr-summary:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dshtr-summary-meta { font-weight: 400; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshtr-body { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; }
.dshtr-models { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dshtr-model { border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg); padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.dshtr-model-head { display: flex; align-items: center; gap: 8px; }
.dshtr-model-identity { display: inline-flex; align-items: center; gap: 6px; min-width: 0; margin-right: auto; }
.dshtr-model-id { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshtr-model-summary { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshtr-tag { flex: none; padding: 1px 6px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xs); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.dshtr-editor { margin-top: 6px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.dshtr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 16px; }
.dshtr-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshtr-field-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dshtr-hint, .dshtr-empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshtr-warning { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-error-primary)); }
.dshtr-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dshtr-input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); font: inherit; font-size: 13px; line-height: 20px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dshtr-input:focus, .dshtr-slugs:focus-within { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.dshtr-input::placeholder, .dshtr-slug-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dshtr-input:disabled { opacity: 0.6; cursor: default; }
.dshtr-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.dshtr-select { appearance: none; cursor: pointer; padding-right: 32px; text-overflow: ellipsis; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; background-size: 12px 12px; }
.dshtr-textarea { height: auto; padding: 6px 10px; resize: vertical; }
.dshtr-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 18px; }
.dshtr-slugs { box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 32px; padding: 3px 6px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.dshtr-slugs.dshtr-disabled { opacity: 0.6; }
.dshtr-chip { display: inline-flex; align-items: center; gap: 2px; padding: 0 2px 0 8px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); font-size: 12px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.dshtr-chip-remove { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; line-height: 1; cursor: pointer; }
.dshtr-chip-remove:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshtr-slug-input { flex: 1 1 80px; min-width: 80px; height: 24px; padding: 0 4px; border: none; outline: none; background: transparent; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshtr-switch-row { display: flex; align-items: center; min-height: 32px; }
.dshtr-switch-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dshtr-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; }
.dshtr-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dshtr-switch:disabled { cursor: default; opacity: 0.5; }
.dshtr-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dshtr-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
.dshtr-switch[aria-checked='false'] .dshtr-thumb { background: var(--dsw-alias-switch-thumb); }
.dshtr-switch[aria-checked='true'] .dshtr-thumb { transform: translateX(16px); }
.dshtr-actions, .dshtr-page-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshtr-spacer { flex: 1; }
.dshtr-primary-button, .dshtr-secondary-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.dshtr-primary-button { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dshtr-primary-button:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dshtr-secondary-button { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary); }
.dshtr-secondary-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)); }
.dshtr-compact { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 18px; }
.dshtr-link-button { box-sizing: border-box; display: inline-flex; align-items: center; height: 28px; padding: 0 10px; margin-left: -10px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.dshtr-link-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dshtr-primary-button:disabled, .dshtr-secondary-button:disabled, .dshtr-link-button:disabled, .dshtr-save:disabled { opacity: 0.4; cursor: default; }
.dshtr-primary-button:focus-visible, .dshtr-secondary-button:focus-visible, .dshtr-link-button:focus-visible, .dshtr-chip-remove:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dshtr-page { display: flex; flex-direction: column; gap: 14px; }
.dshtr-page-heading { margin: 8px 0 -4px; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshtr-page-footer { padding-top: 4px; }
.dshtr-save { appearance: none; border: 1px solid transparent; border-radius: var(--dsw-radius-md); padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dshtr-save:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
`

    /** Component-local styles, so unmounting the last entry removes them. */
    function Styles() {
      return h('style', null, CSS)
    }

    // ---------------------------------------------------------------- copy

    const EN = {
      'meta.description': 'Choose TrustedRouter\'s privacy floor, providers and billing per model.',
      'level.any': 'Any provider',
      'level.no_store': 'No-store',
      'level.zdr': 'Zero retention',
      'level.confidential': 'Confidential + E2EE + ZDR',
      'level.with': '{level} — {providers}',
      'level.none': '{level} — no provider',
      'providers.more': '{names} +{count}',
      'sort.price': 'Price',
      'sort.latency': 'Latency',
      'sort.throughput': 'Throughput',
      'usage.credits': 'TrustedRouter credits',
      'usage.byok': 'Your own provider key (BYOK)',
      'summary.floor': 'floor {value}',
      'summary.only': 'only {list}',
      'summary.ignore': 'not {list}',
      'summary.sort': 'by {by}',
      'summary.us': 'US only',
      'summary.jurisdiction': 'jurisdiction {value}',
      'summary.off': 'No privacy policy yet: requests go out unchanged.',
      'summary.on': 'Every model: {defaults}. Own settings for {count} models.',
      'summary.onOne': 'Every model: {defaults}. Own settings for 1 model.',
      'summary.noDefaults': 'no defaults',
      'section.title': 'Privacy & routing',
      'section.off': 'Not set',
      'section.overridden': '{count} of {total} models customized',
      'section.overriddenOne': '1 of {total} models customized',
      'section.defaults': 'Defaults for every model: {summary}. Change them on Plugins → TrustedRouter privacy.',
      'section.noDefaults': 'No defaults, so a model without its own settings goes out unchanged. Set defaults on Plugins → TrustedRouter privacy.',
      'section.noModels': 'This provider lists no models yet.',
      'section.readOnly': 'Settings are read-only here; change them from a browser on this machine.',
      'catalog.loading': 'Loading TrustedRouter\'s model list…',
      'catalog.failed': 'Couldn\'t load TrustedRouter\'s model list ({error}), so every privacy level is offered.',
      'catalog.unknownModel': 'TrustedRouter\'s model list doesn\'t include this model, so every privacy level is offered.',
      'model.override': 'Custom',
      'model.inherits': 'Uses {model}',
      'model.defaults': 'Defaults',
      'model.none': 'No policy: TrustedRouter routes this model as it normally would.',
      'model.edit': 'Edit',
      'model.editLabel': 'Edit privacy and routing for {model}',
      'field.privacy': 'Privacy floor',
      'field.privacyHint': 'TrustedRouter refuses the request rather than use a provider below this.',
      'field.sort': 'Prefer',
      'field.only': 'Only these providers',
      'field.onlyHint': 'Leave empty to allow every provider.',
      'field.ignore': 'Never these providers',
      'field.ignoreHint': 'Applied after the list above.',
      'field.usage': 'Billing',
      'field.us': 'US-headquartered providers only',
      'field.usHint': 'Sends jurisdiction "us".',
      'field.usInherited': 'Set for every model in the defaults.',
      'field.jurisdictionOther': 'Jurisdiction "{value}" is set; turning this on replaces it with "us".',
      'field.notSet': 'Not set',
      'field.inherit': 'Default ({value})',
      'field.inheritList': 'Defaults: {list}. A list here replaces it.',
      'field.anyProvider': 'Any provider',
      'field.noProvider': 'None',
      'field.remove': 'Remove {slug}',
      'editor.qualifying': '{count} providers qualify: {providers}',
      'editor.qualifyingOne': 'Only {providers} qualifies.',
      'editor.noProvider': 'No TrustedRouter provider for this model meets these settings, so its requests will be refused.',
      'editor.clear': 'Clear overrides',
      'editor.cancel': 'Cancel',
      'editor.apply': 'Apply',
      'editor.applying': 'Applying…',
      'editor.failed': 'Not saved: the settings were refused. Cancel and try again.',
      'editor.stale': 'These settings were saved elsewhere since you opened this. Cancel and reopen to edit the latest.',
      'editor.inherits': 'Starts from {model}\'s settings. Applying saves them for this model alone.',
      'page.unavailable': 'The trustedrouter row isn\'t running, so it can\'t be configured right now.',
      'page.where': 'Where it applies',
      'page.gateways': 'Gateways',
      'page.gatewaysHint': 'One base URL per line. Requests under these get the policy below; the EU gateway is https://api-europe-west4.quillrouter.com/v1.',
      'page.defaults': 'Defaults for every model',
      'page.defaultsHint': 'Per-model settings on Settings → Models override these field by field.',
      'page.advanced': 'Advanced defaults',
      'page.order': 'Preferred order',
      'page.orderHint': 'Tried first while fallbacks are on; other providers stay eligible.',
      'page.fallbacks': 'Fallbacks',
      'page.fallbacksHint': '"No" serves only the first candidate.',
      'page.yes': 'Yes',
      'page.no': 'No',
      'page.maxPrompt': 'Max prompt price',
      'page.maxCompletion': 'Max completion price',
      'page.maxPriceHint': 'USD per million tokens.',
      'page.slugsPlaceholder': 'tinfoil, privatemode',
      'page.models': 'Per-model overrides (JSON)',
      'page.modelsHint': 'Keyed by model id. Settings → Models edits the common fields; here you can add any provider field or remove models no route lists.',
      'page.rules': 'Raw body rules (JSON)',
      'page.rulesHint': 'Each rule deep-merges its body into every POST under its baseURL, after the provider policy.',
      'page.log': 'Log changes to the terminal',
      'page.logHint': 'Prints "[trustedrouter] …" lines to the dsh web terminal. Request bodies are never printed.',
      'page.invalidURL': 'Each line must be an http(s) URL with no query or fragment.',
      'page.invalidJSON': 'This isn\'t valid JSON.',
      'page.invalidModels': 'Expected an object of objects: { "model-id": { "min_privacy": "zdr" } }.',
      'page.invalidField': '{where}: {field} must be {expected}.',
      'page.invalidRules': 'Expected a list: [{ "baseURL": "…", "body": { … } }].',
      'page.invalidRule': 'Rule {index} needs an http(s) "baseURL" with no query or fragment, and a "body" object.',
      'page.invalidPrice': 'Enter a number such as 0.15.',
      'page.save': 'Save',
      'page.saving': 'Saving…',
      'page.discard': 'Discard',
      'page.saveFailed': 'Not saved: a value was refused.',
      'page.stale': 'These settings were saved elsewhere since your first change here. Discard to load them, then redo your changes.',
    }

    // ---------------------------------------------------------------- apply

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, 'en', EN))
      const routes = ctx.configForms.get(ROUTES_NS)
      const policy = ctx.configForms.get(POLICY_NS)
      const catalogs = createCatalogs(url => globalThis.fetch(url))
      ctx.effect(() => () => catalogs.dispose())
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card', key: ROUTES_NS, locale: NS,
        inject: () => ({ routes, policy, catalogs }),
      }, ProviderCardSection))
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config', key: ROW_KEY, locale: NS,
        inject: () => ({ policy }),
      }, PluginRowConfig))
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply,
      // Pure helpers, exported like the host half's for the unit tests.
      EN, LEVELS, mergeBody, providerFor, overrideKey, routeCovered, slugList, levelOf, indexCatalog,
      catalogEntry, levelChoices, qualifyingProviders, modelOps, pageOps, providerProblem, routeModels, valueAt, createCatalogs,
    }
  },
})
