const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.WA_API_KEY || "change-this-secret-key";
const PORT = process.env.PORT || 3100;

// In-memory session store: userId -> { client, status, qr }
const sessions = new Map();

// Auth middleware
const auth = (req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
};

// Create or get a WhatsApp session for a user
function getOrCreateSession(userId) {
  if (sessions.has(userId)) return sessions.get(userId);

  const session = { client: null, status: "initializing", qr: null, phone: null };
  sessions.set(userId, session);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
      ],
    },
  });

  client.on("qr", async (qr) => {
    session.status = "qr_ready";
    session.qr = await QRCode.toDataURL(qr);
    console.log(`[${userId}] QR generated`);
  });

  client.on("ready", () => {
    session.status = "connected";
    session.qr = null;
    session.phone = client.info?.wid?.user || null;
    console.log(`[${userId}] Connected as ${session.phone}`);
  });

  client.on("authenticated", () => {
    session.status = "authenticated";
    console.log(`[${userId}] Authenticated`);
  });

  client.on("auth_failure", (msg) => {
    session.status = "auth_failed";
    session.qr = null;
    console.error(`[${userId}] Auth failed:`, msg);
  });

  client.on("disconnected", (reason) => {
    session.status = "disconnected";
    session.qr = null;
    session.phone = null;
    console.log(`[${userId}] Disconnected:`, reason);
    sessions.delete(userId);
    client.destroy().catch(() => {});
  });

  session.client = client;
  client.initialize().catch((err) => {
    console.error(`[${userId}] Init error:`, err.message);
    session.status = "error";
  });

  return session;
}

// ─── ROUTES ───

// Health check
app.get("/", (req, res) => res.json({ status: "ok", sessions: sessions.size }));

// Start session & get QR code
app.post("/session/start", auth, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const session = getOrCreateSession(userId);
  res.json({ status: session.status, qr: session.qr, phone: session.phone });
});

// Get session status (poll this)
app.get("/session/status/:userId", auth, (req, res) => {
  const session = sessions.get(req.params.userId);
  if (!session) return res.json({ status: "none" });
  res.json({ status: session.status, qr: session.qr, phone: session.phone });
});

// Disconnect session
app.post("/session/disconnect", auth, async (req, res) => {
  const { userId } = req.body;
  const session = sessions.get(userId);
  if (!session) return res.json({ status: "not_found" });

  try {
    await session.client.logout();
    await session.client.destroy();
  } catch {}
  sessions.delete(userId);
  res.json({ status: "disconnected" });
});

// Send a single message
app.post("/send", auth, async (req, res) => {
  const { userId, phone, message } = req.body;
  if (!userId || !phone || !message) {
    return res.status(400).json({ error: "userId, phone, message required" });
  }

  const session = sessions.get(userId);
  if (!session || session.status !== "connected") {
    return res.status(400).json({ error: "Session not connected", status: session?.status || "none" });
  }

  try {
    // Format phone: remove +, spaces, dashes. Add @c.us
    const chatId = phone.replace(/[\s\-\+]/g, "") + "@c.us";
    const result = await session.client.sendMessage(chatId, message);
    res.json({ success: true, messageId: result.id?.id });
  } catch (err) {
    console.error(`[${userId}] Send error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send bulk messages (with built-in delay)
app.post("/send/bulk", auth, async (req, res) => {
  const { userId, contacts, message } = req.body;
  if (!userId || !contacts?.length || !message) {
    return res.status(400).json({ error: "userId, contacts[], message required" });
  }

  const session = sessions.get(userId);
  if (!session || session.status !== "connected") {
    return res.status(400).json({ error: "Session not connected" });
  }

  // Send in background with delays
  res.json({ success: true, queued: contacts.length });

  let sent = 0, failed = 0;
  for (const phone of contacts) {
    try {
      const chatId = phone.replace(/[\s\-\+]/g, "") + "@c.us";
      await session.client.sendMessage(chatId, message);
      sent++;
    } catch {
      failed++;
    }
    // Random delay 3-10 seconds between messages
    const delay = Math.floor(Math.random() * 7000) + 3000;
    await new Promise((r) => setTimeout(r, delay));
  }
  console.log(`[${userId}] Bulk done: ${sent} sent, ${failed} failed`);
});

// List all active sessions (admin)
app.get("/sessions", auth, (req, res) => {
  const list = [];
  for (const [userId, s] of sessions) {
    list.push({ userId, status: s.status, phone: s.phone });
  }
  res.json(list);
});

app.listen(PORT, () => console.log(`WhatsApp server running on port ${PORT}`));
