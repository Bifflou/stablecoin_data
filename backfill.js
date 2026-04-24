#!/usr/bin/env node
/**
 * SG Forge · Historical Backfill
 *
 * Fetches weekly supply data since each token's creation date.
 * Run ONCE, then use fetchData.js for daily updates.
 *
 * Requirements : Node.js 18+, ETHERSCAN_API_KEY env variable
 * Usage        : ETHERSCAN_API_KEY=xxx node backfill.js
 *
 * What it fetches historically:
 *   Ethereum → full weekly supply via Etherscan (archive-free)
 *   Stellar  → creation date + current data
 *   XRPL     → estimated weekly supply via ledger index
 *   Solana   → current data only (no free historical RPC)
 *
 * Estimated runtime: 3–8 min (rate-limited to 4 req/s on Etherscan free tier)
 */

'use strict';
const fs = require('fs');

// ── Guards ────────────────────────────────────────────────────────────────────
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) { console.error('Node.js 18+ required'); process.exit(1); }

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';
if (!ETHERSCAN_KEY) {
  console.error('Error: set ETHERSCAN_API_KEY before running');
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_JSON = './data.json';
const DATA_JS   = './data.js';

const TOKENS = {
  EURCV: {
    Ethereum: { address: '0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2', decimals: 18 },
    Solana:   { mint: 'DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52' },
    XRPL:     { currency: '4555524356000000000000000000000000000000', issuer: 'rUNaS5sqRuxZz6V7rBGhoSaZiVYA3ut4UL' },
    Stellar:  { code: 'EURCV', issuer: 'GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G' },
  },
  USDCV: {
    Ethereum: { address: '0x5422374B27757da72d5265cC745ea906E0446634', decimals: 18 },
    Solana:   { mint: '8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35' },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const tsDate = ts => new Date(ts * 1000).toISOString().split('T')[0];
const nowTs  = ()  => Math.floor(Date.now() / 1000);
const DAY    = 24 * 3600;

function dailyTimestamps(startTs, endTs) {
  const out = [];
  for (let t = startTs; t <= endTs; t += DAY) out.push(t);
  return out;
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

// ── Etherscan ─────────────────────────────────────────────────────────────────
const ETH_BASE = 'https://api.etherscan.io/v2/api';

async function etherscan(params, retries = 3) {
  await sleep(250); // 4 req/s — safe for free tier
  const url = `${ETH_BASE}?chainid=1&apikey=${ETHERSCAN_KEY}&${new URLSearchParams(params)}`;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) }).then(r => r.json());
      if (res.status === '0' && res.message !== 'No transactions found') {
        if (res.result?.includes('rate limit')) { await sleep(1000); continue; }
        throw new Error(res.result || res.message);
      }
      return res.result;
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(1000 * (i + 1));
    }
  }
}

async function getContractCreationTs(address) {
  // Step 1: get creation tx hash
  const info = await etherscan({ module: 'contract', action: 'getcontractcreation', contractaddresses: address });
  const txHash = Array.isArray(info) ? info[0]?.txHash : info?.txHash;
  if (!txHash) throw new Error('No creation tx found');

  // Step 2: get block number from tx
  const tx       = await etherscan({ module: 'proxy', action: 'eth_getTransactionByHash', txhash: txHash });
  const blockHex = tx?.blockNumber;
  if (!blockHex) throw new Error('No block in tx');

  // Step 3: get block timestamp
  const blockno  = parseInt(blockHex, 16);
  const reward   = await etherscan({ module: 'block', action: 'getblockreward', blockno });
  return { blockno, ts: Number(reward.timeStamp), date: tsDate(Number(reward.timeStamp)) };
}

async function getBlockAtTs(timestamp) {
  const result = await etherscan({ module: 'block', action: 'getblocknobytime', timestamp, closest: 'before' });
  return Number(result);
}

function parseSupply(raw, decimals) {
  try {
    const r = BigInt(raw);
    const d = BigInt(10 ** decimals);
    return Number(r / d) + Number(r % d) / 10 ** decimals;
  } catch {
    return Number(raw) / 10 ** decimals;
  }
}

async function getEthSupplyAtBlock(address, decimals, blockno) {
  const raw = await etherscan({ module: 'stats', action: 'tokensupply', contractaddress: address, blockno });
  return parseSupply(raw, decimals);
}

// ── XRPL ──────────────────────────────────────────────────────────────────────
// XRPL: ~1 ledger per 3.5 seconds
// We estimate historical ledger index from current ledger + time delta
const XRPL_SECONDS_PER_LEDGER = 3.5;

