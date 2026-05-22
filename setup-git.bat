@echo off
REM ====================================================================
REM  setup-git.bat  -  one-time git version control setup for Finance App
REM  Double-click this file, or run it from a terminal in this folder.
REM  Safe to re-run: it removes any half-finished .git and starts clean.
REM ====================================================================
cd /d "%~dp0"

echo.
echo === Finance App :: git setup ===
echo.

REM --- 1. Verify git is installed -------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo ERROR: git was not found on your PATH.
  echo Install "Git for Windows" from https://git-scm.com/download/win
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM --- 2. Remove any partial/corrupt .git from earlier attempts -------
if exist ".git" (
  echo Removing a previous partial .git folder...
  rmdir /s /q ".git"
)

REM --- 3. Initialize the repository ----------------------------------
echo Initializing repository on branch "main"...
git init -b main
git config user.name "ChrisAvalos"
git config user.email "avaloschris94@gmail.com"

REM --- 4. Stage everything (.gitignore excludes secrets + data) ------
echo Staging files...
git add -A

echo.
echo Files about to be committed:
git diff --cached --name-only | find /c /v ""
echo (full list: run "git status")
echo.

REM --- 5. Initial commit --------------------------------------------
git commit -m "Initial commit: Finance App - local-first personal finance engine (FastAPI backend, React web, mobile app, project docs)"

REM --- 6. Connect the GitHub remote ---------------------------------
echo Connecting GitHub remote...
git remote remove origin >nul 2>nul
git remote add origin https://ChrisAvalos@github.com/ChrisAvalos/FinanceApp.git

echo.
echo ====================================================================
echo  Local repository is ready.
echo.
echo  FINAL STEP - push to GitHub. Run this command:
echo.
echo      git push -u origin main --force
echo.
echo  Notes:
echo   * --force replaces the README/LICENSE-only "Initial commit"
echo     currently on GitHub with this full one. Nothing of yours is lost
echo     (a fuller README and an MIT LICENSE are both included here).
echo   * You'll be asked to sign in to GitHub the first time you push.
echo   * Remember to switch the repo to Private on GitHub first:
echo     Settings -^> General -^> Danger Zone -^> Change visibility.
echo ====================================================================
echo.
pause
