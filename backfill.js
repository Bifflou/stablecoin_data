#!/usr/bin/env node
/**
 * SG Forge · Historical Backfill
 *
 * Run ONCE to populate historical data, then use fetchData.js for daily updates.
 *
 * Requirements : Node.js 18+, ETHERSCAN_API_KEY env variable
 * Usage        : ETHERSCAN_API_KEY=xxx node backfill.js
 *
 * Ethereum  → reconstructs daily supply from mint/burn Transfer events (0x0)
 *             Works on free tier — no archive node needed
 * XRPL      → estimated daily supply via ledger index (last 2 years)
 * Stellar   → current snapshot only (no free historical API)
 * Solana    → current snapshot only (no free historical RPC)
 *
 * Estimated runtime: 2–5 min
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

function parseSupply(raw, decimals) {
  try {
    const r = BigInt(raw);
    const d = BigInt(10 ** decimals);
    return Number(r / d) + Number(r % d) / 10 ** decimals;
  } catch {
    return Number(raw) / 10 ** decimals;
  }
}

function upsert(store, date, tokenName, chainName, marketcap, holders = null) {
  if (!store[date]) store[date] = { date, tokens: {} };
  if (!store[date].tokens[tokenName]) {
    store[date].tokens[tokenName] = { marketcap: 0, holders: null, byChain: {} };
  }
  store[date].tokens[tokenName].byChain[chainName] = { marketcap, holders };
  store[date].tokens[tokenName].marketcap = Object.values(store[date].tokens[tokenName].byChain)
    .reduce((sum, c) => sum + (c.marketcap ?? 0), 0);
}

// ── Etherscan ─────────────────────────────────────────────────────────────────
const ETH_BASE  = 'https://api.etherscan.io/v2/api';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

async function etherscan(params, retries = 3) {
  await sleep(250); // 4 req/s — safe for free tier
  const url = `${ETH_BASE}?chainid=1&apikey=${ETHERSCAN_KEY}&${new URLSearchParams(params)}`;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) }).then(r => r.json());
      if (res.status === '0' && res.message !== 'No transactions found') {
        if (res.result?.includes?.('rate limit')) { await sleep(1500); continue; }
        throw new Error(res.result || res.message);
      }
      return res.result;
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(1000 * (i + 1));
    }
  }
}

/**
 * Fetch all ERC-20 Transfer events to/from the zero address (mints & burns).
 * Paginates automatically. Free tier: up to 10 000 results per page.
 */
async function fetchMintBurnEvents(contractAddress) {
  const events = [];
  let page = 1;
  while (true) {
    const result = await etherscan({
      module:          'account',
      action:          'tokentx',
      contractaddress: contractAddress,
      address:         ZERO_ADDR,
      sort:            'asc',
      page,
      offset:          10000,
    });
    if (!Array.isArray(result) || result.length === 0) break;
    events.push(...result);
    process.stdout.write(`    page ${page}: ${result.length} events\n`);
    if (result.length < 10000) break;
    page++;
  }
  return events;
}

// ── Ethereum backfill ─────────────────────────────────────────────────────────
async function backfillEthereum(store) {
  console.log('\n══ Ethereum (mint/burn reconstruction) ══════════════');

  for (const [tokenName, chains] of Object.entries(TOKENS)) {
    const cfg = chains.Ethereum;
    if (!cfg) continue;

    console.log(`\n[${tokenName}] Fetching Transfer events from/to 0x0...`);

    let events;
    try {
      events = await fetchMintBurnEvents(cfg.address);
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
      continue;
    }

    if (!events.length) {
      console.log('  No mint/burn events found — skipping');
      continue;
    }

    // Sort ascending by timestamp (should already be sorted)
    events.sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp));

    const firstTs    = Number(events[0].timeStamp);
    const timestamps = dailyTimestamps(firstTs, nowTs());
    console.log(`  ${events.length} events → rebuilding ${timestamps.length} daily snapshots from ${tsDate(firstTs)}`);

    let supply = BigInt(0);
    let evtIdx = 0;
    let logged = 0;

    for (const ts of timestamps) {
      const dayEnd = ts + DAY - 1;

      // Consume all events up to end of this day
      while (evtIdx < events.length && Number(events[evtIdx].timeStamp) <= dayEnd) {
        const evt = events[evtIdx];
        const val = BigInt(evt.value);
        if (evt.from.toLowerCase() === ZERO_ADDR) supply += val; // mint
        else if (evt.to.toLowerCase() === ZERO_ADDR) supply -= val; // burn
        evtIdx++;
      }

      const date      = tsDate(ts);
      const marketcap = parseSupply(supply.toString(), cfg.decimals);
      upsert(store, date, tokenName, 'Ethereum', marketcap);

      // Print one line every ~60 days
      if (logged % 60 === 0) process.stdout.write(`  ${date}: ${fmt(marketcap)}\n`);
      logged++;
    }
    console.log(`  ✓ done`);
  }
}

// ── XRPL ─────────────────────────────────────────────────────────────────────
const XRPL_SECONDS_PER_LEDGER = 3.5;

async function xrplPost(body) {
  await sleep(300);
  return fetch('https://xrplcluster.com/', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(15000),
  }).then(r => r.json());
}