async function xrplPost(body) {
  await sleep(300);
  return fetch('https://xrplcluster.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).then(r => r.json());
}

async function getXrplCurrentLedger() {
  const res = await xrplPost({ method: 'ledger', params: [{ ledger_index: 'validated' }] });
  return {
    index: res.result.ledger_index,
    ts:    res.result.ledger?.close_time
      ? res.result.ledger.close_time + 946684800  // XRPL epoch offset to Unix
      : nowTs(),
  };
}

async function getXrplSupplyAtLedger(currency, issuer, ledgerIndex) {
  const res = await xrplPost({
    method: 'gateway_balances',
    params: [{ account: issuer, ledger_index: ledgerIndex }],
  });
  if (res.result?.error) return null;
  const obligations = res.result?.obligations ?? {};
  return parseFloat(obligations[currency] ?? 0);
}

// ── Stellar ───────────────────────────────────────────────────────────────────
async function getStellarAsset(code, issuer) {
  const res = await fetch(
    `https://horizon.stellar.org/assets?asset_code=${code}&asset_issuer=${issuer}`,
    { signal: AbortSignal.timeout(10000) }
  ).then(r => r.json());
  const rec = res._embedded?.records?.[0] ?? null;
  if (!rec) return null;
  // Normalize fields: Horizon uses balances.authorized + accounts.authorized
  return {
    ...rec,
    amount:       rec.balances?.authorized ?? '0',
    num_accounts: rec.accounts?.authorized ?? 0,
  };
}

async function getStellarCreationTs(issuer) {
  // Get the oldest operation on the issuer account
  const res = await fetch(
    `https://horizon.stellar.org/accounts/${issuer}/operations?order=asc&limit=1`,
    { signal: AbortSignal.timeout(10000) }
  ).then(r => r.json());
  const first = res._embedded?.records?.[0];
  if (!first?.created_at) return null;
  return Math.floor(new Date(first.created_at).getTime() / 1000);
}

// ── Solana ────────────────────────────────────────────────────────────────────
async function getSolanaSupply(mint) {
  const res = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
    signal: AbortSignal.timeout(10000),
  }).then(r => r.json());
  const v = res.result?.value ?? {};
  return v.uiAmount ?? (Number(v.amount ?? 0) / 10 ** (v.decimals ?? 0));
}

// ── Main backfill logic ───────────────────────────────────────────────────────

