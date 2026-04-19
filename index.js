const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");

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

const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ─── SESSION MANAGER ───
const sessions = new Map();
// Rate limit tracking: userId -> { sent today, last batch start, batch count }
const rateLimits = new Map();

const auth = (req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
};

function getRateLimit(userId) {
  if (!rateLimits.has(userId)) {
    rateLimits.set(userId, { dailySent: 0, dailyDate: new Date().toDateString(), batchSent: 0, batchStart: Date.now(), paused: false, pauseUntil: 0, dailyLimit: 1000 });
  }
  const rl = rateLimits.get(userId);
  if (rl.dailyDate !== new Date().toDateString()) {
    rl.dailySent = 0;
    rl.dailyDate = new Date().toDateString();
  }
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
  // Batch pause: after 20-50 messages, pause 10-30 min
  const batchSize = 20 + Math.floor(Math.random() * 30);
  if (rl.batchSent >= batchSize) {
    const pauseMs = (10 + Math.floor(Math.random() * 20)) * 60 * 1000;
    rl.paused = true;
    rl.pauseUntil = Date.now() + pauseMs;
    rl.batchSent = 0;
    console.log(`[${userId}] Batch pause: ${Math.round(pauseMs / 60000)}min after ${batchSize} msgs`);
  }
}

function randomDelay() {
  return (3 + Math.random() * 12) * 1000; // 3-15 seconds
}

function getOrCreateSession(userId) {
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    if (existing.status === "error" || existing.status === "auth_failed") cleanup(userId);
    else return existing;
  }

  const session = { client: null, status: "initializing", qr: null, phone: null, error: null, lastActive: Date.now() };
  sessions.set(userId, session);
  console.log(`[${userId}] Creating session...`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    webVersionCache: { type: "none" },
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process", "--no-zygote", "--disable-extensions", "--disable-background-networking", "--disable-default-apps", "--disable-sync", "--disable-translate", "--no-first-run", "--js-flags=--max-old-space-size=256"],
    },
    qrMaxRetries: 0,
  });

  client.on("loading_screen", (percent, message) => { session.status = "loading"; console.log(`[${userId}] Loading: ${percent}%`); });
  client.on("qr", async (qr) => { session.status = "qr_ready"; session.qr = await QRCode.toDataURL(qr); console.log(`[${userId}] QR ready`); });
  client.on("authenticated", () => { session.status = "authenticated"; session.qr = null; console.log(`[${userId}] Authenticated`); });
  client.on("ready", () => {
    session.status = "connected"; session.qr = null; session.phone = client.info?.wid?.user || null; session.lastActive = Date.now();
    console.log(`[${userId}] Connected as ${session.phone}`);
    logSessionEvent(userId, "connected");
  });
  client.on("auth_failure", (msg) => {
    console.log(`[${userId}] Auth failed:`, msg);
    session.status = "auth_failed"; session.error = String(msg);
    logSessionEvent(userId, "auth_failed");
    // Clear corrupted auth and allow retry
    cleanup(userId);
  });
  client.on("disconnected", (reason) => {
    console.log(`[${userId}] Disconnected:`, reason);
    logSessionEvent(userId, "disconnected");
    cleanup(userId);
  });
  // Track incoming messages (for sequence stop-on-reply)
  client.on("message", async (msg) => {
    session.lastActive = Date.now();
    if (supabase && msg.from?.endsWith("@c.us")) {
      const phone = msg.from.replace("@c.us", "");
      await supabase.from("wa_sequence_contacts").update({ status: "replied", replied_at: new Date().toISOString() }).eq("user_id", userId).eq("phone", phone).eq("status", "active");
    }
  });

  session.client = client;
  client.initialize().catch((err) => { console.error(`[${userId}] Init error:`, err.message); session.status = "error"; session.error = err.message; });
  return session;
}

function cleanup(userId) {
  const s = sessions.get(userId);
  if (s?.client) { try { s.client.destroy(); } catch {} }
  sessions.delete(userId);
  // Clear stored auth so next QR scan starts fresh
  const fs = require("fs");
  const path = require("path");
  const authDir = path.join(process.cwd(), ".wwebjs_auth", `session-${userId}`);
  try { fs.rmSync(authDir, { recursive: true, force: true }); console.log(`[${userId}] Auth data cleared`); } catch {}
}

async function logSessionEvent(userId, event) {
  if (!supabase) return;
  try { await supabase.from("wa_session_log").insert({ user_id: userId, event, timestamp: new Date().toISOString() }); } catch {}
}

