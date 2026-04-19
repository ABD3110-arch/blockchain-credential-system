# CredentialChain — Complete Setup Guide

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    CREDENTIALCHAIN ARCHITECTURE                  │
├──────────────────┬──────────────────────┬───────────────────────┤
│   FRONTEND       │     BACKEND          │    BLOCKCHAIN/IPFS    │
│                  │                      │                       │
│ Admin Dashboard  │  Node.js + Express   │  Ethereum (Ganache)   │
│  • Add / Update  │  • CSV parser        │  • CredentialRegistry │
│  • Revoke        │  • IPFS uploader     │  • Hash storage       │
│  • CSV Upload    │  • Web3.js bridge    │  • Events             │
│                  │                      │                       │
│ Public Verify    │  POST /credential/*  │  IPFS (Pinata)        │
│  • By file       │  GET  /credential/:id│  • Full JSON data     │
│  • By ID         │  POST /upload/csv    │  • CID references     │
│  • By hash       │  GET  /stats         │                       │
└──────────────────┴──────────────────────┴───────────────────────┘
```

---

## Prerequisites

| Tool         | Version    | Download                                  |
|--------------|------------|-------------------------------------------|
| Node.js      | ≥ 18.x     | https://nodejs.org                        |
| Ganache      | ≥ 7.x      | https://trufflesuite.com/ganache          |
| MetaMask     | Latest     | https://metamask.io (Chrome extension)    |
| Remix IDE    | Browser    | https://remix.ethereum.org                |
| Pinata       | Free tier  | https://app.pinata.cloud                  |

---

## Step 1 — Start Ganache

1. Open Ganache desktop application
2. Click **"Quickstart Ethereum"**
3. Verify settings:
   - **RPC Server**: `HTTP://127.0.0.1:7545`
   - **Network ID**: `5777`
   - **Accounts**: 10 accounts with 100 ETH each
4. **Keep Ganache open** throughout development

> **Note the first account's address and private key** — this will be your admin.

---

## Step 2 — Configure MetaMask

1. Open MetaMask extension
2. Click the network dropdown → **"Add network"** → **"Add manually"**
3. Fill in:
   ```
   Network Name:    Ganache Local
   RPC URL:         http://127.0.0.1:7545
   Chain ID:        1337
   Currency Symbol: ETH
   ```
4. Import admin account:
   - Click account icon → **"Import Account"**
   - Paste the **private key** of Ganache Account #1

---

## Step 3 — Deploy Smart Contract (Remix IDE)

### 3.1 Open Remix
Go to https://remix.ethereum.org

### 3.2 Create Contract File
1. In **File Explorer** panel, click the "+" icon
2. Name it: `CredentialRegistry.sol`
3. Paste the **entire contents** of `contracts/CredentialRegistry.sol`

### 3.3 Compile
1. Click **Solidity Compiler** tab (left sidebar)
2. Select compiler version: **`0.8.19`** (or any 0.8.x)
3. Click **"Compile CredentialRegistry.sol"**
4. Verify ✅ — no errors in the output

### 3.4 Deploy to Ganache
1. Click **"Deploy & Run Transactions"** tab
2. Set **ENVIRONMENT** to: **"Injected Provider - MetaMask"**
3. MetaMask popup → approve connection to Remix
4. Verify the **Account** shows your Ganache address
5. Under **CONTRACT**, select `CredentialRegistry`
6. Click **"Deploy"** → MetaMask will prompt → **Confirm**
7. In the **"Deployed Contracts"** section, expand the deployed contract
8. **Copy the contract address** (e.g., `0x5FbDB2315678afecb367f032d93F642f64180aa3`)

### 3.5 Get the ABI
1. In Remix, go to **Solidity Compiler** → **ABI** button (copy icon)
2. **Optional**: The `backend/abi/CredentialRegistry.json` already contains the correct ABI.
   If you made changes, replace that file with the compiled ABI.

---

## Step 4 — Get Pinata API Keys

1. Sign up at https://app.pinata.cloud (free tier: 1 GB)
2. Go to **Developers** → **API Keys**
3. Click **"+ New Key"**
4. Enable: `pinJSONToIPFS`, `pinFileToIPFS`
5. Copy the **API Key** and **API Secret**

---

## Step 5 — Configure Backend

```bash
cd credential-chain/backend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

Edit `.env` with your values:

```bash
# .env
GANACHE_URL=http://127.0.0.1:7545
CONTRACT_ADDRESS=0x<YOUR_DEPLOYED_CONTRACT_ADDRESS>
ADMIN_ADDRESS=0x<GANACHE_ACCOUNT_1_ADDRESS>
ADMIN_PRIVATE_KEY=0x<GANACHE_ACCOUNT_1_PRIVATE_KEY>
PINATA_API_KEY=<YOUR_PINATA_API_KEY>
PINATA_SECRET_KEY=<YOUR_PINATA_SECRET_KEY>
PORT=3001
```

> ⚠️ **Security**: Never commit `.env` to git. The `.gitignore` should exclude it.

---

## Step 6 — Start Backend Server

```bash
cd credential-chain/backend
npm start
```

Expected output:
```
╔════════════════════════════════════════╗
║     CredentialChain Backend v1.0       ║
╠════════════════════════════════════════╣
║  Server  : http://localhost:3001       ║
║  Ganache : http://127.0.0.1:7545       ║
║  Contract: 0x5FbDB2315678afecb...      ║
╚════════════════════════════════════════╝
```

### Run pre-flight checks:
```bash
node scripts/deploy.js
```

All 4 checks should pass:
- ✓ Environment Variables
- ✓ Ganache Connection
- ✓ Smart Contract
- ✓ Pinata IPFS

### Run test transaction:
```bash
node scripts/deploy.js --test
```

---

## Step 7 — Open Frontend

Open the HTML files directly in your browser:

| Page             | Path                               | Purpose              |
|------------------|------------------------------------|----------------------|
| Admin Dashboard  | `frontend/admin/index.html`        | Manage credentials   |
| Public Verify    | `frontend/public/verify.html`      | Verify credentials   |

> For local development, you can also serve them:
> ```bash
> npx serve frontend/ -p 8080
> # Admin:  http://localhost:8080/admin/
> # Public: http://localhost:8080/public/verify.html
> ```

---

## Step 8 — Add Your First Credential

1. Open `frontend/admin/index.html`
2. Verify the **ONLINE** badge appears in the header
3. Click **"Add Credential"** in the sidebar
4. Fill in the form:
   ```
   Credential ID:  CERT-2024-001
   Recipient:      Alice Johnson
   Issuer:         Your Institution
   Issue Date:     2024-01-15
   Course:         Blockchain Development
   Grade:          A
   ```
5. Click **"Anchor on Blockchain"**
6. Watch the log for:
   ```
   ✓ IPFS CID: bafybeig...
   ✓ Hash: 0x3a7b9f...
   ✓ Tx: 0xd4e8f1...
   ```

---

## Step 9 — Verify a Credential

1. Open `frontend/public/verify.html`
2. Tab: **"Search by ID"**
3. Enter `CERT-2024-001`
4. Click **"Look Up Credential"**
5. See the ✅ **Credential Valid** result

---

## Step 10 — Bulk CSV Upload

1. Open Admin Dashboard → **"CSV Upload"**
2. Download the sample CSV (click the link)
3. Drag & drop or click to upload `sample-credentials.csv`
4. Click **"Upload & Anchor"**
5. Watch the progress log — each row is processed sequentially

### CSV Format:
```csv
credentialId,userName,issuerName,issueDate,course,grade,remarks
CERT-001,Alice Johnson,MIT,2024-01-15,Blockchain,A,With Distinction
CERT-002,Bob Smith,Stanford,2024-02-20,Cryptography,B+,Passed
```

---

## API Reference

### POST `/api/credential/add`
```json
{
  "credentialId": "CERT-2024-001",
  "userName":     "Alice Johnson",
  "issuerName":   "MIT",
  "issueDate":    "2024-01-15",
  "metadata": {
    "course":  "Blockchain",
    "grade":   "A",
    "remarks": "With Distinction"
  }
}
```

### POST `/api/credential/verify`
```json
{ "credentialId": "CERT-2024-001" }
// OR
{ "dataHash": "0x3a7b9f..." }
// OR
{ "credentialData": { /* full JSON */ } }
```

### GET `/api/credential/:id`
```
GET /api/credential/CERT-2024-001
```

### POST `/api/upload/csv`
```
multipart/form-data
file: credentials.csv
```

---

## Smart Contract — Key Functions

| Function                              | Access | Description                    |
|---------------------------------------|--------|--------------------------------|
| `addCredential(id, hash, cid)`        | Admin  | Register new credential        |
| `updateCredential(id, hash, cid)`     | Admin  | Update existing credential     |
| `revokeCredential(id)`                | Admin  | Permanently revoke             |
| `verifyCredential(hash)`              | Public | Verify by data hash            |
| `getCredentialById(rawId)`            | Public | Fetch full metadata by ID      |
| `isRegistered(rawId)`                 | Public | Check if ID exists             |
| `transferAdmin(newAddress)`           | Admin  | Transfer admin role            |

---

## Security Model

### Forgery Prevention
```
Credential JSON  ──SHA-256──▶  Hash  ──stored on──▶  Immutable Ethereum chain
       │                                                        │
       └── any modification ──▶  different hash ──▶  mismatch ─▶ INVALID
