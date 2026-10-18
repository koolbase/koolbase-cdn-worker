// Presets for private buckets (#146): /s/{project_id}/{preset}/{bucket}/{path}
// ?exp={unix seconds}&sig={hex}. The API issues the address after the
// bucket's rules let the person see the file (storage.download-url with a
// preset), signed with the key it shares with this Worker:
//
//   sig = hex(HMAC-SHA256(PRESET_SIGNING_KEY,
//                         "s/{project}/{preset}/{bucket}/{path}\n{exp}\n{v}"))
//
// with {path} decoded (each segment as it is stored) and {v} the file's
// version as the API knows it (its ETag), so a file replaced, deleted or
// cleaned is never served from an older copy. Anything else -- no
// signature, a wrong one, an expired link -- is refused before anything is
// read. The file is read from R2 through a binding (the private store, or
// the public one while a newly private bucket's file is still being moved),
// sized by the Images binding as the preset says, and kept at the edge for
// an hour under its object, version, preset (and the preset's options) and
// format -- never its signature, under a host nobody can ask for, and only
// ever handed out after a signature checks out.

export interface SignedEnv {
  PRESETS: KVNamespace;
  PRIVATE_FILES: R2Bucket;
  PUBLIC_FILES: R2Bucket;
  IMAGES: ImagesBinding;
  PRESET_SIGNING_KEY: string;
}

export type StoredOptions = Partial<Record<'width' | 'height' | 'format' | 'quality' | 'fit' | 'dpr' | 'gravity', string | number>>;

/** How long the edge keeps a sized private image, in seconds. */
export const EDGE_SECONDS = 3600;

/** The text a signature is made over: the API makes the same. */
export function signedMessage(projectId: string, preset: string, bucket: string, path: string, exp: number, version: string): string {
  return `s/${projectId}/${preset}/${bucket}/${path}\n${exp}\n${version}`;
}

/** A link is never good for longer than this from now (the API issues an
 *  hour), a minute's grace for clocks. */
export const MAX_LINK_SECONDS = 3600 + 60;

