# Changelog

## Unreleased (0.1.0)

First release.

- Adds TrustedRouter's `provider` object to POSTs under configured gateways (default `https://api.trustedrouter.com/v1`). It merges `defaults` with a per-model override from `models`, and a `:suffix` variant falls back to its base model's override.
- Settings → Models: a **Privacy & routing** section on each TrustedRouter card, to set each model's privacy floor, allowed and blocked providers, sort, billing and US-only. It lists the providers that qualify, from TrustedRouter's public model list.
- Plugins → TrustedRouter privacy: gateways, defaults, advanced defaults (`order`, `allow_fallbacks`, `max_price`), per-model and raw body rules as JSON, and logging.
- Config changes apply on the next request, with no restart.
- Fails closed: a gateway POST that needs a policy but can't be rewritten is refused.
- Optional `[trustedrouter]` log lines on the dsh terminal. Request bodies are never logged.
- Tested on dsh 0.2.0-rc.2 and 0.2.1-alpha.1.
