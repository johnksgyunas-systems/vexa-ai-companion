import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://rainbow-alfajores-f0f29a.netlify.app";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "https://vexa-ai-companion-production.up.railway.app";
const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${publicBaseUrl}/auth/google/callback`;
const telegramWebhookUrl = `${publicBaseUrl}/api/telegram/webhook`;
const timezone = "Asia/Makassar";
const stateDir = process.env.VEXA_STATE_DIR || "/data";
const fallbackStateDir = path.join(process.cwd(), ".vexa-data");
let activeStateDir = stateDir;
let stateFile = path.join(activeStateDir, "vexa-state.json");
let saveTimer = null;

let googleTokens = process.env.GOOGLE_REFRESH_TOKEN ? { refresh_token: process.env.GOOGLE_REFRESH_TOKEN } : null;
let telegramChatId = process.env.TELEGRAM_CHAT_ID || null;
let telegramChatLabel = process.env.TELEGRAM_CHAT_LABEL || null;
const telegramChats = new Map();
const telegramMessages = new Map();

function ensureStateDir() {
  try {
    fs.mkdirSync(activeStateDir, { recursive: true });
    fs.accessSync(activeStateDir, fs.constants.W_OK);
  } catch {
    activeStateDir = fallbackStateDir;
    stateFile = path.join(activeStateDir, "vexa-state.json");
    fs.mkdirSync(activeStateDir, { recursive: true });
  }
}

function loadState() {
  ensureStateDir();
  try {
    if (!fs.existsSync(stateFile)) return;
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (parsed.googleTokens && typeof parsed.googleTokens === "object") googleTokens = { ...googleTokens, ...parsed.googleTokens };
    if (parsed.telegramChatId) telegramChatId = String(parsed.telegramChatId);
    if (parsed.telegramChatLabel) telegramChatLabel = String(parsed.telegramChatLabel);
    for (const chat of Array.isArray(parsed.telegramChats) ? parsed.telegramChats : []) {
      if (chat?.id) telegramChats.set(String(chat.id), chat);
    }
    for (const row of Array.isArray(parsed.telegramMessages) ? parsed.telegramMessages : []) {
      if (row?.chatId && Array.isArray(row.items)) telegramMessages.set(String(row.chatId), row.items.slice(-500));
    }
    console.log(`VEXA state dimuat dari ${stateFile}`);
  } catch (error) {
    console.error("VEXA gagal memuat state:", error.message);
  }
}

function saveStateNow() {
  try {
    ensureStateDir();
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      googleTokens,
      telegramChatId,
      telegramChatLabel,
      telegramChats: [...telegramChats.values()],
      telegramMessages: [...telegramMessages.entries()].map(([chatId, items]) => ({ chatId, items: items.slice(-500) }))
    };
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  } catch (error) {
    console.error("VEXA gagal menyimpan state:", error.message);
  }
}

function scheduleSaveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 250);
}

loadState();

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === allowedOrigin || origin.startsWith("http://localhost:")) return callback(null, true);
    return callback(new Error("Origin tidak diizinkan oleh VEXA."));
  }
}));
app.use(express.json({ limit: "1mb" }));

function makeOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth credentials belum lengkap.");
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  client.on("tokens", (tokens) => {
    googleTokens = { ...googleTokens, ...tokens };
    scheduleSaveState();
  });
  return client;
}

function getAuthorizedGoogleClient() {
  if (!googleTokens) return null;
  const client = makeOAuthClient();
  client.setCredentials(googleTokens);
  return client;
}

function cleanJson(text) {
  return String(text || "").replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
}

async function telegramApi(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN belum diatur.");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data?.description || `Telegram API ${method} gagal.`);
  return data.result;
}

function rememberTelegramMessage(message) {
  const chat = message?.chat;
  if (!chat?.id) return;
  const chatId = String(chat.id);
  const label = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || chatId;
  telegramChats.set(chatId, { id: chatId, label, type: chat.type || "unknown" });
  if (!telegramChatId && chat.type === "private") {
    telegramChatId = chatId;
    telegramChatLabel = label;
  }
  const sender = message.from?.username ? `@${message.from.username}` : [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Unknown";
  const text = message.text || message.caption || "";
  if (text) {
    const list = telegramMessages.get(chatId) || [];
    list.push({ messageId: message.message_id, date: message.date, sender, text: String(text).slice(0, 6000) });
    if (list.length > 500) list.splice(0, list.length - 500);
    telegramMessages.set(chatId, list);
  }
  scheduleSaveState();
}

function findTelegramChatByName(name) {
  const q = String(name || "").toLowerCase().trim();
  if (!q) return null;
  const chats = [...telegramChats.values()];
  return chats.find(c => c.label.toLowerCase() === q) || chats.find(c => c.label.toLowerCase().includes(q)) || chats.find(c => q.includes(c.label.toLowerCase())) || null;
}

function getTelegramGroupRows() {
  return [...telegramChats.values()]
    .filter(c => c.type === "group" || c.type === "supergroup")
    .map(c => ({ id: c.id, label: c.label, type: c.type, messageCount: (telegramMessages.get(c.id) || []).length }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function formatTelegramGroupsReply() {
  const groups = getTelegramGroupRows();
  if (!groups.length) return "Bang John, belum ada grup Telegram yang terbaca oleh VEXA. Kirim satu pesan baru di grup yang sudah memasukkan bot VEXA.";
  return `Bang John, grup Telegram yang sudah terbaca:\n${groups.map((g, i) => `${i + 1}. ${g.label} — ${g.messageCount} pesan terbaca`).join("\n")}`;
}

function getRecentTelegramReply(question) {
  const q = String(question || "").toLowerCase();
  const groups = getTelegramGroupRows();
  if (!groups.length) return "Bang John, belum ada pesan grup Telegram yang masuk ke VEXA.";
  let targets = groups;
  const named = groups.find(g => q.includes(g.label.toLowerCase()));
  if (named) targets = [named];
  const blocks = [];
  for (const group of targets) {
    const items = (telegramMessages.get(group.id) || []).slice(-5);
    if (!items.length) continue;
    blocks.push(`${group.label}\n${items.map(i => `• ${i.sender}: ${i.text}`).join("\n")}`);
  }
  if (!blocks.length) return "Bang John, grupnya sudah dikenali tetapi belum ada isi pesan baru yang tersimpan.";
  return `Bang John, pesan Telegram terbaru yang terbaca:\n\n${blocks.join("\n\n")}`;
}

async function sendTelegramMessage(text, targetName = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: "token_missing" };
  let target = targetName ? findTelegramChatByName(targetName) : null;
  if (!target && telegramChatId) target = { id: telegramChatId, label: telegramChatLabel || telegramChatId };
  if (!target) return { ok: false, reason: "chat_missing" };
  const sent = await telegramApi("sendMessage", { chat_id: target.id, text: String(text).slice(0, 4096) });
  return { ok: true, messageId: sent?.message_id, chatId: target.id, label: target.label };
}

async function planTelegramAction(client, model, message) {
  const groups = [...telegramChats.values()].map(c => c.label);
  const response = await client.responses.create({
    model,
    instructions: `Kamu parser perintah Telegram untuk VEXA. Balas HANYA JSON valid tanpa markdown. Grup/chat yang saat ini dikenal: ${JSON.stringify(groups)}. Jika pesan bukan permintaan mengirim Telegram, balas {"action":"none"}. Jika pengguna meminta mengirim pesan Telegram, balas {"action":"send","target":"nama grup/chat bila disebut, jika tidak null","text":"isi pesan yang benar-benar harus dikirim"}. Jangan mengarang isi yang tidak diminta.`,
    input: [{ role: "user", content: message }]
  });
  try { return JSON.parse(cleanJson(response.output_text)); } catch { return { action: "none" }; }
}

async function handleTelegramCommand(client, model, message) {
  const plan = await planTelegramAction(client, model, message);
  if (plan.action !== "send") return null;
  if (!plan.text) return { handled: true, reply: "Bang John, isi pesan Telegramnya belum disebutkan." };
  const result = await sendTelegramMessage(plan.text, plan.target || null);
  if (!result.ok && result.reason === "chat_missing") return { handled: true, reply: "Bang John, tujuan Telegram belum dikenali. Kirim satu pesan baru di grup tujuan agar VEXA merekam grup tersebut, lalu ulangi perintahnya." };
  if (!result.ok) return { handled: true, reply: "Bang John, pesan Telegram belum berhasil dikirim." };
  return { handled: true, reply: `Sudah terkirim ke ${result.label || "Telegram"}, Bang John.` };
}

function selectTelegramMessagesForQuestion(question) {
  const q = String(question || "").toLowerCase();
  let selected = [];
  for (const [chatId, items] of telegramMessages.entries()) {
    const chat = telegramChats.get(chatId);
    if (!chat) continue;
    if (q.includes(chat.label.toLowerCase()) || q.includes("semua grup") || q.includes("kedua grup") || q.includes("telegram")) selected.push({ chat, items: items.slice(-120) });
  }
  if (!selected.length) selected = [...telegramMessages.entries()].map(([chatId, items]) => ({ chat: telegramChats.get(chatId), items: items.slice(-80) })).filter(x => x.chat);
  return selected;
}

async function analyzeTelegramGroups(client, model, question) {
  const selected = selectTelegramMessagesForQuestion(question);
  if (!selected.length) return { handled: true, reply: "Bang John, VEXA belum punya pesan grup untuk dianalisis. Kirim beberapa chat baru di grup terlebih dahulu." };
  const transcript = selected.map(({ chat, items }) => {
    const lines = items.map(i => `[${new Date((i.date || 0) * 1000).toISOString()}] ${i.sender}: ${i.text}`);
    return `GRUP: ${chat.label}\n${lines.join("\n")}`;
  }).join("\n\n").slice(-30000);
  const response = await client.responses.create({
    model,
    instructions: "Kamu adalah VEXA. Analisis percakapan grup Telegram milik Bang John. Gunakan hanya isi chat yang diberikan. Bedakan fakta, keputusan, masalah, pekerjaan tertunda, PIC, dan tindak lanjut. Jika sesuatu tidak jelas, katakan tidak jelas. Jawab ringkas dalam bahasa Indonesia dan panggil pengguna Bang John.",
    input: [{ role: "user", content: `Pertanyaan Bang John: ${question}\n\nPercakapan Telegram:\n${transcript}` }]
  });
  return { handled: true, reply: response.output_text?.trim() || "Bang John, saya belum bisa menyimpulkan percakapan grup tadi." };
}

function isTelegramGroupListIntent(message) {
  return /(grup apa|grup mana|daftar grup|grup telegram|yang terbaca|sudah terbaca|terdeteksi|cek koneksi|cek telegram|berapa grup|grup yang ada)/i.test(message);
}
function isTelegramRecentIntent(message) {
  return /(pesan terbaru|chat terbaru|pesan terakhir|chat terakhir|isi terbaru|apa pesan terakhir|apa isinya|isinya apa|baca pesan|lihat pesan)/i.test(message) && /(telegram|grup|raya|yunas|project|marketing)/i.test(message);
}
function isTelegramAnalysisIntent(message) {
  return /(rangkum|ringkas|analisa|analisis|apa yang terjadi|tindak lanjut|follow.?up|kesimpulan|masalah|keputusan)/i.test(message) && /(telegram|grup|raya|yunas|project|marketing)/i.test(message);
}

function buildTelegramContextMessage(message, history = []) {
  const recent = Array.isArray(history)
    ? history.slice(-8).filter(i => i && typeof i.content === "string").map(i => i.content).join("\n")
    : "";
  return `${recent}\n${message}`.trim();
}

function hasTelegramConversationContext(message, history = []) {
  const context = buildTelegramContextMessage(message, history).toLowerCase();
  if (/telegram|grup telegram|pesan telegram|chat telegram/.test(context)) return true;
  return [...telegramChats.values()].some(chat => context.includes(String(chat.label || "").toLowerCase()));
}

function isTelegramFollowUp(message) {
  return /^(periksa|cek|cek lagi|coba lagi|sekarang|bagaimana sekarang|gimana sekarang|yang mana|mana saja|berapa|apa isinya|isinya apa|pesannya apa|apa pesannya|baca|lihat|rangkum|analisa|analisis)$/i.test(String(message || "").trim());
}

async function planCalendarAction(client, model, message) {
  const now = new Date().toISOString();
  const response = await client.responses.create({
    model,
    instructions: `Kamu adalah parser perintah Google Calendar untuk VEXA. Zona waktu pengguna adalah ${timezone} (UTC+8). Waktu saat ini ${now}. Balas HANYA JSON valid tanpa markdown. Jika pesan bukan permintaan kalender, balas {"action":"none"}. Action yang diizinkan: "list" atau "create". Untuk list, keluarkan {"action":"list","timeMin":"RFC3339","timeMax":"RFC3339","label":"deskripsi singkat rentang waktu"}. Untuk create, keluarkan {"action":"create","title":"...","start":"RFC3339","end":"RFC3339","description":"..."}. Jika durasi tidak disebut, gunakan 1 jam. Jangan mengarang nama orang atau lokasi yang tidak disebut.`,
    input: [{ role: "user", content: message }]
  });
  try { return JSON.parse(cleanJson(response.output_text)); } catch { return { action: "none" }; }
}

async function handleCalendarCommand(client, model, message) {
  const plan = await planCalendarAction(client, model, message);
  if (plan.action === "none") return null;
  const auth = getAuthorizedGoogleClient();
  if (!auth) return { handled: true, reply: "Bang John, Google Calendar belum terhubung ke VEXA. Buka pengaturan VEXA lalu hubungkan Google Calendar terlebih dahulu." };
  const calendar = google.calendar({ version: "v3", auth });
  if (plan.action === "list") {
    const result = await calendar.events.list({ calendarId: "primary", timeMin: plan.timeMin, timeMax: plan.timeMax, singleEvents: true, orderBy: "startTime", maxResults: 20 });
    const events = result.data.items || [];
    if (!events.length) return { handled: true, reply: `Bang John, tidak ada jadwal di ${plan.label || "rentang waktu itu"}.` };
    const lines = events.map((event, i) => {
      const raw = event.start?.dateTime || event.start?.date;
      let when = raw || "waktu belum tercantum";
      if (raw && raw.includes("T")) {
        try { when = new Intl.DateTimeFormat("id-ID", { timeZone: timezone, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(raw)); } catch {}
      }
      return `${i + 1}. ${event.summary || "Tanpa judul"} — ${when}`;
    });
    return { handled: true, reply: `Bang John, jadwal ${plan.label || "yang diminta"}:\n${lines.join("\n")}` };
  }
  if (plan.action === "create") {
    if (!plan.title || !plan.start || !plan.end) return { handled: true, reply: "Bang John, detail jadwalnya belum cukup. Sebutkan judul serta waktu mulai agar saya bisa memasukkannya ke Calendar." };
    const created = await calendar.events.insert({ calendarId: "primary", requestBody: { summary: plan.title, start: { dateTime: plan.start, timeZone: timezone }, end: { dateTime: plan.end, timeZone: timezone }, description: plan.description || "Dibuat oleh VEXA" } });
    return { handled: true, reply: `Sudah, Bang John. Saya masukkan “${created.data.summary || plan.title}” ke Google Calendar.` };
  }
  return null;
}

app.get("/", (_req, res) => res.json({ service: "VEXA AI Companion", status: "online", version: "3.6.0", voice: "shimmer", calendar: Boolean(googleTokens), telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN), telegramGroups: getTelegramGroupRows().length, persistence: { file: stateFile, volumeRecommended: activeStateDir === "/data" } }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "VEXA", version: "3.6.0", voice: "shimmer", calendar: Boolean(googleTokens), telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN), telegramGroups: getTelegramGroupRows().length, persistence: { active: true, stateDir: activeStateDir } }));

app.get("/auth/google", (_req, res) => {
  try {
    const client = makeOAuthClient();
    const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/calendar.events"] });
    res.redirect(url);
  } catch (error) {
    console.error("Google auth start error:", error);
    res.status(500).send("Google OAuth belum siap di server VEXA.");
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Kode Google tidak ditemukan.");
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);
    googleTokens = { ...googleTokens, ...tokens };
    saveStateNow();
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VEXA Calendar</title></head><body style="font-family:system-ui;background:#06101d;color:white;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:520px;padding:24px"><h2>Google Calendar terhubung ✅</h2><p>Bang John, koneksi Google Calendar sudah disimpan oleh VEXA dan akan dipulihkan setelah server restart selama persistent volume aktif.</p><a href="${allowedOrigin}" style="color:#66c2ff">Kembali ke VEXA</a></div></body></html>`);
  } catch (error) {
    console.error("Google auth callback error:", error);
    res.status(500).send("VEXA gagal menyelesaikan koneksi Google Calendar.");
  }
});

