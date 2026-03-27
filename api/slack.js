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
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  if (!process.env.SLACK_WEBHOOK_URL) {
    res.status(500).json({ error: "SLACK_WEBHOOK_URL not configured" });
    return;
  }
  if (!process.env.SLACK_BOT_TOKEN) {
    res.status(500).json({ error: "SLACK_BOT_TOKEN not configured" });
    return;
  }

  try {
    const { members } = req.body;
    // members = [{ name: "Lenin Bakhara", email: "lenin@company.com" }, ...]
    if (!members?.length) {
      res.status(400).json({ error: "No members provided" });
      return;
    }

    // ── Look up each member's Slack ID from their email ──────────────────────
    const resolvedMembers = await Promise.all(
      members.map(async (m) => {
        try {
          const lookupRes = await fetch(
            `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(m.email)}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json",
              },
            }
          );
          const data = await lookupRes.json();
          if (data.ok && data.user?.id) {
            return { ...m, slackId: data.user.id };
          }
          // If lookup fails, fall back to plain name
          return { ...m, slackId: null };
        } catch {
          return { ...m, slackId: null };
        }
      })
    );

    // ── Build mention list ───────────────────────────────────────────────────
    const memberList = resolvedMembers
      .map(m => m.slackId ? `• <@${m.slackId}>` : `• ${m.name}`)
      .join("\n");

    const message = {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*📋 TeamPulse — Daily standup reminder*`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `The following team members haven't submitted their standup update yet today:\n\n${memberList}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Please log in to TeamPulse and submit your update. It only takes 2 minutes! 🙏`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Sent by TeamPulse · ${new Date().toLocaleDateString("en-US", {
                weekday: "long", month: "long", day: "numeric",
              })}`,
            },
          ],
        },
      ],
    };

    const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack returned ${response.status}`);
    }

    // Report how many were resolved vs fell back to name
    const resolved   = resolvedMembers.filter(m => m.slackId).length;
    const unresolved = resolvedMembers.filter(m => !m.slackId).length;

    res.status(200).json({
      success:    true,
      reminded:   members.length,
      mentioned:  resolved,
      namedOnly:  unresolved,
    });

  } catch (e) {
    console.error("Slack error:", e);
    res.status(500).json({ error: "Failed to send Slack message" });
  }
}
