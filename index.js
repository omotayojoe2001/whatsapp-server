const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const app = express();
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
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const AUTH_DIR = path.join(process.cwd(), "auth_sessions");

const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const logger = pino({ level: "silent" });

// Session store: userId -> { sock, status, qr, phone }
const sessions = new Map();
const rateLimits = new Map();

const auth = (req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
};

// ─── RATE LIMITER ───
function getRateLimit(userId) {
  if (!rateLimits.has(userId)) {
    rateLimits.set(userId, { dailySent: 0, dailyDate: new Date().toDateString(), batchSent: 0, paused: false, pauseUntil: 0, dailyLimit: 1000 });
  }
  const rl = rateLimits.get(userId);
  if (rl.dailyDate !== new Date().toDateString()) { rl.dailySent = 0; rl.dailyDate = new Date().toDateString(); }
  return rl;
}

function canSend(userId) {
  const rl = getRateLimit(userId);
  if (rl.dailySent >= rl.dailyLimit) return { ok: false, reason: "daily_limit" };
  if (rl.paused && Date.now() < rl.pauseUntil) return { ok: false, reason: "batch_pause", resumeIn: Math.ceil((rl.pauseUntil - Date.now()) / 1000) };
  if (rl.paused && Date.now() >= rl.pauseUntil) { rl.paused = false; rl.batchSent = 0; }
  return { ok: true };
}

function recordSend(userId) {
  const rl = getRateLimit(userId);
  rl.dailySent++;
  rl.batchSent++;
  const batchSize = 20 + Math.floor(Math.random() * 30);
  if (rl.batchSent >= batchSize) {
    rl.paused = true;
    rl.pauseUntil = Date.now() + (10 + Math.floor(Math.random() * 20)) * 60 * 1000;
    rl.batchSent = 0;
    console.log(`[${userId}] Batch pause`);
  }
}

function randomDelay() { return (3 + Math.random() * 12) * 1000; }

async function logEvent(userId, event) {
  if (!supabase) return;
  try { await supabase.from("wa_session_log").insert({ user_id: userId, event, timestamp: new Date().toISOString() }); } catch {}
}

// ─── BAILEYS SESSION ───
async function getOrCreateSession(userId) {
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    if (existing.status === "connected" || existing.status === "qr_ready" || existing.status === "connecting") return existing;
    // Clean up broken session
    if (existing.sock) { try { existing.sock.end(); } catch {} }
    sessions.delete(userId);
  }

  const session = { sock: null, status: "connecting", qr: null, phone: null, error: null };
  sessions.set(userId, session);
  console.log(`[${userId}] Creating Baileys session...`);

  const authDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ["GoodDeeds", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    qrTimeout: undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.status = "qr_ready";
      session.qr = await QRCode.toDataURL(qr);
      console.log(`[${userId}] QR ready`);
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      session.phone = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || null;
      console.log(`[${userId}] Connected as ${session.phone}`);
      logEvent(userId, "connected");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;
      console.log(`[${userId}] Disconnected, code: ${statusCode}`);

      if (statusCode === reason.loggedOut) {
        // User logged out from phone — clear auth and stop
        console.log(`[${userId}] Logged out, clearing auth`);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        session.status = "disconnected";
        session.qr = null;
        session.phone = null;
        sessions.delete(userId);
        logEvent(userId, "logged_out");
      } else {
        // Reconnect automatically
        console.log(`[${userId}] Reconnecting...`);
        session.status = "reconnecting";
        sessions.delete(userId);
        setTimeout(() => getOrCreateSession(userId), 3000);
      }
    }
  });

  // Track incoming messages for sequence stop-on-reply
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.key.remoteJid?.endsWith("@s.whatsapp.net")) {
        const phone = msg.key.remoteJid.replace("@s.whatsapp.net", "");
        if (supabase) {
          try {
            await supabase.from("wa_sequence_contacts").update({ status: "replied", replied_at: new Date().toISOString() })
              .eq("user_id", userId).eq("phone", phone).eq("status", "active");
          } catch {}
        }
      }
    }
  });

  session.sock = sock;
  return session;
}

