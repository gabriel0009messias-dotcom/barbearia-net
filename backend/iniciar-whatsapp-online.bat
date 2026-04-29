@echo off
cd /d "%~dp0"

echo Iniciando bot local do WhatsApp...
start "Bot WhatsApp" cmd /k "cd /d %~dp0 && npm run bot"

echo Aguardando o bot subir...
timeout /t 5 /nobreak >nul

echo Iniciando tunnel publico do WhatsApp...
start "Tunnel WhatsApp" cmd /k "cloudflared tunnel --url http://127.0.0.1:3010 --logfile %~dp0cloudflared.log"

echo.
echo Pronto.
echo Deixe as duas janelas abertas:
echo 1. Bot WhatsApp
echo 2. Tunnel WhatsApp
echo.
echo Depois atualize o painel do barbeiro e clique em Gerar QR Code.
pause
