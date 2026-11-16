# Datacel Servidor

Painel para transformar um PC comum num servidor de hospedagem, sem pagar assinatura. Ele hospeda **sites estáticos** e mantém **bots e apps Node.js/Python** sempre ligados, tudo controlado por uma interface web e por um aplicativo de desktop.

Com um domínio próprio, cada site pode ganhar um subdomínio público (`blog.seudominio.com.br`) por meio de um túnel da Cloudflare, sem abrir porta no roteador.

## Funcionalidades

**Sites**
- Criar, remover e reiniciar sites. Cada pasta em `sites/` vira um site servido pelo [Caddy](https://caddyserver.com) numa porta própria (8080, 8081...).
- Gerenciador de arquivos no painel: navegar, editar, criar pastas e enviar arquivos (inclusive `.zip`, que é extraído automaticamente).
- Logs de acesso por site.
- **Link rápido**: publica um site na hora num endereço temporário `*.trycloudflare.com`, sem precisar de domínio.

**Bots e apps**
- Cada pasta em `bots/` é um processo mantido no ar pelo [PM2](https://pm2.keymetrics.io), que reinicia se cair.
- Ligar, desligar e reiniciar pelo painel, com logs ao vivo.
- `npm install` das dependências com um clique.
- Configuração do token de bots do Discord direto na interface (gravado no `.env` do bot).
- Modelo pronto de bot de Discord para começar do zero (`painel/modelos/bot`).

**Domínio**
- Login na Cloudflare pelo navegador e criação do túnel com um clique.
- Associação de um subdomínio para cada site.

**Monitoramento**
- Consumo de CPU e memória de cada processo.

**Aplicativo de desktop**
- App em Electron com instalador para Windows, ícone na bandeja e opção de iniciar com o Windows.
- Fechar a janela não derruba nada: o painel, os sites e os bots continuam rodando pelo PM2.

## Como usar

Pré-requisitos: [Node.js](https://nodejs.org), PM2 (`npm i -g pm2`) e [Caddy](https://caddyserver.com) no PATH. Para domínio próprio, também o [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

```bash
cd painel
npm install
pm2 start server.js --name painel
```

Abra **http://localhost:3000**, ou use o `abrir-painel.bat`. O painel só aceita conexões do próprio PC.

Para ligar tudo automaticamente ao entrar no Windows:

```powershell
.\ativar-inicio-automatico.ps1
```

### Aplicativo de desktop

```bash
cd app
npm install
npm start            # abre o app
npm run instalador   # gera o instalador .exe em app/dist
```

### Colocar um bot do Discord no ar

1. Crie o bot em <https://discord.com/developers/applications> e copie o token.
2. No painel: **Bots → Novo** (ou envie a pasta do seu bot), depois **⚙️ Config**, cole o token e clique em **▶ Ligar**.

### Domínio próprio

1. Adicione o domínio na Cloudflare (plano grátis) e troque os servidores DNS no registro.br pelos da Cloudflare.
2. No painel: **Domínio → Conectar à Cloudflare** e confirme a criação do túnel.
3. Em cada site: **Colocar no domínio** e escolha o subdomínio.

## Estrutura

```
painel/
  server.js        API (Express) que controla Caddy, PM2, arquivos e Cloudflare
  public/          interface do painel
  modelos/bot/     modelo de bot de Discord
app/
  main.js          aplicativo Electron (janela + bandeja)
  preload.js
sites/             um site por pasta
bots/              um bot/app por pasta
Caddyfile          gerado pelo painel
```

## Tecnologias

Node.js, Express 5, Multer, adm-zip, PM2, Caddy, Cloudflare Tunnel e Electron.