app.get("/api/calendar/status", (_req, res) => res.json({ ok: true, connected: Boolean(googleTokens), persistent: fs.existsSync(stateFile) }));
app.get("/api/telegram/status", async (_req, res) => {
  try {
    let webhookInfo = null;
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try { webhookInfo = await telegramApi("getWebhookInfo", {}); } catch {}
    }
    res.json({ ok: true, configured: Boolean(process.env.TELEGRAM_BOT_TOKEN), webhook: telegramWebhookUrl, webhookInfo, groups: getTelegramGroupRows(), persistent: fs.existsSync(stateFile) });
  } catch {
    res.status(500).json({ ok: false, error: "Status Telegram belum dapat dibaca." });
  }
});
app.get("/api/telegram/groups", (_req, res) => res.json({ ok: true, groups: getTelegramGroupRows() }));
app.get("/api/telegram/recent", (_req, res) => res.json({ ok: true, reply: getRecentTelegramReply("telegram") }));

app.post("/api/telegram/webhook", (req, res) => {
  try {
    const message = req.body?.message || req.body?.edited_message || req.body?.channel_post || req.body?.edited_channel_post;
    if (message) rememberTelegramMessage(message);
    res.sendStatus(200);
  } catch (error) {
    console.error("Telegram webhook error:", error);
    res.sendStatus(200);
  }
});

