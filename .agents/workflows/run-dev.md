---
description: How to run the Jammin development server
---

## Steps

1. Make sure port 3000 is free (kill existing process if needed):
```bash
lsof -ti :3000 | xargs kill -9 2>/dev/null
```
// turbo

2. Start the dev server:
```bash
cd /Users/ronikagarwal/Desktop/jammin && npm run dev
```

3. Server runs at `http://localhost:3000`

## Environment Variables

- `YOUTUBE_API_KEY` — YouTube Data API v3 key (required for search)
- `PORT` — Server port (default: 3000)

## Notes

- No build step required — vanilla JS served statically
- `.env` is loaded by a custom parser in `server.js` (no `dotenv` dependency)
- WebSocket runs on the same port as the HTTP server
