/**
 * Single entry point. vercel.json rewrites every path here, so this routes the
 * OAuth endpoints and the MCP endpoint itself.
 *
 * The MCP transport runs stateless (no session id, JSON responses rather than a
 * long-lived SSE stream) because each request lands on its own serverless
 * invocation with nothing shared between them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  authenticate,
  authorizeGet,
  authorizePost,
  authorizationServerMetadata,
  protectedResourceMetadata,
  register,
  token,
  unauthorized
} from '../src/oauth.js';
import { buildServer } from '../src/tools.js';
import { signingSecret } from '../src/config.js';

type Req = IncomingMessage & { body?: unknown; headers: Record<string, string | string[] | undefined> };

/**
 * Vercel normally parses the request body, but that depends on the runtime and the
 * content type, and a body that silently arrives as undefined is indistinguishable
 * from a malformed request once it reaches /register or /token. Read it ourselves
 * whenever it is missing so those endpoints behave the same either way.
 */
async function ensureBody(req: Req): Promise<void> {
  if (req.body !== undefined) return;
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return;
  if (String(req.headers['content-type'] || '').includes('application/json')) {
    try {
      req.body = JSON.parse(raw);
    } catch {
      req.body = raw;
    }
  } else {
    req.body = raw;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function handleMcp(req: Req, res: ServerResponse): Promise<void> {
  const session = authenticate(req);
  if (!session) {
    unauthorized(req, res);
    return;
  }
  const server = buildServer(session);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/**
 * The path we were actually asked for. vercel.json passes it as __path because a
 * rewrite does not reliably leave the original path on req.url; the pathname is
 * the fallback for local runs and for any host without that rewrite.
 */
function requestPath(req: Req): string {
  const url = new URL(req.url || '/', 'https://placeholder.invalid');
  const forwarded = url.searchParams.get('__path');
  const raw = forwarded || url.pathname;
  return raw.replace(/\/+$/, '') || '/';
}

export default async function handler(req: Req, res: ServerResponse): Promise<void> {
  const path = requestPath(req);
  const method = (req.method || 'GET').toUpperCase();

  try {
    await ensureBody(req);

    // Discovery. Claude also probes the /mcp-suffixed variants of these.
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      protectedResourceMetadata(req, res);
      return;
    }
    if (
      path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/oauth-authorization-server/mcp' ||
      path === '/.well-known/openid-configuration'
    ) {
      authorizationServerMetadata(req, res);
      return;
    }

    if (path === '/register' && method === 'POST') {
      register(req, res);
      return;
    }
    if (path === '/authorize' && method === 'GET') {
      authorizeGet(req, res);
      return;
    }
    if (path === '/authorize' && method === 'POST') {
      await authorizePost(req, res);
      return;
    }
    if (path === '/token' && method === 'POST') {
      await token(req, res);
      return;
    }

    if (path === '/mcp') {
      await handleMcp(req, res);
      return;
    }

    // /api/index is the function's own filesystem route — reachable even if the
    // vercel.json rewrite is not in effect, which makes it the probe that tells a
    // live-but-misrouted server apart from one that never got built at all.
    if (path === '/' || path === '/health' || path === '/api/index') {
      // The signing secret is only reached at /register, so without this a
      // misconfigured deployment looks healthy right up until someone connects.
      let secret = true;
      let why = '';
      try {
        signingSecret();
      } catch (e) {
        secret = false;
        why = e instanceof Error ? e.message : String(e);
      }
      send(res, secret ? 200 : 500, {
        name: 'gym-tracker-mcp',
        status: secret ? 'ok' : 'misconfigured',
        signing_secret: secret ? 'set' : why,
        mcp_endpoint: '/mcp',
        rewrite: path === '/api/index' ? 'not applied — hit via the function route' : 'applied'
      });
      return;
    }

    send(res, 404, { error: 'not_found', path });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A missing signing secret is the one failure worth naming plainly in the response.
    send(res, 500, { error: 'server_error', error_description: message });
  }
}
