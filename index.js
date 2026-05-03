const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
ffmpeg.setFfmpegPath(ffmpegPath);
const os = require("os");

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
        // Send disconnect alert email
        if (supabase) {
          try {
            const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", userId).single();
            const { data: authUser } = await supabase.auth.admin.getUserById(userId);
            const email = authUser?.user?.email;
            if (email) {
              const sesUrl = `${SUPABASE_URL}/functions/v1/ses-send-email`;
              await fetch(sesUrl, {
                method: "POST",
                headers: { "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  recipients: [email],
                  subject: "\u26a0\ufe0f Your WhatsApp is disconnected",
                  htmlBody: "<div style='font-family:system-ui;max-width:520px;margin:0 auto;padding:32px'><div style='background:#fef2f2;border-radius:12px;padding:20px;border-left:4px solid #dc2626'><h2 style='color:#dc2626;font-size:18px;margin:0 0 8px'>WhatsApp Disconnected</h2><p style='color:#555;font-size:14px;line-height:1.6;margin:0'>Your WhatsApp connection has been lost. Your chatbot and automations won't work until you reconnect.</p></div><div style='text-align:center;margin-top:20px'><a href='https://business.gooddeednetwork.com/settings/connect-whatsapp' style='display:inline-block;background:#dc2626;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:13px'>Reconnect Now</a></div></div>",
                }),
              });
              console.log(`[${userId}] Disconnect alert email sent to ${email}`);
            }
          } catch (e) { console.error(`[${userId}] Disconnect email failed:`, e.message); }
        }
      } else if (code === 440) {
        // Connection replaced — another instance connected. Don't reconnect.
        console.log(`[${userId}] Connection replaced (440), waiting...`);
        session.status = "reconnecting";
        // Wait longer before reconnecting to avoid loop
        setTimeout(() => {
          if (session.status === "reconnecting") {
            sessions.delete(userId);
            getOrCreateSession(userId);
          }
        }, 30000);
      } else {
        session.status = "reconnecting";
        setTimeout(() => {
          sessions.delete(userId);
          getOrCreateSession(userId);
        }, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    console.log(`[MSG] Received ${msgs.length} message(s), type: ${type}`);
    for (const msg of msgs) {
      const fromMe = msg.key.fromMe;
      const jid = msg.key.remoteJid || "";
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
      console.log(`[MSG] from=${jid} fromMe=${fromMe} text="${text.slice(0, 50)}"`);
      if (!fromMe && (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"))) {
        const phone = jid.replace("@s.whatsapp.net", "").replace("@lid", "");
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        
        // Track sequence replies
        if (supabase) {
          try { await supabase.from("wa_sequence_contacts").update({ status: "replied", has_replied: true }).eq("user_id", userId).eq("contact_phone", phone).eq("status", "active"); } catch {}
        }

        // AI Chatbot auto-reply
        if (supabase && text) {
          try {
            console.log(`[Chatbot] Message from ${phone}: "${text.slice(0, 80)}" (user: ${userId})`);
            // Check if user has an active WhatsApp chatbot
            const { data: bots, error: botErr } = await supabase.from("chatbots").select("*").eq("user_id", userId).eq("platform", "whatsapp").eq("is_active", true).limit(1);
            console.log(`[Chatbot] Bots found: ${bots?.length || 0}, error: ${botErr?.message || "none"}`);
            const bot = bots?.[0];
            if (bot) {
              console.log(`[Chatbot] Using bot: ${bot.name} (${bot.id})`);
              // Load conversation history (last 10 messages)
              const { data: history } = await supabase.from("chat_messages").select("role, content").eq("chatbot_id", bot.id).eq("phone_number", phone).order("created_at", { ascending: false }).limit(10);
              const chatHistory = (history || []).reverse().map(h => ({ role: h.role, content: h.content }));

              // Save incoming message
              await supabase.from("chat_messages").insert({ chatbot_id: bot.id, phone_number: phone, role: "user", content: text });

              // Build AI prompt
              const systemPrompt = `You are an AI customer service assistant for a business. Your name is ${bot.name}.

BUSINESS INSTRUCTIONS:
${bot.instructions}

${bot.knowledge_base ? `KNOWLEDGE BASE (use this to answer questions):
${bot.knowledge_base}
` : ""}
RULES:
- Be helpful, friendly, and professional
- Answer in the same language the customer writes in
- Keep responses concise (max 3-4 sentences unless they ask for details)
- If you don't know something, say so honestly and offer to connect them with a human
- Never make up information about products, prices, or policies
- Use WhatsApp-friendly formatting: *bold*, _italic_, no markdown headers`;

              // Call AI (Groq)
              const { data: groqConfig } = await supabase.from("api_config").select("api_key").eq("service", "groq").maybeSingle();
              const { data: geminiConfig } = await supabase.from("api_config").select("api_key").eq("service", "gemini").maybeSingle();

              let aiReply = "";

              if (groqConfig?.api_key) {
                const aiRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${groqConfig.api_key}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: bot.model || "llama-3.3-70b-versatile",
                    messages: [{ role: "system", content: systemPrompt }, ...chatHistory, { role: "user", content: text }],
                    temperature: bot.temperature || 0.7,
                    max_tokens: 500,
                  }),
                });
                const aiData = await aiRes.json();
                aiReply = aiData.choices?.[0]?.message?.content || "";
              } else if (geminiConfig?.api_key) {
                const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiConfig.api_key}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: [...chatHistory.map(h => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] })), { role: "user", parts: [{ text }] }],
                    generationConfig: { maxOutputTokens: 500, temperature: bot.temperature || 0.7 },
                  }),
                });
                const aiData = await aiRes.json();
                aiReply = aiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
              }

              if (aiReply) {
                // Send reply using original JID (works for both @s.whatsapp.net and @lid)
                await sock.sendMessage(jid, { text: aiReply });
                console.log(`[Chatbot] Replied to ${phone}: ${aiReply.slice(0, 100)}`);

                // Save reply to history
                await supabase.from("chat_messages").insert({ chatbot_id: bot.id, phone_number: phone, role: "assistant", content: aiReply });
              }
            }
          } catch (chatErr) {
            console.error(`[Chatbot] Error:`, chatErr.message);
          }
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
      await new Promise(r => setTimeout(r, 15000));
      const s = sessions.get(userId);
      if (s && s.status === "connected") {
        console.log(`[Restore] ${userId} connected successfully`);
      } else {
        console.log(`[Restore] ${userId} status: ${s?.status || 'none'} — will retry on next message`);
      }
    } catch (e) {
      console.error(`[Restore] ${userId} error:`, e.message);
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
      // SMS messages — send via BulkSMS API, not WhatsApp
      if (msg.type === "recurring_sms" || msg.type === "sms") {
        try {
          const { data: smsConfig } = await supabase.from("api_config").select("api_key").eq("service", "bulksms").single();
          if (!smsConfig?.api_key) {
            await supabase.from("wa_message_queue").update({ status: "failed", error_message: "BulkSMS not configured" }).eq("id", msg.id);
            continue;
          }
          // Get sender ID
          const { data: senderIdConfig } = await supabase.from("api_config").select("api_key").eq("service", "bulksms_sender_id").maybeSingle();
          const senderId = senderIdConfig?.api_key || "GoodDeeds";
          const smsRes = await fetch("https://www.bulksmsnigeria.com/api/v2/sms", {
            method: "POST",
            headers: { "Authorization": `Bearer ${smsConfig.api_key}`, "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ from: senderId, to: msg.phone, body: msg.message, gateway: "direct-refund" }),
          });
          const smsData = await smsRes.json().catch(() => ({}));
          console.log(`[Queue] SMS to ${msg.phone}:`, smsRes.status, JSON.stringify(smsData).slice(0, 200));
          if (smsRes.ok) {
            await supabase.from("wa_message_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", msg.id);
          } else {
            await supabase.from("wa_message_queue").update({ status: "failed", error_message: smsData.error || `HTTP ${smsRes.status}` }).eq("id", msg.id);
          }
        } catch (smsErr) {
          await supabase.from("wa_message_queue").update({ status: "failed", error_message: smsErr.message }).eq("id", msg.id);
        }
        await new Promise(r => setTimeout(r, randomDelay()));
        continue;
      }
      // WhatsApp messages
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

// ─── REMINDER PROCESSOR (every 60s) ───
async function processReminders() {
  if (!supabase) return;
  try {
    const now = new Date().toISOString();
    // Get due reminders that haven't been notified yet
    const { data: reminders } = await supabase
      .from("reminders")
      .select("*, profiles!inner(full_name)")
      .eq("status", "pending")
      .lte("due_date", now)
      .is("notified_at", null)
      .limit(10);

    if (!reminders?.length) return;
    console.log(`[Reminders] Processing ${reminders.length} due reminder(s)`);

    for (const rem of reminders) {
      // Get user email
      const { data: authUser } = await supabase.auth.admin.getUserById(rem.user_id);
      const email = authUser?.user?.email;

      if (email && rem.send_email !== false) {
        const sesUrl = `${SUPABASE_URL}/functions/v1/ses-send-email`;
        try {
          await fetch(sesUrl, {
            method: "POST",
            headers: { "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              recipients: [email],
              subject: "\u23f0 Reminder: " + rem.title,
              htmlBody: "<div style='font-family:system-ui;max-width:520px;margin:0 auto;padding:32px'>"
                + "<div style='background:#fef3c7;border-radius:12px;padding:20px;border-left:4px solid #f59e0b'>"
                + "<h2 style='color:#b45309;font-size:18px;margin:0 0 8px'>\u23f0 Reminder Due Now</h2>"
                + "<p style='color:#333;font-size:15px;font-weight:600;margin:0 0 4px'>" + rem.title + "</p>"
                + (rem.description ? "<p style='color:#555;font-size:13px;margin:0 0 8px'>" + rem.description + "</p>" : "")
                + "<p style='color:#888;font-size:12px;margin:0'>Category: " + (rem.category || "General") + "</p>"
                + "</div>"
                + "<div style='text-align:center;margin-top:20px'>"
                + "<a href='https://business.gooddeednetwork.com/reminders' style='display:inline-block;background:#8B5CF6;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:13px'>View Reminders</a>"
                + "</div></div>",
            }),
          });
          console.log(`[Reminders] Email sent for "${rem.title}" to ${email}`);
        } catch (e) { console.error(`[Reminders] Email failed:`, e.message); }
      }

      // Send WhatsApp if enabled
      if (rem.send_whatsapp && rem.recipient_phone) {
        const session = sessions.get(rem.user_id);
        if (session?.status === "connected") {
          try {
            const phone = rem.recipient_phone.replace(/[\s\-\+]/g, "") + "@s.whatsapp.net";
            await session.sock.sendMessage(phone, { text: `*\u23f0 Reminder: ${rem.title}*\n\n${rem.description || ""}\n\n_This reminder is now due._` });
            console.log(`[Reminders] WhatsApp sent for "${rem.title}"`);
          } catch (e) { console.error(`[Reminders] WhatsApp failed:`, e.message); }
        }
      }

      // Mark as notified
      await supabase.from("reminders").update({ notified_at: now, status: "sent" }).eq("id", rem.id);
    }
  } catch (err) { console.error("[Reminders]", err.message); }
}

// ─── BACKGROUND LOOPS ───
setInterval(processQueue, 5000);
setInterval(processCampaigns, 30000);
setInterval(processSequences, 60000);
setInterval(processRecurring, 60000);
setInterval(processReminders, 60000);
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

// ─── VIDEO GENERATION ───

// Format configs
const VIDEO_FORMATS = {
  landscape: { w: 1920, h: 1080, fontScale: 1.0,  yOffset: 0    },
  square:    { w: 1080, h: 1080, fontScale: 0.85, yOffset: 0    },
  portrait:  { w: 1080, h: 1920, fontScale: 0.85, yOffset: -120 }, // slightly above center
};

// Scene definitions
const VIDEO_SCENES = [
  { text: "Welcome to GoodDeeds Network",  bg: "0x0a0a0a", fontsize: 64, fontcolor: "white",    animation: "fade_up"   },
  { text: "All-in-One Business Platform",  bg: "0x0d1b2a", fontsize: 58, fontcolor: "0x22c55e", animation: "word_by_word" },
  { text: "Simple. Fast. Powerful.",        bg: "0x1a0a2e", fontsize: 72, fontcolor: "white",    animation: "zoom_in"   },
  { text: "Start Growing Today",            bg: "0x0a1a0a", fontsize: 66, fontcolor: "0x22c55e", animation: "fade_up"   },
];

async function renderScene(sc, fmt, sceneOut, fontPath, D, FPS) {
  const { w, h, fontScale, yOffset } = fmt;
  const fs_size = Math.round(sc.fontsize * fontScale);
  const fontOpt = fontPath ? `:fontfile=${fontPath}` : "";
  const fade = 0.35;
  const escText = (t) => t
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
  const safeText = escText(sc.text);
  const centerY = yOffset !== 0 ? `(${h}-text_h)/2+${yOffset}` : `(${h}-text_h)/2`;
  const centerX = `(${w}-text_w)/2`;
  const alphaFade = `if(lt(t,${fade}),t/${fade},if(gt(t,${D - fade}),(${D}-t)/${fade},1))`;
  let filters = [];

  if (sc.animation === "fade_up") {
    const yExpr = `${centerY}-40*(t/${D})`;
    filters = [`drawtext=text='${safeText}'${fontOpt}:fontcolor=${sc.fontcolor}:fontsize=${fs_size}:x='${centerX}':y='${yExpr}':alpha='${alphaFade}'`];

  } else if (sc.animation === "zoom_in") {
    // Only use pad+crop zoom for square (1080x1080). Larger formats use fade_up to avoid SIGKILL.
    if (w <= 1080 && h <= 1080) {
      const pad = Math.round(w * 0.05);
      filters = [
        `pad=${w + pad * 2}:${h + pad * 2}:${pad}:${pad}:color=${sc.bg}`,
        `crop=${w}:${h}:'${pad}*(1-t/${D})':'${pad}*(1-t/${D})'`,
        `drawtext=text='${safeText}'${fontOpt}:fontcolor=${sc.fontcolor}:fontsize=${fs_size}:x='${centerX}':y='${centerY}':alpha='${alphaFade}'`,
      ];
    } else {
      // Fallback for large frames: simple fade_up (no heavy filter)
      const yExpr = `${centerY}-30*(t/${D})`;
      filters = [`drawtext=text='${safeText}'${fontOpt}:fontcolor=${sc.fontcolor}:fontsize=${fs_size}:x='${centerX}':y='${yExpr}':alpha='${alphaFade}'`];
    }

  } else if (sc.animation === "word_by_word") {
    const words = sc.text.split(" ");
    const wordDelay = Math.min(0.35, (D * 0.6) / words.length);
    const charW = Math.round(fs_size * 0.55);
    const spaceW = Math.round(fs_size * 0.3);
    const wordWidths = words.map(word => word.length * charW);
    const totalW = wordWidths.reduce((s, ww) => s + ww, 0) + spaceW * (words.length - 1);
    let xCursor = Math.round((w - totalW) / 2);
    const wordFilters = words.map((word, idx) => {
      const sw = escText(word);
      const startT = (idx * wordDelay).toFixed(2);
      const endFade = (idx * wordDelay + fade).toFixed(2);
      const wordAlpha = `if(lt(t,${startT}),0,if(lt(t,${endFade}),(t-${startT})/${fade},if(gt(t,${(D - fade).toFixed(2)}),(${D}-t)/${fade},1)))`;
      const xPos = xCursor;
      xCursor += wordWidths[idx] + spaceW;
      return `drawtext=text='${sw}'${fontOpt}:fontcolor=${sc.fontcolor}:fontsize=${fs_size}:x=${xPos}:y='${centerY}':alpha='${wordAlpha}'`;
    });
    filters = wordFilters;
  }

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=${sc.bg}:size=${w}x${h}:rate=${FPS}:duration=${D}`)
      .inputOptions(["-f", "lavfi"])
      .videoFilters(filters)
      .outputOptions(["-c:v", "libx264", "-preset", (w > 1080 || h > 1080) ? "ultrafast" : "fast", "-crf", "26", "-pix_fmt", "yuv420p", "-t", String(D)])
      .output(sceneOut)
      .on("stderr", line => { if (line.includes("Error")) console.log("[FFmpeg]", line); })
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}


// ─── PIXABAY MUSIC FETCH ───
async function fetchPixabayMusic() {
  const key = process.env.PIXABAY_API_KEY || "55700466-152b17378ca052da54a0afb72";
  const queries = ["corporate background", "motivational upbeat", "ambient business"];
  const q = queries[Math.floor(Math.random() * queries.length)];
  try {
    const url = `https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(q)}&category=music&per_page=20&safesearch=true`;
    const res = await fetch(url);
    const data = await res.json();
    const hits = (data.hits || []).filter(h => h.webformatURL || h.previewURL);
    if (!hits.length) return null;
    const hit = hits[Math.floor(Math.random() * Math.min(hits.length, 10))];
    // Pixabay music tracks are returned as audio files via previewURL
    return hit.previewURL || hit.webformatURL || null;
  } catch (e) {
    console.log("[Music] Fetch failed:", e.message);
    return null;
  }
}


// ─── JAMENDO MUSIC FETCH ───
async function fetchPixabayMusic() {
  const clientId = process.env.JAMENDO_CLIENT_ID || "3ff88d7b";
  const tags = ["background", "corporate", "ambient", "motivational"];
  const tag = tags[Math.floor(Math.random() * tags.length)];
  try {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${clientId}&format=json&limit=20&tags=${tag}&audioformat=mp32&include=musicinfo&boost=popularity_total`;
    const res = await fetch(url);
    const data = await res.json();
    const tracks = (data.results || []).filter(t => t.audio);
    if (!tracks.length) return null;
    const track = tracks[Math.floor(Math.random() * Math.min(tracks.length, 10))];
    console.log(`[Music] Track: "${track.name}" by ${track.artist_name}`);
    return track.audio;
  } catch (e) {
    console.log("[Music] Jamendo fetch failed:", e.message);
    return null;
  }
}

