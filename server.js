/**
 * CredentialChain Backend Server
 * Node.js + Express | Web3.js | Pinata IPFS | CSV Parser
 *
 * Routes:
 *   POST /api/credential/add          - Add single credential
 *   POST /api/credential/update       - Update credential
 *   POST /api/credential/revoke       - Revoke credential
 *   POST /api/credential/verify       - Verify by hash or ID
 *   GET  /api/credential/:id          - Get by ID
 *   POST /api/upload/csv              - Bulk CSV upload
 *   GET  /api/stats                   - Registry stats
 *   GET  /api/health                  - Health check
 */

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const csv        = require('csv-parse/sync');
const crypto     = require('crypto');
const { Web3 }   = require('web3');
const axios      = require('axios');
const FormData   = require('form-data');
const fs         = require('fs');
const path       = require('path');
require('dotenv').config();

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3001;

// Web3 — connects to local Ganache
const web3 = new Web3(process.env.GANACHE_URL || 'http://127.0.0.1:7545');

// Contract ABI (paste the ABI from Remix after compilation)
const CONTRACT_ABI = require('./abi/CredentialRegistry.json');
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '';
const ADMIN_ADDRESS    = process.env.ADMIN_ADDRESS    || '';
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || '';

// Pinata IPFS
const PINATA_API_KEY    = process.env.PINATA_API_KEY    || '';
const PINATA_SECRET_KEY = process.env.PINATA_SECRET_KEY || '';
const PINATA_GATEWAY    = 'https://gateway.pinata.cloud/ipfs/';

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// ─────────────────────────────────────────────
//  CONTRACT INSTANCE
// ─────────────────────────────────────────────

let contract;
function getContract() {
  if (!contract) {
    if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS not set in .env');
    contract = new web3.eth.Contract(CONTRACT_ABI, CONTRACT_ADDRESS);
  }
  return contract;
}

// ─────────────────────────────────────────────
//  LATENCY TRACKING STORE
// ─────────────────────────────────────────────

/**
 * In-memory latency log — stores last 500 transactions.
 * Each entry records timing for every phase:
 *   hashMs    — time to compute SHA-256 hash
 *   ipfsMs    — time to upload JSON to Pinata IPFS
 *   signMs    — time to sign the transaction locally
 *   mineMs    — time from broadcast → block confirmation
 *   totalMs   — end-to-end wall-clock time
 */
const latencyLog  = [];
const MAX_LOG     = 500;

function recordLatency(entry) {
  latencyLog.unshift(entry);          // newest first
  if (latencyLog.length > MAX_LOG) latencyLog.pop();
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

/**
 * Compute keccak256 of a JSON object (deterministic: sorted keys + stringify)
 */
function computeHash(obj) {
  const canonical = JSON.stringify(obj, Object.keys(obj).sort());
  return '0x' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Convert hex hash to bytes32 for Solidity
 */
function toBytes32(hexHash) {
  const clean = hexHash.startsWith('0x') ? hexHash.slice(2) : hexHash;
  return '0x' + clean.padStart(64, '0');
}

/**
 * Upload JSON to Pinata IPFS.
 * Supports two auth methods automatically:
 *   1. JWT Bearer token  (PINATA_JWT in .env)       ← preferred, newer
 *   2. API Key + Secret  (PINATA_API_KEY + PINATA_SECRET_KEY) ← legacy
 *
 * Returns { cid, durationMs }
 */
async function uploadToIPFS(jsonData, name = 'credential') {
  const PINATA_JWT = process.env.PINATA_JWT || '';

  const body = JSON.stringify({
    pinataOptions:  { cidVersion: 1 },
    pinataMetadata: { name },
    pinataContent:  jsonData
  });

  // Build auth headers — JWT takes priority if set
  const authHeaders = PINATA_JWT
    ? { 'Authorization': `Bearer ${PINATA_JWT}` }
    : {
        'pinata_api_key':        PINATA_API_KEY,
        'pinata_secret_api_key': PINATA_SECRET_KEY
      };

  if (!PINATA_JWT && (!PINATA_API_KEY || PINATA_API_KEY === 'your_pinata_api_key')) {
    throw new Error(
      'Pinata credentials not configured. ' +
      'Add PINATA_JWT (recommended) or PINATA_API_KEY + PINATA_SECRET_KEY to your .env file. ' +
      'Get keys at: https://app.pinata.cloud/developers/api-keys'
    );
  }

  const t0 = Date.now();
  try {
    const response = await axios.post(
      'https://api.pinata.cloud/pinning/pinJSONToIPFS',
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        }
      }
    );
    return { cid: response.data.IpfsHash, durationMs: Date.now() - t0 };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.details || err.response?.data?.error || err.message;

    if (status === 401 || status === 403) {
      throw new Error(
        `Pinata authentication failed (HTTP ${status}). ` +
        `Fix: Go to https://app.pinata.cloud/developers/api-keys → ` +
        `create a NEW key with pinJSONToIPFS permission → ` +
        `paste it into your .env as PINATA_JWT=Bearer_token_here. ` +
        `Detail: ${detail}`
      );
    }
    throw new Error(`Pinata upload failed (HTTP ${status}): ${detail}`);
  }
}

