// Aplicativo do painel: janela própria + ícone na bandeja.
// O painel (painel/server.js), os sites e os bots rodam no PM2, então continuam
// funcionando mesmo com o app fechado. O app só garante que estão ligados e mostra a interface.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { exec } = require('node:child_process');

const URL_PAINEL = 'http://127.0.0.1:3000';
// Pasta do servidor quando o app roda instalado (dá pra trocar no config.json).
const RAIZ_PADRAO = process.env.SERVIDOR_RAIZ || path.join(app.getPath('documents'), 'Servidor');
const PM2 = path.join(process.env.APPDATA || '', 'npm', 'pm2.cmd');
const ICONE = path.join(__dirname, 'icone.png');

if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId('br.dev.datacel.servidor');

let janela = null;
let bandeja = null;
let saindo = false;
let avisouBandeja = false;
let resumo = 'carregando…';

// ---------- configuração ----------

const ARQ_CONFIG = path.join(app.getPath('userData'), 'config.json');
const PADRAO = { iniciarComWindows: false, fecharParaBandeja: true, raiz: app.isPackaged ? RAIZ_PADRAO : path.resolve(__dirname, '..') };

function lerConfig() {
  try { return { ...PADRAO, ...JSON.parse(fs.readFileSync(ARQ_CONFIG, 'utf8')) }; } catch { return { ...PADRAO }; }
}

function salvarConfig(cfg) {
  fs.mkdirSync(path.dirname(ARQ_CONFIG), { recursive: true });
  fs.writeFileSync(ARQ_CONFIG, JSON.stringify(cfg, null, 2));
}

function aplicarInicioComWindows(ligado) {
  // Fora do instalador (rodando com "npm start") o electron.exe precisa saber qual app abrir.
  const args = app.isPackaged ? ['--oculto'] : [app.getAppPath(), '--oculto'];
  app.setLoginItemSettings({ openAtLogin: ligado, args });
}

// ---------- garantir que o painel está rodando ----------

function painelResponde() {
  return new Promise((ok) => {
    const req = http.get(`${URL_PAINEL}/api/estado`, { timeout: 2000 }, (res) => { res.resume(); ok(res.statusCode === 200); });
    req.on('error', () => ok(false));
    req.on('timeout', () => { req.destroy(); ok(false); });
  });
}

function pm2(args) {
  return new Promise((ok) => exec(`"${PM2}" ${args}`, { windowsHide: true }, () => ok()));
}

async function esperarPainel(segundos) {
  for (let i = 0; i < segundos * 2; i++) {
    if (await painelResponde()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function garantirPainel() {
  if (await painelResponde()) return true;
  // Depois de reiniciar o PC o PM2 está desligado: "resurrect" religa tudo que estava rodando.
  await pm2('resurrect');
  if (await esperarPainel(10)) return true;
  const pasta = path.join(lerConfig().raiz, 'painel');
  await pm2(`start "${path.join(pasta, 'server.js')}" --name painel --cwd "${pasta}"`);
  await pm2('save');
  return esperarPainel(15);
}

// ---------- janela ----------

const PAGINA_ERRO = (msg) => `data:text/html;charset=utf-8,${encodeURIComponent(`
  <body style="margin:0;background:#0d0d0c;color:#d8d4c6;font:14px/1.6 Consolas,monospace;display:grid;place-items:center;height:100vh;-webkit-app-region:drag">
    <div style="max-width:520px;padding:24px">
      <div style="color:#ff6b5b">[erro] ${msg}</div>
      <p style="color:#8b867a">verifique se o node e o pm2 estão instalados e se a pasta do servidor existe.</p>
      <a href="#" onclick="location.href='${URL_PAINEL}'" style="color:#ffb000;-webkit-app-region:no-drag">[tentar de novo]</a>
    </div>
  </body>`)}`;

async function criarJanela(oculta) {
  janela = new BrowserWindow({
    width: 1180, height: 760, minWidth: 720, minHeight: 480,
    frame: false, show: false, backgroundColor: '#0d0d0c',
    title: 'Datacel Servidor', icon: ICONE,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });

  // Links externos (domínio, cloudflare, discord…) abrem no navegador.
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  janela.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL_PAINEL) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); }
  });

  janela.on('close', (e) => {
    if (saindo || !lerConfig().fecharParaBandeja) return;
    e.preventDefault();
    janela.hide();
    if (!avisouBandeja) {
      avisouBandeja = true;
      bandeja?.displayBalloon({ title: 'Datacel Servidor', content: 'Continua rodando aqui na bandeja. Seus bots e sites não param.', iconType: 'info' });
    }
  });
  janela.on('closed', () => { janela = null; });
  janela.once('ready-to-show', () => { if (!oculta) janela.show(); });

  // Só para testes: PRINT_JANELA=arquivo.png salva um print da janela e fecha o app.
  if (process.env.PRINT_JANELA) {
    janela.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 3000));
      fs.writeFileSync(process.env.PRINT_JANELA, (await janela.webContents.capturePage()).toPNG());
      saindo = true;
      app.quit();
    });
  }

  const ok = await garantirPainel();
  await janela.loadURL(ok ? URL_PAINEL : PAGINA_ERRO('não consegui ligar o painel.')).catch(() => {});
}

function mostrar() {
  if (!janela) return criarJanela(false);
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
}

// ---------- bandeja ----------

function montarMenu() {
  bandeja.setToolTip(`Datacel Servidor — ${resumo}`);
  bandeja.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir painel', click: mostrar },
    { label: resumo, enabled: false },
    { type: 'separator' },
    { label: 'Abrir no navegador', click: () => shell.openExternal(URL_PAINEL) },
    { label: 'Abrir pasta do servidor', click: () => shell.openPath(lerConfig().raiz) },
    { type: 'separator' },
    { label: 'Sair (bots e sites continuam rodando)', click: () => { saindo = true; app.quit(); } },
  ]));
}

// ---------- comunicação com a interface ----------

ipcMain.on('janela', (e, acao) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (acao === 'minimizar') w.minimize();
  else if (acao === 'maximizar') (w.isMaximized() ? w.unmaximize() : w.maximize());
  else if (acao === 'fechar') w.close();
});

ipcMain.handle('config', () => ({ ...lerConfig(), versao: app.getVersion() }));

ipcMain.handle('definir', (e, chave, valor) => {
  if (!['iniciarComWindows', 'fecharParaBandeja'].includes(chave)) return;
  const cfg = lerConfig();
  cfg[chave] = Boolean(valor);
  salvarConfig(cfg);
  if (chave === 'iniciarComWindows') aplicarInicioComWindows(cfg.iniciarComWindows);
});

ipcMain.on('estado', (e, { botsOn, bots, sites }) => {
  const novo = `${botsOn}/${bots} bots online · ${sites} site(s)`;
  if (novo !== resumo && bandeja) { resumo = novo; montarMenu(); }
});

// ---------- início ----------

app.on('second-instance', mostrar);
app.on('before-quit', () => { saindo = true; });
app.on('window-all-closed', () => {}); // continua na bandeja

app.whenReady().then(async () => {
  bandeja = new Tray(nativeImage.createFromPath(ICONE).resize({ width: 16, height: 16 }));
  bandeja.on('click', mostrar);
  montarMenu();
  await criarJanela(process.argv.includes('--oculto'));
});