app.post("/generate-video", async (req, res) => {
  const formatKey = (req.body?.format || "landscape");
  const fmt = VIDEO_FORMATS[formatKey] || VIDEO_FORMATS.landscape;
  const D = 3.0;
  const FPS = (fmt.w > 1080 || fmt.h > 1080) ? 24 : 25;

  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const sceneFiles = [];
  const outputPath = path.join(tmpDir, `video_${ts}.mp4`);
  const listFile   = path.join(tmpDir, `list_${ts}.txt`);

  const fontCandidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  ];
  const fontPath = fontCandidates.find(f => fs.existsSync(f)) || null;
  const cleanup = () => [outputPath, listFile, ...sceneFiles].forEach(f => { try { fs.unlinkSync(f); } catch {} });

  try {
    for (let i = 0; i < VIDEO_SCENES.length; i++) {
      const sceneOut = path.join(tmpDir, `scene_${ts}_${i}.mp4`);
      sceneFiles.push(sceneOut);
      await renderScene(VIDEO_SCENES[i], fmt, sceneOut, fontPath, D, FPS);
      console.log(`[Video] Scene ${i + 1}/${VIDEO_SCENES.length} (${formatKey}) done`);
    }

    fs.writeFileSync(listFile, sceneFiles.map(f => `file '${f}'`).join("\n"));
    const silentPath = path.join(tmpDir, `silent_${ts}.mp4`);

    // Step 1: Concat scenes (no audio yet)
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .outputOptions(["-c", "copy", "-movflags", "+faststart"])
        .output(silentPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    // Step 2: Fetch background music from Pixabay
    const totalDuration = VIDEO_SCENES.length * D;
    const musicUrl = await fetchPixabayMusic();
    console.log("[Music] URL:", musicUrl || "none");

    if (musicUrl) {
      const musicPath = path.join(tmpDir, `music_${ts}.mp3`);
      try {
        // Download MP3 to temp file — avoids FFmpeg SIGSEGV on streamed URLs
        const musicRes = await fetch(musicUrl);
        if (!musicRes.ok) throw new Error(`HTTP ${musicRes.status}`);
        const musicBuf = await musicRes.arrayBuffer();
        fs.writeFileSync(musicPath, Buffer.from(musicBuf));
        console.log(`[Music] Downloaded ${Math.round(musicBuf.byteLength / 1024)}KB`);

        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(silentPath)
            .input(musicPath)
            .complexFilter([
              `[1:a]volume=0.18,atrim=0:${totalDuration},asetpts=PTS-STARTPTS[aout]`,
            ])
            .outputOptions([
              "-map", "0:v",
              "-map", "[aout]",
              "-c:v", "copy",
              "-c:a", "aac",
              "-b:a", "128k",
              "-shortest",
              "-movflags", "+faststart",
            ])
            .output(outputPath)
            .on("end", resolve)
            .on("error", (err) => {
              console.log("[Music] Mix failed, using silent:", err.message);
              try { fs.copyFileSync(silentPath, outputPath); } catch {}
              resolve();
            })
            .run();
        });
      } catch (e) {
        console.log("[Music] Download failed, using silent:", e.message);
        try { fs.copyFileSync(silentPath, outputPath); } catch {}
      } finally {
        try { fs.unlinkSync(musicPath); } catch {}
      }
    } else {
      fs.copyFileSync(silentPath, outputPath);
    }
    try { fs.unlinkSync(silentPath); } catch {}

    console.log(`[Video] Done: ${formatKey} ${fmt.w}x${fmt.h}`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename=gooddeeds-${formatKey}.mp4`);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", cleanup);
    stream.on("error", cleanup);

  } catch (err) {
    console.error("[Video] Error:", err.message);
    cleanup();
    res.status(500).json({ error: err.message });
  }
});


// ─── VIDEO TYPE 1: KINETIC TYPOGRAPHY ───
app.post("/generate-video/kinetic", async (req, res) => {
  const { text = "GoodDeeds Network", format = "square" } = req.body || {};
  const fmt = VIDEO_FORMATS[format] || VIDEO_FORMATS.square;
  const { w, h } = fmt;
  const D = 4.0; const FPS = 25;
  const tmpDir = os.tmpdir(); const ts = Date.now();
  const outputPath = path.join(tmpDir, `kinetic_${ts}.mp4`);
  const fontCandidates = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"];
  const fontOpt = fontCandidates.find(f => fs.existsSync(f)) ? `:fontfile=${fontCandidates.find(f => fs.existsSync(f))}` : "";
  const words = text.split(" ");
  const charW = Math.round(60 * 0.55);
  const spaceW = Math.round(60 * 0.3);
  const wordWidths = words.map(w => w.length * charW);
  const totalW = wordWidths.reduce((s,ww)=>s+ww,0) + spaceW*(words.length-1);
  let xCursor = Math.round((w - totalW) / 2);
  const wordDelay = 0.4;
  const filters = words.map((word, idx) => {
    const sw = word.replace(/'/g,"’").replace(/:/g,"\:").replace(/[/g,"\[").replace(/]/g,"\]");
    const startT = (idx * wordDelay).toFixed(2);
    const endT = (idx * wordDelay + 0.3).toFixed(2);
    // Each word slides in from below with scale effect
    const yExpr = `if(lt(t,${startT}),${h},if(lt(t,${endT}),${h}-((${h}-((${h}-text_h)/2))*(t-${startT})/0.3),(${h}-text_h)/2))`;
    const alpha = `if(lt(t,${startT}),0,if(lt(t,${endT}),(t-${startT})/0.3,if(gt(t,${(D-0.4).toFixed(2)}),(${D}-t)/0.4,1)))`;
    const xPos = xCursor; xCursor += wordWidths[idx] + spaceW;
    return `drawtext=text='${sw}'${fontOpt}:fontcolor=white:fontsize=60:x=${xPos}:y='${yExpr}':alpha='${alpha}'`;
  });
  try {
    await new Promise((resolve, reject) => {
      ffmpeg().input(`color=c=0x0d0d0d:size=${w}x${h}:rate=${FPS}:duration=${D}`).inputOptions(["-f","lavfi"])
        .videoFilters(filters)
        .outputOptions(["-c:v","libx264","-preset","fast","-crf","23","-pix_fmt","yuv420p","-t",String(D)])
        .output(outputPath).on("end",resolve).on("error",reject).run();
    });
    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition","attachment; filename=kinetic.mp4");
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => { try{fs.unlinkSync(outputPath);}catch{} });
  } catch(err) { try{fs.unlinkSync(outputPath);}catch{} res.status(500).json({error:err.message}); }
});

// ─── VIDEO TYPE 2: DATA VISUALIZATION ───
app.post("/generate-video/data-viz", async (req, res) => {
  const { title = "Your Growth This Month", stats = [{label:"Emails Sent",value:450,max:500},{label:"SMS Sent",value:120,max:200},{label:"Revenue",value:75,max:100}], format = "landscape" } = req.body || {};
  const fmt = VIDEO_FORMATS[format] || VIDEO_FORMATS.landscape;
  const { w, h } = fmt;
  const D = 5.0; const FPS = 25;
  const tmpDir = os.tmpdir(); const ts = Date.now();
  const outputPath = path.join(tmpDir, `dataviz_${ts}.mp4`);
  const fontCandidates = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"];
  const fontOpt = fontCandidates.find(f => fs.existsSync(f)) ? `:fontfile=${fontCandidates.find(f => fs.existsSync(f))}` : "";
  const barH = Math.round(h * 0.08);
  const barMaxW = Math.round(w * 0.6);
  const startX = Math.round(w * 0.2);
  const startY = Math.round(h * 0.3);
  const gap = Math.round(h * 0.18);
  const animDur = 1.5;
  const filters = [
    `drawtext=text='${title.replace(/'/g,"’")}'${fontOpt}:fontcolor=white:fontsize=${Math.round(h*0.055)}:x=(w-text_w)/2:y=${Math.round(h*0.1)}:alpha='if(lt(t,0.3),t/0.3,1)'`,
  ];
  stats.forEach((stat, idx) => {
    const y = startY + idx * gap;
    const pct = Math.min(stat.value / stat.max, 1);
    const barW = Math.round(barMaxW * pct);
    const delay = 0.5 + idx * 0.4;
    // Animated bar growing from left
    filters.push(`drawbox=x=${startX}:y=${y}:w='${barMaxW}':h=${barH}:color=0x333333:t=fill`);
    filters.push(`drawbox=x=${startX}:y=${y}:w='if(lt(t,${delay}),0,min(${barW}*(t-${delay})/${animDur},${barW}))':h=${barH}:color=0x22c55e:t=fill`);
    filters.push(`drawtext=text='${stat.label.replace(/'/g,"’")}'${fontOpt}:fontcolor=0xaaaaaa:fontsize=${Math.round(h*0.035)}:x=${startX}:y=${y-Math.round(h*0.045)}:alpha='if(lt(t,${delay}),0,1)'`);
    filters.push(`drawtext=text='${stat.value}'${fontOpt}:fontcolor=white:fontsize=${Math.round(h*0.04)}:x=${startX+barW+10}:y=${y+Math.round(barH*0.1)}:alpha='if(lt(t,${(delay+animDur).toFixed(1)}),0,1)'`);
  });
  try {
    await new Promise((resolve, reject) => {
      ffmpeg().input(`color=c=0x0a0a1a:size=${w}x${h}:rate=${FPS}:duration=${D}`).inputOptions(["-f","lavfi"])
        .videoFilters(filters)
        .outputOptions(["-c:v","libx264","-preset",(w>1080||h>1080)?"ultrafast":"fast","-crf","23","-pix_fmt","yuv420p","-t",String(D)])
        .output(outputPath).on("end",resolve).on("error",reject).run();
    });
    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition","attachment; filename=dataviz.mp4");
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => { try{fs.unlinkSync(outputPath);}catch{} });
  } catch(err) { try{fs.unlinkSync(outputPath);}catch{} res.status(500).json({error:err.message}); }
});

