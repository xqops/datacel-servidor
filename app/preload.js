// Ponte entre a interface do painel e o aplicativo (só o necessário, nada de acesso ao sistema).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('janelaApp', {
  minimizar: () => ipcRenderer.send('janela', 'minimizar'),
  maximizar: () => ipcRenderer.send('janela', 'maximizar'),
  fechar: () => ipcRenderer.send('janela', 'fechar'),
  config: () => ipcRenderer.invoke('config'),
  definir: (chave, valor) => ipcRenderer.invoke('definir', chave, valor),
  estado: (resumo) => ipcRenderer.send('estado', resumo),
});