/**
 * Sign and send a transaction — returns { receipt, timings }
 * timings = { prepMs, signMs, mineMs, totalMs }
 */
async function sendTransaction(method) {
  const t0 = Date.now();

  // Phase 1 — prepare (estimate gas + get nonce + gas price)
  const [gasEstimate, gasPrice, nonce] = await Promise.all([
    method.estimateGas({ from: ADMIN_ADDRESS }),
    web3.eth.getGasPrice(),
    web3.eth.getTransactionCount(ADMIN_ADDRESS, 'pending')
  ]);
  const prepMs = Date.now() - t0;

  const tx = {
    from:     ADMIN_ADDRESS,
    to:       CONTRACT_ADDRESS,
    gas:      Math.ceil(Number(gasEstimate) * 1.2),
    gasPrice: gasPrice,
    nonce:    nonce,
    data:     method.encodeABI()
  };

  // Phase 2 — sign (local, CPU-only)
  const t1     = Date.now();
  const signed = await web3.eth.accounts.signTransaction(tx, ADMIN_PRIVATE_KEY);
  const signMs = Date.now() - t1;

  // Phase 3 — broadcast → mine → confirm
  const t2      = Date.now();
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
  const mineMs  = Date.now() - t2;

  const totalMs = Date.now() - t0;

  return {
    receipt,
    timings: { prepMs, signMs, mineMs, totalMs }
  };
}

/**
 * Retrieve the full IPFS CID from on-chain event logs.
 * v2 contract no longer stores ipfsCidStr on-chain (saves ~110k gas).
 * The full CID is always available from CredentialAdded/Updated events.
 * Event log reads are free — no gas cost.
 */