// ─── QUEUE PROCESSOR ───
// Processes wa_message_queue table every 5 seconds
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
        if (check.reason === "daily_limit") {
          await supabase.from("wa_message_queue").update({ status: "failed", error_message: "Daily limit reached" }).eq("id", msg.id);
        }
        // batch_pause: skip, will retry next cycle
        continue;
      }
      try {
        const chatId = msg.phone.replace(/[\s\-\+]/g, "") + "@c.us";
        await session.client.sendMessage(chatId, msg.message);
        recordSend(msg.user_id);
        await supabase.from("wa_message_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", msg.id);
        console.log(`[Queue] Sent to ${msg.phone} for ${msg.user_id}`);
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
  } catch (err) { console.error("[Queue] Error:", err.message); }
}

// ─── CAMPAIGN PROCESSOR ───
// Checks for active campaigns and enqueues their messages
async function processCampaigns() {
  if (!supabase) return;
  try {
    const { data: campaigns } = await supabase.from("wa_campaigns")
      .select("*").eq("status", "active").lte("scheduled_at", new Date().toISOString());
    if (!campaigns?.length) return;

    for (const campaign of campaigns) {
      console.log(`[Campaign] Processing: ${campaign.name} (${campaign.id})`);
      await supabase.from("wa_campaigns").update({ status: "processing" }).eq("id", campaign.id);

      // Get contacts from the linked list
      const { data: contacts } = await supabase.from("wa_campaign_contacts")
        .select("phone").eq("campaign_id", campaign.id).eq("status", "pending");

      if (!contacts?.length) {
        await supabase.from("wa_campaigns").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", campaign.id);
        continue;
      }

      // Enqueue all messages
      const queueItems = contacts.map(c => ({
        user_id: campaign.user_id, phone: c.phone, message: campaign.message,
        status: "queued", campaign_id: campaign.id, type: "campaign",
        scheduled_at: new Date().toISOString(),
      }));

      await supabase.from("wa_message_queue").insert(queueItems);
      await supabase.from("wa_campaign_contacts").update({ status: "queued" }).eq("campaign_id", campaign.id).eq("status", "pending");
      await supabase.from("wa_campaigns").update({ status: "sending", total_contacts: contacts.length }).eq("id", campaign.id);
      console.log(`[Campaign] Queued ${contacts.length} messages for ${campaign.name}`);
    }

    // Check if sending campaigns are complete
    const { data: sending } = await supabase.from("wa_campaigns").select("id").eq("status", "sending");
    for (const c of (sending || [])) {
      const { count: remaining } = await supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", c.id).eq("status", "queued");
      if (remaining === 0) {
        const { count: sent } = await supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", c.id).eq("status", "sent");
        const { count: failed } = await supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", c.id).eq("status", "failed");
        await supabase.from("wa_campaigns").update({ status: "completed", completed_at: new Date().toISOString(), sent_count: sent || 0, failed_count: failed || 0 }).eq("id", c.id);
        console.log(`[Campaign] Completed: ${c.id} — ${sent} sent, ${failed} failed`);
      }
    }
  } catch (err) { console.error("[Campaign] Error:", err.message); }
}

// ─── SEQUENCE PROCESSOR ───
// Drip sequences: Day 1 → msg1, Day 2 → msg2, etc. Stop if replied.
async function processSequences() {
  if (!supabase) return;
  try {
    const { data: activeSeqs } = await supabase.from("wa_sequences").select("*").eq("status", "active");
    if (!activeSeqs?.length) return;

    const now = new Date();
    for (const seq of activeSeqs) {
      const steps = seq.steps || []; // [{day: 1, message: "..."}, {day: 2, message: "..."}]
      const { data: contacts } = await supabase.from("wa_sequence_contacts")
        .select("*").eq("sequence_id", seq.id).eq("status", "active");

      for (const contact of (contacts || [])) {
        const enrolledAt = new Date(contact.enrolled_at);
        const daysSinceEnroll = Math.floor((now.getTime() - enrolledAt.getTime()) / (1000 * 60 * 60 * 24));
        const currentStepIdx = contact.current_step || 0;

        if (currentStepIdx >= steps.length) {
          await supabase.from("wa_sequence_contacts").update({ status: "completed" }).eq("id", contact.id);
          continue;
        }

        const step = steps[currentStepIdx];
        if (daysSinceEnroll >= step.day) {
          // Check if already sent today for this step
          const cacheKey = `seq_${seq.id}_${contact.id}_step${currentStepIdx}`;
          const { data: alreadySent } = await supabase.from("wa_message_queue")
            .select("id").eq("campaign_id", cacheKey).limit(1);
          if (alreadySent?.length) continue;

          // Enqueue the message
          await supabase.from("wa_message_queue").insert({
            user_id: seq.user_id, phone: contact.phone, message: step.message,
            status: "queued", campaign_id: cacheKey, type: "sequence",
            scheduled_at: new Date().toISOString(),
          });
          await supabase.from("wa_sequence_contacts").update({ current_step: currentStepIdx + 1, last_sent_at: now.toISOString() }).eq("id", contact.id);
          console.log(`[Sequence] Queued step ${currentStepIdx + 1} for ${contact.phone} in ${seq.name}`);
        }
      }
    }
  } catch (err) { console.error("[Sequence] Error:", err.message); }
}

