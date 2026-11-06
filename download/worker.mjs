const version = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const stablePrefix = new RegExp(`^releases/${version}/$`);
const stagingPrefix = new RegExp(`^staging/releases/${version}/[a-f0-9]{40}/[1-9]\\d*-[1-9]\\d*/$`);
const fileName = /^[A-Za-z0-9][A-Za-z0-9_+.-]*\.(?:zip|msi|sha256|deb|rpm|flatpak|yml|json)$/;

export function validatePointer(pointer, channel) {
  if (pointer?.schema_version !== 1 || pointer.channel !== channel ||
      !/^[a-f0-9]{64}$/.test(pointer.candidate_sha256) ||
      !/^[a-f0-9]{40}$/.test(pointer.source_sha) ||
      !new RegExp(`^${version}$`).test(pointer.version) ||
      !(channel === 'stable' ? stablePrefix : stagingPrefix).test(pointer.prefix) ||
      !pointer.prefix.startsWith(channel === 'stable' ? `releases/${pointer.version}/` : `staging/releases/${pointer.version}/${pointer.source_sha}/`) ||
      !Array.isArray(pointer.platforms) || pointer.platforms.some(platform => !['linux', 'macos', 'windows'].includes(platform))) {
    throw new Error('Invalid release pointer');
  }
  return pointer;
}

function failure(status, staging = false) {
  return new Response(status === 404 ? 'Not found' : 'Download temporarily unavailable', {
    status, headers: { 'Cache-Control': 'no-store', 'X-Shhield-Distribution': 'r2', ...(staging ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const staging = url.pathname.startsWith('/staging/');
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store', ...(staging ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) } });
    if (url.search || /%|\\|\/\//.test(url.pathname)) return failure(404, staging);
    if (url.pathname === '/staging/healthz') return new Response(request.method === 'HEAD' ? null : '{"status":"ok","channel":"staging"}\n', {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Shhield-Distribution': 'r2' },
    });
    const active = /^\/(stable|staging)\/(update\.json|latest\.json|latest-mac\.yml)$/.exec(url.pathname);
    let key;
    try {
      if (active) {
        // Binding reads bypass CDN caches; no stale pointer or manifest may authorize installation.
        const stored = await env.RELEASES.get(`_channels/${active[1]}.json`);
        if (!stored) return failure(503, staging);
        if (stored.size > 16384) return failure(503, staging);
        const pointer = validatePointer(await stored.json(), active[1]);
        const name = active[1] === 'staging' && active[2] === 'latest.json' ? 'update.json' : active[2];
        key = pointer.prefix + name;
      } else {
        const split = url.pathname.lastIndexOf('/');
        const prefix = url.pathname.slice(1, split + 1);
        const name = url.pathname.slice(split + 1);
        if (!(stablePrefix.test(prefix) || stagingPrefix.test(prefix)) || !fileName.test(name) || name === 'candidate.json') return failure(404, staging);
        key = prefix + name;
      }
      const object = request.method === 'HEAD' ? await env.RELEASES.head(key) : await env.RELEASES.get(key);
      if (!object) return failure(active ? 503 : 404, staging);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('Content-Length', String(object.size));
      headers.set('ETag', object.httpEtag);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Shhield-Distribution', 'r2');
      headers.set('Cache-Control', active || staging || key.endsWith('.json') || key.endsWith('.yml') ? 'no-store' : 'public, max-age=31536000, immutable');
      if (staging) headers.set('X-Robots-Tag', 'noindex, nofollow');
      // The first client version restarts partial transfers; a Range request receives the full object.
      return new Response(request.method === 'HEAD' ? null : object.body, { headers });
    } catch {
      return failure(503, staging);
    }
  },
};
