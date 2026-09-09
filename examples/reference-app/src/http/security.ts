/**
 * Loopback-only transport security.
 *
 * "It only listens on localhost" is not authentication — any process or page
 * on the host, or any page open in the same browser, can otherwise reach it.
 * Three independent checks apply to every request this app answers:
 *
 *   1. Host header must name this app's own loopback address. Rejects DNS
 *      rebinding: a public DNS name that resolves to 127.0.0.1 would still
 *      fail this check because its Host header does not match.
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

/** `host` is the raw `Host` request header value, e.g. `127.0.0.1:4173`. */
export function checkHost(host: string | undefined): SecurityCheck {
  if (host === undefined || host.length === 0) {
    return fail(400, 'missing_host', 'a Host header is required');
  }
  const hostname = host.startsWith('[') ? (host.match(/^\[[^\]]*\]/u)?.[0] ?? host) : (host.split(':')[0] ?? host);
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return fail(400, 'non_loopback_host', 'this app only serves requests addressed to a loopback host');
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
  /** Static assets (the HTML/JS/CSS shell) are reachable by a plain navigation. */
  readonly requireCsrf: boolean;
}): SecurityCheck {
  const host = checkHost(headers.host);
  if (!host.ok) return host;
  const origin = checkOrigin(headers.origin, headers.host);
  if (!origin.ok) return origin;
  if (headers.requireCsrf) {
    const csrf = checkCsrfHeader(headers.csrf);
    if (!csrf.ok) return csrf;
  }
  return { ok: true };
}
