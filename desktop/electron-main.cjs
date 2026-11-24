'use strict';
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { randomBytes, randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, appendFileSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync, rmdirSync, lstatSync } = require('node:fs');
const path = require('node:path');

const nonce = randomBytes(32).toString('hex');
const legacyProfile = path.join(app.getPath('appData'), 'local-agent-harness');
if (!app.commandLine.hasSwitch('user-data-dir') && existsSync(legacyProfile)) app.setPath('userData', legacyProfile);
const updateStatus = path.join(app.getPath('userData'), 'update-result.txt');
const pendingUpdate = path.join(app.getPath('userData'), 'update-pending.json');
const updateMarker = app.commandLine.getSwitchValue('wisk-update-marker');
const packageKind = app.isPackaged && process.platform === 'win32'
  ? (process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'setup') : '';
let updateStarted = false;
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
function quoteWindows(value) {
  // Windows paths cannot contain quotes. Double trailing separators before the closing quote.
  return '"' + value.replace(/\\+$/, '$&$&') + '"';
}
function checkPendingUpdate() {
  let pending;
  try { pending = JSON.parse(readFileSync(pendingUpdate, 'utf8')); }
  catch { return true; }
  try { process.kill(pending.pid, 0); }
  catch {
    // Only unlink a runner copied by this app into its own temporary directory.
    const temp = path.resolve(app.getPath('temp'));
    const folder = path.resolve(path.dirname(pending.marker || '.'));
    if (path.dirname(folder) === temp && /^wisk-update-[A-Za-z0-9]+$/.test(path.basename(folder))) {
      try { rmSync(path.join(folder, 'WiskHarness Update.exe'), {force:true}); } catch {}
      try { rmdirSync(folder); } catch {}
    }
    try { rmSync(pendingUpdate, {force:true}); } catch {}
    return true;
  }
  return pending.marker === updateMarker;
}
async function handoffUpdate(child, message, settingsFolder) {
  if (message?.type !== 'install-update') return;
  if (updateStarted || shuttingDown) return;
  updateStarted = true;
  let runner;
  let folder;
  try {
    if (!packageKind || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(message.version) ||
        !/^[a-f0-9]{64}$/.test(message.sha256)) throw new Error('Invalid desktop update request.');
    const kind = packageKind === 'portable' ? 'Portable' : 'Setup';
    const expected = path.join(settingsFolder, 'updates', 'WiskHarness ' + kind + ' ' + message.version + '.exe');
    if (message.path !== expected || !lstatSync(expected).isFile()) throw new Error('The verified update file is missing.');
    const target = packageKind === 'portable' ? process.env.PORTABLE_EXECUTABLE_FILE : process.execPath;
    if (!path.isAbsolute(target) || !lstatSync(target).isFile()) throw new Error('Cannot locate this WiskHarness executable.');
    if (packageKind === 'setup' && !existsSync(path.join(path.dirname(target), 'Uninstall WiskHarness.exe')))
      throw new Error('Automatic Setup updates require an installed copy of WiskHarness.');
    const environment = {...process.env};
    for (const name of ['PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_APP_FILENAME', 'ELECTRON_RUN_AS_NODE'])
      delete environment[name];
    folder = mkdtempSync(path.join(app.getPath('temp'), 'wisk-update-'));
    const helper = path.join(folder, 'WiskHarness Update.exe');
    copyFileSync(path.join(process.resourcesPath, 'WiskHarness Update.exe'), helper);
    const marker = path.join(folder, 'started');
    const restart = '--user-data-dir=' + quoteWindows(app.getPath('userData'));
    const stage = path.join(path.dirname(target), '.wisk-update-' + randomUUID() + '.exe');
    runner = spawn(helper, [String(process.pid), packageKind, expected, target, message.sha256,
      message.version, updateStatus, marker, stage, restart], {
      detached:true, windowsHide:true, stdio:'ignore', cwd:folder, env:environment
    });
    await new Promise((resolve,reject)=>{ runner.once('spawn',resolve); runner.once('error',reject); });
    writeFileSync(pendingUpdate, JSON.stringify({pid:runner.pid,marker}));
    runner.unref();
    log('Installing verified ' + packageKind + ' update ' + message.version);
    app.quit();
  } catch (error) {
    if (runner?.pid) runner.kill();
    if (folder) try { rmSync(folder, {recursive:true,force:true}); } catch {}
    updateStarted = false;
    log('Update handoff failed: ' + error.message);
    if (child.connected) child.send({type:'update-error',error:error.message});
  }
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
  const settingsFolder = path.resolve(process.env.LOCAL_AGENT_SETTINGS_DIR || (hasSourceProject ? projectFolder : app.getPath('userData')));
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
    WISKHARNESS_PACKAGE_KIND: packageKind,
    WISKHARNESS_UPDATE_STATUS: packageKind ? updateStatus : ''
  };
  backendProcess = spawn(process.execPath, [backendFile], {
    cwd: runtimeRoot,
    windowsHide: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const child = backendProcess;
  child.on('message', message => { void handoffUpdate(child, message, settingsFolder); });
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
  window.once('ready-to-show', () => {
    if (ready && updateMarker) {
      try {
        const pending = JSON.parse(readFileSync(pendingUpdate, 'utf8'));
        if (pending.marker === updateMarker) writeFileSync(updateMarker, app.getVersion());
      } catch (error) { log('Could not confirm update startup: ' + error.message); }
    }
    window.show();
  });
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
    if (!checkPendingUpdate()) { app.quit(); return; }
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
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 6000);
  child.once('exit', () => { clearTimeout(timer); app.quit(); });
  if (child.connected) child.disconnect();
});
app.on('window-all-closed', () => {if (process.platform !== 'darwin') app.quit();});
app.on('activate', () => {if (BrowserWindow.getAllWindows().length===0) createWindow(false);});