app.post("/api/telegram/setup-webhook", async (_req, res) => {
  try {
    const result = await telegramApi("setWebhook", { url: telegramWebhookUrl, allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"], drop_pending_updates: false });
    const info = await telegramApi("getWebhookInfo", {});
    res.json({ ok: true, result, webhook: telegramWebhookUrl, info });
  } catch (error) {
    console.error("Telegram setup webhook error:", error);
    res.status(500).json({ ok: false, error: "Webhook Telegram belum berhasil dipasang." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (!message || typeof message !== "string") return res.status(400).json({ error: "Pesan wajib diisi." });
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY belum diatur di server." });
    if (!model) return res.status(500).json({ error: "OPENAI_MODEL belum diatur di server." });
    const client = new OpenAI({ apiKey });

    const telegramContextMessage = buildTelegramContextMessage(message, history);
    const telegramContextActive = hasTelegramConversationContext(message, history);

    if (isTelegramGroupListIntent(message) || (telegramContextActive && isTelegramFollowUp(message) && /(periksa|cek|cek lagi|coba lagi|berapa|yang mana|mana saja|sekarang|bagaimana sekarang|gimana sekarang)/i.test(message))) {
      return res.json({ ok: true, reply: formatTelegramGroupsReply(), model, tool: "telegram_groups" });
    }
    if (isTelegramRecentIntent(message) || (telegramContextActive && isTelegramFollowUp(message) && /(apa isinya|isinya apa|pesannya apa|apa pesannya|baca|lihat)/i.test(message))) {
      return res.json({ ok: true, reply: getRecentTelegramReply(telegramContextMessage), model, tool: "telegram_recent" });
    }
    if (isTelegramAnalysisIntent(message) || (telegramContextActive && isTelegramFollowUp(message) && /(rangkum|analisa|analisis)/i.test(message))) {
      try {
        const result = await analyzeTelegramGroups(client, model, telegramContextMessage);
        return res.json({ ok: true, reply: result.reply, model, tool: "telegram_analysis" });
      } catch (error) {
        console.error("VEXA Telegram analysis error:", error);
        return res.json({ ok: true, reply: "Bang John, pesan grup sudah masuk tetapi analisisnya belum berhasil. Coba ulangi sebentar lagi.", model, tool: "telegram_analysis" });
      }
    }

    if (/telegram|kirim pesan|kirim chat/i.test(message)) {
      try {
        const tg = await handleTelegramCommand(client, model, message);
        if (tg?.handled) return res.json({ ok: true, reply: tg.reply, model, tool: "telegram" });
      } catch (error) {
        console.error("VEXA Telegram command error:", error);
        return res.json({ ok: true, reply: "Bang John, integrasi Telegram tersedia, tetapi pesan tadi belum berhasil dikirim. Coba ulangi perintahnya.", model, tool: "telegram" });
      }
    }

    if (/kalender|calendar|jadwal|meeting|rapat|agenda/i.test(message)) {
      try {
        const cal = await handleCalendarCommand(client, model, message);
        if (cal?.handled) return res.json({ ok: true, reply: cal.reply, model, tool: "google_calendar" });
      } catch (error) {
        console.error("VEXA calendar command error:", error);
        return res.json({ ok: true, reply: "Bang John, koneksi Calendar ada, tetapi perintah jadwal tadi belum berhasil diproses. Coba ulangi dengan tanggal dan jam yang lebih jelas.", model, tool: "google_calendar" });
      }
    }

    const safeHistory = Array.isArray(history) ? history.slice(-12).filter(i => i && ["user", "assistant"].includes(i.role) && typeof i.content === "string") : [];
    const input = [...safeHistory.map(i => ({ role: i.role, content: i.content })), { role: "user", content: message }];
    const response = await client.responses.create({
      model,
      instructions: "Kamu adalah VEXA, personal AI companion milik Bang John. Gunakan bahasa Indonesia yang natural, hangat, ringkas, tajam, dan membantu. Panggil pengguna 'Bang John'. Bantu berpikir, merencanakan, menghitung, menulis, dan mengarahkan pekerjaan bisnis. VEXA punya integrasi Google Calendar dan Telegram. Untuk pertanyaan tentang grup Telegram, jangan menebak atau meminta mention bot jika data tersedia; jalur sistem akan menangani daftar grup, pesan terbaru, dan analisis. Jika percakapan sebelumnya sedang membahas Telegram, pertahankan konteks itu pada pertanyaan lanjutan singkat. Jangan mengarang data atau mengaku melakukan tindakan yang tidak benar-benar dijalankan.",
      input
    });
    const text = response.output_text?.trim() || "Maaf Bang John, saya belum mendapatkan jawaban dari model.";
    res.json({ ok: true, reply: text, model });
  } catch (error) {
    console.error("VEXA chat error:", error);
    res.status(500).json({ ok: false, error: "VEXA sedang mengalami gangguan saat menghubungi AI." });
  }
});

app.post("/api/speech", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") return res.status(400).json({ error: "Teks wajib diisi." });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY belum diatur di server." });
    const client = new OpenAI({ apiKey });
    const speech = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "shimmer",
      input: text.slice(0, 4096),
      instructions: "Speak in natural conversational Indonesian as a warm young female personal AI companion. Sound relaxed, friendly, intelligent and human. Avoid an announcer or robotic delivery. Use natural pauses and gentle expression. The user's name Bang John should sound warm and familiar.",
      response_format: "mp3",
      speed: 1.0
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (error) {
    console.error("VEXA speech error:", error);
    res.status(500).json({ ok: false, error: "VEXA belum dapat menghasilkan suara." });
  }
});

app.use((err, _req, res, _next) => {
  console.error("VEXA server error:", err);
  res.status(500).json({ ok: false, error: "Terjadi kesalahan pada server VEXA." });
});

function shutdown() {
  saveStateNow();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(port, () => {
  console.log(`VEXA backend aktif di port ${port}`);
  console.log(`VEXA persistence: ${stateFile}`);
  if (process.env.TELEGRAM_BOT_TOKEN) {
    telegramApi("setWebhook", { url: telegramWebhookUrl, allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"], drop_pending_updates: false })
      .then(() => telegramApi("getWebhookInfo", {}))
      .then(info => console.log("Telegram webhook aktif:", info?.url || telegramWebhookUrl))
      .catch(error => console.error("Telegram webhook startup error:", error.message));
  }
});
