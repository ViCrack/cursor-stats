import { log } from './logger';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NetworkErrorLike {
  code?: string;
  message?: string;
  name?: string;
  response?: { status?: number };
  request?: unknown;
  cause?: unknown;
}

export interface NetworkRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  requestName?: string;
  onBeforeRetry?: (error: unknown, nextAttempt: number) => void | Promise<void>;
}

const TRANSIENT_ERROR_CODES = new Set([
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

const PERMANENT_CERTIFICATE_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function toNetworkError(error: unknown): NetworkErrorLike {
  return typeof error === 'object' && error !== null ? (error as NetworkErrorLike) : {};
}

function getNestedCause(error: unknown): NetworkErrorLike {
  return toNetworkError(toNetworkError(error).cause);
}

export function getNetworkErrorCode(error: unknown): string | undefined {
  const networkError = toNetworkError(error);
  const nestedCause = getNestedCause(error);
  return networkError.code || nestedCause.code;
}

function getNetworkErrorMessage(error: unknown): string {
  const networkError = toNetworkError(error);
  const nestedCause = getNestedCause(error);
  const messages = [networkError.message, nestedCause.message].filter(
    (message): message is string => typeof message === 'string' && message.length > 0,
  );
  return messages.join(' | ') || String(error);
}

export function isTlsConnectionError(error: unknown): boolean {
  const errorCode = getNetworkErrorCode(error);
  const errorMessage = getNetworkErrorMessage(error);
  return (
    errorCode === 'EPROTO' ||
    /BAD_DECRYPT|bad record mac|decryption failed or bad record mac|OPENSSL_internal/i.test(
      errorMessage,
    )
  );
}

function isCancelledRequest(error: unknown): boolean {
  const networkError = toNetworkError(error);
  const errorCode = getNetworkErrorCode(error);
  return errorCode === 'ERR_CANCELED' || networkError.name === 'CanceledError';
}

/** 判断是否为可通过短暂等待后重试的网络 / TLS 类错误（非 4xx 业务错误） */
export function isTransientNetworkError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }
  const networkError = toNetworkError(error);
  const errorCode = getNetworkErrorCode(error);

  if (isCancelledRequest(error)) {
    return false;
  }
  if (errorCode && PERMANENT_CERTIFICATE_ERROR_CODES.has(errorCode)) {
    return false;
  }
  if (errorCode && TRANSIENT_ERROR_CODES.has(errorCode)) {
    return true;
  }
  if (networkError.response?.status) {
    return TRANSIENT_HTTP_STATUSES.has(networkError.response.status);
  }
  const errorMessage = getNetworkErrorMessage(error);
  if (/SSL|TLS|OPENSSL|BAD_DECRYPT|bad record mac|handshake|EPROTO|socket hang up|timed out|ECONNRESET|ENETUNREACH|EHOSTUNREACH/i.test(errorMessage)) {
    return true;
  }
  // Axios：无 response 且已发出请求，多为网络层断开
  if (networkError.request && !networkError.response) {
    return true;
  }
  return false;
}

export async function withNetworkRetry<T>(
  request: () => Promise<T>,
  options?: NetworkRetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 600;
  const maxDelayMs = options?.maxDelayMs ?? 5000;
  const requestName = options?.requestName ?? 'network request';
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      const retryable = isTransientNetworkError(error);
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      await options?.onBeforeRetry?.(error, nextAttempt);

      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitterMultiplier = 0.5 + Math.random();
      const delayMs = Math.round(exponentialDelay * jitterMultiplier);
      const errorCode = getNetworkErrorCode(error) ?? 'UNKNOWN';
      log(
        `[API] ${requestName} failed with ${errorCode}; retrying in ${delayMs}ms (attempt ${nextAttempt}/${maxAttempts}): ${getNetworkErrorMessage(error)}`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}
