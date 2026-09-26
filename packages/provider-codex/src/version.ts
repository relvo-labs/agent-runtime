/**
 * Supported *published stable* Codex app-server versions. This finite window
 * is intentionally not `^0.153`: prereleases and newly published/untested
 * versions inside a numeric interval do not inherit compatibility by accident.
 * The host supplies the CLI; the adapter does not install it.
 */
export const CODEX_SUPPORTED_APP_SERVER_VERSIONS = [
  '0.153.4',
  '0.154.0',
  '0.155.0',
  '0.155.1',
  '0.156.0',
  '0.156.1',
] as const;

/**
 * Real app-server initialize responses observed on the boundary releases use
 * `<clientInfo.name>/<serverVersion> (`. The stable schema promises only a
 * string, not its grammar, so an unrecognised format is an unsupported host
 * rather than permission to start a thread. A custom injected transport must
 * either implement the same handshake or use a separately reviewed binding.
 */
export function isCompatibleCodexUserAgent(value: unknown, clientName: string): boolean {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith(`${clientName}/`)) return false;
  const rest = value.slice(clientName.length + 1);
  const separator = rest.indexOf(' (');
  if (separator < 0) return false;
  return (CODEX_SUPPORTED_APP_SERVER_VERSIONS as readonly string[]).includes(rest.slice(0, separator));
}
