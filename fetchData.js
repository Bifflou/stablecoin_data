#!/usr/bin/env node
/**
 * SG Forge Stablecoin Data Fetcher
 *
 * Requirements : Node.js 18+ (built-in fetch)
 *
 * Environment variables (optional but recommended):
 *   ETHERSCAN_API_KEY  — free at https://etherscan.io/apis
 *   SOLSCAN_API_KEY    — pro-api.solscan.io (holders Solana)
 *
 * Usage: node fetchData.js
 */

'use strict';

const fs = require('fs');

// ── Node version guard ─────────────────────────────────────────────────────
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  console.error(`Node.js 18+ required (current: ${process.version})`);
  process.exit(1);
}

// ── Config ─────────────────────────────────────────────────────────────────
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';
const SOLSCAN_KEY   = process.env.SOLSCAN_API_KEY   || '';
const DATA_JSON     = './data.json';
const DATA_JS       = './data.js';   // consumed by index.html via <script>

const TOKENS = {
  EURCV: {
    Ethereum: {
      type: 'evm',
      address:  '0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2',
      decimals: 18,
    },
    Solana: {
      type: 'solana',
      mint: 'DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52',
    },
    XRPL: {
      type:     'xrpl',
      currency: '4555524356000000000000000000000000000000',
      issuer:   'rUNaS5sqRuxZz6V7rBGhoSaZiVYA3ut4UL',
    },
    Stellar: {
      type:   'stellar',
      code:   'EURCV',
      issuer: 'CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH',
    },
  },
  USDCV: {
    Ethereum: {
      type: 'evm',
      address:  '0x5422374B27757da72d5265cC745ea906E0446634',
      decimals: 18,
    },
    Solana: {
      type: 'solana',
      mint: '8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35',
    },
  },
};

// ── Fetchers ───────────────────────────────────────────────────────────────

// Etherscan V2 API (non-deprecated)
const ETH_BASE = `https://api.etherscan.io/v2/api?chainid=1&apikey=${ETHERSCAN_KEY}&`;
const T = ms => AbortSignal.timeout(ms);

// BigInt parser — avoids float precision loss on 18-decimal tokens
function parseSupply(raw, decimals) {
  try {
    const r = BigInt(raw);
    const d = BigInt(10 ** decimals);
    return Number(r / d) + Number(r % d) / 10 ** decimals;
  } catch {
    return Number(raw) / 10 ** decimals;
  }
}

async function fetchEVM({ address, decimals }) {
  const [supplyRes, infoRes] = await Promise.all([
    fetch(`${ETH_BASE}module=stats&action=tokensupply&contractaddress=${address}`, { signal: T(12000) })
      .then(r => r.json()),
    fetch(`${ETH_BASE}module=token&action=tokeninfo&contractaddress=${address}`, { signal: T(12000) })
      .then(r => r.json()),
  ]);

  if (supplyRes.status === '0') throw new Error(`Etherscan: ${supplyRes.result}`);

  const marketcap = parseSupply(supplyRes.result, decimals);
  const holders   = Number(infoRes.result?.[0]?.holdersCount ?? 0);

  return { marketcap, holders };
}

async function fetchSolana({ mint }) {
  // Supply — public Solana RPC
  const rpc = await fetch('https://api.mainnet-beta.solana.com', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
    signal:  T(12000),
  }).then(r => r.json());

  const v = rpc.result?.value ?? {};
  const marketcap = v.uiAmount ?? (Number(v.amount ?? 0) / 10 ** (v.decimals ?? 0));

  // Holders — Solscan Pro (si clé dispo) sinon public API
  let holders = 0;
  try {
    if (SOLSCAN_KEY) {
      const h = await fetch(
        `https://pro-api.solscan.io/v2.0/token/holders?address=${mint}&page=1&page_size=1`,
        { headers: { accept: 'application/json', token: SOLSCAN_KEY }, signal: T(12000) },
      ).then(r => r.json());
      holders = Number(h.data?.total ?? 0);
    } else {
      const h = await fetch(
        `https://public-api.solscan.io/token/holders?tokenAddress=${mint}&limit=1&offset=0`,
        { headers: { accept: 'application/json' }, signal: T(8000) },
      ).then(r => r.json());
      holders = Number(h.total ?? 0);
    }
  } catch {
    console.warn(`    [Solana] holder count unavailable`);
  }

  return { marketcap, holders };
}

