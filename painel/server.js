// Painel do servidor: gerencia sites (servidos pelo Caddy) e bots (rodando no PM2).
import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import pm2 from 'pm2';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const PASTAS = { sites: path.join(RAIZ, 'sites'), bots: path.join(RAIZ, 'bots') };
const DADOS = path.join(AQUI, 'dados.json');
const LOGS_SITES = path.join(RAIZ, 'logs', 'sites');
const PORTA_PAINEL = 3000;

const CADDY = process.env.CADDY_PATH || path.join(process.env.LOCALAPPDATA || '',
  'Microsoft/WinGet/Packages/CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe/caddy.exe');
const CLOUDFLARED = process.env.CLOUDFLARED_PATH || 'C:/Program Files (x86)/cloudflared/cloudflared.exe';
const PASTA_CF = path.join(os.homedir(), '.cloudflared');
const CERT_CF = path.join(PASTA_CF, 'cert.pem');
const CONFIG_TUNEL = path.join(AQUI, 'cloudflared.yml');
const NOME_TUNEL = 'meu-servidor';
const TOKEN_EXEMPLO = 'cole_seu_token_aqui';
const IGNORAR = new Set(['node_modules', '.git']);

// ---------- utilidades ----------

const pm = (fn, ...args) => new Promise((ok, erro) => pm2[fn](...args, (e, r) => (e ? erro(e) : ok(r))));

function nomeValido(nome) {
  if (typeof nome !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(nome)) {
    throw new ErroUsuario('Nome inválido: use só letras minúsculas, números e hífen (ex.: meu-site).');
  }
  return nome;
}

class ErroUsuario extends Error {}

// Garante que um caminho relativo não escape da pasta base (ex.: "../../Windows").
function dentro(base, relativo = '') {
  const alvo = path.resolve(base, relativo);
  if (alvo !== base && !alvo.startsWith(base + path.sep)) throw new ErroUsuario('Caminho inválido.');
  return alvo;
}

function pastaDe(tipo, nome) {
  if (!PASTAS[tipo]) throw new ErroUsuario('Tipo inválido.');
  return dentro(PASTAS[tipo], nomeValido(nome));
}

