export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, baseDelayMs = 5000 } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRetryable = err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED');
      if (!isRetryable || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.log(`  Rate limited, retrying in ${delay / 1000}s (attempt ${attempt}/${maxAttempts})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}
