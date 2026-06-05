# Koolbase CDN Worker

Cloudflare Worker that powers `cdn.koolbase.com/p/{project_id}/{preset_name}/{bucket}/{path}` — resolves named image transform presets from Workers KV and applies them at the edge.

Part of [Koolbase](https://koolbase.com), the Flutter-first open-source BaaS.

## How it works

1. Request hits `cdn.koolbase.com/p/*` (routed to this Worker by Cloudflare)
2. Worker parses `{project_id}/{preset_name}/{bucket}/{rest}` from the path
3. KV lookup at key `preset:{project_id}:{preset_name}` returns the transform options
4. Worker fetches the source image and applies transforms via `fetch(url, { cf: { image: opts } })`
5. Cloudflare caches the result at the edge for 4 hours

## Deploy

```bash
npx wrangler deploy
```

The KV binding (`PRESETS`) and the route (`cdn.koolbase.com/p/*`) are declared in `wrangler.toml`.

## KV sync

Presets are written to KV by the Koolbase API (`internal/transformpreset/service.go`) whenever a preset is created, updated, or deleted via the dashboard or REST. The Worker is read-only against KV — DB is the source of truth.

## Why not the `/cdn-cgi/image/<opts>/<url>` URL form?

That form only applies to direct browser/curl requests against the zone. It is **silently ignored** for Worker subrequests on the same zone. The canonical Workers approach is `fetch(url, { cf: { image: opts } })`, which works regardless of routing — and is what this Worker uses.

## License

MIT — see [LICENSE](./LICENSE).