async function fetchXRPL({ currency, issuer }) {
  const rpc = body =>
    fetch('https://xrplcluster.com/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  T(12000),
    }).then(r => r.json());

  // Total supply via gateway_balances (obligations = total outstanding IOUs)
  const gb  = await rpc({
    method: 'gateway_balances',
    params: [{ account: issuer, ledger_index: 'validated' }],
  });
  const marketcap = parseFloat(gb.result?.obligations?.[currency] ?? 0);

  // Holders: paginate account_lines, count lines where issuer owes (balance < 0)
  let holders = 0, marker, page = 0;
  do {
    const params = { account: issuer, ledger_index: 'validated', limit: 400 };
    if (marker) params.marker = marker;

    const res   = await rpc({ method: 'account_lines', params: [params] });
    const lines = res.result?.lines ?? [];

    // From issuer's perspective: balance < 0 means the counterparty holds tokens
    holders += lines.filter(
      l => l.currency === currency && parseFloat(l.balance) < 0,
    ).length;

    marker = res.result?.marker;
    page++;
  } while (marker && page < 25); // cap at 25 pages = 10 000 trust lines

  return { marketcap, holders };
}

async function fetchStellar({ code, issuer }) {
  const res = await fetch(
    `https://horizon.stellar.org/assets?asset_code=${code}&asset_issuer=${issuer}`,
    { signal: T(12000) },
  ).then(r => r.json());

  const rec = res._embedded?.records?.[0] ?? {};
  return {
    marketcap: parseFloat(rec.amount ?? 0),
    holders:   Number(rec.num_accounts ?? 0),
  };
}

// ── Orchestration ──────────────────────────────────────────────────────────

const FETCHERS = {
  evm:     fetchEVM,
  solana:  fetchSolana,
  xrpl:    fetchXRPL,
  stellar: fetchStellar,
};

function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(n);
}

async function fetchToken(name, chains) {
  const byChain    = {};
  let totalMcap    = 0;
  let totalHolders = 0;

  for (const [chain, cfg] of Object.entries(chains)) {
    process.stdout.write(`  ${name}/${chain} ... `);
    try {
      const d = await FETCHERS[cfg.type](cfg);
      byChain[chain]  = d;
      totalMcap      += d.marketcap;
      totalHolders   += d.holders;
      console.log(`supply=${fmtNum(d.marketcap)}  holders=${d.holders}`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      byChain[chain] = { marketcap: 0, holders: 0 };
    }
  }

  return { marketcap: totalMcap, holders: totalHolders, byChain };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════');
  console.log('  SG Forge · Stablecoin Data Fetcher  ');
  console.log('══════════════════════════════════════\n');

  if (!ETHERSCAN_KEY) {
    console.warn('Warning: ETHERSCAN_API_KEY not set — Ethereum calls may be rate-limited\n');
  }

  const today    = new Date().toISOString().split('T')[0];
  const snapshot = { date: today, tokens: {} };

  for (const [name, chains] of Object.entries(TOKENS)) {
    console.log(`\n[${name}]`);
    snapshot.tokens[name] = await fetchToken(name, chains);
  }

  // Load existing store
  let store = { snapshots: [] };
  if (fs.existsSync(DATA_JSON)) {
    try {
      store = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
    } catch {
      console.warn('Could not parse existing data.json — starting fresh');
    }
  }

  // Upsert today's snapshot, keep sorted
  store.snapshots = store.snapshots.filter(s => s.date !== today);
  store.snapshots.push(snapshot);
  store.snapshots.sort((a, b) => a.date.localeCompare(b.date));

  // Write data.json (canonical) + data.js (loaded by index.html without a server)
  fs.writeFileSync(DATA_JSON, JSON.stringify(store, null, 2));
  fs.writeFileSync(DATA_JS,   `window.STABLECOIN_DATA = ${JSON.stringify(store)};`);

  console.log(`\nSaved ${store.snapshots.length} snapshot(s) → data.json + data.js`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