function lerDados() {
  if (fs.existsSync(DADOS)) return JSON.parse(fs.readFileSync(DADOS, 'utf8'));
  // Primeira execução: registra o que já existe nas pastas.
  const listar = (p) => (fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
  const dados = {
    sites: listar(PASTAS.sites).map((nome, i) => ({ nome, porta: 8080 + i })),
    bots: listar(PASTAS.bots).map((nome) => ({ nome, principal: 'index.js' })),
  };
  salvarDados(dados);
  return dados;
}

function salvarDados(dados) {
  fs.writeFileSync(DADOS, JSON.stringify(dados, null, 2));
}

async function processos() {
  const lista = await pm('list');
  return new Map(lista.map((p) => [p.name, p]));
}

function resumo(p) {
  if (!p) return { status: 'parado', cpu: 0, mem: 0, reinicios: 0 };
  return {
    status: p.pm2_env.status === 'online' ? 'online' : p.pm2_env.status === 'errored' ? 'erro' : 'parado',
    cpu: p.monit?.cpu ?? 0,
    mem: p.monit?.memory ?? 0,
    reinicios: p.pm2_env.restart_time ?? 0,
  };
}

async function finalDoArquivo(arquivo, bytes = 64 * 1024) {
  try {
    const h = await fsp.open(arquivo, 'r');
    const { size } = await h.stat();
    const inicio = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - inicio);
    await h.read(buf, 0, buf.length, inicio);
    await h.close();
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

async function iniciarOuReiniciar(config) {
  const lista = await processos();
  if (lista.has(config.name)) await pm('delete', config.name);
  await pm('start', config);
  await pm('dump');
}

async function remover(nomeProcesso) {
  const lista = await processos();
  if (lista.has(nomeProcesso)) {
    await pm('delete', nomeProcesso);
    await pm('dump');
  }
}

// ---------- sites (Caddy) ----------

async function aplicarSites() {
  const { sites } = lerDados();
  if (sites.length === 0) return remover('sites');
  await fsp.mkdir(LOGS_SITES, { recursive: true });
  // Cada site grava um log de acessos em JSON, lido pela aba "consumo".
  const caddyfile = sites
    .map((s) => `:${s.porta} {\n\troot * "sites/${s.nome}"\n\tfile_server\n\tlog {\n\t\toutput file "logs/sites/${s.nome}.log" {\n\t\t\troll_size 20MiB\n\t\t\troll_keep 2\n\t\t}\n\t\tformat json\n\t}\n}`)
    .join('\n\n');
  await fsp.writeFile(path.join(RAIZ, 'Caddyfile'), caddyfile + '\n');
  await iniciarOuReiniciar({
    name: 'sites', script: CADDY, args: ['run', '--config', 'Caddyfile'], interpreter: 'none', cwd: RAIZ,
  });
}

async function urlDoTunel(p) {
  if (!p) return null;
  const texto = await finalDoArquivo(p.pm2_env.pm_err_log_path) + await finalDoArquivo(p.pm2_env.pm_out_log_path);
  const achados = texto.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  return achados ? achados[achados.length - 1] : null;
}

// ---------- domínio próprio (túnel nomeado da Cloudflare) ----------

function cloudflared(...args) {
  return new Promise((ok, erro) => {
    execFile(CLOUDFLARED, args, { maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) erro(new ErroUsuario((stderr || stdout || e.message).trim().split('\n').pop()));
      else ok(stdout); // avisos (ex.: "versão desatualizada") vão pro stderr e não podem estragar o JSON
    });
  });
}

function dominioValido(dominio) {
  dominio = String(dominio || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(dominio)) throw new ErroUsuario('Domínio inválido (ex.: seunome.com.br).');
  return dominio;
}

// Cria o túnel "meu-servidor" na sua conta (ou reaproveita, se já existir).
async function garantirTunel(dados) {
  if (dados.tunel && fs.existsSync(dados.tunel.credenciais)) return dados.tunel;
  const procurar = async () => (JSON.parse(await cloudflared('tunnel', 'list', '--output', 'json')) || []).find((t) => t.name === NOME_TUNEL && (!t.deleted_at || t.deleted_at.startsWith('0001-')));
  let tunel = await procurar();
  if (!tunel) {
    await cloudflared('tunnel', 'create', NOME_TUNEL);
    tunel = await procurar();
  }
  const credenciais = path.join(PASTA_CF, `${tunel.id}.json`);
  if (!fs.existsSync(credenciais)) {
    throw new ErroUsuario(`O túnel "${NOME_TUNEL}" já existe na Cloudflare mas as credenciais não estão neste PC. Apague ele no painel da Cloudflare (Zero Trust → Networks → Tunnels) e tente de novo.`);
  }
  dados.tunel = { id: tunel.id, credenciais };
  salvarDados(dados);
  return dados.tunel;
}

async function aplicarTunel() {
  const dados = lerDados();
  const comEndereco = dados.sites.filter((s) => s.endereco);
  if (!dados.tunel || comEndereco.length === 0) return remover('tunel');
  const regras = comEndereco.map((s) => `  - hostname: ${s.endereco}\n    service: http://localhost:${s.porta}`).join('\n');
  await fsp.writeFile(CONFIG_TUNEL,
    `tunnel: ${dados.tunel.id}\ncredentials-file: ${dados.tunel.credenciais.replaceAll('\\', '/')}\ningress:\n${regras}\n  - service: http_status:404\n`);
  await iniciarOuReiniciar({
    name: 'tunel', script: CLOUDFLARED, interpreter: 'none',
    args: ['tunnel', '--no-autoupdate', '--config', CONFIG_TUNEL, 'run'],
  });
}

let login = null; // processo do "cloudflared tunnel login" em andamento

// ---------- bots ----------

const instalando = new Set();

function temToken(pasta) {
  try {
    const env = fs.readFileSync(path.join(pasta, '.env'), 'utf8');
    const m = env.match(/^DISCORD_TOKEN=(.*)$/m);
    return Boolean(m && m[1].trim() && m[1].trim() !== TOKEN_EXEMPLO);
  } catch {
    return false;
  }
}

// Descobre o arquivo principal de um bot enviado pronto: "main" ou "scripts.start" do package.json,
// senão os nomes mais comuns. Retorna null se não achar nada.
function acharPrincipal(pasta) {
  const candidatos = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pasta, 'package.json'), 'utf8'));
    const start = String(pkg.scripts?.start || '').match(/node\s+(?:--\S+\s+)*([^\s]+\.[cm]?js)/);
    if (start) candidatos.push(start[1]);
    if (pkg.main) candidatos.push(pkg.main);
  } catch {}
  candidatos.push('index.js', 'src/index.js', 'bot.js', 'main.js', 'src/bot.js', 'main.py', 'bot.py');
  return candidatos.map((c) => c.replace(/^\.\//, '')).find((c) => fs.existsSync(path.join(pasta, c))) || null;
}

function npmInstall(nome) {
  const pasta = pastaDe('bots', nome);
  if (!fs.existsSync(path.join(pasta, 'package.json'))) return Promise.resolve('Sem package.json, nada para instalar.');
  instalando.add(nome);
  return new Promise((ok) => {
    exec('npm install --omit=dev', { cwd: pasta, maxBuffer: 10 * 1024 * 1024 }, (erro, stdout, stderr) => {
      instalando.delete(nome);
      ok((stdout + stderr).trim() || (erro ? String(erro) : 'ok'));
    });
  });
}

// ---------- consumo (histórico de CPU/memória e acessos aos sites) ----------

const INTERVALO_AMOSTRA = 5; // segundos
const PONTOS = 720; // 1 hora de amostras
const historico = { cpu: [], mem: [], processos: new Map() };
let cpusAntes = os.cpus();

function empurrar(lista, valor) {
  lista.push(valor);
  if (lista.length > PONTOS) lista.shift();
}

function cpuDoPc() {
  const agora = os.cpus();
  let total = 0;
  let ocioso = 0;
  agora.forEach((c, i) => {
    const antes = cpusAntes[i]?.times;
    if (!antes) return;
    for (const k of Object.keys(c.times)) total += c.times[k] - antes[k];
    ocioso += c.times.idle - antes.idle;
  });
  cpusAntes = agora;
  return total ? Math.round(100 * (1 - ocioso / total)) : 0;
}

async function amostrar() {
  empurrar(historico.cpu, cpuDoPc());
  empurrar(historico.mem, os.totalmem() - os.freemem());
  const lista = await processos();
  for (const nome of new Set([...lista.keys(), ...historico.processos.keys()])) {
    if (!historico.processos.has(nome)) historico.processos.set(nome, { cpu: [], mem: [] });
    const h = historico.processos.get(nome);
    const r = resumo(lista.get(nome));
    empurrar(h.cpu, r.status === 'online' ? r.cpu : 0);
    empurrar(h.mem, r.status === 'online' ? r.mem : 0);
    // Processo que sumiu há mais de 1h sai da lista.
    if (!lista.has(nome) && h.mem.every((m) => m === 0)) historico.processos.delete(nome);
  }
}

// Acessos: lê só o que foi acrescentado aos logs do Caddy desde a última leitura.
const acessos = new Map(); // site -> { posicao, resto, minutos: Map(minuto -> {req, bytes, erros, ips}), reqTotal, bytesTotal }

async function lerAcessos() {
  const agoraMin = Math.floor(Date.now() / 60000);
  for (const { nome } of lerDados().sites) {
    if (!acessos.has(nome)) acessos.set(nome, { posicao: 0, resto: '', minutos: new Map(), reqTotal: 0, bytesTotal: 0 });
    const a = acessos.get(nome);
    const arquivo = path.join(LOGS_SITES, `${nome}.log`);
    let tamanhoAtual;
    try { ({ size: tamanhoAtual } = await fsp.stat(arquivo)); } catch { continue; }
    if (tamanhoAtual < a.posicao) { a.posicao = 0; a.resto = ''; } // log foi rotacionado
    if (tamanhoAtual > a.posicao) {
      const h = await fsp.open(arquivo, 'r');
      const buf = Buffer.alloc(Math.min(tamanhoAtual - a.posicao, 50 * 1024 * 1024));
      await h.read(buf, 0, buf.length, a.posicao);
      await h.close();
      a.posicao += buf.length;
      const linhas = (a.resto + buf.toString('utf8')).split('\n');
      a.resto = linhas.pop();
      for (const linha of linhas) {
        let e;
        try { e = JSON.parse(linha); } catch { continue; }
        if (!e.request) continue;
        const bytes = e.size || 0;
        a.reqTotal++;
        a.bytesTotal += bytes;
        const minuto = Math.floor((e.ts || 0) / 60);
        if (agoraMin - minuto >= 60) continue;
        if (!a.minutos.has(minuto)) a.minutos.set(minuto, { req: 0, bytes: 0, erros: 0, ips: new Set() });
        const m = a.minutos.get(minuto);
        m.req++;
        m.bytes += bytes;
        if (e.status >= 400) m.erros++;
        // Atrás do túnel da Cloudflare o IP real do visitante vem neste cabeçalho.
        m.ips.add(e.request.headers?.['Cf-Connecting-Ip']?.[0] || e.request.remote_ip);
      }
    }
    for (const minuto of a.minutos.keys()) if (agoraMin - minuto >= 60) a.minutos.delete(minuto);
  }
}

function resumoAcessos(nome) {
  const a = acessos.get(nome);
  const agoraMin = Math.floor(Date.now() / 60000);
  const porMinuto = Array.from({ length: 60 }, (_, i) => a?.minutos.get(agoraMin - 59 + i)?.req || 0);
  const ips = new Set();
  let req = 0, bytes = 0, erros = 0;
  for (const m of a?.minutos.values() ?? []) {
    req += m.req; bytes += m.bytes; erros += m.erros;
    m.ips.forEach((ip) => ips.add(ip));
  }
  return { porMinuto, req1h: req, bytes1h: bytes, erros1h: erros, visitantes1h: ips.size, reqTotal: a?.reqTotal || 0, bytesTotal: a?.bytesTotal || 0 };
}

// ---------- arquivos ----------

async function listarArquivos(base, rel = '') {
  const saida = [];
  for (const d of await fsp.readdir(path.join(base, rel), { withFileTypes: true })) {
    if (IGNORAR.has(d.name)) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      saida.push({ caminho: r, pasta: true });
      saida.push(...(await listarArquivos(base, r)));
    } else {
      const { size } = await fsp.stat(path.join(base, r));
      saida.push({ caminho: r, pasta: false, tamanho: size });
    }
  }
  return saida;
}

