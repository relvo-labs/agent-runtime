/**
 * Packed-artifact inspection.
 *
 * The release path never trusts the source tree for what will be published:
 * identity, dependency ranges and digests are all read back out of the packed
 * tarball that is actually going to be uploaded. The tar reader is in-process
 * and total — it either understands every byte of the archive or it throws —
 * so a crafted archive cannot be partially interpreted into an identity it
 * does not have.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export type PackedManifest = {
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly license: string | undefined;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalPeers: readonly string[];
  readonly publishAccess: string | undefined;
  readonly publishProvenance: boolean | undefined;
  readonly repositoryUrl: string | undefined;
};

export type PackedArtifact = {
  readonly fileName: string;
  readonly size: number;
  /** Transport integrity between the verify and publish jobs. */
  readonly sha256: string;
  /** What the registry records as `dist.integrity` for these exact bytes. */
  readonly integrity: string;
  /** What the registry records as `dist.shasum` for these exact bytes. */
  readonly shasum: string;
  readonly entries: readonly string[];
  readonly manifest: PackedManifest;
};

const BLOCK = 512;

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error('tar header has a malformed octal field');
  return Number.parseInt(text, 8);
}

/**
 * Verify the header checksum the way tar implementations do.
 *
 * npm's extractor (`node-tar`, via pacote) rejects a header whose checksum does
 * not match, and reports the archive as unrecognised. A reader that ignores the
 * field will happily describe an archive that npm refuses to read at all — so
 * the two would disagree about what is being published.
 */
function verifyChecksum(header: Buffer): void {
  const declared = readString(header, 148, 8).trim().replace(/\0.*$/u, '');
  if (!/^[0-7]+$/u.test(declared)) throw new Error('tar header has a malformed checksum field');
  let signed = 0;
  let unsigned = 0;
  for (const [index, byte] of header.entries()) {
    const value = index >= 148 && index < 156 ? 0x20 : byte;
    unsigned += value;
    signed += value > 0x7f ? value - 0x100 : value;
  }
  const expected = Number.parseInt(declared, 8);
  if (expected !== unsigned && expected !== signed) {
    throw new Error(`tar header checksum ${declared} does not match its contents`);
  }
}

/**
 * Normalize an entry path the way an extractor does before it decides which
 * file a name refers to.
 *
 * This is where "what we validated" and "what npm installs" can silently
 * diverge: `package/./package.json` and `package/package.json` are the same
 * destination after normalization, so an archive carrying both has two
 * manifests for one path and npm reads the later one. Everything below is
 * therefore normalized first and any resulting collision is refused outright —
 * deliberately stricter than an extractor, which would simply let the last
 * entry win.
 */
export function normalizeEntryPath(raw: string): string {
  if (raw.includes('\0')) throw new Error('tar entry name contains a NUL byte');
  if (raw.includes('\\')) throw new Error(`tar entry \`${raw}\` uses a backslash separator`);
  if (raw.startsWith('/')) throw new Error(`tar entry \`${raw}\` is an absolute path`);
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue; // `a//b` and `a/./b` collapse
    if (segment === '..') throw new Error(`tar entry \`${raw}\` escapes the archive root`);
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error(`tar entry \`${raw}\` normalizes to an empty path`);
  return segments.join('/');
}

/**
 * Decode a tar archive into `path -> contents`, keyed by normalized path.
 *
 * Total by construction: every byte is accounted for, or it throws. Anything an
 * extractor would treat as special — links, devices, sparse files, global pax
 * headers, unknown vendor types — is refused rather than skipped, because a
 * skipped entry is an entry this repository did not review but a consumer may
 * still receive.
 */
