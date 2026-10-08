import {
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  Keypair,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  calculateFee,
  getMint,
} from "@solana/spl-token";
import bs58 from "bs58";

const SIGNATURE_FEE = 5000;
const MAX_TRANSFERS_PER_TX = 12;
const MAX_CLOSES_PER_TX = 10;

export function keypairFromSecret(value, name) {
  if (!value) throw new Error(`${name} is not configured`);
  let bytes;
  try {
    bytes = value.trim().startsWith("[") ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value.trim());
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`${name} must contain 32 or 64 bytes`);
}

export function makeConnection(rpcUrl) {
  return new Connection(rpcUrl || "https://api.mainnet-beta.solana.com", "confirmed");
}

async function scan(connection, owner) {
  const lamports = await connection.getBalance(owner);

  const grouped = new Map();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const entry of accounts.value) {
      const info = entry.account.data.parsed.info;
      const prior = grouped.get(info.mint);
      grouped.set(info.mint, {
        raw: (prior ? prior.raw : 0n) + BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
        account: entry.pubkey.toBase58(),
        program: entry.account.owner.toBase58(),
      });
    }
  }

  return { lamports, grouped };
}

async function emptyAccountsOf(connection, owner) {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
  return accounts.value
    .filter((entry) => BigInt(entry.account.data.parsed.info.tokenAmount.amount) === 0n)
    .map((entry) => entry.pubkey);
}

function tokenProgramOf(entry) {
  return entry.program === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

function attachComputeBudget(tx, priorityMicroLamports, unitLimit) {
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }));
}

async function finalizeTx(connection, tx, feePayer) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer;
}

async function transferInstruction(connection, entry, destination, owner) {
  const mint = new PublicKey(entry.mint);
  const source = new PublicKey(entry.account);
  const program = tokenProgramOf(entry);

  if (program.equals(TOKEN_PROGRAM_ID)) {
    return createTransferCheckedInstruction(source, mint, destination, owner, entry.raw, entry.decimals, [], TOKEN_PROGRAM_ID);
  }

  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = mintInfo.transferFeeConfig;
  if (!feeConfig) {
    return createTransferCheckedInstruction(source, mint, destination, owner, entry.raw, entry.decimals, [], TOKEN_2022_PROGRAM_ID);
  }
  const fee = calculateFee(feeConfig.newerTransferFee, entry.raw);
  return createTransferCheckedWithFeeInstruction(source, mint, destination, owner, entry.raw, entry.decimals, fee, [], TOKEN_2022_PROGRAM_ID);
}

export async function buildPlan({ rpc, source, recipient, mode, liquidMints, priorityMicroLamports, unitLimit }) {
  const connection = makeConnection(rpc);
  const sourceKey = new PublicKey(source);
  const recipientKey = new PublicKey(recipient);
  if (sourceKey.equals(recipientKey)) throw new Error("source and recipient must differ");

  const { lamports, grouped } = await scan(connection, sourceKey);
  const manual = mode === "manual";
  const allowlist = manual ? new Set(liquidMints || []) : null;

  const entries = [];
  for (const [mint, entry] of grouped) {
    if (entry.raw <= 0n) continue;
    if (allowlist && !allowlist.has(mint)) continue;
    entries.push({ mint, ...entry });
  }
  entries.sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));

  const closable = await emptyAccountsOf(connection, sourceKey);

  const feePerTx = SIGNATURE_FEE + Math.ceil((priorityMicroLamports * unitLimit) / 1_000_000);
  const txCount = Math.max(1, Math.ceil(entries.length / MAX_TRANSFERS_PER_TX));
  const reserve = BigInt(feePerTx * txCount);
  const settable = (!manual) && lamports > reserve ? lamports - reserve : 0n;

  const transactions = [];
  const tokenChunks = Math.ceil(entries.length / MAX_TRANSFERS_PER_TX);
  const closeChunks = Math.ceil(closable.length / MAX_CLOSES_PER_TX);
  const iterations = Math.max(tokenChunks, closeChunks, 1);

  for (let i = 0; i < iterations; i++) {
    const chunk = entries.slice(i * MAX_TRANSFERS_PER_TX, (i + 1) * MAX_TRANSFERS_PER_TX);
    const closes = closable.slice(i * MAX_CLOSES_PER_TX, (i + 1) * MAX_CLOSES_PER_TX);
    if (chunk.length === 0 && closes.length === 0 && (i !== 0 || settable === 0n)) continue;

    const tx = new Transaction();
    attachComputeBudget(tx, priorityMicroLamports, unitLimit);

    if (i === 0 && settable > 0n) {
      tx.add(SystemProgram.transfer({ fromPubkey: sourceKey, toPubkey: recipientKey, lamports: settable }));
    }

    for (const entry of chunk) {
      const program = tokenProgramOf(entry);
      const destination = getAssociatedTokenAddressSync(new PublicKey(entry.mint), recipientKey, false, program);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(sourceKey, destination, recipientKey, new PublicKey(entry.mint), program));
      tx.add(await transferInstruction(connection, entry, destination, sourceKey));
    }

    for (const account of closes) {
      tx.add(createCloseAccountInstruction(account, recipientKey, sourceKey, [], TOKEN_PROGRAM_ID));
    }

    await finalizeTx(connection, tx, sourceKey);
    transactions.push(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
  }

  return { transactions, tokenCount: entries.length, solLamports: lamports.toString(), settableLamports: settable.toString() };
}

export async function submitSigned({ rpc, signedTransactions }) {
  const connection = makeConnection(rpc);
  const signatures = [];
  const failed = [];

  for (let i = 0; i < signedTransactions.length; i++) {
    let tx;
    try {
      tx = Transaction.from(Buffer.from(signedTransactions[i], "base64"));
    } catch {
      failed.push({ index: i, error: "malformed" });
      continue;
    }
    if (!tx.verifySignatures()) {
      failed.push({ index: i, error: "signature verification failed" });
      continue;
    }
    try {
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
      const confirmed = await confirm(connection, signature);
      if (confirmed) signatures.push(signature);
      else failed.push({ index: i, error: "not confirmed", signature });
    } catch (err) {
      failed.push({ index: i, error: err.message });
    }
  }

  return { signatures, failed, complete: failed.length === 0 && signatures.length === signedTransactions.length };
}

async function confirm(connection, signature) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (status.value && status.value.confirmationStatus === "confirmed") return status.value.err === null;
      if (status.value && status.value.err) return false;
    } catch {}
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
