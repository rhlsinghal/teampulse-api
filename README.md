# teampulse-api

Anthropic API proxy for TeamPulse. Deployed on Vercel.

## Setup

1. Deploy this repo to Vercel (connect via GitHub)
2. In Vercel → Settings → Environment Variables, add:
   - `ANTHROPIC_API_KEY` = your key from console.anthropic.com
3. In `api/chat.js`, update `allowedOrigins` with your GitHub Pages URL
4. In your TeamPulse app, set `REACT_APP_AI_PROXY_URL` to your Vercel deployment URL

## Endpoint

`POST /api/chat` — proxies requests to Anthropic's `/v1/messages` endpoint.
