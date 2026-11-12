# Jeopardy+

## Run locally

Install dependencies once:

```powershell
npm install
```

Start the web app and game server:

```powershell
npm run dev:network
```

Open the host page at `http://localhost:5173/host`.

## Connect phones on the same Wi-Fi

1. Connect the host computer and every phone to the same Wi-Fi network.
2. Find the host computer's local IPv4 address:

   ```powershell
   ipconfig
   ```

   Use the IPv4 address from the active Wi-Fi adapter, such as `192.168.1.25`.
3. On the host computer, open `http://192.168.1.25:5173/host`.
4. On each phone, open `http://192.168.1.25:5173/` and join using the room code shown by the host.

The browser uses the page hostname for WebSocket and media connections, so phones must use the host computer's local IP rather than `localhost`. If Windows Firewall prompts for Node.js access, allow it on private networks.
