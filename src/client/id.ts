export function createOperationId(prefix = "op"): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random !== undefined) {
    return `${prefix}_${random}`;
  }

  const time = Date.now().toString(36);
  const entropy = Math.random().toString(36).slice(2, 12);
  return `${prefix}_${time}_${entropy}`;
}
