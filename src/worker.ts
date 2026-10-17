// koolbase-cdn-worker — bound to cdn.koolbase.com/p/*.
//
// Resolves named image-transformation preset URLs at the edge:
//
//   GET https://cdn.koolbase.com/p/{project_id}/{preset_name}/{bucket}/{path}
//
// 1. Looks up `preset:{project_id}:{preset_name}` in the PRESETS KV namespace.
// 2. Joins the stored options into `/cdn-cgi/image/<opts>/` form.
// 3. Sub-requests the rewritten URL on the same zone — Cloudflare's native
//    Image Transformations layer intercepts /cdn-cgi/image/ and applies the
//    transform, caching the result at the edge for free.
//
// Other paths on cdn.koolbase.com (raw R2 fetches, direct /cdn-cgi/image/
// calls) bypass this Worker entirely — the route binding scopes it to /p/*.

export interface Env {
  PRESETS: KVNamespace;
}

// Order is irrelevant to Cloudflare but stable here for predictable cache keys.
const ALLOWED_OPTIONS = [
  'width',
  'height',
  'format',
  'quality',
  'fit',
  'dpr',
  'gravity',
] as const;

type OptionKey = (typeof ALLOWED_OPTIONS)[number];
type StoredOptions = Partial<Record<OptionKey, string | number>>;

// Lenient UUID check — the API enforces the real format on write; this is
// just to keep junk out of the KV lookup path.
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Mirrors the DB CHECK constraint on transform_presets.name.
const PRESET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // A browser's preflight: answered here, never looked up.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return withCors(await resolve(request, env));
  },
};

// Cross-origin reads (#146): a preset image is a public file, readable from
// any page as its original is -- the raw object's route sends
// `Access-Control-Allow-Origin: *`, and a transformed response from
// cf.image does not carry it. Browsers that fetch images (Flutter on the
// web, a canvas reading pixels) refuse a response without it. Every
// response from this Worker carries it, errors too, so a page can read why.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function withCors(res: Response): Response {
  // A fetched response's headers are immutable: copy, then add.
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

async function resolve(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // /p/{project_id}/{preset_name}/{rest_of_path}
  // where rest_of_path = {bucket}/{path...} (any depth)
  const match = url.pathname.match(/^\/p\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) {
    return jsonError(
      404,
      'not_found',
      'preset URL must be /p/{project_id}/{preset_name}/{bucket}/{path}',
    );
  }

  const [, projectId, presetName, restPath] = match;

  if (!UUID_RE.test(projectId)) {
    return jsonError(400, 'invalid_project_id', 'project_id must be a UUID');
  }
  if (!PRESET_NAME_RE.test(presetName)) {
    return jsonError(
      400,
      'invalid_preset_name',
      'preset name must be lowercase alphanumeric with _ or -, 1-64 chars',
    );
  }

  const kvKey = `preset:${projectId}:${presetName}`;
  const stored = await env.PRESETS.get(kvKey);
  if (stored === null) {
    return jsonError(
      404,
      'preset_not_found',
      `no preset named '${presetName}' in project ${projectId}`,
    );
  }

  let opts: StoredOptions;
  try {
    opts = JSON.parse(stored) as StoredOptions;
  } catch {
    return jsonError(
      500,
      'preset_corrupted',
      'preset data in KV is not valid JSON; re-save the preset from the dashboard',
    );
  }

  // Build the cf.image options object, allowlist-filtered. Workers must
  // use `cf.image` for in-Worker transforms because the /cdn-cgi/image/
  // URL prefix is NOT applied to Worker subrequests on the same zone —
  // hitting that prefix from inside a Worker just returns an R2 404.
  const imageOpts: Record<string, string | number> = {};
  for (const key of ALLOWED_OPTIONS) {
    const value = opts[key];
    if (value !== undefined && value !== null) {
      imageOpts[key] = value;
    }
  }

  const sourceUrl = `https://cdn.koolbase.com/${projectId}/${restPath}`;

  // Empty preset → pass through to the raw object.
  if (Object.keys(imageOpts).length === 0) {
    return fetch(sourceUrl, {
      method: 'GET',
      headers: forwardHeaders(request.headers),
    });
  }

  // Transform via cf.image — Cloudflare applies the transform on the fly
  // and caches the result at the edge.
  return fetch(sourceUrl, {
    method: 'GET',
    headers: forwardHeaders(request.headers),
    cf: {
      image: imageOpts,
    },
  });
}

// --- helpers --------------------------------------------------------------

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Forward only safe headers — strip auth, cookies, anything that would cause
// the cache to miss or that doesn't apply to a public CDN read.
function forwardHeaders(src: Headers): Headers {
  const out = new Headers();
  const allow = ['accept', 'accept-encoding', 'accept-language', 'user-agent'];
  for (const name of allow) {
    const v = src.get(name);
    if (v) out.set(name, v);
  }
  return out;
}