// ─── VIDEO TYPE 3: SPLIT SCREEN ───
app.post("/generate-video/split-screen", async (req, res) => {
  const { leftText = "Before GoodDeeds", rightText = "After GoodDeeds", leftSub = "Scattered tools\nWasted time\nNo insights", rightSub = "One dashboard\nFull automation\nReal results", format = "landscape" } = req.body || {};
  const fmt = VIDEO_FORMATS[format] || VIDEO_FORMATS.landscape;
  const { w, h } = fmt;
  const D = 5.0; const FPS = 25;
  const tmpDir = os.tmpdir(); const ts = Date.now();
  const outputPath = path.join(tmpDir, `split_${ts}.mp4`);
  const fontCandidates = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"];
  const fontOpt = fontCandidates.find(f => fs.existsSync(f)) ? `:fontfile=${fontCandidates.find(f => fs.existsSync(f))}` : "";
  const half = Math.round(w / 2);
  const fs2 = Math.round(h * 0.055);
  const fs3 = Math.round(h * 0.038);
  const filters = [
    // Left panel background
    `drawbox=x=0:y=0:w=${half}:h=${h}:color=0x1a0a0a:t=fill`,
    // Right panel background
    `drawbox=x=${half}:y=0:w=${half}:h=${h}:color=0x0a1a0a:t=fill`,
    // Divider line
    `drawbox=x=${half-1}:y=0:w=2:h=${h}:color=0x444444:t=fill`,
    // Left title
    `drawtext=text='${leftText.replace(/'/g,"’")}'${fontOpt}:fontcolor=0xff6b6b:fontsize=${fs2}:x=${Math.round(half*0.5)-100}:y=${Math.round(h*0.2)}:alpha='if(lt(t,0.3),t/0.3,1)'`,
    // Right title
    `drawtext=text='${rightText.replace(/'/g,"’")}'${fontOpt}:fontcolor=0x22c55e:fontsize=${fs2}:x=${half+Math.round(half*0.5)-100}:y=${Math.round(h*0.2)}:alpha='if(lt(t,0.5),0,if(lt(t,0.8),(t-0.5)/0.3,1))'`,
    // Left sub lines
    ...leftSub.split("\n").map((line, i) =>
      `drawtext=text='${line.replace(/'/g,"’")}'${fontOpt}:fontcolor=0xaaaaaa:fontsize=${fs3}:x=${Math.round(half*0.1)}:y=${Math.round(h*0.38)+i*Math.round(h*0.1)}:alpha='if(lt(t,${0.6+i*0.2}),0,if(lt(t,${0.9+i*0.2}),(t-${0.6+i*0.2})/0.3,1))'`
    ),
    // Right sub lines
    ...rightSub.split("\n").map((line, i) =>
      `drawtext=text='${line.replace(/'/g,"’")}'${fontOpt}:fontcolor=white:fontsize=${fs3}:x=${half+Math.round(half*0.1)}:y=${Math.round(h*0.38)+i*Math.round(h*0.1)}:alpha='if(lt(t,${0.8+i*0.2}),0,if(lt(t,${1.1+i*0.2}),(t-${0.8+i*0.2})/0.3,1))'`
    ),
  ];
  try {
    await new Promise((resolve, reject) => {
      ffmpeg().input(`color=c=0x111111:size=${w}x${h}:rate=${FPS}:duration=${D}`).inputOptions(["-f","lavfi"])
        .videoFilters(filters)
        .outputOptions(["-c:v","libx264","-preset",(w>1080||h>1080)?"ultrafast":"fast","-crf","23","-pix_fmt","yuv420p","-t",String(D)])
        .output(outputPath).on("end",resolve).on("error",reject).run();
    });
    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition","attachment; filename=split-screen.mp4");
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => { try{fs.unlinkSync(outputPath);}catch{} });
  } catch(err) { try{fs.unlinkSync(outputPath);}catch{} res.status(500).json({error:err.message}); }
});

