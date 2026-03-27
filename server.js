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

function parseServiceAccount(raw) {
    if (!raw || raw === "{}") {
          console.error("❌ GOOGLE_SERVICE_ACCOUNT_JSON is empty or not set");
          return null;
    }
    try {
          // Railway sometimes double-escapes newlines in private_key
      const fixed = raw.replace(/\\\\n/g, "\\n");
          const creds = JSON.parse(fixed);
          if (!creds.client_email) {
                  console.error("❌ Service Account JSON is missing 'client_email' field");
                  console.error("   Keys found:", Object.keys(creds).join(", "));
                  return null;
          }
          if (!creds.private_key) {
                  console.error("❌ Service Account JSON is missing 'private_key' field");
                  return null;
          }
          console.log(`✅ Service Account loaded: ${creds.client_email}`);
          return creds;
    } catch (err) {
          console.error("❌ Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", err.message);
          console.error("   First 80 chars:", raw.substring(0, 80));
          return null;
    }
}

const serviceAccountCreds = parseServiceAccount(GOOGLE_SERVICE_ACCOUNT_JSON);

async function getSheetsClient() {
    if (sheetsClient) return sheetsClient;
    if (!serviceAccountCreds) {
          throw new Error("No valid service account credentials");
    }
    const auth = new google.auth.GoogleAuth({
          credentials: serviceAccountCreds,
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
    const signature = req.headers["x-line-signature"];
    if (LINE_CHANNEL_SECRET && !verifySignature(req.rawBody, signature)) {
          console.warn("Invalid signature");
          return res.status(401).json({ error: "Invalid signature" });
    }
    res.status(200).json({ status: "ok" });
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
    const thTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const timestamp = thTime.toISOString().replace("T", " ").substring(0, 19);
    const date = timestamp.substring(0, 10);
    const time = timestamp.substring(11, 19);
    const userId = event.source?.userId || "unknown";
    const senderType = event.source?.type || "unknown";
    const replyToken = event.replyToken || "";
    const webhookEventId = event.webhookEventId || "";
    if (event.type !== "message") {
          console.log(`Skipped event type: ${event.type}`);
          return;
    }
    const msg = event.message;
    const messageId = msg.id || "";
    const messageType = msg.type || "unknown";
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
    const displayName = userId.substring(0, 12) + "...";
    const row = [
          timestamp, date, time, userId, displayName,
          messageType, messageText, messageId,
          senderType, replyToken, webhookEventId
        ];
    await logToSheet(row);
    console.log(`✅ Logged: [${date} ${time}] ${messageType}: ${messageText.substring(0, 60)}`);
}

// ─── STATS ENDPOINT ───────────────────────────────────────────────────────────
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
    const envStatus = {
          LINE_CHANNEL_SECRET: LINE_CHANNEL_SECRET ? "✅ set" : "⚠️  not set",
          GOOGLE_SHEET_ID: GOOGLE_SHEET_ID ? "✅ set" : "❌ not set",
          GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountCreds ? "✅ valid" : "❌ invalid or not set",
    };
    console.log("── Environment Check ──");
    for (const [key, status] of Object.entries(envStatus)) {
          console.log(`  ${key}: ${status}`);
    }
    console.log("───────────────────────");
    if (GOOGLE_SHEET_ID && serviceAccountCreds) {
          await initSheet();
          console.log(`📊 Google Sheet connected: ${GOOGLE_SHEET_ID}`);
    } else {
          if (!GOOGLE_SHEET_ID) console.warn("⚠️  GOOGLE_SHEET_ID not set — messages will not be saved");
          if (!serviceAccountCreds) console.warn("⚠️  Service account invalid — cannot save to Sheet");
    }
});
