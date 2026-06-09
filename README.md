<div align="center">
  <a href="https://koolbase.com">
    <img src="https://koolbase.com/logo.svg" alt="Koolbase" width="80" />
  </a>

  <h1>Koolbase CDN Worker</h1>

  <p>Cloudflare Worker that powers <code>cdn.koolbase.com/p/*</code> — resolves named image transform presets from Workers KV and applies them at the edge.</p>

  <p>
    <a href="https://koolbase.com">Website</a> ·
    <a href="https://docs.koolbase.com">Docs</a> ·
    <a href="https://x.com/koolbasedev">X</a>
  </p>
</div>

---

## About

This Worker is part of the [Koolbase](https://koolbase.com) image delivery pipeline. It sits in front of object storage and applies named image transform presets — resize, crop, format conversion, quality — at Cloudflare's edge.

Koolbase is a Backend-as-a-Service built for mobile developers.

## How it works

1. Request hits `cdn.koolbase.com/p/*` (routed to this Worker by Cloudflare)
2. Worker parses `{project_id}/{preset_name}/{bucket}/{path}` from the URL
3. KV lookup at key `preset:{project_id}:{preset_name}` returns the transform options
4. Worker fetches the source image and applies transforms via `fetch(url, { cf: { image: opts } })`
5. Cloudflare caches the result at the edge for 4 hours

## Tech stack

- Cloudflare Workers (TypeScript)
- Cloudflare Workers KV — preset storage
- Cloudflare Image Resizing — transformation engine
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) for local dev and deployment

## Local development

Prerequisites: Node.js 18+, a Cloudflare account with Workers + Image Resizing enabled, Wrangler CLI authenticated.

```
git clone https://github.com/koolbase/koolbase-cdn-worker.git
cd koolbase-cdn-worker
npm install
npx wrangler login
npx wrangler dev
```

The dev server runs against a remote KV namespace by default. See `wrangler.toml` for bindings.

## Deployment

```
npx wrangler deploy
```

The KV binding (`PRESETS`) and the route (`cdn.koolbase.com/p/*`) are declared in `wrangler.toml`.

## How presets are populated

Presets are written to KV by the Koolbase API whenever a preset is created, updated, or deleted via the dashboard or REST API.

This Worker is **read-only** against KV — the Postgres database is the source of truth, and KV is a cache/projection of preset definitions for fast edge lookup.

## Why not the `/cdn-cgi/image/<opts>/<url>` URL form?

That URL form only applies to direct browser or `curl` requests against the zone. It is **silently ignored** for Worker subrequests on the same zone — even when the Worker route matches first.

The canonical Workers approach for image transformation is `fetch(url, { cf: { image: opts } })`, which works regardless of routing. That's what this Worker uses.

This is the kind of gotcha that costs an afternoon when you discover it. Don't.

## Contributing

Bug fixes, performance improvements, and additional preset transforms are welcome via pull request.

For larger changes (route schema changes, KV schema changes, breaking config), please [open an issue](https://github.com/koolbase/koolbase-cdn-worker/issues/new) first to discuss the approach.

## Reporting issues

Found a bug — wrong image returned, cache miss when there should be a hit, malformed transform applied? [Open an issue](https://github.com/koolbase/koolbase-cdn-worker/issues/new) with:

- The request URL that failed
- What you expected vs. what you got
- The `cf-ray` header from the response (visible in browser devtools or `curl -i`) so we can correlate with Cloudflare logs

## Community

- X — [@koolbasedev](https://x.com/koolbasedev)
- Bluesky — [koolbase.bsky.social](https://bsky.app/profile/koolbase.bsky.social)
- YouTube — [@koolbase](https://youtube.com/@koolbase)
- Dev.to — [@koolbase](https://dev.to/koolbase)
- Hashnode — [@koolbase](https://hashnode.com/@koolbase)

## License

[MIT](LICENSE) — see the [LICENSE](LICENSE) file.

---

<sub>Built by <a href="https://koolbase.com">Koolbase</a>
