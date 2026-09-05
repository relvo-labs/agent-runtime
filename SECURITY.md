# Security policy

This foundation is pre-1.0 and has not been published. Report suspected vulnerabilities privately through GitHub's security-advisory flow for `relvo-labs/agent-runtime`; do not include credentials, customer data, or exploit secrets in a public issue.

The runtime is an orchestration library, not a sandbox. In-process provider adapters execute with the host process's privileges. Capability and approval descriptors communicate provider-declared behavior to the host UI; they do not enforce filesystem, process, or network isolation.

No package owns provider credentials. Workspace-Git uses an injected command runner and never discovers tokens, SSH agents, keychains, or configuration. Existing workspaces are borrowed and must never be deleted, reset, cleaned, stashed, checked out, or otherwise destructively mutated by workspace lifecycle code.

The local/CI gate is credential-free. Dependency lifecycle scripts are denied by default, direct versions are exact, a strict three-day pnpm release-age window applies, and packed artifacts—not source-tree imports—are the publication boundary under test.