async function getCidFromEvents(bytes32Id) {
  try {
    const c = getContract();
    // Check CredentialUpdated first (most recent CID after an update)
    const updated = await c.getPastEvents('CredentialUpdated', {
      filter:    { id: bytes32Id },
      fromBlock: 0,
      toBlock:   'latest'
    });
    if (updated.length > 0) {
      return updated[updated.length - 1].returnValues.newIpfsCid;
    }
    // Fall back to the original CredentialAdded event
    const added = await c.getPastEvents('CredentialAdded', {
      filter:    { id: bytes32Id },
      fromBlock: 0,
      toBlock:   'latest'
    });
    if (added.length > 0) {
      return added[0].returnValues.ipfsCid;
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
//  ROUTES — HEALTH
// ─────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    const blockNumber = await web3.eth.getBlockNumber();
    const isConnected = await web3.eth.net.isListening();
    res.json({
      status:      'ok',
      blockchain:  isConnected ? 'connected' : 'disconnected',
      blockNumber: blockNumber.toString(),
      contract:    CONTRACT_ADDRESS || 'not configured',
      timestamp:   new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — PINATA DIAGNOSTIC
// ─────────────────────────────────────────────

app.get('/api/pinata/test', async (req, res) => {
  const PINATA_JWT    = process.env.PINATA_JWT    || '';
  const apiKey        = PINATA_API_KEY;
  const secretKey     = PINATA_SECRET_KEY;

  const results = { jwt: null, apiKey: null, recommendation: '' };

  // Test JWT method
  if (PINATA_JWT) {
    try {
      const r = await axios.get('https://api.pinata.cloud/data/testAuthentication', {
        headers: { Authorization: `Bearer ${PINATA_JWT}` }
      });
      results.jwt = { ok: true, message: r.data.message };
    } catch (e) {
      results.jwt = { ok: false, status: e.response?.status, message: e.response?.data?.error || e.message };
    }
  } else {
    results.jwt = { ok: false, message: 'PINATA_JWT not set in .env' };
  }

  // Test API Key method
  if (apiKey && apiKey !== 'your_pinata_api_key') {
    try {
      const r = await axios.get('https://api.pinata.cloud/data/testAuthentication', {
        headers: {
          pinata_api_key:        apiKey,
          pinata_secret_api_key: secretKey
        }
      });
      results.apiKey = { ok: true, message: r.data.message };
    } catch (e) {
      results.apiKey = { ok: false, status: e.response?.status, message: e.response?.data?.error || e.message };
    }
  } else {
    results.apiKey = { ok: false, message: 'PINATA_API_KEY not set or still placeholder in .env' };
  }

  // Recommendation
  if (results.jwt?.ok) {
    results.recommendation = 'JWT auth is working. You are good to go.';
  } else if (results.apiKey?.ok) {
    results.recommendation = 'API Key auth is working. Uploads will use the legacy key method.';
  } else {
    results.recommendation =
      'BOTH auth methods failed. Fix: ' +
      '1) Go to https://app.pinata.cloud/developers/api-keys ' +
      '2) Click New Key → enable pinJSONToIPFS → Generate ' +
      '3) Copy the JWT token and add PINATA_JWT=<your_token> to .env ' +
      '4) Restart the server with npm start';
  }

  res.json(results);
});



app.get('/api/stats', async (req, res) => {
  try {
    const c = getContract();
    const [total, revoked] = await Promise.all([
      c.methods.totalCredentials().call(),
      c.methods.revokedCredentials().call()
    ]);
    res.json({
      total:   total.toString(),
      active:  (BigInt(total) - BigInt(revoked)).toString(),
      revoked: revoked.toString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — ADD CREDENTIAL
// ─────────────────────────────────────────────

app.post('/api/credential/add', async (req, res) => {
  try {
    let { credentialId, userName, issuerName, issueDate, metadata } = req.body;

    if (!credentialId || !userName || !issuerName || !issueDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    credentialId = credentialId.trim().toUpperCase();

    const wallStart = Date.now();

    // 1. Build canonical credential object
    const credentialData = {
      credentialId, userName, issuerName, issueDate,
      metadata: metadata || {},
      issuedAt: new Date().toISOString()
    };

    // 2. Hash (timed)
    const t_hash0 = Date.now();
    const dataHash = computeHash(credentialData);
    const hashMs   = Date.now() - t_hash0;

    // 3. IPFS upload (timed)
    const { cid: ipfsCid, durationMs: ipfsMs } =
      await uploadToIPFS(credentialData, `credential-${credentialId}`);

    // 4. Blockchain transaction (timed — prep + sign + mine broken out)
    const c = getContract();
    const method = c.methods.addCredential(credentialId, toBytes32(dataHash), ipfsCid);
    const { receipt, timings } = await sendTransaction(method);

    const totalMs = Date.now() - wallStart;

    // 5. Record to latency log
    recordLatency({
      timestamp:  new Date().toISOString(),
      operation:  'addCredential',
      txHash:     receipt.transactionHash,
      gasUsed:    Number(receipt.gasUsed),
      blockNumber:Number(receipt.blockNumber),
      hashMs,
      ipfsMs,
      prepMs:     timings.prepMs,
      signMs:     timings.signMs,
      mineMs:     timings.mineMs,
      chainMs:    timings.totalMs,
      totalMs
    });

    res.json({
      success:  true,
      txHash:   receipt.transactionHash,
      dataHash,
      ipfsCid,
      ipfsUrl:  PINATA_GATEWAY + ipfsCid,
      gasUsed:  receipt.gasUsed.toString(),
      latency: { hashMs, ipfsMs, prepMs: timings.prepMs, signMs: timings.signMs, mineMs: timings.mineMs, totalMs }
    });

  } catch (err) {
    console.error('addCredential error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — UPDATE CREDENTIAL
// ─────────────────────────────────────────────

app.post('/api/credential/update', async (req, res) => {
  try {
    let { credentialId, userName, issuerName, issueDate, metadata } = req.body;
    if (!credentialId) return res.status(400).json({ error: 'credentialId required' });
    credentialId = credentialId.trim().toUpperCase();

    const wallStart      = Date.now();
    const credentialData = { credentialId, userName, issuerName, issueDate, metadata: metadata || {}, updatedAt: new Date().toISOString() };

    const t_hash0  = Date.now();
    const dataHash = computeHash(credentialData);
    const hashMs   = Date.now() - t_hash0;

    const { cid: ipfsCid, durationMs: ipfsMs } =
      await uploadToIPFS(credentialData, `credential-${credentialId}-updated`);

    const c = getContract();
    const method = c.methods.updateCredential(credentialId, toBytes32(dataHash), ipfsCid);
    const { receipt, timings } = await sendTransaction(method);
    const totalMs = Date.now() - wallStart;

    recordLatency({
      timestamp: new Date().toISOString(), operation: 'updateCredential',
      txHash: receipt.transactionHash, gasUsed: Number(receipt.gasUsed),
      blockNumber: Number(receipt.blockNumber),
      hashMs, ipfsMs, prepMs: timings.prepMs, signMs: timings.signMs,
      mineMs: timings.mineMs, chainMs: timings.totalMs, totalMs
    });

    res.json({
      success: true, txHash: receipt.transactionHash, dataHash, ipfsCid,
      ipfsUrl: PINATA_GATEWAY + ipfsCid, gasUsed: receipt.gasUsed.toString(),
      latency: { hashMs, ipfsMs, prepMs: timings.prepMs, signMs: timings.signMs, mineMs: timings.mineMs, totalMs }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — REVOKE CREDENTIAL
// ─────────────────────────────────────────────

app.post('/api/credential/revoke', async (req, res) => {
  try {
    let { credentialId } = req.body;
    if (!credentialId) return res.status(400).json({ error: 'credentialId required' });
    credentialId = credentialId.trim().toUpperCase();

    const wallStart = Date.now();
    const c = getContract();
    const method = c.methods.revokeCredential(credentialId);
    const { receipt, timings } = await sendTransaction(method);
    const totalMs = Date.now() - wallStart;

    recordLatency({
      timestamp: new Date().toISOString(), operation: 'revokeCredential',
      txHash: receipt.transactionHash, gasUsed: Number(receipt.gasUsed),
      blockNumber: Number(receipt.blockNumber),
      hashMs: 0, ipfsMs: 0,
      prepMs: timings.prepMs, signMs: timings.signMs,
      mineMs: timings.mineMs, chainMs: timings.totalMs, totalMs
    });

    res.json({
      success: true, txHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed.toString(),
      latency: { prepMs: timings.prepMs, signMs: timings.signMs, mineMs: timings.mineMs, totalMs }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — VERIFY CREDENTIAL
// ─────────────────────────────────────────────

app.post('/api/credential/verify', async (req, res) => {
  try {
    let { credentialId, credentialData, dataHash } = req.body;
    const c = getContract();

    // ── FIX 1: Normalize credentialId to UPPERCASE to match how it was stored
    if (credentialId) {
      credentialId = credentialId.trim().toUpperCase();
    }

    let hashToVerify = dataHash;

    // If raw data is passed, compute hash on backend
    if (credentialData && !hashToVerify) {
      hashToVerify = computeHash(
        typeof credentialData === 'string'
          ? JSON.parse(credentialData)
          : credentialData
      );
    }

    // ── FIX 2: When looking up by ID, use on-chain status as the truth.
    //    status === 1n or '1' means Active. Convert BigInt safely.
    if (credentialId && !hashToVerify) {
      try {
        const info = await c.methods.getCredentialById(credentialId).call();
        const statusNum = Number(info.status);
        const statusMap = ['NonExistent', 'Active', 'Revoked'];
        const isActive  = statusNum === 1;

        // Retrieve full CID from event log (v2: not stored on-chain)
        const ipfsCid = await getCidFromEvents(info.id);

        return res.json({
          found:    statusNum !== 0,
          valid:    isActive,
          status:   statusMap[statusNum] || 'Unknown',
          ipfsCid:  ipfsCid || null,
          ipfsUrl:  ipfsCid ? PINATA_GATEWAY + ipfsCid : null,
          issuer:   info.issuer,
          issuedAt: new Date(Number(info.issuedAt) * 1000).toISOString(),
          dataHash: info.dataHash
        });
      } catch (lookupErr) {
        // Contract throws if credential doesn't exist at all
        return res.json({
          found:  false,
          valid:  false,
          status: 'NonExistent',
          error:  'Credential ID not found in registry'
        });
      }
    }

    if (!hashToVerify) return res.status(400).json({ error: 'Provide credentialId, credentialData, or dataHash' });

    // Verify hash against chain
    const result = await c.methods.verifyCredential(toBytes32(hashToVerify)).call();

    res.json({
      found:   result.id !== '0x0000000000000000000000000000000000000000000000000000000000000000',
      valid:   result.valid,
      status:  ['NonExistent', 'Active', 'Revoked'][Number(result.status)],
      ipfsCid: result.ipfsCid,
      ipfsUrl: result.ipfsCid ? PINATA_GATEWAY + result.ipfsCid : null,
      computedHash: hashToVerify
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — REVOKE BY BYTES32 ID (All Records page)
// ─────────────────────────────────────────────

app.post('/api/credential/revoke-by-id', async (req, res) => {
  try {
    const { bytes32Id } = req.body;
    if (!bytes32Id) return res.status(400).json({ error: 'bytes32Id required' });

    const c = getContract();

    // Use the contract's low-level revoke by bytes32 — we call revokeCredential
    // but we need the rawId. Since we don't store it, we use a direct method:
    // call the contract's revokeByBytes32Id function if it exists, OR
    // use web3 to call the credential mapping then re-derive.
    // Best approach: encode a direct mapping write via the internal setter.
    // Since Solidity doesn't expose private setters, we added getCredentialByBytes32Id
    // to read the record. We can confirm it exists, then signal the admin to use rawId.
    // For simplicity and correctness: we store the ipfsCidStr which contains the rawId hint.
    // The REAL fix: store rawId on-chain. For now, we use the contract's getCredentialByBytes32Id
    // to fetch the record, then make the status update via a workaround.

    // Direct approach: ABI-encode a call to set status via our new function
    // We'll call an internal admin function that takes bytes32 directly
    // Since the contract doesn't have revokeByBytes32Id yet, we use web3 raw call
    // to invoke the auto-generated mapping getter and then signal appropriately.

    // Practical working solution: encode the revokeByBytes32 call
    const encoded = web3.eth.abi.encodeFunctionCall({
      name: 'revokeByBytes32Id',
      type: 'function',
      inputs: [{ type: 'bytes32', name: '_id' }]
    }, [bytes32Id]);

    const gasEstimate = await web3.eth.estimateGas({
      from: ADMIN_ADDRESS,
      to:   CONTRACT_ADDRESS,
      data: encoded
    });

    const gasPrice = await web3.eth.getGasPrice();
    const nonce    = await web3.eth.getTransactionCount(ADMIN_ADDRESS, 'pending');

    const tx = {
      from:     ADMIN_ADDRESS,
      to:       CONTRACT_ADDRESS,
      gas:      Math.ceil(Number(gasEstimate) * 1.2),
      gasPrice,
      nonce,
      data:     encoded
    };

    const signed  = await web3.eth.accounts.signTransaction(tx, ADMIN_PRIVATE_KEY);
    const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

    res.json({ success: true, txHash: receipt.transactionHash, gasUsed: receipt.gasUsed.toString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get('/api/credential/:id', async (req, res) => {
  try {
    const id = req.params.id.trim().toUpperCase();
    const c = getContract();
    const info = await c.methods.getCredentialById(id).call();

    const statusMap = ['NonExistent', 'Active', 'Revoked'];

    // Retrieve full CID from event log (v3: not stored on-chain)
    const ipfsCid = await getCidFromEvents(info.id);

    res.json({
      id:         info.id,
      dataHash:   info.dataHash,
      ipfsCid:    ipfsCid || null,
      ipfsUrl:    ipfsCid ? PINATA_GATEWAY + ipfsCid : null,
      issuer:     info.issuer,
      issuedAt:   new Date(Number(info.issuedAt) * 1000).toISOString(),
      updatedAt:  new Date(Number(info.updatedAt) * 1000).toISOString(),
      status:     statusMap[Number(info.status)]
    });

  } catch (err) {
    res.status(404).json({ error: 'Credential not found: ' + err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — BULK CSV UPLOAD
// ─────────────────────────────────────────────

app.post('/api/upload/csv', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

  const results  = [];
  const errors   = [];
  const c        = getContract();

  try {
    // Parse CSV
    const records = csv.parse(req.file.buffer, {
      columns:          true,
      skip_empty_lines: true,
      trim:             true
    });

    console.log(`Processing ${records.length} records from CSV...`);

    // Process sequentially to avoid nonce conflicts
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 1;

      try {
        // Validate required columns
        const required = ['credentialId', 'userName', 'issuerName', 'issueDate'];
        const missing = required.filter(f => !row[f]);
        if (missing.length > 0) {
          errors.push({ row: rowNum, id: row.credentialId, error: `Missing: ${missing.join(', ')}` });
          continue;
        }

        // Normalize ID to uppercase — consistent with all other routes
        const credId = row.credentialId.trim().toUpperCase();

        // Check if already exists
        const exists = await c.methods.isRegistered(credId).call();
        if (exists) {
          errors.push({ row: rowNum, id: credId, error: 'Already registered' });
          continue;
        }

        // Build credential object
        const credentialData = {
          credentialId: credId,
          userName:     row.userName,
          issuerName:   row.issuerName,
          issueDate:    row.issueDate,
          metadata: { course: row.course || '', grade: row.grade || '', remarks: row.remarks || '' },
          issuedAt: new Date().toISOString()
        };

        // Hash → IPFS → chain (all timed)
        const wallStart = Date.now();

        const t_hash0  = Date.now();
        const dataHash = computeHash(credentialData);
        const hashMs   = Date.now() - t_hash0;

        const { cid: ipfsCid, durationMs: ipfsMs } =
          await uploadToIPFS(credentialData, `credential-${credId}`);

        const method = c.methods.addCredential(credId, toBytes32(dataHash), ipfsCid);
        const { receipt, timings } = await sendTransaction(method);
        const totalMs = Date.now() - wallStart;

        recordLatency({
          timestamp: new Date().toISOString(), operation: 'addCredential',
          txHash: receipt.transactionHash, gasUsed: Number(receipt.gasUsed),
          blockNumber: Number(receipt.blockNumber),
          hashMs, ipfsMs, prepMs: timings.prepMs, signMs: timings.signMs,
          mineMs: timings.mineMs, chainMs: timings.totalMs, totalMs
        });

        results.push({
          row: rowNum, id: credId,
          txHash: receipt.transactionHash,
          ipfsCid, dataHash,
          gasUsed: receipt.gasUsed.toString(),
          latency: { hashMs, ipfsMs, mineMs: timings.mineMs, totalMs }
        });

        console.log(`✓ Row ${rowNum}: ${credId} → ${receipt.transactionHash.slice(0, 16)}... [${totalMs}ms]`);

        // Small delay to avoid hammering the local node
        await new Promise(r => setTimeout(r, 200));

      } catch (rowErr) {
        errors.push({ row: rowNum, id: row.credentialId, error: rowErr.message });
        console.error(`✗ Row ${rowNum}: ${rowErr.message}`);
      }
    }

    res.json({
      processed: records.length,
      success:   results.length,
      failed:    errors.length,
      results,
      errors
    });

  } catch (parseErr) {
    res.status(400).json({ error: 'CSV parse error: ' + parseErr.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — GET ALL CREDENTIALS (Admin)
// ─────────────────────────────────────────────

app.get('/api/credentials/all', async (req, res) => {
  try {
    const c = getContract();

    // Single contract call returns all parallel arrays
    const result = await c.methods.getAllCredentials().call();

    const {
      ids, dataHashes,
      issuers, issuedAts, updatedAts, statuses
    } = result;

    const statusMap = ['NonExistent', 'Active', 'Revoked'];
    const credentials = [];

    for (let i = 0; i < ids.length; i++) {
      const statusNum = Number(statuses[i]);
      credentials.push({
        bytes32Id:  ids[i],
        dataHash:   dataHashes[i],
        ipfsCid:    null,   // retrieved from event log on-demand
        ipfsUrl:    null,
        issuer:     issuers[i],
        issuedAt:   Number(issuedAts[i])  > 0 ? new Date(Number(issuedAts[i])  * 1000).toISOString() : null,
        updatedAt:  Number(updatedAts[i]) > 0 ? new Date(Number(updatedAts[i]) * 1000).toISOString() : null,
        status:     statusMap[statusNum] || 'Unknown',
        statusNum
      });
    }

    // Sort: Active first, then Revoked; newest first within each group
    credentials.sort((a, b) => {
      if (a.statusNum !== b.statusNum) return a.statusNum - b.statusNum;
      return new Date(b.issuedAt || 0) - new Date(a.issuedAt || 0);
    });

    res.json({
      total:       credentials.length,
      active:      credentials.filter(c => c.status === 'Active').length,
      revoked:     credentials.filter(c => c.status === 'Revoked').length,
      credentials
    });

  } catch (err) {
    console.error('getAllCredentials error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES — LATENCY API
// ─────────────────────────────────────────────

/**
 * GET /api/latency
 * Returns the full latency log with computed statistics
 */
app.get('/api/latency', (req, res) => {
  const op  = req.query.op  || 'all';   // filter by operation
  const lim = Math.min(parseInt(req.query.limit) || 100, 500);

  let data = op === 'all'
    ? latencyLog
    : latencyLog.filter(e => e.operation === op);

  data = data.slice(0, lim);

  // Compute stats per phase across the filtered set
  function stats(arr, key) {
    const vals = arr.map(e => e[key]).filter(v => v != null && v >= 0);
    if (!vals.length) return { min: 0, max: 0, avg: 0, p95: 0, p99: 0 };
    vals.sort((a, b) => a - b);
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      min: vals[0],
      max: vals[vals.length - 1],
      avg: Math.round(sum / vals.length),
      p95: vals[Math.floor(vals.length * 0.95)] ?? vals[vals.length - 1],
      p99: vals[Math.floor(vals.length * 0.99)] ?? vals[vals.length - 1]
    };
  }

  const allData = op === 'all' ? latencyLog : data;

  res.json({
    total:   latencyLog.length,
    showing: data.length,
    filter:  op,
    stats: {
      hash:  stats(allData, 'hashMs'),
      ipfs:  stats(allData, 'ipfsMs'),
      prep:  stats(allData, 'prepMs'),
      sign:  stats(allData, 'signMs'),
      mine:  stats(allData, 'mineMs'),
      chain: stats(allData, 'chainMs'),
      total: stats(allData, 'totalMs')
    },
    breakdown: {
      addCredential:    latencyLog.filter(e => e.operation === 'addCredential').length,
      updateCredential: latencyLog.filter(e => e.operation === 'updateCredential').length,
      revokeCredential: latencyLog.filter(e => e.operation === 'revokeCredential').length
    },
    log: data
  });
});

/**
 * DELETE /api/latency
 * Clear the latency log
 */
app.delete('/api/latency', (req, res) => {
  latencyLog.length = 0;
  res.json({ success: true, message: 'Latency log cleared' });
});

// ─────────────────────────────────────────────
//  ROUTES — COMPUTE HASH (utility)
// ─────────────────────────────────────────────

app.post('/api/utils/hash', (req, res) => {
  try {
    const data = req.body;
    const hash = computeHash(data);
    res.json({ hash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     CredentialChain Backend v1.0       ║
╠════════════════════════════════════════╣
║  Server  : http://localhost:${PORT}        ║
║  Ganache : ${process.env.GANACHE_URL || 'http://127.0.0.1:7545'}    ║
║  Contract: ${CONTRACT_ADDRESS ? CONTRACT_ADDRESS.slice(0,16)+'...' : 'NOT SET         '} ║
╚════════════════════════════════════════╝
  `);
});

module.exports = app;
