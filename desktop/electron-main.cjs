'use strict';
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, appendFileSync } = require('node:fs');
const path = require('node:path');

const nonce = randomBytes(32).toString('hex');
const legacyProfile = path.join(app.getPath('appData'), 'local-agent-harness');
if (!app.commandLine.hasSwitch('user-data-dir') && existsSync(legacyProfile)) app.setPath('userData', legacyProfile);
let appURL = 'http://127.0.0.1:' + (process.env.LOCAL_AGENT_PORT || '4317') + '/';
let window = null;
let backendProcess = null;
let startedBackend = false;
let shuttingDown = false;
let startupError = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'desktop-runtime.log'), '[' + new Date().toISOString() + '] ' + message + '\n', 'utf8');
  } catch {}
}
async function isLocalAgentRunning(url=appURL) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 2500);
  try {
    const response = await fetch(url + 'api/health', { signal: ctrl.signal, cache: 'no-store', headers: { 'x-wiskharness-session': nonce } });
    if (!response.ok) return false;
    const info = await response.json();
    return info.ok === true && info.apiVersion === 4 && info.version === app.getVersion() && 'model' in info && 'preflight' in info && 'ollama' in info;
  } catch { return false; }
  finally { clearTimeout(timeout); }
}
async function portFree(port) {
  return new Promise(resolve => {
    const server=net.createServer();
    server.once('error',()=>resolve(false));
    server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));
  });
}
async function ensureBackend() {
  const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '..');
  const backendFile = path.join(runtimeRoot, 'server.mjs');
  if (!existsSync(backendFile)) throw new Error('Bundled backend not found at: ' + backendFile);

  const projectFolder = path.join(app.getPath('documents'), 'Local Agent Harness');
  const hasSourceProject = existsSync(path.join(projectFolder, 'settings.json'));
  const settingsFolder = process.env.LOCAL_AGENT_SETTINGS_DIR || (hasSourceProject ? projectFolder : app.getPath('userData'));
  const agentWorkspace = process.env.LOCAL_AGENT_WORKSPACE || path.join(app.getPath('documents'), 'WiskHarness Projects');
  let chosenPort = Number(process.env.LOCAL_AGENT_PORT || 4317);
  if (process.env.LOCAL_AGENT_PORT && !(await portFree(chosenPort)))
    throw new Error('The requested WiskHarness port is already in use');
  if (!(await portFree(chosenPort))) {
    for(const port of [4318,4319,4320,4321]){if(await portFree(port)){chosenPort=port;break}}
  }
  if (!(await portFree(chosenPort))) throw new Error('No available local API port; close the application using the requested port first');
  appURL='http://127.0.0.1:'+chosenPort+'/';
  log('Starting backend ' + backendFile + ' on '+appURL);
  const environment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LOCAL_AGENT_PORT: String(chosenPort),
    LOCAL_AGENT_SETTINGS_DIR: settingsFolder,
    LOCAL_AGENT_WORKSPACE: agentWorkspace,
    WISKHARNESS_API_TOKEN: nonce,
    WISKHARNESS_PACKAGE_KIND: app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'setup') : ''
  };
  backendProcess = spawn(process.execPath, [backendFile], {
    cwd: runtimeRoot,
    windowsHide: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  startedBackend = true;
  backendProcess.stdout.on('data', data => log('[server] ' + String(data).trim()));
  backendProcess.stderr.on('data', data => log('[server/error] ' + String(data).trim()));
  backendProcess.on('error', error => {startupError = error.message; log('Spawn error: ' + error.message);});
  backendProcess.on('exit', (code, signal) => {
    log('Backend exited with code ' + code + ', signal ' + signal);
    backendProcess = null;
  });
  for (let i = 0; i < 35; i++) {
    if (await isLocalAgentRunning()) {log('Bundled backend healthy'); return true;}
    if (!backendProcess) break;
    await delay(400);
  }
  throw new Error('Backend startup failed. See desktop-runtime.log in the WiskHarness app data folder.');
}
function createWindow(ready) {
  window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#111217',
    title: 'WiskHarness',
    icon: path.join(__dirname, 'assets', 'wiskharness-256.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  window.webContents.session.setPermissionRequestHandler((_web, _permission, decide) => decide(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeSendHeaders({urls: [appURL + '*']}, (details, callback) => {
    const sameOrigin = new URL(details.url).origin === new URL(appURL).origin;
    callback({requestHeaders: sameOrigin ? {...details.requestHeaders, 'X-WiskHarness-Session': nonce} : details.requestHeaders});
  });
  window.once('ready-to-show', () => window.show());
  let confirmingExternal = false;
  window.webContents.setWindowOpenHandler(({url}) => {
    try {
      const target = new URL(url);
      const official = target.origin === 'https://github.com' && target.pathname.startsWith('/itsfyze/WiskHarness/releases/');
      if (official || ['https://ollama.com','https://goose-docs.ai','https://tailscale.com'].includes(target.origin)) {
        void shell.openExternal(target.href).catch(error => log(error.message));
      } else if (!confirmingExternal && target.href.length<=2048 && !target.username && !target.password &&
          ['http:','https:'].includes(target.protocol)) {
        confirmingExternal = true;
        void dialog.showMessageBox(window,{type:'question',title:'Open external link',
          message:'Open this address in your browser?',detail:target.href,buttons:['Cancel','Open link'],
          defaultId:0,cancelId:0}).then(({response})=>{
            if(response===1)return shell.openExternal(target.href);
          }).catch(error=>log(error.message)).finally(()=>{confirmingExternal=false;});
      }
    } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(appURL)) {
      event.preventDefault();
      log('Prevented navigation outside the local app');
    }
  });
  window.webContents.on('render-process-gone', (_event, info) => log('Renderer crash: ' + JSON.stringify(info)));

  if (ready) {
    window.loadURL(appURL).catch(error => log('Window load failed: ' + error.message));
  } else {
    const escapeHTML = text => String(text).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[character]));
    const text = escapeHTML(startupError || 'Unable to connect to the local agent backend.');
    const page = '<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:#0e1013;color:#e9ecf3;font:14px Segoe UI,sans-serif;padding:50px;line-height:1.7"><h2>Could not start WiskHarness</h2><p>'+text+'</p><p>Verify Ollama and Goose are installed, then launch the app again. Logs are saved in the WiskHarness app data folder.</p></body></html>';
    window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  }
  window.on('closed', () => {window = null;});
}
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => {if (window) {if(window.isMinimized()) window.restore();window.focus();}});
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.localagent.desktop');
    let ready = false;
    try {ready = await ensureBackend();}
    catch(error) {startupError = String(error?.stack || error);log(startupError);}
    createWindow(ready);
  });
}
app.on('before-quit', event => {
  if (shuttingDown || !startedBackend || !backendProcess) return;
  event.preventDefault();
  shuttingDown = true;
  const child = backendProcess;
  if (child.connected) child.disconnect();
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); app.quit(); }, 6000);
  child.once('exit', () => { clearTimeout(timer); app.quit(); });
});
app.on('window-all-closed', () => {if (process.platform !== 'darwin') app.quit();});
app.on('activate', () => {if (BrowserWindow.getAllWindows().length===0) createWindow(false);});