function extrairZip(zipPath, destino) {
  const entradas = new AdmZip(zipPath).getEntries();
  // Se o zip tem uma única pasta no topo (ex.: "meu-site/index.html"), tira essa pasta.
  const topos = new Set(entradas.map((e) => e.entryName.split('/')[0]));
  const prefixo = topos.size === 1 && entradas.some((e) => e.entryName.includes('/')) ? [...topos][0] + '/' : '';
  let total = 0;
  for (const e of entradas) {
    const nome = e.entryName.slice(prefixo.length);
    if (!nome || nome.split('/').some((parte) => IGNORAR.has(parte))) continue;
    const alvo = dentro(destino, nome);
    if (e.isDirectory) {
      fs.mkdirSync(alvo, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(alvo), { recursive: true });
      fs.writeFileSync(alvo, e.getData());
      total++;
    }
  }
  return total;
}

// ---------- API ----------

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(AQUI, 'public')));
const upload = multer({ dest: path.join(os.tmpdir(), 'painel-uploads'), limits: { fileSize: 500 * 1024 * 1024 } });

const rota = (fn) => async (req, res) => {
  try {
    res.json((await fn(req, res)) ?? { ok: true });
  } catch (e) {
    res.status(e instanceof ErroUsuario ? 400 : 500).json({ erro: e.message });
  }
};

