// api/slack-post.js
// Posts a Slack message using the member's xoxp token passed from the frontend.

export default async function handler(req, res) {
  const allowedOrigins = [
    "https://rhlsinghal.github.io",
    "http://localhost:3000",
  ];
  const origin = req.headers.origin || "";
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")   { res.status(405).json({ error: "Method not allowed" }); return; }

  const { token, channelId, text, blocks } = req.body || {};
  if (!token)     return res.status(400).json({ error: "token is required" });
  if (!channelId) return res.status(400).json({ error: "channelId is required" });

  try {
    const payload = { channel: channelId, text: text || "" };
    if (blocks?.length) payload.blocks = blocks;

    const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json; charset=utf-8",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await slackRes.json();
    if (!data.ok) return res.status(400).json({ error: data.error || "Slack API error" });

    return res.status(200).json({ ok: true, ts: data.ts });
  } catch (e) {
    console.error("slack-post error:", e);
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