// ─── VIDEO TYPE 4: SUBTITLE/CAPTION STYLE ───
app.post("/generate-video/subtitle", async (req, res) => {
  const { lines = ["GoodDeeds Network","All your business tools","In one place","Email. SMS. WhatsApp.","Invoices. Social. AI.","Start free today."], format = "portrait" } = req.body || {};
  const fmt = VIDEO_FORMATS[format] || VIDEO_FORMATS.portrait;
  const { w, h } = fmt;
  const lineD = 1.8; const D = lines.length * lineD; const FPS = 25;
  const tmpDir = os.tmpdir(); const ts = Date.now();
  const sceneFiles = []; const listFile = path.join(tmpDir, `list_${ts}.txt`);
  const outputPath = path.join(tmpDir, `subtitle_${ts}.mp4`);
  const fontCandidates = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"];
  const fontOpt = fontCandidates.find(f => fs.existsSync(f)) ? `:fontfile=${fontCandidates.find(f => fs.existsSync(f))}` : "";
  const bgs = ["0x0a0a0a","0x0d1b2a","0x1a0a2e","0x0a1a0a","0x1a1a0a","0x0a0a1a"];
  try {
    for (let i = 0; i < lines.length; i++) {
      const sceneOut = path.join(tmpDir, `sub_${ts}_${i}.mp4`);
      sceneFiles.push(sceneOut);
      const safe = lines[i].replace(/'/g,"’").replace(/:/g,"\:").replace(/[/g,"\[").replace(/]/g,"\]");
      const yPos = Math.round(h * 0.72);
      const filters = [
        `drawbox=x=0:y=${yPos-20}:w=${w}:h=${Math.round(h*0.12)}:color=0x000000@0.7:t=fill`,
        `drawtext=text='${safe}'${fontOpt}:fontcolor=white:fontsize=${Math.round(h*0.048)}:x=(w-text_w)/2:y=${yPos}:alpha='if(lt(t,0.2),t/0.2,if(gt(t,${lineD-0.2}),(${lineD}-t)/0.2,1))'`,
      ];
      await new Promise((resolve, reject) => {
        ffmpeg().input(`color=c=${bgs[i%bgs.length]}:size=${w}x${h}:rate=${FPS}:duration=${lineD}`).inputOptions(["-f","lavfi"])
          .videoFilters(filters)
          .outputOptions(["-c:v","libx264","-preset","fast","-crf","23","-pix_fmt","yuv420p","-t",String(lineD)])
          .output(sceneOut).on("end",resolve).on("error",reject).run();
      });
    }
    fs.writeFileSync(listFile, sceneFiles.map(f=>`file '${f}'`).join("\n"));
    await new Promise((resolve, reject) => {
      ffmpeg().input(listFile).inputOptions(["-f","concat","-safe","0"])
        .outputOptions(["-c","copy","-movflags","+faststart"])
        .output(outputPath).on("end",resolve).on("error",reject).run();
    });
    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition","attachment; filename=subtitle.mp4");
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => { [outputPath,listFile,...sceneFiles].forEach(f=>{try{fs.unlinkSync(f);}catch{}}); });
  } catch(err) { [outputPath,listFile,...sceneFiles].forEach(f=>{try{fs.unlinkSync(f);}catch{}}); res.status(500).json({error:err.message}); }
});