app.get('/api/estado', rota(async () => {
  const dados = lerDados();
  const lista = await processos();
  const sites = await Promise.all(dados.sites.map(async (s) => {
    const tunel = lista.get(`tunel-${s.nome}`);
    return { ...s, tunel: { ...resumo(tunel), url: await urlDoTunel(tunel) } };
  }));
  const bots = dados.bots.map((b) => ({
    ...b,
    ...resumo(lista.get(`bot-${b.nome}`)),
    temToken: temToken(pastaDe('bots', b.nome)),
    instalando: instalando.has(b.nome),
    instalado: fs.existsSync(path.join(pastaDe('bots', b.nome), 'node_modules')),
  }));
  const dominio = {
    nome: dados.dominio || null,
    conectado: fs.existsSync(CERT_CF),
    entrando: Boolean(login),
    linkLogin: login?.url || null,
    tunel: dados.tunel?.id || null,
    ...resumo(lista.get('tunel')),
  };
  return {
    servidorSites: resumo(lista.get('sites')), sites, bots, dominio,
    memoriaLivre: os.freemem(), memoriaTotal: os.totalmem(), ligadoHa: os.uptime(), maquina: os.hostname(),
  };
}));

app.get('/api/consumo', rota(() => {
  const tipo = (nome) => (nome === 'painel' ? 'painel' : nome === 'sites' ? 'http' : nome.startsWith('tunel') ? 'túnel' : nome.startsWith('bot-') ? 'bot' : 'outro');
  return {
    intervalo: INTERVALO_AMOSTRA,
    cpu: historico.cpu,
    mem: historico.mem,
    memTotal: os.totalmem(),
    nucleos: os.cpus().length,
    processos: [...historico.processos].map(([nome, h]) => ({ nome, tipo: tipo(nome), cpu: h.cpu, mem: h.mem })),
    sites: lerDados().sites.map((s) => ({ nome: s.nome, ...resumoAcessos(s.nome) })),
  };
}));

