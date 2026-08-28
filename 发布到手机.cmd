@echo off
chcp 65001 >nul
title MarketPulse Mobile Deploy
cd /d "%~dp0"

rem ---- make sure freshly-installed git is reachable even in stale PATH ----
set "PATH=%PATH%;C:\Program Files\Git\cmd;C:\Program Files (x86)\Git\cmd"

rem ---- fallback init (only first time) ----
if not exist ".git" (
  echo === First run: initializing repo ===
  git init -b main
  git remote add origin https://github.com/TXYR7/marketpulse-mobile.git
)

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git not found in PATH. Reopen this window after installing Git.
  pause
  exit /b 1
)

node scripts/bump-sw.mjs`r`necho === Adding files ===
git add -A
if errorlevel 1 goto fail

echo === Committing ===
git commit -m "mobile update %date% %time%"
if errorlevel 1 echo (nothing new to commit, still pushing)

echo === Pushing to GitHub Pages ===
git push origin main
if errorlevel 1 goto fail

echo.
echo [OK] Pushed. GitHub Pages auto-publishes in 1-2 minutes.
echo      Phone: reopen the app ^(pull-to-refresh twice if old screen persists^).
pause
exit /b 0

:fail
echo.
echo [FAIL] See messages above. If a GitHub login window appeared, finish it and re-run this script.
pause
exit /b 1
