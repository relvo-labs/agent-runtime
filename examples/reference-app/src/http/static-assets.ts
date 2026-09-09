/**
 * The browser shell.
 *
 * Served from a fixed allowlist of exact pathnames, each mapped to a file this
 * module names itself — never by joining a request path onto a directory.
 * There is therefore no path-traversal surface here to get wrong.
 */

import { readFile } from 'node:fs/promises';

const publicDirectory = new URL('../../public/', import.meta.url);

type StaticAsset = {
  readonly file: string;
  readonly contentType: string;
};

const ASSETS: ReadonlyMap<string, StaticAsset> = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
]);

export function isStaticAssetPath(pathname: string): boolean {
  return ASSETS.has(pathname);
}

export async function readStaticAsset(
  pathname: string,
): Promise<{ readonly body: string; readonly contentType: string } | undefined> {
  const asset = ASSETS.get(pathname);
  if (asset === undefined) return undefined;
  const body = await readFile(new URL(asset.file, publicDirectory), 'utf8');
  return { body, contentType: asset.contentType };
}
