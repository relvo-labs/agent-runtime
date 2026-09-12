import { describe, expect, it } from 'vitest';
import { confirmationPhrase, parseReleaseRequest, type DispatchInputs } from './lib/plan.ts';

const SHA = 'a'.repeat(40);

function inputs(overrides: Partial<DispatchInputs> = {}): DispatchInputs {
  const base = {
    sourceSha: SHA,
    packages: '@relvo-labs/agent-protocol@0.2.0 @relvo-labs/agent-runtime@0.2.0',
    distTag: 'latest',
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    confirm:
      overrides.confirm ??
      confirmationPhrase({
        count: merged.packages.split(/[\s,]+/u).filter((entry) => entry !== '').length,
        sourceSha: merged.sourceSha,
        distTag: merged.distTag,
      }),
  };
}

function codes(raw: DispatchInputs): readonly string[] {
  const result = parseReleaseRequest(raw);
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

describe('release dispatch inputs', () => {
  it('accepts a fully stated scope and preserves it verbatim', () => {
    const result = parseReleaseRequest(inputs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.targets).toEqual([
      { name: '@relvo-labs/agent-protocol', version: '0.2.0' },
      { name: '@relvo-labs/agent-runtime', version: '0.2.0' },
    ]);
    expect(result.request.distTag).toBe('latest');
    expect(result.request.sourceSha).toBe(SHA);
  });

  it('refuses anything but one full lowercase commit id', () => {
    for (const sourceSha of ['a'.repeat(39), 'A'.repeat(40), 'main', 'refs/heads/main', '', `${SHA} `.repeat(2)]) {
      expect(codes(inputs({ sourceSha }))).toContain('dispatch_source_sha');
    }
  });

  it('refuses a version that is a range, a tag or absent', () => {
    for (const packages of [
      '@relvo-labs/agent-protocol@^0.2.0',
      '@relvo-labs/agent-protocol@latest',
      '@relvo-labs/agent-protocol@0.2',
      '@relvo-labs/agent-protocol@0.2.0+build.1',
      '@relvo-labs/agent-protocol',
    ]) {
      expect(codes(inputs({ packages }))).toContain('dispatch_scope_entry');
    }
  });

  it('refuses a package outside this repository scope', () => {
    for (const packages of ['@evil/agent-protocol@0.2.0', 'agent-protocol@0.2.0', '@relvo-labs/Agent-Protocol@0.2.0']) {
      expect(codes(inputs({ packages }))).toContain('dispatch_scope_entry');
    }
  });

  it('refuses an empty, duplicated or oversized scope', () => {
    expect(codes(inputs({ packages: '   ' }))).toContain('dispatch_scope_empty');
    expect(codes(inputs({ packages: '@relvo-labs/agent-protocol@0.2.0 @relvo-labs/agent-protocol@0.2.0' }))).toContain(
      'dispatch_scope_duplicate',
    );
    const many = Array.from({ length: 17 }, (_, index) => `@relvo-labs/agent-p${String(index)}@0.2.0`).join(' ');
    expect(codes(inputs({ packages: many }))).toContain('dispatch_scope_size');
  });

  it('accepts commas as well as spaces between scope entries', () => {
    const result = parseReleaseRequest(
      inputs({ packages: '@relvo-labs/agent-protocol@0.2.0,@relvo-labs/agent-runtime@0.2.0' }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses an unsafe dist-tag', () => {
    for (const distTag of ['Latest', '1.0.0', 'next tag', '', '-next', 'x'.repeat(40)]) {
      expect(codes(inputs({ distTag }))).toContain('dispatch_dist_tag');
    }
  });

  it('refuses a prerelease under latest but allows it under its own tag', () => {
    expect(codes(inputs({ packages: '@relvo-labs/agent-protocol@0.2.0-rc.1', distTag: 'latest' }))).toContain(
      'dispatch_dist_tag_prerelease',
    );
    expect(codes(inputs({ packages: '@relvo-labs/agent-protocol@0.2.0-rc.1', distTag: 'next' }))).toEqual([]);
  });

  it('requires the confirmation to restate the count, the commit and the tag', () => {
    expect(codes(inputs({ confirm: 'yes' }))).toContain('dispatch_confirmation');
    expect(codes(inputs({ confirm: confirmationPhrase({ count: 1, sourceSha: SHA, distTag: 'latest' }) }))).toContain(
      'dispatch_confirmation',
    );
    expect(
      codes(inputs({ confirm: confirmationPhrase({ count: 2, sourceSha: 'b'.repeat(40), distTag: 'latest' }) })),
    ).toContain('dispatch_confirmation');
    expect(codes(inputs({ confirm: confirmationPhrase({ count: 2, sourceSha: SHA, distTag: 'next' }) }))).toContain(
      'dispatch_confirmation',
    );
  });

  /**
   * Regressions for literal inputs.
   *
   * These fields are documented as exact and the confirmation phrase is
   * documented as a literal restatement of them. An independent review wrapped
   * each of them in a leading space and a trailing newline and the dispatch was
   * still accepted — with the *normalised* value in the parsed request, not the
   * one that was typed. Nothing here changed which package or version was
   * selected, but "retype this exactly" stops meaning anything the moment
   * something else is quietly accepted in its place.
   *
   * The scope list keeps its deliberately supported separators; that is the one
   * documented exception and it is asserted above.
   */
  describe('exactness of the values the operator types', () => {
    const decorate = (value: string): string => ` ${value}\n`;

    it('refuses a source SHA that is only valid after trimming', () => {
      for (const sourceSha of [decorate(SHA), `${SHA}\n`, ` ${SHA}`, `\t${SHA}`]) {
        expect(codes({ ...inputs(), sourceSha })).toContain('dispatch_source_sha');
      }
    });

    it('refuses a dist-tag that is only valid after trimming', () => {
      for (const distTag of [decorate('latest'), 'latest\n', ' latest']) {
        expect(codes({ ...inputs(), distTag })).toContain('dispatch_dist_tag');
      }
    });

    it('compares the confirmation literally, with no normalisation at all', () => {
      const base = inputs();
      for (const confirm of [decorate(base.confirm), `${base.confirm}\n`, ` ${base.confirm}`, `${base.confirm} `]) {
        expect(codes({ ...base, confirm })).toContain('dispatch_confirmation');
      }
    });

    it('keeps the accepted request identical to what was typed', () => {
      const result = parseReleaseRequest(inputs());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.request.sourceSha).toBe(SHA);
      expect(result.request.distTag).toBe('latest');
    });
  });

  it('does not let a stale confirmation survive a changed scope', () => {
    const stale = confirmationPhrase({ count: 2, sourceSha: SHA, distTag: 'latest' });
    const widened = inputs({
      packages: '@relvo-labs/agent-protocol@0.2.0 @relvo-labs/agent-runtime@0.2.0 @relvo-labs/agent-provider@0.2.0',
      confirm: stale,
    });
    expect(codes(widened)).toContain('dispatch_confirmation');
  });
});
