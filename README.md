# Nayroda Backroom Arena — WebSocket server

This server matches the message types used by the current Nayroda HTML client:
`create_room`, `join_room`, `reconnect`, `leave_room`, `room_snapshot`,
`start_match`, `player_state`, and game-event relays.

## Deploy to Render (Android-friendly)

1. Upload these files to a GitHub repository: `server.js`, `package.json`, `README.md`.
2. In Render, create **New → Web Service**, connect that repository.
3. Use:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance type: Free (for testing)
4. Deploy. Test the service URL by opening `/health`; it should show
   `Nayroda Backroom multiplayer server is online.`
5. WebSocket endpoint is the service URL with `/ws`, using `wss://` for Render.

## Important client setting

In the game HTML, set:
`const NETWORK_URL = 'wss://YOUR-RENDER-SERVICE.onrender.com/ws';`

The current game file already uses:
`wss://nayroda-backroom-server.onrender.com/ws`

If you create a new Render service with a different hostname, update only `NETWORK_URL`
in the HTML and redeploy the HTML host.

## Limitations of this starter

- Rooms and player state are stored in memory. A server restart or Render sleep/redeploy
  clears rooms; players must create/join again.
- Free Render services may sleep when idle and reconnect can take time.
- The server relays game events; it is not authoritative anti-cheat simulation.
  For production persistence and stronger security, use a database and validate combat
  server-side.
- The existing game client is host-driven for bot snapshots and some game events.
  This server preserves that protocol rather than replacing game mechanics.
