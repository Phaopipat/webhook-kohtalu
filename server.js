const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();

// ─── CONFIG (set in Railway Environment Variables) ───────────────────────────
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const PORT = process.env.PORT || 3000;

// ─── GOOGLE SHEETS SETUP ─────────────────────────────────────────────────────
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// ─── SHEET INITIALIZER (creates headers if sheet is empty) ───────────────────
async function initSheet() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Messages!A1:A1",
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Messages!A1",
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            "timestamp", "date", "time", "userId", "displayName",
            "messageType", "messageText", "messageId",
            "senderType", "replyToken", "webhookEventId"
          ]],
        },
      });
      console.log("✅ Sheet headers created");
    }
  } catch (err) {
    console.error("Sheet init error:", err.message);
  }
}

// ─── LOG MESSAGE TO SHEET ─────────────────────────────────────────────────────
async function logToSheet(row) {
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Messages!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.error("Sheet append error:", err.message);
  }
}

// ─── SIGNATURE VERIFICATION ───────────────────────────────────────────────────
function verifySignature(body, signature) {
  if (!LINE_CHANNEL_SECRET) return true; // skip in dev
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Koh Talu LINE Webhook",
    version: "1.0.0",
    sheetConfigured: !!GOOGLE_SHEET_ID,
  });
});

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // 1. Verify LINE signature
  const signature = req.headers["x-line-signature"];
  if (LINE_CHANNEL_SECRET && !verifySignature(req.rawBody, signature)) {
    console.warn("Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // 2. Always respond 200 immediately (LINE requires this)
  res.status(200).json({ status: "ok" });

  // 3. Process events asynchronously
  const { events } = req.body;
  if (!events || events.length === 0) return;

  for (const event of events) {
    try {
      await processEvent(event);
    } catch (err) {
      console.error("Event processing error:", err.message);
    }
  }
});

// ─── EVENT PROCESSOR ──────────────────────────────────────────────────────────
async function processEvent(event) {
  const now = new Date();
  // Convert to Thailand time (UTC+7)
  const thTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const timestamp = thTime.toISOString().replace("T", " ").substring(0, 19);
  const date = timestamp.substring(0, 10);
  const time = timestamp.substring(11, 19);

  const userId = event.source?.userId || "unknown";
  const senderType = event.source?.type || "unknown"; // user / room / group
  const replyToken = event.replyToken || "";
  const webhookEventId = event.webhookEventId || "";

  // Only process message events
  if (event.type !== "message") {
    console.log(`Skipped event type: ${event.type}`);
    return;
  }

  const msg = event.message;
  const messageId = msg.id || "";
  const messageType = msg.type || "unknown"; // text / image / sticker / file / video / audio

  let messageText = "";
  switch (msg.type) {
    case "text":    messageText = msg.text || ""; break;
    case "sticker": messageText = `[สติกเกอร์ id:${msg.stickerId}]`; break;
    case "image":   messageText = "[รูปภาพ]"; break;
    case "video":   messageText = "[วิดีโอ]"; break;
    case "audio":   messageText = "[เสียง]"; break;
    case "file":    messageText = `[ไฟล์: ${msg.fileName || "unknown"}]`; break;
    case "location":messageText = `[ตำแหน่ง: ${msg.address || ""}]`; break;
    default:        messageText = `[${msg.type}]`;
  }

  // displayName not available in webhook without Profile API call (keep simple)
  const displayName = userId.substring(0, 12) + "...";

  const row = [
    timestamp, date, time, userId, displayName,
    messageType, messageText, messageId,
    senderType, replyToken, webhookEventId
  ];

  await logToSheet(row);
  console.log(`✅ Logged: [${date} ${time}] ${messageType}: ${messageText.substring(0, 60)}`);
}

// ─── STATS ENDPOINT (used by dashboard) ───────────────────────────────────────
app.get("/stats", async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Messages!A2:K10000",
    });

    const rows = result.data.values || [];
    const total = rows.length;
    const users = [...new Set(rows.map(r => r[3]))].filter(Boolean);
    const msgTypes = {};
    const dateCount = {};

    for (const r of rows) {
      const type = r[5] || "unknown";
      msgTypes[type] = (msgTypes[type] || 0) + 1;
      const d = r[1] || "unknown";
      dateCount[d] = (dateCount[d] || 0) + 1;
    }

    res.json({
      totalMessages: total,
      uniqueUsers: users.length,
      messageTypes: msgTypes,
      dailyMessages: dateCount,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RECENT MESSAGES ENDPOINT ─────────────────────────────────────────────────
app.get("/recent", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50");
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Messages!A2:K10000",
    });
    const rows = (result.data.values || []).slice(-limit).reverse();
    const messages = rows.map(r => ({
      timestamp: r[0], date: r[1], time: r[2],
      userId: r[3], displayName: r[4],
      messageType: r[5], messageText: r[6],
      messageId: r[7], senderType: r[8],
    }));
    res.json({ messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Koh Talu Webhook server running on port ${PORT}`);
  if (GOOGLE_SHEET_ID) {
    await initSheet();
    console.log(`📊 Google Sheet connected: ${GOOGLE_SHEET_ID}`);
  } else {
    console.warn("⚠️  GOOGLE_SHEET_ID not set — messages will not be saved");
  }
});
