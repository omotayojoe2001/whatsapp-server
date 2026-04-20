const express = require("express");
const { default: makeWASocket, DisconnectReason, makeCacheableSignalKeyStore, proto, initAuthCreds, BufferJSON } = require("baileys");
const QRCode = require("qrcode");
const pino = require("pino");
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
const logger = pino({ level: "silent" });

const sessions = new Map();
const rateLimits = new Map();

const auth = (req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
};

// ─── SUPABASE AUTH STATE (persists across redeploys) ───
async function useSupabaseAuthState(userId) {
  const key = (k) => `${userId}_${k}`;

  const readData = async (k) => {
    if (!supabase) return null;
    const { data } = await supabase.from("wa_auth_store").select("data").eq("id", key(k)).single();
    return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
  };

  const writeData = async (k, value) => {
    if (!supabase) return;
    const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    await supabase.from("wa_auth_store").upsert({ id: key(k), user_id: userId, data: serialized, updated_at: new Date().toISOString() }, { onConflict: "id" });
  };

  const removeData = async (k) => {
    if (!supabase) return;
    await supabase.from("wa_auth_store").delete().eq("id", key(k));
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            const val = await readData(`${type}-${id}`);
            if (val) result[id] = val;
          }
          return result;
        },
        set: async (data) => {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              if (value) await writeData(`${type}-${id}`, value);
              else await removeData(`${type}-${id}`);
            }
          }
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}

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
    if (existing.sock) { try { existing.sock.end(); } catch {} }
    sessions.delete(userId);
  }

  const session = { sock: null, status: "connecting", qr: null, phone: null, error: null };
  sessions.set(userId, session);
  console.log(`[${userId}] Creating Baileys session...`);

  const { state, saveCreds } = await useSupabaseAuthState(userId);

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
      console.log(`[${userId}] Disconnected, code: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
        console.log(`[${userId}] Session invalid (${statusCode}), clearing auth`);
        if (supabase) await supabase.from("wa_auth_store").delete().like("id", `${userId}_%`);
        session.status = "disconnected";
        session.qr = null;
        session.phone = null;
        sessions.delete(userId);
        logEvent(userId, "logged_out");
      } else {
        console.log(`[${userId}] Reconnecting...`);
        session.status = "reconnecting";
        sessions.delete(userId);
        setTimeout(() => getOrCreateSession(userId), 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.key.remoteJid?.endsWith("@s.whatsapp.net")) {
        const phone = msg.key.remoteJid.replace("@s.whatsapp.net", "");
        if (supabase) {
          try {
            await supabase.from("wa_sequence_contacts").update({ status: "replied", has_replied: true })
              .eq("user_id", userId).eq("contact_phone", phone).eq("status", "active");
          } catch {}
        }
      }
    }
  });

  session.sock = sock;
  return session;
}

// ─── AUTO-RESTORE SESSIONS ON STARTUP ───
async function restoreSessions() {
  if (!supabase) return;
  const { data } = await supabase.from("wa_auth_store").select("user_id").like("id", "%_creds");
  if (!data?.length) return;
  const userIds = [...new Set(data.map(r => r.user_id))];
  console.log(`[Restore] Found ${userIds.length} saved session(s), reconnecting...`);
  for (const userId of userIds) {
    try { await getOrCreateSession(userId); } catch (e) { console.error(`[Restore] Failed for ${userId}:`, e.message); }
  }
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
    const { data: campaigns } = await supabase.from("wa_campaigns").select("*").eq("status", "active").lte("scheduled_at", new Date().toISOString());
    if (!campaigns?.length) return;
    for (const campaign of campaigns) {
      console.log(`[Campaign] Processing: ${campaign.name}`);
      await supabase.from("wa_campaigns").update({ status: "processing" }).eq("id", campaign.id);
      const { data: contacts } = await supabase.from("wa_campaign_contacts").select("phone").eq("campaign_id", campaign.id).eq("status", "pending");
      if (!contacts?.length) { await supabase.from("wa_campaigns").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", campaign.id); continue; }
      const items = contacts.map(c => ({ user_id: campaign.user_id, phone: c.phone, message: campaign.message, status: "queued", campaign_id: campaign.id, type: "campaign", scheduled_at: new Date().toISOString() }));
      await supabase.from("wa_message_queue").insert(items);
      await supabase.from("wa_campaign_contacts").update({ status: "queued" }).eq("campaign_id", campaign.id).eq("status", "pending");
      await supabase.from("wa_campaigns").update({ status: "sending", total_contacts: contacts.length }).eq("id", campaign.id);
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
    const { data: seqs, error: seqErr } = await supabase.from("wa_sequences").select("*").eq("status", "active");
    if (seqErr) { console.error("[Sequence] Fetch error:", seqErr.message); return; }
    if (!seqs?.length) return;
    console.log(`[Sequence] Processing ${seqs.length} active sequence(s)`);
    const now = new Date();
    for (const seq of seqs) {
      const steps = seq.steps || [];
      const { data: contacts, error: cErr } = await supabase.from("wa_sequence_contacts").select("*").eq("sequence_id", seq.id).eq("status", "active");
      if (cErr) { console.error("[Sequence] Contacts error:", cErr.message); continue; }
      console.log(`[Sequence] "${seq.name}": ${(contacts || []).length} active contact(s)`);
      for (const contact of (contacts || [])) {
        const idx = contact.current_step || 0;
        if (idx >= steps.length) { await supabase.from("wa_sequence_contacts").update({ status: "completed" }).eq("id", contact.id); continue; }
        const step = steps[idx];
        let totalDelayMins = 0;
        for (let i = 0; i <= idx; i++) {
          const s = steps[i];
          totalDelayMins += s.delayMinutes != null ? s.delayMinutes : s.unit === "immediately" ? 0 : s.unit === "minutes" ? (s.delay || 0) : s.unit === "hours" ? (s.delay || 0) * 60 : (s.delay || s.day || 0) * 1440;
        }
        const enrolled = new Date(contact.created_at);
        const minsSinceEnroll = (now.getTime() - enrolled.getTime()) / 60000;
        let timeOk = true;
        if (step.unit === "days" && step.time) {
          const [h, m] = step.time.split(":").map(Number);
          const targetMins = h * 60 + m;
          const currentMins = now.getUTCHours() * 60 + now.getUTCMinutes();
          timeOk = currentMins >= targetMins && currentMins <= targetMins + 30;
        }
        if (minsSinceEnroll >= totalDelayMins && timeOk) {
          const cacheKey = `seq_${seq.id}_${contact.id}_step${idx}`;
          const { data: already } = await supabase.from("wa_message_queue").select("id").eq("campaign_id", cacheKey).limit(1);
          if (already?.length) continue;
          await supabase.from("wa_message_queue").insert({ user_id: seq.user_id, phone: contact.contact_phone, message: step.message, status: "queued", campaign_id: cacheKey, type: "sequence", scheduled_at: new Date().toISOString() });
          await supabase.from("wa_sequence_contacts").update({ current_step: idx + 1, last_sent_at: now.toISOString() }).eq("id", contact.id);
          console.log(`[Seq] Step ${idx + 1} for ${contact.contact_phone}`);
        }
      }
    }
  } catch (err) { console.error("[Sequence]", err.message); }
}

// ─── BACKGROUND LOOPS ───
setInterval(processQueue, 5000);
setInterval(processCampaigns, 30000);
setInterval(processSequences, 60000);
setInterval(() => {
  const url = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/` : `http://localhost:${PORT}/`;
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
  if (supabase) await supabase.from("wa_auth_store").delete().like("id", `${userId}_%`);
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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

app.get("/rate-limit/:userId", auth, (req, res) => { res.json(getRateLimit(req.params.userId)); });
app.get("/sessions", auth, (req, res) => {
  const list = [];
  for (const [userId, s] of sessions) list.push({ userId, status: s.status, phone: s.phone });
  res.json(list);
});

process.on("uncaughtException", (err) => console.error("[UNCAUGHT]", err.message));
process.on("unhandledRejection", (err) => console.error("[UNHANDLED]", err));

app.listen(PORT, async () => {
  console.log(`WhatsApp server (Baileys) on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? "connected" : "NOT configured"}`);
  // Auto-restore saved sessions
  await restoreSessions();
});