async function shortHash(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The signature for [message], as the API makes it. */
export const signatureFor = hmacHex;

/** Constant-time comparison of two hex strings. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const CORNERS: Record<string, { x: number; y: number }> = {
  'top-left': { x: 0, y: 0 },
  'top-right': { x: 1, y: 0 },
  'bottom-left': { x: 0, y: 1 },
  'bottom-right': { x: 1, y: 1 },
};

/** The preset's sizing as the Images binding takes it: dpr folded into the
 *  width and height, a corner gravity as a point. */
export function transformOf(opts: StoredOptions): ImageTransform {
  const dpr = typeof opts.dpr === 'number' && opts.dpr > 1 ? opts.dpr : 1;
  const t: ImageTransform = {};
  if (typeof opts.width === 'number') t.width = Math.round(opts.width * dpr);
  if (typeof opts.height === 'number') t.height = Math.round(opts.height * dpr);
  if (typeof opts.fit === 'string') t.fit = opts.fit as ImageTransform['fit'];
  if (typeof opts.gravity === 'string') {
    const corner = CORNERS[opts.gravity];
    t.gravity = corner ? { ...corner, mode: 'remainder' } : (opts.gravity as Exclude<ImageTransform['gravity'], object>);
  }
  return t;
}

/** The output format: the preset's; "auto" (or none) the best the browser
 *  takes -- AVIF, then WebP -- else the file's own when the binding writes
 *  it, else JPEG. */
export function formatOf(opts: StoredOptions, accept: string, original: string): ImageOutputOptions['format'] {
  const named: Record<string, ImageOutputOptions['format']> = { webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg', png: 'image/png' };
  if (typeof opts.format === 'string' && named[opts.format]) return named[opts.format];
  if (accept.includes('image/avif')) return 'image/avif';
  if (accept.includes('image/webp')) return 'image/webp';
  return original === 'image/png' || original === 'image/gif' ? (original as ImageOutputOptions['format']) : 'image/jpeg';
}

export type Refusal = { status: number; code: string; message: string };

export async function serveSigned(
  request: Request,
  env: SignedEnv,
  loadPreset: (projectId: string, preset: string) => Promise<StoredOptions | Refusal>,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response | Refusal> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/s\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return { status: 404, code: 'not_found', message: 'a signed preset address is /s/{project_id}/{preset}/{bucket}/{path}' };
  const [, projectId, preset, bucketEnc, pathEnc] = m;
  let bucket: string, path: string;
  try {
    bucket = decodeURIComponent(bucketEnc);
    path = pathEnc.split('/').map(decodeURIComponent).join('/');
  } catch {
    return { status: 400, code: 'invalid_path', message: 'the path is not validly encoded' };
  }
  const expRaw = url.searchParams.get('exp') ?? '';
  const version = url.searchParams.get('v') ?? '';
  const sig = (url.searchParams.get('sig') ?? '').toLowerCase();
  if (!env.PRESET_SIGNING_KEY) return { status: 503, code: 'not_configured', message: 'signed presets are not set up' };
  if (!/^\d{1,11}$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(sig) || version.length > 256) {
    return { status: 403, code: 'invalid_signature', message: 'this address is not signed' };
  }
  const exp = Number(expRaw);
  const want = await hmacHex(env.PRESET_SIGNING_KEY, signedMessage(projectId, preset, bucket, path, exp, version));
  if (!sameHex(want, sig)) return { status: 403, code: 'invalid_signature', message: 'this address is not signed' };
  if (exp < now) return { status: 403, code: 'expired', message: 'this address has expired; ask for a new one' };
  if (exp - now > MAX_LINK_SECONDS) return { status: 403, code: 'invalid_signature', message: 'this address is good for too long' };

  const opts = await loadPreset(projectId, preset);
  if ('status' in opts && 'code' in opts) return opts as Refusal;
  const stored = opts as StoredOptions;
  // A preset's sizing changed is a new copy, as on /p/.
  const optsHash = await shortHash(JSON.stringify(stored));

  const key = `${projectId}/${bucket}/${path}`;
  const accept = request.headers.get('accept') ?? '';
  // The edge copy: one per object, version, preset, its options and the
  // format the browser takes -- under a host no one can ask for, so it is
  // only ever reached through a checked signature.
  const cacheKey = new Request(
    `https://signed-preset-cache.invalid/${projectId}/${preset}/${bucketEnc}/${pathEnc}` +
      `?v=${encodeURIComponent(version)}&o=${optsHash}&f=${encodeURIComponent(formatOf(stored, accept, ''))}`,
  );
  const edge = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const ttl = Math.max(0, Math.min(EDGE_SECONDS, exp - now));
  const forClient = (res: Response) => {
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', `private, max-age=${ttl}`);
    return out;
  };
  const hit = await edge?.match(cacheKey);
  if (hit) return forClient(hit);

  const obj = (await env.PRIVATE_FILES.get(key)) ?? (await env.PUBLIC_FILES.get(key));
  if (!obj) return { status: 404, code: 'not_found', message: 'no such file' };
  const original = (obj.httpMetadata?.contentType ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!original.startsWith('image/') || original === 'image/svg+xml') {
    return { status: 415, code: 'not_an_image', message: 'presets size images' };
  }
  const t = transformOf(stored);
  let res: Response;
  if (Object.keys(t).length === 0 && stored.format === undefined && stored.quality === undefined) {
    res = new Response(obj.body, { headers: { 'Content-Type': original } });
  } else {
    try {
      const out = await env.IMAGES.input(obj.body)
        .transform(t)
        .output({ format: formatOf(stored, accept, original), ...(typeof stored.quality === 'number' ? { quality: stored.quality } : {}) });
      res = out.response();
    } catch {
      // Not an image the binding can read, whatever its type says.
      return { status: 415, code: 'not_an_image', message: 'this file could not be sized' };
    }
  }
  const keep = new Response(res.body, res);
  keep.headers.set('Cache-Control', `public, max-age=${EDGE_SECONDS}`);
  // Never anything but the image it says it is.
  keep.headers.set('X-Content-Type-Options', 'nosniff');
  keep.headers.set('Content-Security-Policy', "default-src 'none'");
  if (edge) await edge.put(cacheKey, keep.clone());
  return forClient(keep);
}
