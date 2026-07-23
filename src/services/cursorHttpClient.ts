import axios from 'axios';
import * as https from 'https';
import * as vscode from 'vscode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { log } from '../utils/logger';
import {
  isTlsConnectionError,
  NetworkRetryOptions,
} from '../utils/networkRetry';

const CURSOR_API_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_CONNECTIONS = 6;

interface DestroyableAgent {
  destroy(): void;
}

interface NetworkErrorWithAgent {
  config?: {
    httpsAgent?: DestroyableAgent;
  };
}

let activeHttpsAgent: DestroyableAgent;
let activeProxyMode: 'direct' | 'vscode-proxy' | 'env-proxy' = 'direct';
/** TLS 出错后关闭 keep-alive，避免代理下复用脏连接反复 BAD_DECRYPT */
let keepAliveEnabled = true;

function resolveProxyUrl(): string | undefined {
  const workspaceConfiguration = vscode.workspace.getConfiguration();
  const vscodeProxy = (workspaceConfiguration.get('http.proxy') as string | undefined)?.trim();
  if (vscodeProxy) {
    return vscodeProxy;
  }

  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  return envProxy?.trim() || undefined;
}

function createDirectHttpsAgent(): DestroyableAgent {
  activeProxyMode = 'direct';
  return new https.Agent({
    keepAlive: keepAliveEnabled,
    maxSockets: MAX_CONCURRENT_CONNECTIONS,
    maxFreeSockets: keepAliveEnabled ? 2 : 0,
    timeout: CURSOR_API_TIMEOUT_MS,
  });
}

function createHttpsAgentFromConfiguration(): DestroyableAgent {
  const workspaceConfiguration = vscode.workspace.getConfiguration();
  const proxyUrl = resolveProxyUrl();
  const strictSsl = workspaceConfiguration.get('http.proxyStrictSSL') as boolean | undefined;
  const usingVscodeProxy = Boolean(
    (workspaceConfiguration.get('http.proxy') as string | undefined)?.trim(),
  );

  if (proxyUrl) {
    try {
      const parsedProxyUrl = new URL(proxyUrl);
      if (parsedProxyUrl.protocol !== 'http:' && parsedProxyUrl.protocol !== 'https:') {
        throw new Error('Unsupported proxy protocol');
      }
      // 经代理时默认不用 keep-alive：不少代理/MITM 对复用连接会触发 BAD_DECRYPT
      const proxyKeepAlive = false;
      const proxyAgent = new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: strictSsl !== false,
        keepAlive: proxyKeepAlive,
        maxSockets: MAX_CONCURRENT_CONNECTIONS,
        maxFreeSockets: 0,
      });
      activeProxyMode = usingVscodeProxy ? 'vscode-proxy' : 'env-proxy';
      return proxyAgent;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[API] Ignoring invalid proxy configuration: ${errorMessage}`, true);
    }
  }

  return createDirectHttpsAgent();
}

activeHttpsAgent = createHttpsAgentFromConfiguration();
log(`[API] Initialized ${activeProxyMode} HTTPS agent (keepAlive=${keepAliveEnabled})`);

export const cursorApiClient = axios.create({
  baseURL: 'https://cursor.com',
  timeout: CURSOR_API_TIMEOUT_MS,
  proxy: false,
  httpsAgent: activeHttpsAgent,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
    Origin: 'https://cursor.com',
  },
});

export function resetCursorApiConnections(
  reason: string,
  expectedAgent?: DestroyableAgent,
  options?: { disableKeepAlive?: boolean },
): void {
  // expectedAgent 缺失时仍重建（axios 错误有时不带 config.httpsAgent）
  if (expectedAgent !== undefined && expectedAgent !== activeHttpsAgent) {
    log(`[API] Skipped stale HTTPS agent reset: ${reason}`);
    return;
  }

  if (options?.disableKeepAlive) {
    keepAliveEnabled = false;
  }

  const previousAgent = activeHttpsAgent;
  activeHttpsAgent = createHttpsAgentFromConfiguration();
  cursorApiClient.defaults.httpsAgent = activeHttpsAgent;
  previousAgent.destroy();
  log(
    `[API] Recreated ${activeProxyMode} HTTPS agent (keepAlive=${keepAliveEnabled}): ${reason}`,
  );
}

export function getCursorApiRetryOptions(
  requestName: string,
  baseDelayMs = 600,
): NetworkRetryOptions {
  return {
    maxAttempts: 3,
    baseDelayMs,
    requestName,
    onBeforeRetry: (error) => {
      if (isTlsConnectionError(error)) {
        const failedAgent = (error as NetworkErrorWithAgent).config?.httpsAgent;
        resetCursorApiConnections(
          `${requestName} encountered a TLS record error`,
          failedAgent,
          { disableKeepAlive: true },
        );
      }
    },
  };
}

const proxyConfigurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
  if (
    event.affectsConfiguration('http.proxy') ||
    event.affectsConfiguration('http.proxyStrictSSL')
  ) {
    keepAliveEnabled = true;
    resetCursorApiConnections('VS Code proxy configuration changed');
  }
});

export function disposeCursorApiClient(): void {
  proxyConfigurationListener.dispose();
  activeHttpsAgent.destroy();
}
