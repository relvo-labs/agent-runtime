/**
 * Descriptor construction and capability gating.
 *
 * The point of a structured descriptor is that callers stop guessing. These
 * helpers make the guard explicit at the call site, so an unsupported operation
 * fails with `capability_unsupported` and a readable reason rather than by
 * doing something surprising.
 */

import {
  type ProviderDescriptor,
  type ProviderDescriptorInput,
  ProviderDescriptorSchema,
  WIRE_VERSION,
  agentError,
  type AgentError,
  type ApprovalMode,
} from '@relvo-labs/agent-protocol';

/**
 * Build a descriptor with conservative defaults.
 *
 * Every capability defaults to its least-capable value, so an adapter author
 * who forgets a field under-promises rather than over-promises. That asymmetry
 * is intentional: an unclaimed capability degrades UX, a falsely claimed one
 * produces a hang.
 */
export function defineProviderDescriptor(
  input: Omit<ProviderDescriptorInput, 'wireVersion'> & { readonly wireVersion?: string },
): ProviderDescriptor {
  // An adapter almost always targets the wire version it was compiled against,
  // so that is the default. Stating a different one is possible but explicit.
  return ProviderDescriptorSchema.parse({ ...input, wireVersion: input.wireVersion ?? WIRE_VERSION });
}

export type CapabilityCheck = { readonly ok: true } | { readonly ok: false; readonly error: AgentError };

const ok: CapabilityCheck = { ok: true };

function deny(message: string, details: Record<string, unknown>): CapabilityCheck {
  return { ok: false, error: agentError('capability_unsupported', message, { details }) };
}

export function canInterruptRun(descriptor: ProviderDescriptor): CapabilityCheck {
  if (descriptor.run.interrupt.mode === 'unsupported') {
    return deny(`provider \`${descriptor.providerId}\` cannot interrupt a run independently of the session`, {
      providerId: descriptor.providerId,
      capability: 'run.interrupt',
    });
  }
  return ok;
}

export function canRaiseApproval(descriptor: ProviderDescriptor, mode: ApprovalMode): CapabilityCheck {
  const approval = descriptor.interaction.approval;
  if (!approval.supported) {
    return deny(`provider \`${descriptor.providerId}\` does not support approvals`, {
      providerId: descriptor.providerId,
      capability: 'interaction.approval',
    });
  }
  if (!approval.modes.includes(mode)) {
    return deny(`provider \`${descriptor.providerId}\` does not support approval mode \`${mode}\``, {
      providerId: descriptor.providerId,
      capability: 'interaction.approval.modes',
      requested: mode,
      supported: approval.modes,
    });
  }
  return ok;
}

export function canAcceptWorkspace(descriptor: ProviderDescriptor, ownership: 'borrowed' | 'managed'): CapabilityCheck {
  if (descriptor.workspace.requires === 'none') return ok;
  if (!descriptor.workspace.acceptsOwnership.includes(ownership)) {
    return deny(`provider \`${descriptor.providerId}\` does not accept a \`${ownership}\` workspace`, {
      providerId: descriptor.providerId,
      capability: 'workspace.acceptsOwnership',
      requested: ownership,
      supported: descriptor.workspace.acceptsOwnership,
    });
  }
  return ok;
}

/**
 * Whether a run interrupt leaves the session usable.
 *
 * The runtime consults this to decide whether an interrupt must be escalated to
 * a session close — a limitation that a boolean `supportsInterrupt` could not
 * have expressed.
 */
export function interruptPreservesSession(descriptor: ProviderDescriptor): boolean {
  return descriptor.run.interrupt.mode !== 'unsupported' && descriptor.run.interrupt.sessionRemainsUsable;
}

/**
 * Compatibility between an adapter's wire version and the runtime's.
 *
 * Pre-1.0 the check is exact: `0.x` lines make no compatibility promise across
 * minors, so accepting a mismatch would be pretending otherwise.
 */
export function checkWireCompatibility(descriptor: ProviderDescriptor): CapabilityCheck {
  if (descriptor.wireVersion !== WIRE_VERSION) {
    return {
      ok: false,
      error: agentError(
        'provider_contract_violation',
        `provider \`${descriptor.providerId}\` targets wire version ${descriptor.wireVersion}, runtime speaks ${WIRE_VERSION}`,
        { details: { providerWireVersion: descriptor.wireVersion, runtimeWireVersion: WIRE_VERSION } },
      ),
    };
  }
  return ok;
}
