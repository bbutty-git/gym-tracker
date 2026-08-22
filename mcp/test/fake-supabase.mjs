// Minimal stand-in for the Supabase endpoints this server uses, so the OAuth flow
// and the tools can be driven end to end without real credentials.
import { createServer } from 'node:http';

export const USER_ID = '11111111-2222-3333-4444-555555555555';
const GOOD = { email: 'ben@gymtracker.app', password: 'correct-horse' };

export function startFakeSupabase(seedState) {
  let state = structuredClone(seedState);
  let refreshCounter = 0;
  const issued = new Set(['seed-refresh']);

  const session = () => {
    const rt = `refresh-${++refreshCounter}`;
    issued.add(rt);
    return {
      access_token: `sb-access-${refreshCounter}`,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: rt,
      user: { id: USER_ID, email: GOOD.email, aud: 'authenticated', role: 'authenticated' }
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, obj) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        if (body.email === GOOD.email && body.password === GOOD.password) return send(200, session());
        return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      if (grant === 'refresh_token') {
        if (issued.has(body.refresh_token)) return send(200, session());
        return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/rest/v1/gym_state') {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer sb-access-')) return send(401, { message: 'JWT required' });
      if (req.method === 'GET') {
        const wantObject = String(req.headers.accept || '').includes('pgrst.object');
        const row = { data: state };
        return send(200, wantObject ? row : [row]);
      }
      if (req.method === 'POST') {
        state = body.data ?? (Array.isArray(body) ? body[0].data : state);
        res.statusCode = 201;
        return res.end('');
      }
    }
    send(404, { message: 'not found', path: url.pathname });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
        current: () => state,
        credentials: GOOD
      });
    });
  });
}