export function readTarEntries(tar: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  let pendingPath: string | undefined;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      // End-of-archive marker. Everything after it must also be zero padding;
      // appended data is a second archive an extractor might read differently.
      const trailing = tar.subarray(offset);
      if (!trailing.every((byte) => byte === 0)) {
        throw new Error('tar archive carries data after its end-of-archive marker');
      }
      return entries;
    }
    verifyChecksum(header);
    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeFlag = readString(header, 156, 1);
    const prefix = readString(header, 345, 155);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`tar entry \`${name}\` claims ${size} bytes past the end of the archive`);
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeFlag === 'x') {
      // pax extended header, applying to the next entry only. Only `path` is
      // honoured; every other override — notably `size`, which would move the
      // next entry's data boundary and therefore desynchronise this reader from
      // an extractor that does honour it — is refused rather than ignored.
      for (const record of data.toString('utf8').split('\n')) {
        if (record === '') continue;
        const match = /^\d+ ([^=]+)=(.*)$/u.exec(record);
        if (match?.[1] === undefined) throw new Error(`tar pax header has an unparseable record \`${record}\``);
        const key = match[1];
        if (key === 'path') pendingPath = match[2] ?? '';
        else if (key !== 'mtime' && key !== 'atime' && key !== 'ctime' && key !== 'comment') {
          throw new Error(`tar pax header sets unsupported key \`${key}\``);
        }
      }
      continue;
    }
    if (typeFlag === 'g') throw new Error('tar archive uses a global pax header');
    if (typeFlag === 'L') {
      pendingPath = data.toString('utf8').replace(/\0+$/u, '');
      continue;
    }

    const rawPath = pendingPath ?? (prefix === '' ? name : `${prefix}/${name}`);
    pendingPath = undefined;
    const path = normalizeEntryPath(rawPath);
    if (typeFlag === '5') continue; // directory
    if (typeFlag !== '0' && typeFlag !== '') {
      throw new Error(`tar entry \`${path}\` has unsupported type flag \`${typeFlag}\``);
    }
    if (entries.has(path)) {
      throw new Error(`tar archive resolves \`${path}\` more than once; an extractor would keep only one of them`);
    }
    entries.set(path, Buffer.from(data));
  }
  if (pendingPath !== undefined) throw new Error('tar archive ends with a dangling extended header');
  throw new Error('tar archive has no end-of-archive marker');
}

function readStringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`packed manifest has a malformed ${label} block`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`packed manifest has a non-string range in ${label}`);
    out[key] = entry;
  }
  return out;
}

export function parsePackedManifest(document: unknown): PackedManifest {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('packed manifest is not an object');
  }
  const record = document as Record<string, unknown>;
  const name = record.name;
  const version = record.version;
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error('packed manifest has no string name/version');
  }
  const publishConfig = record.publishConfig;
  const publish =
    typeof publishConfig === 'object' && publishConfig !== null && !Array.isArray(publishConfig)
      ? (publishConfig as Record<string, unknown>)
      : {};
  const repository = record.repository;
  const repositoryUrl =
    typeof repository === 'object' && repository !== null && !Array.isArray(repository)
      ? (repository as Record<string, unknown>).url
      : repository;
  const peerMeta = record.peerDependenciesMeta;
  const optionalPeers: string[] = [];
  if (typeof peerMeta === 'object' && peerMeta !== null && !Array.isArray(peerMeta)) {
    for (const [peer, meta] of Object.entries(peerMeta as Record<string, unknown>)) {
      if (typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).optional === true) {
        optionalPeers.push(peer);
      }
    }
  }

  return {
    name,
    version,
    private: record.private === true,
    license: typeof record.license === 'string' ? record.license : undefined,
    dependencies: readStringMap(record.dependencies, 'dependencies'),
    peerDependencies: readStringMap(record.peerDependencies, 'peerDependencies'),
    optionalPeers: optionalPeers.sort(),
    publishAccess: typeof publish.access === 'string' ? publish.access : undefined,
    publishProvenance: typeof publish.provenance === 'boolean' ? publish.provenance : undefined,
    repositoryUrl: typeof repositoryUrl === 'string' ? repositoryUrl : undefined,
  };
}

export function digestBytes(bytes: Buffer): { sha256: string; integrity: string; shasum: string } {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

/** Inspect one packed tarball. Throws with a precise reason if it cannot be read. */
export function inspectTarball(fileName: string, gzipped: Buffer): PackedArtifact {
  const entries = readTarEntries(gunzipSync(gzipped));
  // An npm tarball is exactly one `package/` tree. An entry outside it is
  // content this repository never reviewed and npm never installs, so its
  // presence means the archive is not the artifact that was packed.
  for (const path of entries.keys()) {
    if (!path.startsWith('package/')) throw new Error(`${fileName} contains \`${path}\` outside the package/ tree`);
  }
  const manifestEntry = entries.get('package/package.json');
  if (manifestEntry === undefined) throw new Error(`${fileName} does not contain package/package.json`);
  let document: unknown;
  try {
    document = JSON.parse(manifestEntry.toString('utf8'));
  } catch {
    throw new Error(`${fileName} contains a package.json that is not JSON`);
  }
  return {
    fileName,
    size: gzipped.byteLength,
    ...digestBytes(gzipped),
    entries: [...entries.keys()].sort(),
    manifest: parsePackedManifest(document),
  };
}

export function tarballFileName(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;
}
