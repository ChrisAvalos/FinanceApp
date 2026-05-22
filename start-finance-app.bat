@echo off
REM =====================================================================
REM Finance App - one-click dev launcher
REM
REM Spawns two cmd windows (backend + frontend), each running a helper
REM .bat in this same folder. Helpers do the cd / venv / run dance, so
REM this top-level launcher avoids the cmd quoting hell that broke v1.
REM
REM Helpers: _start-backend.bat, _start-frontend.bat
REM
REM First-time setup needed in each subfolder before this works:
REM   backend\:  py -m venv .venv  &  .venv\Scripts\activate  &  pip install -e ".[dev]"
REM   web\:      npm install
REM =====================================================================

echo.
echo ============================================================
echo   Finance App launcher
echo   Project root: %~dp0
echo ============================================================
echo.

echo [1/2] Spawning Backend window (uvicorn :8000)...
start "Finance Backend (uvicorn :8000)" cmd /k "%~dp0_start-backend.bat"

REM Give the backend a head start so the frontend's first proxy request lands clean.
timeout /t 2 /nobreak >nul

echo [2/2] Spawning Frontend window (vite :5173)...
start "Finance Frontend (vite :5173)" cmd /k "%~dp0_start-frontend.bat"

echo.
echo Both windows spawned. Watch them for startup output:
echo   Backend:  "Application startup complete." + "Uvicorn running on http://0.0.0.0:8000"
echo   Frontend: "Local: http://localhost:5173/"
echo.
echo This launcher will close in 5 seconds. The two server windows keep running.
timeout /t 5 /nobreak >nul