// ─── QUEUE PROCESSOR ───
async function processQueue() {
  if (!supabase) return;
  try {
    const { data: pending } = await supabase.from("wa_message_queue")
      .select("*").eq("status", "queued").order("created_at", { ascending: true }).limit(10);
    if (!pending?.length) return;

    for (const msg of pending) {
      const session = sessions.get(msg.user_id);
      if (!session || session.status !== "connected") {
        await supabase.from("wa_message_queue").update({ status: "failed", error_message: "Session not connected" }).eq("id", msg.id);
        continue;
      }
      const check = canSend(msg.user_id);
      if (!check.ok) {
        if (check.reason === "daily_limit") await supabase.from("wa_message_queue").update({ status: "failed", error_message: "Daily limit reached" }).eq("id", msg.id);
        continue;
      }
      try {
        const jid = msg.phone.replace(/[\s\-\+]/g, "") + "@s.whatsapp.net";
        await session.sock.sendMessage(jid, { text: msg.message });
        recordSend(msg.user_id);
        await supabase.from("wa_message_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", msg.id);
        console.log(`[Queue] Sent to ${msg.phone}`);
      } catch (err) {
        const retries = (msg.retry_count || 0) + 1;
        if (retries >= 3) {
          await supabase.from("wa_message_queue").update({ status: "failed", error_message: err.message, retry_count: retries }).eq("id", msg.id);
        } else {
          await supabase.from("wa_message_queue").update({ retry_count: retries }).eq("id", msg.id);
        }
      }
      await new Promise(r => setTimeout(r, randomDelay()));
    }
  } catch (err) { console.error("[Queue]", err.message); }
}

// ─── CAMPAIGN PROCESSOR ───
async function processCampaigns() {
  if (!supabase) return;
  try {
    const { data: campaigns } = await supabase.from("wa_campaigns")
      .select("*").eq("status", "active").lte("scheduled_at", new Date().toISOString());
    if (!campaigns?.length) return;

    for (const campaign of campaigns) {
      console.log(`[Campaign] Processing: ${campaign.name}`);
      await supabase.from("wa_campaigns").update({ status: "processing" }).eq("id", campaign.id);
      const { data: contacts } = await supabase.from("wa_campaign_contacts")
        .select("phone").eq("campaign_id", campaign.id).eq("status", "pending");
      if (!contacts?.length) {
        await supabase.from("wa_campaigns").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", campaign.id);
        continue;
      }
      const items = contacts.map(c => ({
        user_id: campaign.user_id, phone: c.phone, message: campaign.message,
        status: "queued", campaign_id: campaign.id, type: "campaign", scheduled_at: new Date().toISOString(),
      }));
      await supabase.from("wa_message_queue").insert(items);
      await supabase.from("wa_campaign_contacts").update({ status: "queued" }).eq("campaign_id", campaign.id).eq("status", "pending");
      await supabase.from("wa_campaigns").update({ status: "sending", total_contacts: contacts.length }).eq("id", campaign.id);
      console.log(`[Campaign] Queued ${contacts.length} msgs`);
    }

    const { data: sending } = await supabase.from("wa_campaigns").select("id").eq("status", "sending");
    for (const c of (sending || [])) {
      const { count: remaining } = await supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", c.id).eq("status", "queued");
      if (remaining === 0) {
        const { count: sent } = await supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", c.id).eq("status", "sent");
        const { count: failed } = await supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", c.id).eq("status", "failed");
        await supabase.from("wa_campaigns").update({ status: "completed", completed_at: new Date().toISOString(), sent_count: sent || 0, failed_count: failed || 0 }).eq("id", c.id);
      }
    }
  } catch (err) { console.error("[Campaign]", err.message); }
}

// ─── SEQUENCE PROCESSOR ───
async function processSequences() {
  if (!supabase) return;
  try {
    const { data: seqs } = await supabase.from("wa_sequences").select("*").eq("status", "active");
    if (!seqs?.length) return;
    const now = new Date();
    for (const seq of seqs) {
      const steps = seq.steps || [];
      const { data: contacts } = await supabase.from("wa_sequence_contacts")
        .select("*").eq("sequence_id", seq.id).eq("status", "active");
      for (const contact of (contacts || [])) {
        const enrolled = new Date(contact.enrolled_at);
        const minsSinceEnroll = (now.getTime() - enrolled.getTime()) / 60000;
        const idx = contact.current_step || 0;
        if (idx >= steps.length) {
          await supabase.from("wa_sequence_contacts").update({ status: "completed" }).eq("id", contact.id);
          continue;
        }
        const step = steps[idx];
        const delayMins = step.delayMinutes || (step.unit === "immediately" ? 0 : step.unit === "minutes" ? step.delay : step.unit === "hours" ? step.delay * 60 : step.delay * 1440);
        if (minsSinceEnroll >= delayMins) {
          const cacheKey = `seq_${seq.id}_${contact.id}_step${idx}`;
          const { data: already } = await supabase.from("wa_message_queue").select("id").eq("campaign_id", cacheKey).limit(1);
          if (already?.length) continue;
          await supabase.from("wa_message_queue").insert({
            user_id: seq.user_id, phone: contact.phone, message: step.message,
            status: "queued", campaign_id: cacheKey, type: "sequence", scheduled_at: new Date().toISOString(),
          });
          await supabase.from("wa_sequence_contacts").update({ current_step: idx + 1, last_sent_at: now.toISOString() }).eq("id", contact.id);
          console.log(`[Seq] Step ${idx + 1} for ${contact.phone}`);
        }
      }
    }
  } catch (err) { console.error("[Sequence]", err.message); }
}

