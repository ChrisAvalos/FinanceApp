@echo off
REM Helper launched by start-finance-app.bat in its own cmd window.
REM Runs the Vite dev server.
REM
REM %~dp0 = directory of THIS .bat (the project root, with trailing \).

cd /d "%~dp0web"
if errorlevel 1 (
    echo [frontend] cd to web\ failed. Project root looks like: %~dp0
    pause
    exit /b 1
)

if not exist "node_modules\.bin\vite" (
    if not exist "node_modules\.bin\vite.cmd" (
        echo [frontend] node_modules not populated. Run once:
        echo            cd web
        echo            npm install
        pause
        exit /b 1
    )
)

echo [frontend] Starting Vite on :5173...
echo.
npm run dev
