# Finance App — iPhone setup walkthrough

The mobile app is a React Native / Expo app in `mobile/`. It talks to
the same FastAPI backend the web app uses, just over the network instead
of through a Vite proxy. End state: you tap an icon (Expo Go), your app
loads, you see your real transactions on your phone.

## What's already in place

- `mobile/package.json` — Expo SDK 50 + React Native + TanStack Query +
  TypeScript.
- `mobile/App.tsx` — wires the QueryClient and renders one screen.
- `mobile/src/api/client.ts` — thin fetch client that reads the backend
  base URL from `EXPO_PUBLIC_API_URL`.
- `mobile/src/screens/TransactionsScreen.tsx` — Recent Transactions
  port. FlatList + pull-to-refresh + loading/error states.
- `mobile/.env.example` — template for the env var; copy to `.env`.
- `_start-mobile.bat` at the project root — one-click Expo dev server.

## One-time setup

### Step 1 — Get Expo Go on your iPhone

App Store → search "Expo Go" → install. No account, no signup.

### Step 2 — Install Node deps

**In a NEW PowerShell window — call it Window C — Mobile PowerShell:**

```powershell
cd "C:\Users\Chris\Documents\Claude\Projects\Finance App\mobile"
npm install
```

This will take 1–3 minutes the first time. You'll see warnings about
peer deps; they're fine for Expo SDK 54.

### Step 2a — Install the receipt-camera deps (once)

The Receipts screen now supports snapping a photo or picking from your
library. That requires two Expo modules. Install with `expo install` so
versions match the SDK:

**Window C — Mobile PowerShell:**

```powershell
cd "C:\Users\Chris\Documents\Claude\Projects\Finance App\mobile"
npx expo install expo-image-picker expo-haptics
```

After this lands, restart `_start-mobile.bat` (or whatever Expo dev
server is running) so Metro picks up the new modules. Camera + library
permissions are requested at first use — iOS shows a permission prompt
the first time you tap the buttons in the add-receipt sheet.

### Step 3 — Pick how the iPhone reaches your PC

Two options. Pick the one that fits your situation:

**Option A — Tailscale (works from anywhere, recommended):**

1. On your iPhone: install Tailscale from the App Store, log in with
   the same account as your PC.
2. **In any PowerShell on your PC**, find the PC's tailnet hostname:
   ```powershell
   tailscale status
   ```
   The first line is your PC's own entry — note the hostname (e.g.
   `chris-pc.tail12345.ts.net`) or the `100.x.y.z` Tailscale IP. Both work.

**Option B — Local WiFi only (no Tailscale required):**

1. iPhone and PC on the same WiFi network.
2. Find your PC's LAN IP. **In any PowerShell on your PC:**
   ```powershell
   ipconfig | Select-String "IPv4"
   ```
   Look for a line like `IPv4 Address. . . . . . . . . . . : 192.168.1.42`
   — that's the IP your iPhone will use.
3. **One-time firewall rule** (from an admin PowerShell):
   ```powershell
   New-NetFirewallRule -DisplayName "Finance App backend (8000)" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
   ```

### Step 4 — Wire the URL into the mobile app

**In Window C — Mobile PowerShell (still in `mobile\`):**

```powershell
copy .env.example .env
notepad .env
```

In Notepad, edit the line:

```
EXPO_PUBLIC_API_URL=http://CHANGEME:8000
```

Replace `CHANGEME` with whichever you picked in step 3:
- Tailscale: `EXPO_PUBLIC_API_URL=http://chris-pc.tail12345.ts.net:8000`
- Tailscale (IP form): `EXPO_PUBLIC_API_URL=http://100.x.y.z:8000`
- LAN: `EXPO_PUBLIC_API_URL=http://192.168.1.42:8000`

Save and close Notepad.

## Daily run loop

1. **Window A — Backend PowerShell:** make sure `uvicorn` is running
   (the regular `start-finance-app.bat` will start it). It must bind
   `0.0.0.0:8000`, which the launcher already does.
2. **Window C — Mobile PowerShell:**
   ```powershell
   cd "C:\Users\Chris\Documents\Claude\Projects\Finance App\mobile"
   npx expo start
   ```
   (or just double-click `_start-mobile.bat` at the project root.)
3. Expo CLI prints a QR code in the terminal. Open the **Camera app**
   on your iPhone, point at the QR. iOS surfaces a banner — tap it.
   Expo Go launches and your app boots.
4. The first time: it'll download the JS bundle (a few seconds) and
   then you see the **Recent transactions** screen with your real data.

### Hot reload

Save any `.tsx` file — the app reloads on the phone in under a second.
Shake the phone for the Expo dev menu (refresh, performance overlay,
etc.).

## Troubleshooting

**"Network request failed" / red error screen on iPhone.** The phone
can't reach the URL in `.env`. Common causes:
- You set it to `localhost` — that's the phone's loopback, not your PC.
  Use the LAN IP or Tailscale hostname.
- Backend isn't running on `0.0.0.0`. Check the backend window — should
  say `Uvicorn running on http://0.0.0.0:8000`.
- LAN option: firewall blocking. Run the firewall rule from step 3
  Option B again.
- LAN option: phone's WiFi dropped to a different SSID (guest network,
  cellular). Reconnect to the same WiFi as the PC.

**"Could not connect to development server" on Expo Go.** The Expo
metro bundler isn't reachable. By default Expo opens on `8081` and the
phone connects directly. If you're on Tailscale, run with the
`--tunnel` flag instead so Expo creates a public tunnel:

```powershell
npx expo start --tunnel
```

Slower than LAN but works through any network.

**Bundle download is slow.** Normal first time (~5–15 seconds for the
JS bundle). After the first run it's incremental.

**Want a real installable app (your icon, no Expo Go).** That's the
"development build" path — needs your MacBook for the first cloud
build. Run `eas build --platform ios --profile development` from the
MacBook once, install the resulting IPA on your phone via TestFlight
or USB. After that you can rebuild from Windows. Out of scope for this
walkthrough; come back to it later.

## What's intentionally NOT in this slice

- Multiple screens / navigation — single screen is enough to verify
  the pipe. Adding Expo Router or React Navigation is the next step
  once we know transactions render correctly.
- Native modules outside Expo Go's prebuilt set — none needed yet for
  what this app does (network + display).
- App Store distribution — that's months out at the earliest.
- Subscriptions, Goals, Credit screens — port them one at a time
  after Transactions is verified working.