// ─── HEALTH MONITOR ───
async function healthCheck() {
  for (const [userId, session] of sessions) {
    if (session.status === "connected") {
      session.lastActive = Date.now();
      // Check if client is still responsive
      try {
        await session.client.getState();
      } catch {
        console.log(`[Health] Session ${userId} unresponsive, cleaning up`);
        logSessionEvent(userId, "unresponsive");
        cleanup(userId);
      }
    }
  }
}

// ─── BACKGROUND LOOPS ───
setInterval(processQueue, 5000);       // Queue every 5s
setInterval(processCampaigns, 30000);  // Campaigns every 30s
setInterval(processSequences, 60000);  // Sequences every 60s
setInterval(healthCheck, 120000);      // Health every 2min

// ─── API ROUTES ───

app.get("/", (req, res) => {
  const list = [];
  for (const [uid, s] of sessions) list.push({ userId: uid, status: s.status, phone: s.phone });
  res.json({ status: "ok", sessions: sessions.size, mem: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB", details: list });
});

app.post("/session/start", auth, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = getOrCreateSession(userId);
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
  try { await session.client.logout(); } catch {}
  cleanup(userId);
  res.json({ status: "disconnected" });
});

// Direct send (still available for single messages)
app.post("/send", auth, async (req, res) => {
  const { userId, phone, message } = req.body;
  if (!userId || !phone || !message) return res.status(400).json({ error: "userId, phone, message required" });
  const session = sessions.get(userId);
  if (!session || session.status !== "connected") return res.status(400).json({ error: "Session not connected", status: session?.status || "none" });
  const check = canSend(userId);
  if (!check.ok) return res.status(429).json({ error: check.reason, resumeIn: check.resumeIn });
  try {
    const chatId = phone.replace(/[\s\-\+]/g, "") + "@c.us";
    await session.client.sendMessage(chatId, message);
    recordSend(userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Queue a message (goes through rate limiter)
app.post("/queue", auth, async (req, res) => {
  const { userId, phone, message, type } = req.body;
  if (!userId || !phone || !message) return res.status(400).json({ error: "userId, phone, message required" });
  if (!supabase) return res.status(500).json({ error: "DB not configured" });
  await supabase.from("wa_message_queue").insert({ user_id: userId, phone, message, status: "queued", type: type || "direct", scheduled_at: new Date().toISOString() });
  res.json({ success: true, queued: true });
});

// Send bulk via queue
app.post("/send/bulk", auth, async (req, res) => {
  const { userId, contacts, message } = req.body;
  if (!userId || !contacts?.length || !message) return res.status(400).json({ error: "userId, contacts[], message required" });
  if (!supabase) return res.status(500).json({ error: "DB not configured" });
  const items = contacts.map(phone => ({ user_id: userId, phone, message, status: "queued", type: "bulk", scheduled_at: new Date().toISOString() }));
  await supabase.from("wa_message_queue").insert(items);
  res.json({ success: true, queued: contacts.length });
});

// Rate limit info
app.get("/rate-limit/:userId", auth, (req, res) => {
  const rl = getRateLimit(req.params.userId);
  res.json({ dailySent: rl.dailySent, dailyLimit: rl.dailyLimit, batchSent: rl.batchSent, paused: rl.paused, pauseUntil: rl.paused ? new Date(rl.pauseUntil).toISOString() : null });
});

// Update daily limit (admin)
app.post("/rate-limit/:userId", auth, (req, res) => {
  const rl = getRateLimit(req.params.userId);
  if (req.body.dailyLimit) rl.dailyLimit = Math.min(req.body.dailyLimit, 2000);
  res.json({ dailyLimit: rl.dailyLimit });
});

// Queue stats
app.get("/stats/:userId", auth, async (req, res) => {
  if (!supabase) return res.json({});
  const userId = req.params.userId;
  const today = new Date().toISOString().split("T")[0];
  const [queued, sent, failed] = await Promise.all([
    supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "queued"),
    supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "sent").gte("sent_at", today),
    supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "failed").gte("created_at", today),
  ]);
  res.json({ queued: queued.count || 0, sentToday: sent.count || 0, failedToday: failed.count || 0 });
});

app.get("/sessions", auth, (req, res) => {
  const list = [];
  for (const [userId, s] of sessions) list.push({ userId, status: s.status, phone: s.phone });
  res.json(list);
});

process.on("uncaughtException", (err) => console.error("[UNCAUGHT]", err.message));
process.on("unhandledRejection", (err) => console.error("[UNHANDLED]", err));

app.listen(PORT, () => {
  console.log(`WhatsApp server on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? "connected" : "NOT configured"}`);
});