// ─── BACKGROUND LOOPS ───
setInterval(processQueue, 5000);
setInterval(processCampaigns, 30000);
setInterval(processSequences, 60000);

// Self-ping keepalive
setInterval(() => {
  const url = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/`
    : `http://localhost:${PORT}/`;
  fetch(url).catch(() => {});
}, 4 * 60 * 1000);

// ─── API ROUTES ───

app.get("/", (req, res) => {
  const list = [];
  for (const [uid, s] of sessions) list.push({ userId: uid, status: s.status, phone: s.phone });
  res.json({ status: "ok", engine: "baileys", sessions: sessions.size, mem: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB", details: list });
});

app.post("/session/start", auth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = await getOrCreateSession(userId);
  res.json({ status: session.status, qr: session.qr, phone: session.phone, error: session.error });
});

app.get("/session/status/:userId", auth, (req, res) => {
  const session = sessions.get(req.params.userId);
  if (!session) return res.json({ status: "none" });
  const rl = getRateLimit(req.params.userId);
  res.json({ status: session.status, qr: session.qr, phone: session.phone, error: session.error, dailySent: rl.dailySent, dailyLimit: rl.dailyLimit, paused: rl.paused });
});

app.post("/session/disconnect", auth, async (req, res) => {
  const { userId } = req.body;
  const session = sessions.get(userId);
  if (!session) return res.json({ status: "not_found" });
  try { await session.sock.logout(); } catch {}
  try { session.sock.end(); } catch {}
  const authDir = path.join(AUTH_DIR, userId);
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
  sessions.delete(userId);
  res.json({ status: "disconnected" });
});

app.post("/send", auth, async (req, res) => {
  const { userId, phone, message } = req.body;
  if (!userId || !phone || !message) return res.status(400).json({ error: "userId, phone, message required" });
  const session = sessions.get(userId);
  if (!session || session.status !== "connected") return res.status(400).json({ error: "Session not connected", status: session?.status || "none" });
  const check = canSend(userId);
  if (!check.ok) return res.status(429).json({ error: check.reason, resumeIn: check.resumeIn });
  try {
    const jid = phone.replace(/[\s\-\+]/g, "") + "@s.whatsapp.net";
    await session.sock.sendMessage(jid, { text: message });
    recordSend(userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/queue", auth, async (req, res) => {
  const { userId, phone, message, type } = req.body;
  if (!userId || !phone || !message) return res.status(400).json({ error: "userId, phone, message required" });
  if (!supabase) return res.status(500).json({ error: "DB not configured" });
  await supabase.from("wa_message_queue").insert({ user_id: userId, phone, message, status: "queued", type: type || "direct", scheduled_at: new Date().toISOString() });
  res.json({ success: true, queued: true });
});

app.post("/send/bulk", auth, async (req, res) => {
  const { userId, contacts, message } = req.body;
  if (!userId || !contacts?.length || !message) return res.status(400).json({ error: "userId, contacts[], message required" });
  if (!supabase) return res.status(500).json({ error: "DB not configured" });
  const items = contacts.map(phone => ({ user_id: userId, phone, message, status: "queued", type: "bulk", scheduled_at: new Date().toISOString() }));
  await supabase.from("wa_message_queue").insert(items);
  res.json({ success: true, queued: contacts.length });
});

app.get("/rate-limit/:userId", auth, (req, res) => {
  const rl = getRateLimit(req.params.userId);
  res.json(rl);
});

app.get("/sessions", auth, (req, res) => {
  const list = [];
  for (const [userId, s] of sessions) list.push({ userId, status: s.status, phone: s.phone });
  res.json(list);
});

process.on("uncaughtException", (err) => console.error("[UNCAUGHT]", err.message));
process.on("unhandledRejection", (err) => console.error("[UNHANDLED]", err));

app.listen(PORT, () => {
  console.log(`WhatsApp server (Baileys) on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? "connected" : "NOT configured"}`);
});
