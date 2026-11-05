// Vercel serverless function: proxies Resources.zip from GitHub release
// adding CORS headers so the browser on noggd.vercel.app can fetch it.
export const config = { runtime: 'edge' };

const UPSTREAM = 'https://github.com/nagatesz/nogGD/releases/download/resources-v1/Resources.zip';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  const upstream = await fetch(UPSTREAM, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: { 'User-Agent': 'nogGD-proxy/1' },
    redirect: 'follow',
  });

  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Content-Type', 'application/zip');
  const cl = upstream.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(req.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}