async function backfillEthereum(store) {
  console.log('\n══ Ethereum ══════════════════════════════');

  for (const [tokenName, chains] of Object.entries(TOKENS)) {
    const ethCfg = chains.Ethereum;
    if (!ethCfg) continue;

    process.stdout.write(`\n[${tokenName}] Finding creation date... `);
    let creationTs;
    try {
      const info = await getContractCreationTs(ethCfg.address);
      creationTs = info.ts;
      console.log(`deployed ${info.date} (block ${info.blockno})`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      continue;
    }

    const timestamps = dailyTimestamps(creationTs, nowTs());
    console.log(`  Building ${timestamps.length} weekly snapshots...`);

    let done = 0;
    for (const ts of timestamps) {
      const date = tsDate(ts);
      process.stdout.write(`  ${date} `);

      try {
        const blockno   = await getBlockAtTs(ts);
        const marketcap = await getEthSupplyAtBlock(ethCfg.address, ethCfg.decimals, blockno);

        // Upsert into store
        let snap = store[date];
        if (!snap) {
          snap = { date, tokens: {} };
          store[date] = snap;
        }
        if (!snap.tokens[tokenName]) {
          snap.tokens[tokenName] = { marketcap: 0, holders: null, byChain: {} };
        }
        // Set Ethereum chain data
        snap.tokens[tokenName].byChain.Ethereum = { marketcap, holders: null };
        // Recalculate total from all chains
        snap.tokens[tokenName].marketcap = Object.values(snap.tokens[tokenName].byChain)
          .reduce((sum, c) => sum + (c.marketcap ?? 0), 0);

        process.stdout.write(`${fmt(marketcap)} ✓\n`);
      } catch (err) {
        process.stdout.write(`ERROR: ${err.message}\n`);
      }

      done++;
      if (done % 10 === 0) console.log(`  ... ${done}/${timestamps.length} done`);
    }
  }
}

async function backfillXRPL(store) {
  console.log('\n══ XRPL ══════════════════════════════════');
  const eurcvXrpl = TOKENS.EURCV.XRPL;

  process.stdout.write('Getting current ledger... ');
  let currentLedger;
  try {
    currentLedger = await getXrplCurrentLedger();
    console.log(`ledger ${currentLedger.index} at ${tsDate(currentLedger.ts)}`);
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
    return;
  }

  // Go back 2 years weekly
  const startTs  = nowTs() - 2 * 365 * 24 * 3600;
  const timestamps = dailyTimestamps(startTs, nowTs());

  console.log(`  Building ${timestamps.length} weekly XRPL snapshots...`);

  for (const ts of timestamps) {
    const date = tsDate(ts);
    // Estimate ledger index for this timestamp
    const deltaSeconds = currentLedger.ts - ts;
    const estimatedLedger = Math.max(1,
      Math.round(currentLedger.index - deltaSeconds / XRPL_SECONDS_PER_LEDGER)
    );

    process.stdout.write(`  ${date} (ledger ~${estimatedLedger}) `);

    try {
      const supply = await getXrplSupplyAtLedger(eurcvXrpl.currency, eurcvXrpl.issuer, estimatedLedger);
      if (supply === null) { process.stdout.write('no data\n'); continue; }

      let snap = store[date];
      if (!snap) { snap = { date, tokens: {} }; store[date] = snap; }
      if (!snap.tokens.EURCV) snap.tokens.EURCV = { marketcap: 0, holders: null, byChain: {} };

      snap.tokens.EURCV.byChain.XRPL = { marketcap: supply, holders: null };
      snap.tokens.EURCV.marketcap = Object.values(snap.tokens.EURCV.byChain)
        .reduce((sum, c) => sum + (c.marketcap ?? 0), 0);

      process.stdout.write(`${fmt(supply)} ✓\n`);
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
    }
  }
}

async function backfillStellar(store) {
  console.log('\n══ Stellar ═══════════════════════════════');
  const cfg = TOKENS.EURCV.Stellar;

  process.stdout.write('Getting Stellar asset info... ');
  try {
    const asset = await getStellarAsset(cfg.code, cfg.issuer);
    if (!asset) { console.log('not found'); return; }

    const supply  = parseFloat(asset.amount ?? 0);
    const holders = Number(asset.num_accounts ?? 0);
    console.log(`supply=${fmt(supply)}, holders=${holders}`);

    // Try to find creation date
    process.stdout.write('Finding creation date... ');
    const creationTs = await getStellarCreationTs(cfg.issuer);
    if (creationTs) {
      console.log(tsDate(creationTs));
      // Add current data to today
      const today = tsDate(nowTs());
      if (!store[today]) store[today] = { date: today, tokens: {} };
      if (!store[today].tokens.EURCV) store[today].tokens.EURCV = { marketcap: 0, holders: null, byChain: {} };
      store[today].tokens.EURCV.byChain.Stellar = { marketcap: supply, holders };
      store[today].tokens.EURCV.marketcap = Object.values(store[today].tokens.EURCV.byChain)
        .reduce((sum, c) => sum + (c.marketcap ?? 0), 0);
      store[today].tokens.EURCV.holders = (store[today].tokens.EURCV.holders ?? 0) + holders;
    } else {
      console.log('not found');
    }
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
  }
}

async function backfillSolana(store) {
  console.log('\n══ Solana ════════════════════════════════');
  const today = tsDate(nowTs());

  for (const [tokenName, chains] of Object.entries(TOKENS)) {
    const cfg = chains.Solana;
    if (!cfg) continue;

    process.stdout.write(`[${tokenName}] current supply... `);
    try {
      const supply = await getSolanaSupply(cfg.mint);
      console.log(fmt(supply));

      if (!store[today]) store[today] = { date: today, tokens: {} };
      if (!store[today].tokens[tokenName]) {
        store[today].tokens[tokenName] = { marketcap: 0, holders: null, byChain: {} };
      }
      store[today].tokens[tokenName].byChain.Solana = { marketcap: supply, holders: null };
      store[today].tokens[tokenName].marketcap = Object.values(store[today].tokens[tokenName].byChain)
        .reduce((sum, c) => sum + (c.marketcap ?? 0), 0);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════');
  console.log('  SG Forge · Historical Backfill        ');
  console.log('════════════════════════════════════════');
  console.log('Ethereum   : full daily history from contract creation');
  console.log('XRPL       : estimated daily history (last 2 years)');
  console.log('Stellar    : current snapshot only');
  console.log('Solana     : current snapshot only (no free archive RPC)');
  console.log('\nEstimated time: 15–25 minutes\n');

  // Load existing data, indexed by date (we'll rebuild from this)
  const store = {};
  if (fs.existsSync(DATA_JSON)) {
    try {
      const existing = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
      // Keep only snapshots that have real non-zero holder data (from fetchData.js)
      // to avoid mixing with fake example data
      for (const snap of existing.snapshots ?? []) {
        const hasRealData = Object.values(snap.tokens).some(t => t.holders > 0);
        if (hasRealData) store[snap.date] = snap;
      }
      if (Object.keys(store).length > 0) {
        console.log(`Loaded ${Object.keys(store).length} existing real snapshots from data.json\n`);
      }
    } catch { /* start fresh */ }
  }

  // Run backfills
  await backfillEthereum(store);
  await backfillXRPL(store);
  await backfillStellar(store);
  await backfillSolana(store);

  // Save
  const snapshots = Object.values(store)
    .filter(s => Object.keys(s.tokens).length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const output = { snapshots };
  fs.writeFileSync(DATA_JSON, JSON.stringify(output, null, 2));
  fs.writeFileSync(DATA_JS,   `window.STABLECOIN_DATA = ${JSON.stringify(output)};`);

  console.log(`\n\n✓ Saved ${snapshots.length} snapshots → data.json + data.js`);
  console.log('\nNext steps:');
  console.log('  git add data.json data.js && git commit -m "data: historical backfill" && git push');
  console.log('  Then run: node fetchData.js   (for current full snapshot with holders)');
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
