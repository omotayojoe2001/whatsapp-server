const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
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

const sessions = new Map();
const rateLimits = new Map();

const auth_mw = (req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
};

// ─── AUTH FILE BACKUP/RESTORE TO SUPABASE ───
async function backupAuthToSupabase(userId) {
  if (!supabase) return;
  const authDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(authDir)) return;
  const files = fs.readdirSync(authDir);
  for (const file of files) {
    const content = fs.readFileSync(path.join(authDir, file), "utf-8");
    await supabase.from("wa_auth_store").upsert({
      id: `${userId}_${file}`, user_id: userId, data: { content }, updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
  }
  console.log(`[Auth] Backed up ${files.length} files for ${userId}`);
}

async function restoreAuthFromSupabase(userId) {
  if (!supabase) return false;
  const { data } = await supabase.from("wa_auth_store").select("id, data").like("id", `${userId}_%`);
  if (!data?.length) return false;
  const authDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  for (const row of data) {
    const fileName = row.id.replace(`${userId}_`, "");
    fs.writeFileSync(path.join(authDir, fileName), row.data.content);
  }
  console.log(`[Auth] Restored ${data.length} files for ${userId}`);
  return true;
}

async function clearAuth(userId) {
  const authDir = path.join(AUTH_DIR, userId);
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
  if (supabase) await supabase.from("wa_auth_store").delete().like("id", `${userId}_%`);
  console.log(`[Auth] Cleared for ${userId}`);
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
  if (rl.batchSent >= 20 + Math.floor(Math.random() * 30)) {
    rl.paused = true;
    rl.pauseUntil = Date.now() + (10 + Math.floor(Math.random() * 20)) * 60 * 1000;
    rl.batchSent = 0;
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
  console.log(`[${userId}] Creating session...`);

  const authDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    connectTimeoutMs: 60000,
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    backupAuthToSupabase(userId).catch(() => {});
  });

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
      backupAuthToSupabase(userId).catch(() => {});
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${userId}] Disconnected, code: ${code}`);

      if (code === DisconnectReason.loggedOut || code === 405 || code === 401) {
        console.log(`[${userId}] Session invalid, clearing`);
        await clearAuth(userId);
        session.status = "disconnected";
        session.qr = null;
        session.phone = null;
        sessions.delete(userId);
        logEvent(userId, "logged_out");
      } else {
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
          try { await supabase.from("wa_sequence_contacts").update({ status: "replied", has_replied: true }).eq("user_id", userId).eq("contact_phone", phone).eq("status", "active"); } catch {}
        }
      }
    }
  });

  session.sock = sock;
  return session;
}

// ─── AUTO-RESTORE ON STARTUP ───
async function restoreSessions() {
  if (!supabase) return;
  const { data } = await supabase.from("wa_auth_store").select("user_id").like("id", "%_creds.json");
  if (!data?.length) { console.log("[Restore] No saved sessions"); return; }
  const userIds = [...new Set(data.map(r => r.user_id))];
  console.log(`[Restore] Found ${userIds.length} session(s)`);
  for (const userId of userIds) {
    const restored = await restoreAuthFromSupabase(userId);
    if (!restored) continue;
    try {
      await getOrCreateSession(userId);
      await new Promise(r => setTimeout(r, 8000));
      const s = sessions.get(userId);
      if (s && s.status !== "connected" && s.status !== "qr_ready") {
        console.log(`[Restore] ${userId} failed, clearing`);
        await clearAuth(userId);
        sessions.delete(userId);
      }
    } catch (e) {
      console.error(`[Restore] ${userId} error:`, e.message);
      await clearAuth(userId);
      sessions.delete(userId);
    }
  }
}

// ─── QUEUE PROCESSOR ───
async function processQueue() {
  if (!supabase) return;
  try {
    const { data: pending } = await supabase.from("wa_message_queue").select("*").eq("status", "queued").order("created_at", { ascending: true }).limit(10);
    if (!pending?.length) return;
    for (const msg of pending) {
      const session = sessions.get(msg.user_id);
      if (!session || session.status !== "connected") { await supabase.from("wa_message_queue").update({ status: "failed", error_message: "Session not connected" }).eq("id", msg.id); continue; }
      const check = canSend(msg.user_id);
      if (!check.ok) { if (check.reason === "daily_limit") await supabase.from("wa_message_queue").update({ status: "failed", error_message: "Daily limit" }).eq("id", msg.id); continue; }
      try {
        const isGroup = msg.phone.includes("@g.us");
        const jid = isGroup ? msg.phone : msg.phone.replace(/[\s\-\+]/g, "") + "@s.whatsapp.net";
        console.log(`[Queue] Sending to ${isGroup ? "group" : "individual"}: ${jid}`);
        if (isGroup) {
          // Fetch group metadata first to establish session
          try { await session.sock.groupMetadata(jid); } catch {}
        }
        await session.sock.sendMessage(jid, { text: msg.message });
        recordSend(msg.user_id);
        await supabase.from("wa_message_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", msg.id);
        console.log(`[Queue] Sent to ${msg.phone}`);
      } catch (err) {
        const retries = (msg.retry_count || 0) + 1;
        if (retries >= 3) await supabase.from("wa_message_queue").update({ status: "failed", error_message: err.message, retry_count: retries }).eq("id", msg.id);
        else await supabase.from("wa_message_queue").update({ retry_count: retries }).eq("id", msg.id);
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
    for (const c of (campaigns || [])) {
      await supabase.from("wa_campaigns").update({ status: "processing" }).eq("id", c.id);
      const { data: contacts } = await supabase.from("wa_campaign_contacts").select("phone").eq("campaign_id", c.id).eq("status", "pending");
      if (!contacts?.length) { await supabase.from("wa_campaigns").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", c.id); continue; }
      await supabase.from("wa_message_queue").insert(contacts.map(ct => ({ user_id: c.user_id, phone: ct.phone, message: c.message, status: "queued", campaign_id: c.id, type: "campaign", scheduled_at: new Date().toISOString() })));
      await supabase.from("wa_campaign_contacts").update({ status: "queued" }).eq("campaign_id", c.id).eq("status", "pending");
      await supabase.from("wa_campaigns").update({ status: "sending", total_contacts: contacts.length }).eq("id", c.id);
    }
    const { data: sending } = await supabase.from("wa_campaigns").select("id").eq("status", "sending");
    for (const c of (sending || [])) {
      const { count: rem } = await supabase.from("wa_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", c.id).eq("status", "queued");
      if (rem === 0) {
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
    console.log(`[Sequence] Processing ${seqs.length} sequence(s)`);
    const now = new Date();
    for (const seq of seqs) {
      const steps = seq.steps || [];
      const { data: contacts } = await supabase.from("wa_sequence_contacts").select("*").eq("sequence_id", seq.id).eq("status", "active");
      console.log(`[Sequence] "${seq.name}": ${(contacts || []).length} contact(s)`);
      for (const contact of (contacts || [])) {
        const idx = contact.current_step || 0;
        if (idx >= steps.length) { await supabase.from("wa_sequence_contacts").update({ status: "completed" }).eq("id", contact.id); continue; }
        const step = steps[idx];
        let totalMins = 0;
        for (let i = 0; i <= idx; i++) { const s = steps[i]; totalMins += s.delayMinutes != null ? s.delayMinutes : s.unit === "immediately" ? 0 : s.unit === "minutes" ? (s.delay || 0) : s.unit === "hours" ? (s.delay || 0) * 60 : (s.delay || 0) * 1440; }
        const mins = (now.getTime() - new Date(contact.created_at).getTime()) / 60000;
        let timeOk = true;
        if (step.unit === "days" && step.time) { const [h, m] = step.time.split(":").map(Number); const t = h * 60 + m, c = now.getUTCHours() * 60 + now.getUTCMinutes(); timeOk = c >= t && c <= t + 30; }
        if (mins >= totalMins && timeOk) {
          const ck = `seq_${seq.id}_${contact.id}_step${idx}`;
          const { data: already } = await supabase.from("wa_message_queue").select("id").eq("campaign_id", ck).limit(1);
          if (already?.length) continue;
          await supabase.from("wa_message_queue").insert({ user_id: seq.user_id, phone: contact.contact_phone, message: step.message, status: "queued", campaign_id: ck, type: "sequence", scheduled_at: new Date().toISOString() });
          await supabase.from("wa_sequence_contacts").update({ current_step: idx + 1, last_sent_at: now.toISOString() }).eq("id", contact.id);
          console.log(`[Seq] Step ${idx + 1} for ${contact.contact_phone}`);
        }
      }
    }
  } catch (err) { console.error("[Sequence]", err.message); }
}

// ─── RECURRING AUTOMATIONS PROCESSOR ───
async function processRecurring() {
  if (!supabase) return;
  try {
    const { data: automations } = await supabase.from("recurring_automations").select("*").eq("status", "active");
    if (!automations?.length) return;
    const now = new Date();
    const currentDay = now.getDay(); // 0=Sun
    const currentMins = now.getUTCHours() * 60 + now.getUTCMinutes();
    // Adjust for WAT (UTC+1)
    const watMins = (now.getUTCHours() + 1) * 60 + now.getUTCMinutes();

    for (const auto of automations) {
      // Check if today is a scheduled day
      if (!auto.schedule_days?.includes(currentDay)) continue;
      // Check time (within 5 min window)
      const [h, m] = auto.schedule_time.split(":").map(Number);
      const targetMins = h * 60 + m;
      if (watMins < targetMins || watMins > targetMins + 10) continue;
      // Check if already ran today
      const today = now.toISOString().split("T")[0];
      if (auto.last_run_at && auto.last_run_at.startsWith(today)) continue;

      console.log(`[Recurring] Running "${auto.name}" (${auto.channel})`);

      if (auto.channel === "whatsapp" || auto.channel === "whatsapp_group") {
        const session = sessions.get(auto.user_id);
        if (!session || session.status !== "connected") {
          console.log(`[Recurring] "${auto.name}" skipped — session not connected, will retry`);
          continue; // Don't mark as done, retry next cycle
        }
        if (auto.channel === "whatsapp_group" && auto.target_id) {
          // Queue group message through the queue processor
          await supabase.from("wa_message_queue").insert({
            user_id: auto.user_id, phone: auto.target_id, message: auto.message,
            status: "queued", type: "recurring", campaign_id: `recurring_${auto.id}_${today}`,
            scheduled_at: now.toISOString(),
          });
          console.log(`[Recurring] Queued group message for ${auto.target_id}`);
        } else {
          // Get phones from list or direct
          let phones = [];
          if (auto.target_type === "list" && auto.target_id) {
            const { data: subs } = await supabase.from("email_subscribers").select("phone").eq("list_id", auto.target_id).eq("status", "active").not("phone", "is", null);
            phones = (subs || []).map(s => s.phone.replace(/[\s\-\+]/g, "").replace(/^0(\d{10})$/, "234$1"));
          } else if (auto.target_phones) {
            phones = auto.target_phones.split(",").map(p => p.trim().replace(/[\s\-\+]/g, "").replace(/^0(\d{10})$/, "234$1"));
          }
          if (phones.length) {
            await supabase.from("wa_message_queue").insert(phones.map(p => ({ user_id: auto.user_id, phone: p, message: auto.message, status: "queued", type: "recurring", campaign_id: `recurring_${auto.id}_${today}`, scheduled_at: now.toISOString() })));
          }
        }
      } else if (auto.channel === "sms") {
        // Queue SMS via sms_history or direct API call
        let phones = [];
        if (auto.target_type === "list" && auto.target_id) {
          const { data: subs } = await supabase.from("email_subscribers").select("phone").eq("list_id", auto.target_id).eq("status", "active").not("phone", "is", null);
          phones = (subs || []).map(s => s.phone.replace(/[\s\-\+]/g, "").replace(/^0(\d{10})$/, "234$1"));
        } else if (auto.target_phones) {
          phones = auto.target_phones.split(",").map(p => p.trim().replace(/[\s\-\+]/g, "").replace(/^0(\d{10})$/, "234$1"));
        }
        if (phones.length) {
          // Insert into sms queue for the scheduled-emails function to pick up
          await supabase.from("wa_message_queue").insert(phones.map(p => ({ user_id: auto.user_id, phone: p, message: auto.message, status: "queued", type: "recurring_sms", campaign_id: `recurring_sms_${auto.id}_${today}`, scheduled_at: now.toISOString() })));
        }
      } else if (auto.channel === "email") {
        // Send email via ses-send-email function
        let emails = [];
        if (auto.target_type === "list" && auto.target_id) {
          const { data: subs } = await supabase.from("email_subscribers").select("email").eq("list_id", auto.target_id).eq("status", "active");
          emails = (subs || []).map(s => s.email);
        }
        if (emails.length) {
          const sesUrl = `${SUPABASE_URL}/functions/v1/ses-send-email`;
          try {
            await fetch(sesUrl, {
              method: "POST",
              headers: { "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ recipients: emails, subject: auto.subject || auto.name, htmlBody: auto.message, addUnsubscribe: true }),
            });
          } catch (e) { console.error(`[Recurring] Email send failed:`, e.message); }
        }
      }

      // Mark as ran
      await supabase.from("recurring_automations").update({ last_run_at: now.toISOString() }).eq("id", auto.id);
      console.log(`[Recurring] Done: "${auto.name}"`);
    }
  } catch (err) { console.error("[Recurring]", err.message); }
}

// ─── BACKGROUND LOOPS ───
setInterval(processQueue, 5000);
setInterval(processCampaigns, 30000);
setInterval(processSequences, 60000);
setInterval(processRecurring, 60000);
setInterval(() => { fetch(process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/` : `http://localhost:${PORT}/`).catch(() => {}); }, 4 * 60 * 1000);

