const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const app = express();

// CORS — handle ALL requests including preflight
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

const API_KEY = process.env.WA_API_KEY || "change-this-secret-key";
const PORT = process.env.PORT || 3100;

const sessions = new Map();

const auth = (req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
};

function getOrCreateSession(userId) {
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    // If stuck in error/auth_failed, clean up and recreate
    if (existing.status === "error" || existing.status === "auth_failed") {
      cleanup(userId);
    } else {
      return existing;
    }
  }

  const session = { client: null, status: "initializing", qr: null, phone: null, error: null };
  sessions.set(userId, session);
  console.log(`[${userId}] Creating session...`);

  const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  console.log(`[${userId}] Chromium path: ${chromePath || "bundled"}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    webVersionCache: { type: "none" },
    puppeteer: {
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--no-first-run",
        "--js-flags=--max-old-space-size=256",
      ],
    },
    qrMaxRetries: 5,
  });

  client.on("loading_screen", (percent, message) => {
    session.status = "loading";
    console.log(`[${userId}] Loading: ${percent}% - ${message}`);
  });

  client.on("qr", async (qr) => {
    session.status = "qr_ready";
    session.qr = await QRCode.toDataURL(qr);
    console.log(`[${userId}] QR ready`);
  });

  client.on("authenticated", () => {
    session.status = "authenticated";
    session.qr = null;
    console.log(`[${userId}] Authenticated — loading WhatsApp...`);
  });

  client.on("ready", () => {
    session.status = "connected";
    session.qr = null;
    session.phone = client.info?.wid?.user || null;
    console.log(`[${userId}] Connected as ${session.phone}`);
  });

  client.on("auth_failure", (msg) => {
    session.status = "auth_failed";
    session.error = String(msg);
    session.qr = null;
    console.error(`[${userId}] Auth failed:`, msg);
  });

  client.on("disconnected", (reason) => {
    console.log(`[${userId}] Disconnected:`, reason);
    cleanup(userId);
  });

  session.client = client;
  client.initialize().catch((err) => {
    console.error(`[${userId}] Init error:`, err.message);
    session.status = "error";
    session.error = err.message;
  });

  return session;
}

function cleanup(userId) {
  const s = sessions.get(userId);
  if (s?.client) {
    try { s.client.destroy(); } catch {}
  }
  sessions.delete(userId);
  console.log(`[${userId}] Cleaned up`);
}

// Health
app.get("/", (req, res) => {
  const list = [];
  for (const [uid, s] of sessions) list.push({ userId: uid, status: s.status, phone: s.phone });
  res.json({ status: "ok", sessions: sessions.size, mem: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB", details: list });
});

// Start session
app.post("/session/start", auth, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = getOrCreateSession(userId);
  res.json({ status: session.status, qr: session.qr, phone: session.phone, error: session.error });
});

// Poll status
app.get("/session/status/:userId", auth, (req, res) => {
  const session = sessions.get(req.params.userId);
  if (!session) return res.json({ status: "none" });
  res.json({ status: session.status, qr: session.qr, phone: session.phone, error: session.error });
});

// Disconnect
app.post("/session/disconnect", auth, async (req, res) => {
  const { userId } = req.body;
  const session = sessions.get(userId);
  if (!session) return res.json({ status: "not_found" });
  try { await session.client.logout(); } catch {}
  cleanup(userId);
  res.json({ status: "disconnected" });
});

// Send single
app.post("/send", auth, async (req, res) => {
  const { userId, phone, message } = req.body;
  if (!userId || !phone || !message) return res.status(400).json({ error: "userId, phone, message required" });
  const session = sessions.get(userId);
  if (!session || session.status !== "connected") return res.status(400).json({ error: "Session not connected", status: session?.status || "none" });
  try {
    const chatId = phone.replace(/[\s\-\+]/g, "") + "@c.us";
    const result = await session.client.sendMessage(chatId, message);
    res.json({ success: true, messageId: result.id?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send bulk
app.post("/send/bulk", auth, async (req, res) => {
  const { userId, contacts, message } = req.body;
  if (!userId || !contacts?.length || !message) return res.status(400).json({ error: "userId, contacts[], message required" });
  const session = sessions.get(userId);
  if (!session || session.status !== "connected") return res.status(400).json({ error: "Session not connected" });
  res.json({ success: true, queued: contacts.length });
  let sent = 0, failed = 0;
  for (const phone of contacts) {
    try {
      const chatId = phone.replace(/[\s\-\+]/g, "") + "@c.us";
      await session.client.sendMessage(chatId, message);
      sent++;
    } catch { failed++; }
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 7000) + 3000));
  }
  console.log(`[${userId}] Bulk: ${sent} sent, ${failed} failed`);
});

// Admin list
app.get("/sessions", auth, (req, res) => {
  const list = [];
  for (const [userId, s] of sessions) list.push({ userId, status: s.status, phone: s.phone });
  res.json(list);
});

// Catch uncaught errors so server doesn't crash
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED]", err);
});

app.listen(PORT, () => {
  console.log(`WhatsApp server on port ${PORT}`);
});
