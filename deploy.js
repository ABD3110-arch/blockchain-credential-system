/**
 * CredentialChain Deployment & Automation Script
 *
 * Usage:
 *   node scripts/deploy.js              — checks .env and connectivity
 *   node scripts/deploy.js --test       — runs test transactions
 *   node scripts/deploy.js --bulk       — uploads sample-credentials.csv
 */

const { Web3 }   = require('web3');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const GANACHE_URL       = process.env.GANACHE_URL    || 'http://127.0.0.1:7545';
const CONTRACT_ADDRESS  = process.env.CONTRACT_ADDRESS;
const ADMIN_ADDRESS     = process.env.ADMIN_ADDRESS;
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const PINATA_API_KEY    = process.env.PINATA_API_KEY;
const PINATA_SECRET_KEY = process.env.PINATA_SECRET_KEY;

const CONTRACT_ABI = require('../abi/CredentialRegistry.json');

const web3 = new Web3(GANACHE_URL);

// ── COLOR HELPERS ─────────────────────────
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m'
};

function ok(msg)   { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function fail(msg) { console.log(`  ${c.red}✗${c.reset} ${msg}`); }
function info(msg) { console.log(`  ${c.cyan}ℹ${c.reset} ${msg}`); }
function warn(msg) { console.log(`  ${c.yellow}⚠${c.reset} ${msg}`); }

// ── CHECK ENVIRONMENT ─────────────────────
async function checkEnvironment() {
  console.log(`\n${c.bold}══════════════════════════════════════════${c.reset}`);
  console.log(`${c.bold}  CredentialChain — Pre-flight Check${c.reset}`);
  console.log(`${c.bold}══════════════════════════════════════════${c.reset}\n`);

  let allGood = true;

  // Check .env vars
  console.log(`${c.dim}[1/4] Environment Variables${c.reset}`);
  const required = ['CONTRACT_ADDRESS', 'ADMIN_ADDRESS', 'ADMIN_PRIVATE_KEY'];
  for (const key of required) {
    if (process.env[key] && process.env[key] !== `0x${key.replace(/_/g,'')}Here`) {
      ok(`${key} is set`);
    } else {
      fail(`${key} is missing or placeholder`);
      allGood = false;
    }
  }

  // Check Ganache connection
  console.log(`\n${c.dim}[2/4] Ganache Connection${c.reset}`);
  try {
    const block = await web3.eth.getBlockNumber();
    const accounts = await web3.eth.getAccounts();
    ok(`Connected to ${GANACHE_URL}`);
    ok(`Block number: ${block}`);
    ok(`Found ${accounts.length} accounts`);

    if (ADMIN_ADDRESS) {
      const balance = await web3.eth.getBalance(ADMIN_ADDRESS);
      const ethBalance = parseFloat(web3.utils.fromWei(balance, 'ether')).toFixed(4);
      if (parseFloat(ethBalance) > 0.1) {
        ok(`Admin balance: ${ethBalance} ETH`);
      } else {
        warn(`Admin balance low: ${ethBalance} ETH`);
      }
    }
  } catch (err) {
    fail(`Cannot connect to Ganache: ${err.message}`);
    fail('Make sure Ganache is running on port 7545');
    allGood = false;
  }

  // Check contract
  console.log(`\n${c.dim}[3/4] Smart Contract${c.reset}`);
  if (CONTRACT_ADDRESS && CONTRACT_ADDRESS !== '0xYourContractAddressHere') {
    try {
      const contract = new web3.eth.Contract(CONTRACT_ABI, CONTRACT_ADDRESS);
      const admin    = await contract.methods.admin().call();
      const total    = await contract.methods.totalCredentials().call();
      ok(`Contract deployed at ${CONTRACT_ADDRESS}`);
      ok(`Admin: ${admin}`);
      ok(`Total credentials: ${total}`);

      if (ADMIN_ADDRESS && admin.toLowerCase() !== ADMIN_ADDRESS.toLowerCase()) {
        warn('ADMIN_ADDRESS does not match contract admin!');
      }
    } catch (err) {
      fail(`Contract error: ${err.message}`);
      allGood = false;
    }
  } else {
    warn('CONTRACT_ADDRESS not set — deploy the contract in Remix first');
    allGood = false;
  }

  // Check IPFS (Pinata)
  console.log(`\n${c.dim}[4/4] Pinata IPFS${c.reset}`);
  if (PINATA_API_KEY && PINATA_SECRET_KEY &&
      PINATA_API_KEY !== 'your_pinata_api_key') {
    try {
      const r = await axios.get('https://api.pinata.cloud/data/testAuthentication', {
        headers: {
          'pinata_api_key':        PINATA_API_KEY,
          'pinata_secret_api_key': PINATA_SECRET_KEY
        }
      });
      if (r.data.message === 'Congratulations! You are communicating with the Pinata API!') {
        ok('Pinata credentials valid');
      }
    } catch {
      fail('Pinata authentication failed — check API keys');
      allGood = false;
    }
  } else {
    warn('Pinata API keys not set');
    allGood = false;
  }

  console.log();
  if (allGood) {
    ok(`${c.bold}${c.green}All checks passed! System is ready.${c.reset}`);
  } else {
    warn(`${c.yellow}Some checks failed. Review the issues above.${c.reset}`);
  }
  console.log();
  return allGood;
}

// ── COMPUTE HASH ──────────────────────────
function computeHash(obj) {
  const canonical = JSON.stringify(obj, Object.keys(obj).sort());
  return '0x' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toBytes32(hexHash) {
  const clean = hexHash.startsWith('0x') ? hexHash.slice(2) : hexHash;
  return '0x' + clean.padStart(64, '0');
}

// ── TEST TRANSACTION ──────────────────────
async function runTestTransaction() {
  if (!CONTRACT_ADDRESS || !ADMIN_PRIVATE_KEY) {
    fail('CONTRACT_ADDRESS and ADMIN_PRIVATE_KEY required for test');
    return;
  }

  console.log(`\n${c.bold}Running Test Transaction${c.reset}\n`);

  const contract = new web3.eth.Contract(CONTRACT_ABI, CONTRACT_ADDRESS);
  const testId   = `TEST-${Date.now()}`;

  const credData = {
    credentialId: testId,
    userName:     'Test User',
    issuerName:   'CredentialChain Test Suite',
    issueDate:    new Date().toISOString().slice(0,10),
    metadata:     { note: 'automated test' },
    issuedAt:     new Date().toISOString()
  };

  const dataHash = computeHash(credData);
  info(`Credential ID: ${testId}`);
  info(`Data hash: ${dataHash.slice(0,20)}…`);

  try {
    // Skip IPFS for test — use a dummy CID
    const testCid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

    const method = contract.methods.addCredential(testId, toBytes32(dataHash), testCid);
    const gas    = await method.estimateGas({ from: ADMIN_ADDRESS });
    const nonce  = await web3.eth.getTransactionCount(ADMIN_ADDRESS, 'pending');
    const gasP   = await web3.eth.getGasPrice();

    const tx = {
      from:     ADMIN_ADDRESS,
      to:       CONTRACT_ADDRESS,
      gas:      Math.ceil(Number(gas) * 1.2),
      gasPrice: gasP,
      nonce,
      data:     method.encodeABI()
    };

    const signed  = await web3.eth.accounts.signTransaction(tx, ADMIN_PRIVATE_KEY);
    const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

    ok(`Transaction mined: ${receipt.transactionHash}`);
    ok(`Gas used: ${receipt.gasUsed}`);
    ok(`Block: ${receipt.blockNumber}`);

    // Verify
    const result = await contract.methods.verifyCredential(toBytes32(dataHash)).call();
    if (result.valid) {
      ok(`Verification passed ✓`);
    } else {
      fail('Verification failed after add');
    }

    // Cleanup — revoke test credential
    const rMethod  = contract.methods.revokeCredential(testId);
    const rGas     = await rMethod.estimateGas({ from: ADMIN_ADDRESS });
    const rNonce   = await web3.eth.getTransactionCount(ADMIN_ADDRESS, 'pending');
    const rTx      = { from: ADMIN_ADDRESS, to: CONTRACT_ADDRESS, gas: Math.ceil(Number(rGas)*1.2), gasPrice: gasP, nonce: rNonce, data: rMethod.encodeABI() };
    const rSigned  = await web3.eth.accounts.signTransaction(rTx, ADMIN_PRIVATE_KEY);
    await web3.eth.sendSignedTransaction(rSigned.rawTransaction);
    ok(`Test credential revoked (cleanup)`);

    console.log(`\n${c.green}${c.bold}Test passed!${c.reset}\n`);

  } catch (err) {
    fail('Test transaction failed: ' + err.message);
  }
}

// ── MAIN ──────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  await checkEnvironment();

  if (args.includes('--test')) {
    await runTestTransaction();
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
