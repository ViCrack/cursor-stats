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
let activeProxyMode: 'direct' | 'vscode-proxy';

function createDirectHttpsAgent(): DestroyableAgent {
  activeProxyMode = 'direct';
  return new https.Agent({
    keepAlive: true,
    maxSockets: MAX_CONCURRENT_CONNECTIONS,
    maxFreeSockets: 2,
    timeout: CURSOR_API_TIMEOUT_MS,
  });
}

function createHttpsAgentFromConfiguration(): DestroyableAgent {
  const workspaceConfiguration = vscode.workspace.getConfiguration();
  const proxyUrl = (workspaceConfiguration.get('http.proxy') as string | undefined)?.trim();
  const strictSsl = workspaceConfiguration.get('http.proxyStrictSSL') as boolean | undefined;

  if (proxyUrl) {
    try {
      const parsedProxyUrl = new URL(proxyUrl);
      if (parsedProxyUrl.protocol !== 'http:' && parsedProxyUrl.protocol !== 'https:') {
        throw new Error('Unsupported proxy protocol');
      }
      const proxyAgent = new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: strictSsl !== false,
        keepAlive: true,
        maxSockets: MAX_CONCURRENT_CONNECTIONS,
        maxFreeSockets: 2,
      });
      activeProxyMode = 'vscode-proxy';
      return proxyAgent;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[API] Ignoring invalid VS Code proxy configuration: ${errorMessage}`, true);
    }
  }

  return createDirectHttpsAgent();
}

activeHttpsAgent = createHttpsAgentFromConfiguration();

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
  expectedAgent: DestroyableAgent = activeHttpsAgent,
): void {
  if (expectedAgent !== activeHttpsAgent) {
    log(`[API] Skipped stale HTTPS agent reset: ${reason}`);
    return;
  }

  const previousAgent = activeHttpsAgent;
  activeHttpsAgent = createHttpsAgentFromConfiguration();
  cursorApiClient.defaults.httpsAgent = activeHttpsAgent;
  previousAgent.destroy();
  log(`[API] Recreated ${activeProxyMode} HTTPS agent: ${reason}`);
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
    resetCursorApiConnections('VS Code proxy configuration changed');
  }
});

export function disposeCursorApiClient(): void {
  proxyConfigurationListener.dispose();
  activeHttpsAgent.destroy();
}
