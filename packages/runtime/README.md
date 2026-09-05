# `@relvo-labs/agent-runtime`

Provider-neutral composition root with deterministic in-memory storage, command idempotency, lifecycle enforcement, atomic event projection, and bounded replay-then-live subscriptions. Unstarted subscriptions retain only a sequence high-water mark; event bodies remain in durable storage until replay begins.