// ─── VIDEO TYPE 5: REAL VIDEO BACKGROUND + TEXT OVERLAY ───
app.post("/generate-video/video-bg", async (req, res) => {
  const { scenes: customScenes, format = "landscape" } = req.body || {};
  const fmt = VIDEO_FORMATS[format] || VIDEO_FORMATS.landscape;
  const { w, h } = fmt;
  const D = 3.0; const FPS = 25;
  const tmpDir = os.tmpdir(); const ts = Date.now();
  const bgVideoUrl = "https://cdn.pixabay.com/video/2020/07/30/46207-447087782_medium.mp4";
  const bgPath = path.join(tmpDir, `bg_${ts}.mp4`);
  const outputPath = path.join(tmpDir, `videobg_${ts}.mp4`);
  const fontCandidates = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"];
  const fontOpt = fontCandidates.find(f => fs.existsSync(f)) ? `:fontfile=${fontCandidates.find(f => fs.existsSync(f))}` : "";
  const scenes = customScenes || VIDEO_SCENES;
  const totalD = scenes.length * D;
  try {
    // Download background video
    const bgRes = await fetch(bgVideoUrl);
    const bgBuf = await bgRes.arrayBuffer();
    fs.writeFileSync(bgPath, Buffer.from(bgBuf));
    console.log(`[VideoBG] Downloaded ${Math.round(bgBuf.byteLength/1024)}KB`);
    // Build text overlays for all scenes
    const filters = [
      // Scale bg to fit, loop it, darken overlay
      `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},loop=-1:size=${Math.round(totalD*FPS)},trim=0:${totalD},setpts=PTS-STARTPTS`,
      `drawbox=x=0:y=0:w=${w}:h=${h}:color=0x000000@0.55:t=fill`,
    ];
    scenes.forEach((sc, idx) => {
      const tStart = idx * D;
      const tEnd = tStart + D;
      const safe = sc.text.replace(/'/g,"’").replace(/:/g,"\:").replace(/[/g,"\[").replace(/]/g,"\]");
      const alpha = `if(lt(t,${tStart}),0,if(lt(t,${(tStart+0.4).toFixed(1)}),(t-${tStart})/0.4,if(gt(t,${(tEnd-0.4).toFixed(1)}),(${tEnd}-t)/0.4,1)))`;
      filters.push(`drawtext=text='${safe}'${fontOpt}:fontcolor=${sc.fontcolor||"white"}:fontsize=${Math.round((sc.fontsize||60)*fmt.fontScale)}:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${alpha}'`);
    });
    await new Promise((resolve, reject) => {
      ffmpeg().input(bgPath)
        .videoFilters(filters)
        .outputOptions(["-c:v","libx264","-preset",(w>1080||h>1080)?"ultrafast":"fast","-crf","23","-pix_fmt","yuv420p","-an","-t",String(totalD)])
        .output(outputPath).on("end",resolve).on("error",reject).run();
    });
    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition","attachment; filename=video-bg.mp4");
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => { [outputPath,bgPath].forEach(f=>{try{fs.unlinkSync(f);}catch{}}); });
  } catch(err) { [outputPath,bgPath].forEach(f=>{try{fs.unlinkSync(f);}catch{}}); res.status(500).json({error:err.message}); }
});

