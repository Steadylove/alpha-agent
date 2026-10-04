/** One provider/job owns one gate; cache hits do not use a request slot. */
export function createFundamentalRequestGate(intervalMs = 1000) {
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000)
    throw new Error("Invalid fundamental request interval");
  let tail = Promise.resolve();
  let lastStart: number | null = null;
  return (beforeStart: () => void): Promise<void> => {
    const slot = tail.then(async () => {
      const remaining = lastStart === null ? 0 : Math.min(intervalMs, Math.max(0, intervalMs - (Date.now() - lastStart)));
      if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, remaining));
      // A queued request must respect a circuit breaker that changed while it waited.
      beforeStart();
      lastStart = Date.now();
    });
    tail = slot.catch(() => undefined);
    return slot;
  };
}
