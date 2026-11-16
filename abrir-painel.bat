@echo off
rem Liga o painel (se estiver desligado) e abre no navegador.
call pm2 describe painel >nul 2>&1 || call pm2 start "%~dp0painel\server.js" --name painel --cwd "%~dp0painel"
start http://localhost:3000
