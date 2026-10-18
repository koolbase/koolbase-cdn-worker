// Presets for private buckets (#146): /s/... signed by the API, checked
// here before anything is read; sized by the Images binding; kept at the
// edge by object, preset and format -- never by signature.
//   npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { type Env } from '../src/worker';
import { signatureFor, signedMessage, EDGE_SECONDS } from '../src/signed';

const VECTOR = 'de12cfbbed713a9fad89aa297bf5b816139e8e096285c4868459daf2c4819475';

const PROJECT = '4a421008-6543-42fd-81f5-89c59be859bf';
const KEY = 'test-signing-key';
const NOW = Math.floor(Date.now() / 1000);

const reads: string[] = [];
const sized: { transform: unknown; output: unknown }[] = [];
const store = (files: Record<string, string>) =>
  ({
    get: async (k: string) => {
      reads.push(k);
      const type = files[k];
      return type === undefined ? null : { body: new Response('bytes-of-' + k).body, httpMetadata: { contentType: type } };
    },
  }) as unknown as R2Bucket;

const edge = new Map<string, Response>();
(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    match: async (r: Request) => edge.get(r.url)?.clone(),
    put: async (r: Request, res: Response) => void edge.set(r.url, res),
  },
};

const env = {
  PRESET_SIGNING_KEY: KEY,
  PRESETS: { get: async (k: string) => (k === `preset:${PROJECT}:card` ? JSON.stringify({ width: 400, dpr: 2, fit: 'cover', gravity: 'top-left' }) : null) },
  PRIVATE_FILES: store({ [`${PROJECT}/vault/neon night #1.png`]: 'image/png', [`${PROJECT}/vault/notes.txt`]: 'text/plain' }),
  PUBLIC_FILES: store({ [`${PROJECT}/vault/moving.png`]: 'image/png' }),
  IMAGES: {
    input: () => {
      const job: { transform: unknown; output: unknown } = { transform: null, output: null };
      const t = {
        transform: (x: unknown) => ((job.transform = x), t),
        output: async (o: unknown) => {
          job.output = o;
          sized.push(job);
          return { response: () => new Response('sized', { headers: { 'Content-Type': (o as { format: string }).format } }) };
        },
      };
      return t;
    },
  },
} as unknown as Env;

async function address(path: string, { exp = NOW + 3600, preset = 'card', signPath = path, v = 'etag-1' } = {}) {
  const sig = await signatureFor(KEY, signedMessage(PROJECT, preset, 'vault', signPath, exp, v));
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return `https://cdn.koolbase.com/s/${PROJECT}/${preset}/vault/${enc}?exp=${exp}&v=${v}&sig=${sig}`;
}
const get = (url: string, accept = 'image/avif,image/webp,*/*') => worker.fetch(new Request(url, { headers: { Accept: accept } }), env);

test('a signed address: the file, sized as the preset says, readable from any page', async () => {
  reads.length = 0; sized.length = 0; edge.clear();
  const res = await get(await address('neon night #1.png'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'sized');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('cache-control') ?? '', /^private, max-age=(\d+)$/);
  assert.ok(Number(/max-age=(\d+)/.exec(res.headers.get('cache-control')!)![1]) <= EDGE_SECONDS);
  assert.deepEqual(reads, [`${PROJECT}/vault/neon night #1.png`], 'the private store, the path decoded');
  assert.deepEqual(sized[0].transform, { width: 800, fit: 'cover', gravity: { x: 0, y: 0, mode: 'remainder' } }, 'dpr 2 folded in; a corner as a point');
  assert.deepEqual(sized[0].output, { format: 'image/avif' });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok([...edge.keys()].every((k) => k.startsWith('https://signed-preset-cache.invalid/')), 'kept where no one can ask for it');
});

test('a file replaced is a new copy, never the old one', async () => {
  reads.length = 0;
  const res = await get(await address('neon night #1.png', { v: 'etag-2' }));
  assert.equal(res.status, 200);
  assert.deepEqual(reads, [`${PROJECT}/vault/neon night #1.png`], 'read again for its new version');
});

test('the second asking is the edge copy, whatever its signature', async () => {
  reads.length = 0;
  const res = await get(await address('neon night #1.png', { exp: NOW + 1800 }));
  assert.equal(res.status, 200);
  assert.deepEqual(reads, [], 'not read again');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=1800', 'never past the link');
});

test('refused before anything is read: no signature, a wrong one, another file, expired', async () => {
  reads.length = 0;
  const good = await address('neon night #1.png');
  const cases: [string, number, string][] = [
    [good.replace(/&sig=.*/, ''), 403, 'invalid_signature'],
    [good.replace(/sig=./, 'sig=0'), 403, 'invalid_signature'],
    [await address('other.png', { signPath: 'neon night #1.png' }), 403, 'invalid_signature'],
    [good.replace('/card/', '/hero/'), 403, 'invalid_signature'],
    [await address('neon night #1.png', { exp: NOW - 5 }), 403, 'expired'],
    [good.replace('v=etag-1', 'v=etag-0'), 403, 'invalid_signature'],
    [await address('neon night #1.png', { exp: NOW + 7 * 24 * 3600 }), 403, 'invalid_signature'],
    [good.replace(/exp=(\d+)/, 'exp=0x1'), 403, 'invalid_signature'],
  ];
  for (const [url, status, code] of cases) {
    const res = await get(url);
    assert.equal(res.status, status, url);
    assert.equal(((await res.json()) as { code: string }).code, code, url);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }
  assert.deepEqual(reads, []);
});

test('a file still in the public store; no file; not an image; a preflight', async () => {
  edge.clear();
  assert.equal((await get(await address('moving.png'))).status, 200);
  assert.equal((await get(await address('gone.png'))).status, 404);
  assert.equal((await get(await address('notes.txt'))).status, 415);
  const pre = await worker.fetch(new Request(await address('moving.png'), { method: 'OPTIONS' }), env);
  assert.equal(pre.status, 204);
});

test('the format follows the browser when the preset says none', async () => {
  edge.clear(); sized.length = 0;
  await get(await address('neon night #1.png'), 'image/webp,*/*');
  await get(await address('moving.png'), '*/*');
  assert.deepEqual(sized.map((s) => (s.output as { format: string }).format), ['image/webp', 'image/png']);
});

test('not set up: said, never served unsigned', async () => {
  const res = await worker.fetch(new Request(await address('neon night #1.png')), { ...env, PRESET_SIGNING_KEY: '' } as Env);
  assert.equal(res.status, 503);
});

test('the signature the API makes (a shared vector: internal/storage/signed_preset_test.go)', async () => {
  const m = signedMessage('4a421008-6543-42fd-81f5-89c59be859bf', 'card', 'vault', 'neon night #1.png', 1760000000, 'etag-1');
  assert.equal(m, 's/4a421008-6543-42fd-81f5-89c59be859bf/card/vault/neon night #1.png\n1760000000\netag-1');
  assert.equal(await signatureFor('test-signing-key', m), VECTOR);
});
