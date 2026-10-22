@echo off
rem QQ Agent launcher (desktop app, no npm window)
rem NOTE: keep this file ASCII-only. cmd parses .bat in GBK on Chinese
rem Windows; UTF-8 Chinese comments swallow the newline and break parsing.
rem 2026-09-23: check electron.exe exists; a missing exe would otherwise
rem make the double-click look completely dead with zero feedback.
rem
rem 2026-10-20: PROXY for OpenAI image generation.
rem   Why: the TUN VPN on this box routes api.openai.com to a dead fake-IP
rem   (ECONNRESET), while the local Clash proxy on 7890 reaches it fine (401).
rem   Electron 35 (Node 22) honours HTTPS_PROXY by itself - do NOT also set
rem   NODE_USE_ENV_PROXY, that combination was measured to fail.
rem   NO_PROXY keeps domestic services direct, so the bot still works when
rem   Clash is not running: chat (DeepSeek), GLM image, bilibili, snowluma.
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=http://127.0.0.1:7890
set NO_PROXY=127.0.0.1,localhost,::1,api.deepseek.com,open.bigmodel.cn,api.bilibili.com,ark.cn-beijing.volces.com,volcengine.com,snowluma
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [QQ Agent] electron.exe not found under node_modules\electron\dist\
  echo [QQ Agent] fix: run npm install first
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
