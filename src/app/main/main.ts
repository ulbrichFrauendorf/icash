import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, net, protocol, safeStorage, session } from 'electron';
import { pathToFileURL } from 'node:url';
import { ProfileStore, type KeyProtection } from '../../features/profiles/main';
import { UserError } from '../../shared/schema';
import { registerHandlers } from './handlers';

if (process.platform === 'win32') {
  // Squirrel invokes the app briefly during install, update, and uninstall.
  const event = process.argv[1] ?? '';
  if (['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete'].includes(event)) {
    if (event !== '--squirrel-obsolete') {
      spawn(resolve(dirname(process.execPath), '..', 'Update.exe'),
        [event === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut', basename(process.execPath)], { detached: true }).unref();
    }
    app.quit();
  }
}

protocol.registerSchemesAsPrivileged([{ scheme: 'icash', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const testRoot = !app.isPackaged ? process.env.ICASH_TEST_DATA : undefined;
const devRoot = !app.isPackaged ? process.env.ICASH_DEV_DATA : undefined;
if (testRoot || devRoot) {
  const dir = resolve(testRoot || devRoot || '');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  app.setPath('userData', dir);
}

let window: BrowserWindow | null = null;
let profiles: ProfileStore | undefined;
const appUrl = 'icash://app/';
const renderer = resolve(__dirname, '../renderer/browser');

const protect: KeyProtection = {
  wrap(key) {
    requireKeyStore();
    return safeStorage.encryptString(key.toString('hex'));
  },
  unwrap(wrapped) {
    requireKeyStore();
    return Buffer.from(safeStorage.decryptString(wrapped), 'hex');
  },
};

function requireKeyStore() {
  if (!safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text' && !testRoot)) {
    throw new UserError('An operating-system key store is required to unlock or create a profile.');
  }
}

function showWindow() {
  window = new BrowserWindow({
    width: 1320, height: 860, minWidth: 730, minHeight: 550, title: 'iCash',
    backgroundColor: '#f3f6f3', autoHideMenuBar: true,
    icon: join(renderer, "assets/branding/invensys-icon-light.png"),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => { window = null; });
  void window.loadURL(appUrl);
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(() => {
    if (testRoot && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(icash:|file:|data:|blob:|devtools:)/.test(details.url) });
    });
    protocol.handle('icash', (request) => {
      const url = new URL(request.url);
      const asset = url.pathname === '/' ? '/index.html' : url.pathname;
      if (url.hostname !== 'app' || !/^\/[a-z0-9._/-]+$/i.test(asset) || asset.includes('..')) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(join(renderer, asset)).href).then((response) => {
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'");
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(response.body, { status: response.status, headers });
      });
    });
    profiles = new ProfileStore(app.getPath('userData'), protect);
    try { profiles.autoSelect(); } catch { /* The profile picker lets users retry or recover a locked profile. */ }
    registerHandlers(profiles, () => window, appUrl, app.getPath('userData'));
    showWindow();
    app.on('activate', () => { if (!window) showWindow(); });
  }).catch(() => { console.error('iCash could not start.'); app.exit(1); });
} else app.quit();

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => profiles?.close());
