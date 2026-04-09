// api/slack-post.js
// Posts a Slack message using the member's stored xoxp token.
// Token is fetched server-side — never exposed to the browser.

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore }                  from "firebase-admin/firestore";

function getDb() {
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")   { res.status(405).json({ error: "Method not allowed" }); return; }

  const { memberName, channelId, text, blocks } = req.body || {};
  if (!memberName || !channelId) {
    return res.status(400).json({ error: "memberName and channelId are required" });
  }

  try {
    const db  = getDb();
    const doc = await db.collection("slackSettings").doc(memberName).get();
    if (!doc.exists) return res.status(404).json({ error: "No Slack token found for this member. Please save your token in Slack Settings." });

    const token = doc.data()?.token;
    if (!token) return res.status(404).json({ error: "Slack token not configured." });

    const payload = { channel: channelId, text: text || "" };
    if (blocks?.length) payload.blocks = blocks;

    const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method:  "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Authorization": `Bearer ${token}` },
      body:    JSON.stringify(payload),
    });

    const data = await slackRes.json();
    if (!data.ok) return res.status(400).json({ error: data.error || "Slack API error" });

    return res.status(200).json({ ok: true, ts: data.ts });
  } catch (e) {
    console.error("slack-post error:", e);
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