// Abre o navegador para você autorizar este PC na sua conta Cloudflare.
app.post('/api/dominio/login', rota(async () => {
  if (fs.existsSync(CERT_CF)) return;
  if (!login) {
    const proc = spawn(CLOUDFLARED, ['tunnel', 'login'], { windowsHide: true });
    login = { proc, url: null };
    const ler = (b) => { const m = String(b).match(/https:\/\/dash\.cloudflare\.com\/argotunnel\S+/); if (m && login) login.url = m[0]; };
    proc.stdout.on('data', ler);
    proc.stderr.on('data', ler);
    proc.on('exit', () => { login = null; });
  }
  for (let i = 0; i < 20 && login && !login.url; i++) await new Promise((r) => setTimeout(r, 250));
  return { url: login?.url || null };
}));

app.delete('/api/dominio/login', rota(async () => {
  login?.proc.kill();
  login = null;
}));

app.put('/api/dominio', rota(async (req) => {
  const dados = lerDados();
  const novo = dominioValido(req.body.dominio);
  if (!fs.existsSync(CERT_CF)) throw new ErroUsuario('Conecte sua conta Cloudflare primeiro.');
  if (dados.dominio && dados.dominio !== novo) {
    for (const s of dados.sites) delete s.endereco;
  }
  dados.dominio = novo;
  salvarDados(dados);
  await garantirTunel(dados);
  await aplicarTunel();
}));

