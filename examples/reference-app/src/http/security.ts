/**
 * Loopback-only transport security.
 *
 * "It only listens on localhost" is not authentication — any process or page
 * on the host, or any page open in the same browser, can otherwise reach it.
 * Independent checks apply to every request this app answers:
 *
 *   1. Host header must name this app's own loopback address AND its own
 *      bound port exactly. Checking only the hostname would let a request
 *      whose Host header names a *different* port — reachable through, say,
 *      a misconfigured proxy that forwards to this server regardless of the
 *      header it was sent — pass a check that never actually verified where
 *      the request thinks it landed.
 *   2. Origin header, when present, must equal `http://` + the Host header
 *      exactly. Rejects a cross-origin page's fetch even though the browser
 *      sent it to the right address.
 *   3. Every request this server answers — including the SSE stream, which
 *      carries prompt/output text — must carry a caller-chosen custom header.
 *      A cross-origin browser request cannot add one without our consent to
 *      a CORS preflight, which this server never grants (no
 *      `Access-Control-Allow-Origin` is ever sent). A same-site HTML form or
 *      plain navigation cannot add one either. This is the anti-CSRF control;
 *      loopback binding and Origin equality are necessary but not sufficient
 *      on their own.
 */

import type { ServerResponse } from 'node:http';

export const CSRF_HEADER_NAME = 'x-relvo-reference-app';
export const CSRF_HEADER_VALUE = '1';

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export type SecurityFailure = {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
};

export type SecurityCheck = { readonly ok: true } | SecurityFailure;

function fail(status: number, code: string, message: string): SecurityFailure {
  return { ok: false, status, code, message };
}

/** Splits a `Host` header into hostname and port, honouring an IPv6 literal. */
function splitHost(host: string): { readonly hostname: string; readonly port: string | undefined } {
  if (host.startsWith('[')) {
    const closing = host.indexOf(']');
    if (closing === -1) return { hostname: host, port: undefined };
    const hostname = host.slice(0, closing + 1);
    const rest = host.slice(closing + 1);
    return { hostname, port: rest.startsWith(':') ? rest.slice(1) : undefined };
  }
  const colon = host.lastIndexOf(':');
  if (colon === -1) return { hostname: host, port: undefined };
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

/**
 * `host` is the raw `Host` request header value, e.g. `127.0.0.1:4173`.
 * `expectedPort` is this server's own actual bound TCP port — read back from
 * `server.address()` after `listen()`, never assumed from configuration,
 * since `port: 0` picks an ephemeral one.
 */
export function checkHost(host: string | undefined, expectedPort: number): SecurityCheck {
  if (host === undefined || host.length === 0 || host.length > 255) {
    return fail(400, 'missing_host', 'a Host header is required');
  }
  const { hostname, port } = splitHost(host);
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return fail(400, 'non_loopback_host', 'this app only serves requests addressed to a loopback host');
  }
  // A `Host` header with no port implies the scheme's default (80 for HTTP).
  // This app never listens on 80 in practice, so an absent port is only ever
  // legitimate when the server itself is bound to 80.
  const impliedPort = port === undefined ? 80 : Number(port);
  if (!/^\d+$/u.test(port ?? '80') || impliedPort !== expectedPort) {
    return fail(400, 'wrong_port', 'the Host header does not name this server’s own bound port');
  }
  return { ok: true };
}

export function checkOrigin(origin: string | undefined, host: string | undefined): SecurityCheck {
  if (origin === undefined) return { ok: true }; // same-origin navigations and non-browser tools omit it
  if (origin !== `http://${host ?? ''}`) {
    return fail(403, 'cross_origin_rejected', 'cross-origin requests are rejected');
  }
  return { ok: true };
}

export function checkCsrfHeader(headerValue: string | string[] | undefined): SecurityCheck {
  if (headerValue !== CSRF_HEADER_VALUE) {
    return fail(403, 'missing_csrf_header', 'requests must carry the application’s own header');
  }
  return { ok: true };
}

/** Applies every check that is independent of HTTP method or route. */
export function checkTransport(headers: {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly csrf: string | string[] | undefined;
  readonly expectedPort: number;
  /** Static assets (the HTML/JS/CSS shell) are reachable by a plain navigation. */
  readonly requireCsrf: boolean;
}): SecurityCheck {
  const host = checkHost(headers.host, headers.expectedPort);
  if (!host.ok) return host;
  const origin = checkOrigin(headers.origin, headers.host);
  if (!origin.ok) return origin;
  if (headers.requireCsrf) {
    const csrf = checkCsrfHeader(headers.csrf);
    if (!csrf.ok) return csrf;
  }
  return { ok: true };
}

/**
 * Baseline response headers applied to every answer this server gives,
 * regardless of route or outcome: never cache a response that may carry
 * prompt/output/receipt data, never let a browser guess a different content
 * type for it, and never let this page be framed by another origin.
 */
export function applyBaselineHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'");
  // This app never sends CORS allow headers; no wildcard, no reflected Origin.
}
