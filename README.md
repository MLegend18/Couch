# Couch — watch together, go live together

A web app where friends join a room, watch YouTube videos in sync, chat, throw emoji reactions, and go live with their camera or screen.

## Run it on your computer

1. Install Node.js 18 or newer (https://nodejs.org).
2. In this folder, run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000, type a name, and join a room.
4. To try it with yourself, open a second browser window to the same room link.

Friends on other computers can't reach `localhost`. To use it with them, put it online (below).

## Put it online (free)

Render (https://render.com) works well and gives you HTTPS, which browsers require before they'll use a camera or screen share.

1. Put this folder in a GitHub repository.
2. On Render: **New → Web Service**, then pick the repository.
3. Build command: `npm install`. Start command: `npm start`. Instance type: Free.
4. Once it deploys, share the `https://….onrender.com` link.

Free Render services go to sleep when no one is using them, so the first visit after a break takes about 30 seconds to load.

## How it works

| Piece | How |
|---|---|
| Rooms, chat, reactions | Socket.IO in `server.js` |
| Synced YouTube | Every viewer plays the video on their own device. The server only keeps track of play, pause and the current time, so people who join late land at the right spot. Drift over 2.5 seconds is corrected automatically. |
| Go live | WebRTC: video goes straight from the streamer's browser to each viewer's browser. The server only passes the connection setup messages between them. One person can be live per room. |

Files: `server.js` (the server), `public/index.html`, `public/style.css`, `public/app.js` (the page).

## Known limits of this first version

- **Live audience size:** the streamer's own upload sends a separate copy to every viewer, so it works well for about 2 to 6 viewers. For bigger audiences, swap the WebRTC part for a media service such as LiveKit, Agora or Mux.
- **Some networks block live video**, mainly strict work, school or mobile networks. Fixing that needs a TURN relay server: add its address to `ICE` at the top of `public/app.js`. Metered.ca and Twilio both have free TURN tiers.
- **Anyone in a room can control playback.** A host-only mode would be a good next feature.
- **Nothing is saved.** A room and its chat disappear when the last person leaves.
- **Some YouTube videos can't be embedded**, because their owners have turned embedding off.
