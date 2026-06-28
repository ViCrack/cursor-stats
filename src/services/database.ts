import * as path from 'path';
import * as os from 'os';
import * as jwt from 'jsonwebtoken';
import * as vscode from 'vscode';
import * as fs from 'fs';
import initSqlJs from 'sql.js';
import { log } from '../utils/logger';
import { execFileSync, execSync } from 'child_process';

// use globalStorageUri to get the user directory path
// support Portable mode : https://code.visualstudio.com/docs/editor/portable
function getDefaultUserDirPath(): string {
  // Import getExtensionContext here to avoid circular dependency
  const { getExtensionContext } = require('../extension');
  const context = getExtensionContext();
  const extensionGlobalStoragePath = context.globalStorageUri.fsPath;
  const userDirPath = path.dirname(path.dirname(path.dirname(extensionGlobalStoragePath)));
  log(`[Database] Default user directory path: ${userDirPath}`);
  return userDirPath;
}

export function getCursorDBPath(): string {
  // Check for custom path in settings
  const config = vscode.workspace.getConfiguration('cursorStats');
  const customPath = config.get<string>('customDatabasePath');
  const userDirPath = getDefaultUserDirPath();

  if (customPath && customPath.trim() !== '') {
    log(`[Database] Using custom path: ${customPath}`);
    return customPath;
  }
  const folderName = vscode.env.appName;

  if (process.platform === 'win32') {
    return path.join(userDirPath, 'User', 'globalStorage', 'state.vscdb');
  } else if (process.platform === 'linux') {
    const isWSL = vscode.env.remoteName === 'wsl';
    if (isWSL) {
      const windowsUsername = getWindowsUsername();
      if (windowsUsername) {
        return path.join(
          '/mnt/c/Users',
          windowsUsername,
          'AppData/Roaming',
          folderName,
          'User/globalStorage/state.vscdb',
        );
      }
    }
    return path.join(userDirPath, 'User', 'globalStorage', 'state.vscdb');
  } else if (process.platform === 'darwin') {
    return path.join(userDirPath, 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(userDirPath, 'User', 'globalStorage', 'state.vscdb');
}

const TOKEN_SELECT_SQL =
  "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'";

function resolveSqlite3Executable(): string | undefined {
  const config = vscode.workspace.getConfiguration('cursorStats');
  const custom = config.get<string>('sqlite3Path')?.trim();
  if (custom) {
    if (fs.existsSync(custom)) {
      return custom;
    }
    log(`[Database] cursorStats.sqlite3Path not found: ${custom}`, true);
    return undefined;
  }
  for (const name of ['sqlite3', 'sqlite3.exe']) {
    try {
      execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
      return name;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Read access token via sqlite3 CLI (avoids Node ~2 GiB Buffer limit on readFileSync). */
function readAccessTokenViaSqlite3Cli(dbPath: string): string | undefined {
  const sqlite3 = resolveSqlite3Executable();
  if (!sqlite3) {
    log(
      '[Database] sqlite3 executable not found. Install SQLite (sqlite3 on PATH) or set cursorStats.sqlite3Path to read very large state.vscdb files.',
      true,
    );
    return undefined;
  }
  try {
    const out = execFileSync(sqlite3, [dbPath, TOKEN_SELECT_SQL], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const token = out.trim();
    return token || undefined;
  } catch (error: any) {
    log('[Database] sqlite3 CLI query failed: ' + (error?.message ?? error), true);
    if (error?.stderr) {
      log('[Database] sqlite3 stderr: ' + String(error.stderr).slice(0, 500), true);
    }
    return undefined;
  }
}

function buildSessionTokenFromAccessToken(token: string): string | undefined {
  try {
    const decoded = jwt.decode(token, { complete: true });

    if (!decoded || !decoded.payload || !decoded.payload.sub) {
      log('[Database] Invalid JWT structure: ' + JSON.stringify({ decoded }), true);
      return undefined;
    }

    const sub = decoded.payload.sub.toString();
    const userId = sub.split('|')[1];
    const sessionToken = `${userId}%3A%3A${token}`;
    log(`[Database] Created session token, length: ${sessionToken.length}`);
    return sessionToken;
  } catch (error: any) {
    log('[Database] Error processing token: ' + error, true);
    log(
      '[Database] Error details: ' +
        JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack,
        }),
      true,
    );
    return undefined;
  }
}

function isFileTooLargeForBuffer(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const anyErr = err as NodeJS.ErrnoException & { code?: string };
  if (anyErr.code === 'ERR_FS_FILE_TOO_LARGE') {
    return true;
  }
  const msg = String(anyErr.message ?? '');
  if (msg.includes('greater than 2 GiB')) {
    return true;
  }
  // Uint8Array / ArrayBuffer allocation failure when the file is very large
  const isRangeError = err instanceof RangeError || (anyErr as any).name === 'RangeError';
  if (isRangeError && msg.includes('Array buffer allocation failed')) {
    return true;
  }
  return false;
}

export async function getCursorTokenFromDB(): Promise<string | undefined> {
  try {
    const dbPath = getCursorDBPath();
    log(`[Database] Attempting to open database at: ${dbPath}`);

    if (!fs.existsSync(dbPath)) {
      log('[Database] Database file does not exist', true);
      return undefined;
    }

    let accessToken: string | undefined;

    const ONE_GB = 1024 * 1024 * 1024;
    const fileSize = fs.statSync(dbPath).size;
    if (fileSize > ONE_GB) {
      log(
        `[Database] state.vscdb is ${(fileSize / ONE_GB).toFixed(2)} GiB, skipping in-memory load; using sqlite3 CLI directly.`,
      );
      accessToken = readAccessTokenViaSqlite3Cli(dbPath);
      if (!accessToken) {
        return undefined;
      }
      return buildSessionTokenFromAccessToken(accessToken);
    }

    try {
      const dbBuffer = fs.readFileSync(dbPath);
      const SQL = await initSqlJs();
      const db = new SQL.Database(new Uint8Array(dbBuffer));

      const result = db.exec(TOKEN_SELECT_SQL);

      if (!result.length || !result[0].values.length) {
        log('[Database] No token found in database');
        db.close();
        return undefined;
      }

      accessToken = result[0].values[0][0] as string;
      log(`[Database] Access token from DB, length: ${accessToken.length}`);
      db.close();
    } catch (readErr: unknown) {
      if (isFileTooLargeForBuffer(readErr)) {
        log(
          '[Database] state.vscdb exceeds Node in-memory limit; falling back to sqlite3 CLI reader.',
        );
        accessToken = readAccessTokenViaSqlite3Cli(dbPath);
        if (!accessToken) {
          return undefined;
        }
      } else {
        throw readErr;
      }
    }

    if (!accessToken) {
      return undefined;
    }

    return buildSessionTokenFromAccessToken(accessToken);
  } catch (error: any) {
    log('[Database] Error opening database: ' + error, true);
    log(
      '[Database] Database error details: ' +
        JSON.stringify({
          message: error.message,
          stack: error.stack,
        }),
      true,
    );
    return undefined;
  }
}
export function getWindowsUsername(): string | undefined {
  try {
    // Executes cmd.exe and echoes the %USERNAME% variable
    const result = execSync('cmd.exe /C "echo %USERNAME%"', { encoding: 'utf8' });
    const username = result.trim();
    return username || undefined;
  } catch (error) {
    console.error('Error getting Windows username:', error);
    return undefined;
  }
}