// ─── ROUTES ───
app.get("/", (req, res) => {
  const list = [];
  for (const [uid, s] of sessions) list.push({ userId: uid, status: s.status, phone: s.phone });
  res.json({ status: "ok", engine: "baileys", sessions: sessions.size, mem: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB", details: list });
});
app.post("/session/start", auth_mw, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = await getOrCreateSession(userId);
  res.json({ status: session.status, qr: session.qr, phone: session.phone, error: session.error });
});
app.get("/session/status/:userId", auth_mw, (req, res) => {
  const session = sessions.get(req.params.userId);
  if (!session) return res.json({ status: "none" });
  const rl = getRateLimit(req.params.userId);
  res.json({ status: session.status, qr: session.qr, phone: session.phone, error: session.error, dailySent: rl.dailySent, dailyLimit: rl.dailyLimit, paused: rl.paused });
});
app.post("/session/disconnect", auth_mw, async (req, res) => {
  const { userId } = req.body;
  const session = sessions.get(userId);
  if (!session) return res.json({ status: "not_found" });
  try { await session.sock.logout(); } catch {}
  try { session.sock.end(); } catch {}
  await clearAuth(userId);
  sessions.delete(userId);
  res.json({ status: "disconnected" });
});
app.post("/send", auth_mw, async (req, res) => {
  const { userId, phone, message } = req.body;
  if (!userId || !phone || !message) return res.status(400).json({ error: "userId, phone, message required" });
  const session = sessions.get(userId);
  if (!session || session.status !== "connected") return res.status(400).json({ error: "Session not connected" });
  const check = canSend(userId);
  if (!check.ok) return res.status(429).json({ error: check.reason });
  try {
    await session.sock.sendMessage(phone.replace(/[\s\-\+]/g, "") + "@s.whatsapp.net", { text: message });
    recordSend(userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/queue", auth_mw, async (req, res) => {
  const { userId, phone, message } = req.body;
  if (!userId || !phone || !message) return res.status(400).json({ error: "required" });
  if (!supabase) return res.status(500).json({ error: "DB not configured" });
  await supabase.from("wa_message_queue").insert({ user_id: userId, phone, message, status: "queued", type: "direct", scheduled_at: new Date().toISOString() });
  res.json({ success: true });
});
app.post("/send/bulk", auth_mw, async (req, res) => {
  const { userId, contacts, message } = req.body;
  if (!userId || !contacts?.length || !message) return res.status(400).json({ error: "required" });
  if (!supabase) return res.status(500).json({ error: "DB not configured" });
  await supabase.from("wa_message_queue").insert(contacts.map(p => ({ user_id: userId, phone: p, message, status: "queued", type: "bulk", scheduled_at: new Date().toISOString() })));
  res.json({ success: true, queued: contacts.length });
});
app.get("/rate-limit/:userId", auth_mw, (req, res) => { res.json(getRateLimit(req.params.userId)); });
app.get("/sessions", auth_mw, (req, res) => {
  const list = [];
  for (const [uid, s] of sessions) list.push({ userId: uid, status: s.status, phone: s.phone });
  res.json(list);
});

app.get("/groups/:userId", auth_mw, async (req, res) => {
  const session = sessions.get(req.params.userId);
  if (!session || session.status !== "connected") return res.status(400).json({ error: "Session not connected" });
  try {
    const groups = await session.sock.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => ({ id: g.id, name: g.subject, participants: g.participants?.length || 0 }));
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/groups/participants", auth_mw, async (req, res) => {
  const { userId, groupId } = req.body;
  if (!userId || !groupId) return res.status(400).json({ error: "userId and groupId required" });
  const session = sessions.get(userId);
  if (!session || session.status !== "connected") return res.status(400).json({ error: "Session not connected" });
  try {
    const metadata = await session.sock.groupMetadata(groupId);
    const participants = (metadata.participants || []).map(p => {
      const id = p.id || "";
      const isLid = id.includes("@lid");
      const phone = isLid ? null : id.replace("@s.whatsapp.net", "");
      return { phone, lid: isLid ? id : null, admin: p.admin || null };
    }).filter(p => p.phone);
    res.json({ name: metadata.subject, participants, total: metadata.participants?.length || 0, filtered: participants.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/send/group", auth_mw, async (req, res) => {
  const { userId, groupId, message } = req.body;
  if (!userId || !groupId || !message) return res.status(400).json({ error: "userId, groupId, message required" });
  const session = sessions.get(userId);
  if (!session || session.status !== "connected") return res.status(400).json({ error: "Session not connected" });
  const check = canSend(userId);
  if (!check.ok) return res.status(429).json({ error: check.reason });
  try {
    await session.sock.sendMessage(groupId, { text: message });
    recordSend(userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

process.on("uncaughtException", (err) => console.error("[UNCAUGHT]", err.message));
process.on("unhandledRejection", (err) => console.error("[UNHANDLED]", err));

app.listen(PORT, async () => {
  console.log(`WhatsApp server (Baileys) on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? "connected" : "NOT configured"}`);
  await restoreSessions();
});
