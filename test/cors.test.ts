// The preset route's responses carry CORS (#146): a browser that fetches
// images -- Flutter on the web, the Koolbase Designer's canvas -- refused a
// preset image that the original route served fine, because cf.image's
// transformed response came back without Access-Control-Allow-Origin.
//   npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { type Env } from '../src/worker';

const PROJECT = '4a421008-6543-42fd-81f5-89c59be859bf';
const env = {
  PRESETS: {
    get: async (key: string) => (key === `preset:${PROJECT}:card` ? JSON.stringify({ width: 400, fit: 'cover' }) : key === `preset:${PROJECT}:raw` ? '{}' : null),
  },
} as unknown as Env;

// The upstream as the zone answers it: an image whose headers cannot be
// changed (a fetched Response's are immutable) and carry no CORS.
const upstream: { url: string; cf?: unknown }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit & { cf?: unknown }) => {
  upstream.push({ url: String(input), cf: init?.cf });
  const r = new Response('jpeg-bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } });
  Object.freeze(r.headers);
  return r;
}) as typeof fetch;

const get = (path: string, method = 'GET') =>
  worker.fetch(new Request(`https://cdn.koolbase.com${path}`, { method, headers: { Origin: 'https://designer.koolbase.com' } }), env);

test('a preset image: transformed, readable from any page', async () => {
  upstream.length = 0;
  const res = await get(`/p/${PROJECT}/card/posters/concert-neon-night.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('content-type'), 'image/jpeg', 'the image\'s own headers kept');
  assert.equal(await res.text(), 'jpeg-bytes');
  assert.deepEqual(upstream, [{ url: `https://cdn.koolbase.com/${PROJECT}/posters/concert-neon-night.png`, cf: { image: { width: 400, fit: 'cover' } } }]);
});

test('an empty preset passes the original through, readable too', async () => {
  const res = await get(`/p/${PROJECT}/raw/posters/a.png`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('errors are readable, so a page can say why', async () => {
  for (const [path, status] of [[`/p/${PROJECT}/missing/posters/a.png`, 404], ['/p/not-a-uuid/card/posters/a.png', 400], ['/p/x', 404]] as const) {
    const res = await get(path);
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', path);
  }
});

test('a preflight is answered without a lookup', async () => {
  upstream.length = 0;
  const res = await get(`/p/${PROJECT}/card/posters/a.png`, 'OPTIONS');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /GET/);
  assert.equal(upstream.length, 0);
});