async function backfillXRPL(store) {
  console.log('\n══ XRPL (estimated ledger index) ════════════════════');
  const { currency, issuer } = TOKENS.EURCV.XRPL;

  process.stdout.write('Getting current ledger... ');
  let currentLedger;
  try {
    const res = await xrplPost({ method: 'ledger', params: [{ ledger_index: 'validated' }] });
    currentLedger = {
      index: res.result.ledger_index,
      ts:    res.result.ledger?.close_time
        ? res.result.ledger.close_time + 946684800
        : nowTs(),
    };
    console.log(`ledger ${currentLedger.index} at ${tsDate(currentLedger.ts)}`);
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
    return;
  }

  // EURCV appeared on XRPL around mid-2025 — go back 2 years to be safe
  const startTs    = nowTs() - 2 * 365 * DAY;
  const timestamps = dailyTimestamps(startTs, nowTs());
  console.log(`  Building ${timestamps.length} daily XRPL snapshots...`);

  let lastNonZero = 0;
  for (const ts of timestamps) {
    const date          = tsDate(ts);
    const deltaSeconds  = currentLedger.ts - ts;
    const ledgerIndex   = Math.max(1, Math.round(currentLedger.index - deltaSeconds / XRPL_SECONDS_PER_LEDGER));

    try {
      const res  = await xrplPost({ method: 'gateway_balances', params: [{ account: issuer, ledger_index: ledgerIndex }] });
      if (res.result?.error) { process.stdout.write('.'); continue; }

      const supply = parseFloat(res.result?.obligations?.[currency] ?? 0);
      if (supply > 0 || lastNonZero > 0) {
        // Only start recording once we first see a non-zero supply
        upsert(store, date, 'EURCV', 'XRPL', supply);
        if (supply > 0) lastNonZero = supply;
        process.stdout.write(`  ${date}: ${fmt(supply)}\n`);
      } else {
        process.stdout.write('.');
      }
    } catch (err) {
      process.stdout.write(`  ${date}: ERROR ${err.message}\n`);
    }
  }
  console.log('\n  ✓ done');
}

// ── Stellar ───────────────────────────────────────────────────────────────────
async function backfillStellar(store) {
  console.log('\n══ Stellar (current snapshot) ═══════════════════════');
  const { code, issuer } = TOKENS.EURCV.Stellar;

  try {
    const res = await fetch(
      `https://horizon.stellar.org/assets?asset_code=${code}&asset_issuer=${issuer}`,
      { signal: AbortSignal.timeout(12000) }
    ).then(r => r.json());

    const rec  = res._embedded?.records?.[0];
    if (!rec) { console.log('  Not found'); return; }

    const supply  = parseFloat(rec.balances?.authorized ?? 0);
    const holders = Number(rec.accounts?.authorized ?? 0);
    console.log(`  supply=${fmt(supply)}, holders=${holders}`);

    const today = tsDate(nowTs());
    upsert(store, today, 'EURCV', 'Stellar', supply, holders);
    store[today].tokens.EURCV.holders = (store[today].tokens.EURCV.holders ?? 0) + holders;
    console.log('  ✓ done');
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}

// ── Solana ────────────────────────────────────────────────────────────────────
async function backfillSolana(store) {
  console.log('\n══ Solana (current snapshot) ════════════════════════');
  const today = tsDate(nowTs());

  for (const [tokenName, chains] of Object.entries(TOKENS)) {
    const cfg = chains.Solana;
    if (!cfg) continue;

    process.stdout.write(`  [${tokenName}] supply... `);
    try {
      const res = await fetch('https://api.mainnet-beta.solana.com', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [cfg.mint] }),
        signal:  AbortSignal.timeout(10000),
      }).then(r => r.json());

      const v      = res.result?.value ?? {};
      const supply = v.uiAmountString ? parseFloat(v.uiAmountString) : (Number(v.amount ?? 0) / 10 ** (v.decimals ?? 0));
      console.log(fmt(supply));
      upsert(store, today, tokenName, 'Solana', supply);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }
  console.log('  ✓ done');
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('  SG Forge · Historical Backfill                    ');
  console.log('════════════════════════════════════════════════════');
  console.log('Ethereum : daily supply rebuilt from mint/burn events');
  console.log('XRPL     : estimated daily supply (last 2 years)    ');
  console.log('Stellar  : current snapshot only                    ');
  console.log('Solana   : current snapshot only                    ');
  console.log('\nEstimated time: 2–5 minutes\n');

  // Load existing snapshots — keep only real ones (have actual holders or recent fresh data)
  const store = {};
  if (fs.existsSync(DATA_JSON)) {
    try {
      const existing = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
      for (const snap of existing.snapshots ?? []) {
        // Keep snapshot if it has real holder data from fetchData.js
        const hasHolders = Object.values(snap.tokens).some(t => t.holders > 0);
        if (hasHolders) store[snap.date] = snap;
      }
      if (Object.keys(store).length) {
        console.log(`Kept ${Object.keys(store).length} existing real snapshot(s) from data.json\n`);
      }
    } catch { /* start fresh */ }
  }

  await backfillEthereum(store);
  await backfillXRPL(store);
  await backfillStellar(store);
  await backfillSolana(store);

  const snapshots = Object.values(store)
    .filter(s => Object.keys(s.tokens).length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const output = { snapshots };
  fs.writeFileSync(DATA_JSON, JSON.stringify(output, null, 2));
  fs.writeFileSync(DATA_JS,   `window.STABLECOIN_DATA = ${JSON.stringify(output)};`);

  console.log(`\n✓ Saved ${snapshots.length} snapshots → data.json + data.js`);
  console.log('\nNext steps:');
  console.log('  git add data.json data.js && git commit -m "data: historical backfill" && git push');
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