```

1. **On-chain hash**: keccak256/SHA-256 anchored in Ethereum — cannot be changed
2. **Duplicate prevention**: Both ID and data hash are checked for uniqueness
3. **Admin-only writes**: `onlyAdmin` modifier on all state-changing functions
4. **IPFS immutability**: CID is content-addressed — CID changes if content changes
5. **Private key protection**: Admin key lives in MetaMask/`.env`, never in frontend

### What prevents forgery?
- Alice receives `CERT-2024-001` with hash `0x3a7b...`
- Attacker modifies Alice's JSON (changes grade A → A+)
- Modified JSON produces hash `0x9f2c...` — completely different
- On-chain only has `0x3a7b...` → **verification fails** ❌
- Attacker cannot write to chain without admin private key

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "OFFLINE" badge in admin | Start backend: `npm start` |
| Ganache connection error | Start Ganache, check port 7545 |
| MetaMask not connecting | Select "Ganache Local" network |
| "CONTRACT_ADDRESS not set" | Copy address from Remix after deploy |
| IPFS upload fails | Check Pinata API keys in `.env` |
| "Nonce too low" error | Reset MetaMask account (Settings → Advanced → Reset) |
| CORS error in browser | Ensure backend is running on port 3001 |

---

## Project File Structure

```
credential-chain/
├── contracts/
│   └── CredentialRegistry.sol      ← Deploy this in Remix
├── backend/
│   ├── server.js                   ← Main backend server
│   ├── package.json
│   ├── .env.example                ← Copy to .env
│   ├── sample-credentials.csv      ← Test CSV data
│   └── abi/
│       └── CredentialRegistry.json ← Contract ABI
├── frontend/
│   ├── admin/
│   │   └── index.html              ← Admin dashboard
│   └── public/
│       └── verify.html             ← Public verification
├── scripts/
│   └── deploy.js                   ← Pre-flight check + test runner
└── SETUP.md                        ← This file
```