app.put('/api/sites/:nome/endereco', rota(async (req) => {
  const dados = lerDados();
  const site = dados.sites.find((s) => s.nome === req.params.nome);
  if (!site) throw new ErroUsuario('Site não encontrado.');
  if (!dados.dominio) throw new ErroUsuario('Configure seu domínio na página "Domínio" primeiro.');
  const sub = String(req.body.subdominio ?? '').trim().toLowerCase();
  if (sub && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(sub)) throw new ErroUsuario('Subdomínio inválido: use letras, números e hífen.');
  const endereco = sub ? `${sub}.${dados.dominio}` : dados.dominio;
  const outro = dados.sites.find((s) => s.endereco === endereco && s !== site);
  if (outro) throw new ErroUsuario(`O site "${outro.nome}" já usa esse endereço.`);
  const tunel = await garantirTunel(dados);
  await cloudflared('tunnel', 'route', 'dns', '--overwrite-dns', tunel.id, endereco);
  site.endereco = endereco;
  salvarDados(dados);
  await aplicarTunel();
  return { endereco };
}));

app.delete('/api/sites/:nome/endereco', rota(async (req) => {
  const dados = lerDados();
  const site = dados.sites.find((s) => s.nome === req.params.nome);
  if (site) delete site.endereco;
  salvarDados(dados);
  await aplicarTunel();
}));

app.post('/api/sites', rota(async (req) => {
  const nome = nomeValido(req.body.nome);
  const dados = lerDados();
  if (dados.sites.some((s) => s.nome === nome)) throw new ErroUsuario('Já existe um site com esse nome.');
  const pasta = pastaDe('sites', nome);
  await fsp.mkdir(pasta, { recursive: true });
  if (!fs.existsSync(path.join(pasta, 'index.html'))) {
    await fsp.writeFile(path.join(pasta, 'index.html'),
      `<!doctype html>\n<html lang="pt-BR">\n<head><meta charset="utf-8"><title>${nome}</title></head>\n<body>\n  <h1>${nome}</h1>\n  <p>Substitua este arquivo pelos arquivos do seu site.</p>\n</body>\n</html>\n`);
  }
  const porta = Math.max(8079, ...dados.sites.map((s) => s.porta)) + 1;
  dados.sites.push({ nome, porta });
  salvarDados(dados);
  await aplicarSites();
}));

app.delete('/api/sites/:nome', rota(async (req) => {
  const nome = nomeValido(req.params.nome);
  const dados = lerDados();
  dados.sites = dados.sites.filter((s) => s.nome !== nome);
  salvarDados(dados);
  await remover(`tunel-${nome}`);
  await aplicarSites();
  await aplicarTunel();
  await fsp.rm(pastaDe('sites', nome), { recursive: true, force: true });
}));

app.post('/api/sites/reiniciar', rota(() => aplicarSites()));

app.post('/api/sites/:nome/tunel', rota(async (req) => {
  const site = lerDados().sites.find((s) => s.nome === req.params.nome);
  if (!site) throw new ErroUsuario('Site não encontrado.');
  await iniciarOuReiniciar({
    name: `tunel-${site.nome}`, script: CLOUDFLARED, interpreter: 'none',
    args: ['tunnel', '--no-autoupdate', '--url', `http://localhost:${site.porta}`],
  });
}));

app.delete('/api/sites/:nome/tunel', rota((req) => remover(`tunel-${nomeValido(req.params.nome)}`)));

