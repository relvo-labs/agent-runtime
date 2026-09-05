# `@relvo-labs/agent-runtime`

Provider-neutral composition root with mutation-isolated in-memory storage, scoped command idempotency, memoized shutdown, exactly-once terminal settlement, atomic event projection, and bounded replay-then-live subscriptions. Unstarted subscriptions retain only a sequence high-water mark; event bodies remain in durable storage until replay begins, and late terminal subscribers close after replay.
