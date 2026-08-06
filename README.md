# Spark Quiz

Live classroom quiz website — English with Rida.

## Run it

```
npm install
npm start
```

Then open:
- http://localhost:3000/admin.html — edit the question bank
- http://localhost:3000/host.html — teacher's projected screen (creates a game + PIN)
- http://localhost:3000/join.html — students go here, enter the PIN shown on the host screen

## How it works

- `server.js` — Express + WebSocket backend. Sessions (PIN, players, live state) are kept in memory, so restarting the server clears active games. Questions persist to `questions.json`.
- `public/` — the four pages, each wired to the backend over REST (join/create session) and WebSocket (live game sync).

## Try the full flow

1. Open `/host.html` in one tab — note the PIN.
2. Open `/join.html` in another tab (or on your phone on the same network, using your computer's local IP instead of localhost) — enter the PIN, pick a nickname and avatar.
3. Back on the host tab, click "Start game" once at least one student has joined.
4. Answer on the student tab — watch the live bar chart update on the host tab.
5. Click "Lock answers & reveal" then "Show standings" to advance through the game.

## Known limits (see spark-quiz-backend-spec.md for the fuller plan)

- In-memory sessions — a server restart drops any game in progress.
- No accounts/login — anyone with the admin URL can edit questions.
- No reconnect-and-resync yet if a student's browser refreshes mid-game.
- Not deployed anywhere yet — this runs locally until you host it somewhere (Render, Railway, Fly.io, etc. all work for a small Node app like this).
