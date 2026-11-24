// Shared JSON-RPC helper for HashKey Chain mainnet (chain ID 177)
// Zero external dependencies; uses Node.js v24 built-in fetch.

export const RPC_URL = "https://mainnet.hsk.xyz";
export const CHAIN_ID = 177;

export const TOPICS = {
  V3_POOL_CREATED: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
  V3_SWAP: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  V3_MINT: "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
  V3_BURN: "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",
  V2_SWAP: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
};

let nextId = 1;

export async function rpc(method, params = [], retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const json = await res.json();
      if (json.error) {
        throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
      }
      return json.result;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

export async function rpcBatch(calls, concurrency = 10) {
  if (calls.length === 0) return [];
  const results = new Array(calls.length);
  let cursor = 0;
  async function worker() {
    while (cursor < calls.length) {
      const idx = cursor++;
      results[idx] = await rpc(calls[idx].method, calls[idx].params || []);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, calls.length) }, worker));
  return results;
}

export async function ethCall(to, data, blockTag = "latest") {
  return rpc("eth_call", [{ to, data }, blockTag]);
}

export async function getLogsChunked({
  address,
  topics,
  fromBlock,
  toBlock,
  chunkSize = 4999,
  concurrency = 6,
}) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1) {
    const end = Math.min(toBlock, start + chunkSize);
    ranges.push([start, end]);
  }
  const results = new Array(ranges.length);
  let cursor = 0;
  async function worker() {
    while (cursor < ranges.length) {
      const idx = cursor++;
      const [s, e] = ranges[idx];
      const filter = {
        fromBlock: "0x" + s.toString(16),
        toBlock: "0x" + e.toString(16),
        topics,
      };
      if (address) filter.address = address;
      results[idx] = await rpc("eth_getLogs", [filter]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));
  return results.flat();
}

export function decodeAddress(hex) {
  if (!hex || hex === "0x") return null;
  return ("0x" + hex.slice(-40)).toLowerCase();
}

export function decodeUint256(hex) {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

export function decodeInt256(hex) {
  const v = BigInt("0x" + hex.replace(/^0x/, ""));
  const TWO256 = 1n << 256n;
  const MAX_INT256 = (1n << 255n) - 1n;
  return v > MAX_INT256 ? v - TWO256 : v;
}

export function decodeInt24(hex) {
  const v = Number(BigInt(hex) & 0xffffffn);
  return v >= 0x800000 ? v - 0x1000000 : v;
}

export function decodeString(hex) {
  if (!hex || hex === "0x") return "";
  const clean = hex.replace(/^0x/, "");
  if (clean.length === 64) {
    // bytes32 string (e.g. MKR-style)
    return Buffer.from(clean, "hex").toString("utf8").replace(/\0/g, "").trim();
  }
  if (clean.length < 128) return "";
  const offset = Number(BigInt("0x" + clean.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + clean.slice(offset, offset + 64)));
  const dataHex = clean.slice(offset + 64, offset + 64 + len * 2);
  return Buffer.from(dataHex, "hex").toString("utf8").replace(/\0/g, "").trim();
}

export function encodeAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export function encodeInt24(tick) {
  const u = tick < 0 ? (1n << 256n) + BigInt(tick) : BigInt(tick);
  return u.toString(16).padStart(64, "0");
}

export function encodeInt16(wordPos) {
  const u = wordPos < 0 ? (1n << 256n) + BigInt(wordPos) : BigInt(wordPos);
  return u.toString(16).padStart(64, "0");
}
