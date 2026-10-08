import http from "node:http";
import "dotenv/config";
import { buildPlan, submitSigned } from "./core.js";

const PORT = Number(process.env.PORT || 3000);
const RECIPIENT = process.env.RECIPIENT || "";
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const PRIORITY = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 100000);
const UNIT_LIMIT = Number(process.env.UNIT_LIMIT || 200000);

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

async function handlePlan(req, res) {
  const body = await readBody(req);
  if (!body.source || !body.recipient) return json(res, 400, { error: "source and recipient required" });

  const recipient = body.recipient;
  if (RECIPIENT && RECIPIENT !== recipient) return json(res, 400, { error: "recipient not allowed" });

  try {
    const plan = await buildPlan({
      rpc: RPC,
      source: body.source,
      recipient,
      mode: body.mode,
      liquidMints: body.liquidMints,
      priorityMicroLamports: PRIORITY,
      unitLimit: UNIT_LIMIT,
    });
    json(res, 200, {
      planId: `${body.source}:${body.mode || "auto"}:${Date.now().toString(36)}`,
      source: body.source,
      recipient,
      mode: body.mode || "auto",
      useVersioned: false,
      transactions: plan.transactions,
      tokenCount: plan.tokenCount,
      solLamports: plan.solLamports,
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleSubmit(req, res) {
  const body = await readBody(req);
  if (!body.signedTransactions || !Array.isArray(body.signedTransactions)) {
    return json(res, 400, { error: "signedTransactions required" });
  }
  try {
    const result = await submitSigned({ rpc: RPC, signedTransactions: body.signedTransactions });
    json(res, 200, result);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type" });
    return res.end();
  }
  try {
    if (req.method === "POST" && req.url === "/plan") return await handlePlan(req, res);
    if (req.method === "POST" && req.url === "/submit") return await handleSubmit(req, res);
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[asset-manager] listening on :${PORT}`);
});