// ─── VIDEO TYPE 6: PRODUCT SHOWCASE ───
app.post("/generate-video/product", async (req, res) => {
  const { productName = "Premium Business Suite", price = "₦15,000/mo", cta = "Start Free Today", imageUrl = "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&q=80", format = "square" } = req.body || {};
  const fmt = VIDEO_FORMATS[format] || VIDEO_FORMATS.square;
  const { w, h } = fmt;
  const D = 5.0; const FPS = 25;
  const tmpDir = os.tmpdir(); const ts = Date.now();
  const imgPath = path.join(tmpDir, `product_img_${ts}.jpg`);
  const outputPath = path.join(tmpDir, `product_${ts}.mp4`);
  const fontCandidates = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"];
  const fontFile = fontCandidates.find(f => fs.existsSync(f)) || null;
  const fontOpt = fontFile ? `:fontfile=${fontFile}` : "";
  try {
    // Download product image
    const imgRes = await fetch(imageUrl);
    const imgBuf = await imgRes.arrayBuffer();
    fs.writeFileSync(imgPath, Buffer.from(imgBuf));
    const imgW = Math.round(w * 0.55); const imgH = Math.round(h * 0.5);
    const imgX = Math.round((w - imgW) / 2); const imgY = Math.round(h * 0.08);
    const textY = Math.round(h * 0.65);
    const safeProduct = productName.replace(/'/g,"’").replace(/:/g,"\:").replace(/[/g,"\[").replace(/]/g,"\]");
    const safePrice = price.replace(/'/g,"’").replace(/:/g,"\:").replace(/[/g,"\[").replace(/]/g,"\]");
    const safeCta = cta.replace(/'/g,"’").replace(/:/g,"\:").replace(/[/g,"\[").replace(/]/g,"\]");
    // Build filter: bg + image overlay + text
    const filterComplex = [
      // Scale product image
      `[1:v]scale=${imgW}:${imgH}:force_original_aspect_ratio=decrease,pad=${imgW}:${imgH}:(ow-iw)/2:(oh-ih)/2:color=0x00000000[img]`,
      // Overlay image on background with fade-in
      `[0:v][img]overlay=x=${imgX}:y=${imgY}:enable='between(t,0,${D})':alpha=1[v1]`,
      // Product name
      `[v1]drawtext=text='${safeProduct}'${fontOpt}:fontcolor=white:fontsize=${Math.round(h*0.055)}:x=(w-text_w)/2:y=${textY}:alpha='if(lt(t,0.5),t/0.5,1)'[v2]`,
      // Price
      `[v2]drawtext=text='${safePrice}'${fontOpt}:fontcolor=0x22c55e:fontsize=${Math.round(h*0.065)}:x=(w-text_w)/2:y=${textY+Math.round(h*0.09)}:alpha='if(lt(t,0.8),0,if(lt(t,1.1),(t-0.8)/0.3,1))'[v3]`,
      // CTA button style
      `[v3]drawbox=x=(w-${Math.round(w*0.5)})/2:y=${textY+Math.round(h*0.2)}:w=${Math.round(w*0.5)}:h=${Math.round(h*0.08)}:color=0x22c55e:t=fill[v4]`,
      `[v4]drawtext=text='${safeCta}'${fontOpt}:fontcolor=black:fontsize=${Math.round(h*0.04)}:x=(w-text_w)/2:y=${textY+Math.round(h*0.225)}:alpha='if(lt(t,1.2),0,if(lt(t,1.5),(t-1.2)/0.3,1))'`,
    ];
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(`color=c=0x111111:size=${w}x${h}:rate=${FPS}:duration=${D}`)
        .inputOptions(["-f","lavfi"])
        .input(imgPath)
        .complexFilter(filterComplex)
        .outputOptions(["-c:v","libx264","-preset","fast","-crf","23","-pix_fmt","yuv420p","-t",String(D)])
        .output(outputPath).on("end",resolve).on("error",reject).run();
    });
    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition","attachment; filename=product.mp4");
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => { [outputPath,imgPath].forEach(f=>{try{fs.unlinkSync(f);}catch{}}); });
  } catch(err) { [outputPath,imgPath].forEach(f=>{try{fs.unlinkSync(f);}catch{}}); res.status(500).json({error:err.message}); }
});

process.on("uncaughtException", (err) => console.error("[UNCAUGHT]", err.message));
process.on("unhandledRejection", (err) => console.error("[UNHANDLED]", err));

app.listen(PORT, async () => {
  console.log(`WhatsApp server (Baileys) on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? "connected" : "NOT configured"}`);
  await restoreSessions();
});
