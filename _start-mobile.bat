@echo off
REM Spawned by start-finance-app.bat (or run directly). Boots the Expo
REM dev server in the mobile\ folder. The first time it runs you'll need
REM to have already done `npm install` inside mobile\ — see MOBILE_SETUP.md.

cd /d "%~dp0mobile"
if errorlevel 1 (
    echo [mobile] cd to mobile\ failed. Project root looks like: %~dp0
    pause
    exit /b 1
)

if not exist "node_modules\expo" (
    echo [mobile] node_modules missing. Run once before using this launcher:
    echo            cd mobile
    echo            npm install
    echo See MOBILE_SETUP.md for the full first-time setup walkthrough.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [mobile] mobile\.env not found. Copy .env.example to .env and fill
    echo          in EXPO_PUBLIC_API_URL with your PC's reachable URL
    echo          (LAN IP or Tailscale hostname).
    pause
    exit /b 1
)

echo [mobile] Starting Expo dev server...
echo          QR code will appear below — scan with Expo Go on your iPhone.
echo.
npx expo start
