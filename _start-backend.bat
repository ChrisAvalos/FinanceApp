@echo off
REM Helper launched by start-finance-app.bat in its own cmd window.
REM Activates the venv and runs uvicorn with --reload.
REM
REM %~dp0 = directory of THIS .bat (the project root, with trailing \).

cd /d "%~dp0backend"
if errorlevel 1 (
    echo [backend] cd to backend\ failed. Project root looks like: %~dp0
    pause
    exit /b 1
)

if not exist ".venv\Scripts\activate.bat" (
    echo [backend] No venv found at backend\.venv. Run this once to create it:
    echo            py -m venv .venv
    echo            .venv\Scripts\activate
    echo            pip install -e ".[dev]"
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat
echo [backend] venv activated. Starting uvicorn on :8000...
echo.
uvicorn finance_app.api.main:app --reload --host 0.0.0.0 --port 8000
