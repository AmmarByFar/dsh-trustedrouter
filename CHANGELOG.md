# Changelog

## 0.1.1 (2026-11-15)

- Fixes the Models page with TrustedRouter's current API. TrustedRouter's model list now leaves out each model's providers unless asked for them. With 0.1.0 that disabled every privacy floor above Any and warned that every model's requests would be refused. The section now fetches `<base URL>/models?include=endpoints`. Requests weren't affected: the saved policy was still sent.
- A model the list gives no provider details for now offers every privacy level, with a note, instead of none.
- Tested on dsh 0.2.0-rc.2, 0.2.1-alpha.1, 0.2.2-rc.1 and 0.2.2-alpha.3, with Node 24. dsh 0.2.2 needs Node 24.9 or newer.

## 0.1.0 (2026-10-07)

First release.

- Adds TrustedRouter's `provider` object to POSTs under configured gateways (default `https://api.trustedrouter.com/v1`). It merges `defaults` with a per-model override from `models`, and a `:suffix` variant falls back to its base model's override.
- Settings → Models: a **Privacy & routing** section on each TrustedRouter card, to set each model's privacy floor, allowed and blocked providers, sort, billing and US-only. It lists the providers that qualify, from TrustedRouter's public model list.
- Plugins → TrustedRouter privacy: gateways, defaults, advanced defaults (`order`, `allow_fallbacks`, `max_price`), per-model and raw body rules as JSON, and logging.
- Config changes apply on the next request, with no restart.
- Fails closed: a gateway POST that needs a policy but can't be rewritten is refused.
- Optional `[trustedrouter]` log lines on the dsh terminal. Request bodies are never logged.
- Tested on dsh 0.2.0-rc.2 and 0.2.1-alpha.1.