app.post('/api/bots', rota(async (req) => {
  const nome = nomeValido(req.body.nome);
  const dados = lerDados();
  if (dados.bots.some((b) => b.nome === nome)) throw new ErroUsuario('Já existe um bot com esse nome.');
  const pasta = pastaDe('bots', nome);
  const vazio = !fs.existsSync(pasta) || fs.readdirSync(pasta).length === 0;
  await fsp.mkdir(pasta, { recursive: true });
  if (vazio && req.body.modelo !== false) {
    await fsp.cp(path.join(AQUI, 'modelos/bot'), pasta, { recursive: true });
    const pkg = JSON.parse(await fsp.readFile(path.join(pasta, 'package.json'), 'utf8'));
    pkg.name = nome;
    await fsp.writeFile(path.join(pasta, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    await fsp.copyFile(path.join(pasta, '.env.example'), path.join(pasta, '.env'));
  }
  dados.bots.push({ nome, principal: 'index.js' });
  salvarDados(dados);
  if (vazio && req.body.modelo !== false) npmInstall(nome);
}));

app.delete('/api/bots/:nome', rota(async (req) => {
  const nome = nomeValido(req.params.nome);
  const dados = lerDados();
  dados.bots = dados.bots.filter((b) => b.nome !== nome);
  salvarDados(dados);
  await remover(`bot-${nome}`);
  await fsp.rm(pastaDe('bots', nome), { recursive: true, force: true });
}));

app.put('/api/bots/:nome/config', rota(async (req) => {
  const nome = nomeValido(req.params.nome);
  const dados = lerDados();
  const bot = dados.bots.find((b) => b.nome === nome);
  if (!bot) throw new ErroUsuario('Bot não encontrado.');
  const pasta = pastaDe('bots', nome);
  if (req.body.principal) {
    dentro(pasta, req.body.principal);
    bot.principal = req.body.principal;
    salvarDados(dados);
  }
  if (req.body.token) {
    const arquivo = path.join(pasta, '.env');
    let env = fs.existsSync(arquivo) ? await fsp.readFile(arquivo, 'utf8') : '';
    const linha = `DISCORD_TOKEN=${req.body.token.trim()}`;
    env = /^DISCORD_TOKEN=.*$/m.test(env) ? env.replace(/^DISCORD_TOKEN=.*$/m, linha) : `${env}${env && !env.endsWith('\n') ? '\n' : ''}${linha}\n`;
    await fsp.writeFile(arquivo, env);
  }
}));

app.post('/api/bots/:nome/:acao', rota(async (req) => {
  const nome = nomeValido(req.params.nome);
  const dados = lerDados();
  const bot = dados.bots.find((b) => b.nome === nome);
  if (!bot) throw new ErroUsuario('Bot não encontrado.');
  const pasta = pastaDe('bots', nome);
  switch (req.params.acao) {
    case 'iniciar':
    case 'reiniciar': {
      if (!fs.existsSync(dentro(pasta, bot.principal))) {
        const achado = acharPrincipal(pasta);
        if (!achado) throw new ErroUsuario(`Arquivo principal "${bot.principal}" não existe. Defina o certo em [config].`);
        bot.principal = achado;
        salvarDados(dados);
      }
      // Bot enviado sem node_modules: instala as dependências antes de ligar.
      if (fs.existsSync(path.join(pasta, 'package.json')) && !fs.existsSync(path.join(pasta, 'node_modules'))) {
        const saida = await npmInstall(nome);
        if (!fs.existsSync(path.join(pasta, 'node_modules'))) throw new ErroUsuario(`Falha ao instalar as dependências: ${saida.split('\n').pop()}`);
      }
      const python = bot.principal.endsWith('.py');
      return iniciarOuReiniciar({
        name: `bot-${nome}`, script: bot.principal, cwd: pasta, restart_delay: 5000,
        ...(python ? { interpreter: 'python' } : {}),
      });
    }
    case 'parar':
      return remover(`bot-${nome}`);
    case 'instalar':
      return { saida: await npmInstall(nome) };
    default:
      throw new ErroUsuario('Ação desconhecida.');
  }
}));

app.get('/api/logs/:processo', rota(async (req) => {
  const p = (await processos()).get(req.params.processo);
  if (!p) return { texto: '(processo não está rodando — sem logs)' };
  const juntar = (t) => t.split('\n').slice(-200).join('\n');
  const saida = juntar(await finalDoArquivo(p.pm2_env.pm_out_log_path));
  const erros = juntar(await finalDoArquivo(p.pm2_env.pm_err_log_path));
  return { texto: `${saida}${erros.trim() ? `\n\n===== ERROS =====\n${erros}` : ''}` };
}));

app.get('/api/arquivos/:tipo/:nome', rota(async (req) => ({ arquivos: await listarArquivos(pastaDe(req.params.tipo, req.params.nome)) })));

app.get('/api/arquivo/:tipo/:nome', rota(async (req) => {
  const alvo = dentro(pastaDe(req.params.tipo, req.params.nome), req.query.caminho);
  const { size } = await fsp.stat(alvo);
  if (size > 2 * 1024 * 1024) throw new ErroUsuario('Arquivo grande demais para editar aqui.');
  return { conteudo: await fsp.readFile(alvo, 'utf8') };
}));

app.put('/api/arquivo/:tipo/:nome', rota(async (req) => {
  const alvo = dentro(pastaDe(req.params.tipo, req.params.nome), req.query.caminho);
  await fsp.mkdir(path.dirname(alvo), { recursive: true });
  await fsp.writeFile(alvo, req.body.conteudo ?? '');
}));

app.post('/api/pasta/:tipo/:nome', rota(async (req) => {
  await fsp.mkdir(dentro(pastaDe(req.params.tipo, req.params.nome), req.query.caminho), { recursive: true });
}));

app.delete('/api/arquivo/:tipo/:nome', rota(async (req) => {
  const base = pastaDe(req.params.tipo, req.params.nome);
  const alvo = dentro(base, req.query.caminho);
  if (alvo === base) throw new ErroUsuario('Não dá para apagar a pasta inteira por aqui.');
  await fsp.rm(alvo, { recursive: true, force: true });
}));

app.post('/api/upload/:tipo/:nome', upload.array('arquivos'), rota(async (req) => {
  const base = pastaDe(req.params.tipo, req.params.nome);
  const destino = dentro(base, req.body.pasta || '');
  const caminhos = [].concat(req.body.caminhos ?? []);
  const extrair = req.body.extrair === 'sim';
  let total = 0;
  try {
    for (const [i, arq] of (req.files ?? []).entries()) {
      const rel = caminhos[i] || arq.originalname;
      if (extrair && rel.toLowerCase().endsWith('.zip')) {
        total += extrairZip(arq.path, destino);
        continue;
      }
      const alvo = dentro(destino, rel);
      await fsp.mkdir(path.dirname(alvo), { recursive: true });
      await fsp.copyFile(arq.path, alvo);
      total++;
    }
  } finally {
    await Promise.all((req.files ?? []).map((a) => fsp.rm(a.path, { force: true })));
  }
  return { total };
}));

// ---------- início ----------

await pm('connect');
const lista = await processos();
if (lerDados().sites.length && resumo(lista.get('sites')).status !== 'online') await aplicarSites();
if (lerDados().sites.some((s) => s.endereco) && resumo(lista.get('tunel')).status !== 'online') await aplicarTunel().catch(console.error);

setInterval(() => { amostrar().catch(() => {}); lerAcessos().catch(() => {}); }, INTERVALO_AMOSTRA * 1000);
lerAcessos().catch(() => {});

// Só escuta no próprio PC: ninguém de fora consegue abrir o painel.
app.listen(PORTA_PAINEL, '127.0.0.1', () => console.log(`Painel em http://localhost:${PORTA_PAINEL}`));
