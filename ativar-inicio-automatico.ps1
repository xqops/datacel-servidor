# Faz o painel, os sites e os bots ligarem sozinhos quando você entra no Windows.
pm2 save
$pm2 = Join-Path (npm prefix -g) 'pm2.cmd'
$acao = New-ScheduledTaskAction -Execute $pm2 -Argument 'resurrect'
$gatilho = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName 'Meu Servidor (PM2)' -Action $acao -Trigger $gatilho -Settings $config -Force
Write-Host 'Pronto! O servidor vai ligar sozinho ao entrar no Windows.'
