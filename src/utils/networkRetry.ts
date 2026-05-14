import { log } from './logger';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判断是否为可通过短暂等待后重试的网络 / TLS 类错误（非 4xx 业务错误） */
export function isTransientNetworkError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }
  const err = error as { code?: string; message?: string; response?: unknown; request?: unknown };
  const code = err.code;
  if (typeof code === 'string') {
    const transientCodes = new Set([
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNABORTED',
      'EPROTO',
      'EPIPE',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ECONNREFUSED',
    ]);
    if (transientCodes.has(code)) {
      return true;
    }
  }
  const message = typeof err.message === 'string' ? err.message : String(err);
  if (/SSL|TLS|handshake|EPROTO|socket hang up|timed out|ECONNRESET|ENETUNREACH|EHOSTUNREACH/i.test(message)) {
    return true;
  }
  // Axios：无 response 且已发出请求，多为网络层断开
  if (err.request && !err.response) {
    return true;
  }
  return false;
}

export async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 600;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retryable = isTransientNetworkError(e);
      if (!retryable || attempt === maxAttempts) {
        throw e;
      }
      const delay = baseDelayMs * attempt;
      log(
        `[API] Transient network error, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts}): ${e instanceof Error ? e.message : String(e)}`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
