'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader (KEY=VALUE lines) so the project has no extra deps for config.
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

const config = {
  port: Number(process.env.PORT || 3000),
  pollSeconds: Number(process.env.POLL_SECONDS || 20),
  timeframeMinutes: Number(process.env.TIMEFRAME_MINUTES || 15),
  dataSource: (process.env.DATA_SOURCE || 'auto').toLowerCase(), // auto | upstox | angelone | fixture
  warmupDays: 7,

  upstox: {
    accessToken: process.env.UPSTOX_ACCESS_TOKEN || '',
  },

  angel: {
    apiKey: process.env.ANGEL_API_KEY || '',
    clientCode: process.env.ANGEL_CLIENT_CODE || '',
    password: process.env.ANGEL_PASSWORD || '',
    totpSecret: process.env.ANGEL_TOTP_SECRET || '',
    jwtToken: process.env.ANGEL_JWT_TOKEN || '', // optional: paste a ready JWT instead of auto-login
    localIP: process.env.ANGEL_LOCAL_IP || '127.0.0.1',
    publicIP: process.env.ANGEL_PUBLIC_IP || '127.0.0.1',
    macAddress: process.env.ANGEL_MAC_ADDRESS || '00:00:00:00:00:00',
  },

  fixtureDir: process.env.FIXTURE_DIR || '',
  host: process.env.HOST || '',
};

// The two instruments, with each broker's identifiers and the lot sizes
// Current NSE market lots: Nifty 65, Bank Nifty 30.
const SYMBOLS = [
  {
    id: 'NIFTY',
    name: 'NIFTY 50',
    lotSize: 65,
    strikeStep: 50,
    upstoxKey: 'NSE_INDEX|Nifty 50',
    angel: { exchange: 'NSE', tradingsymbol: 'NIFTY', symboltoken: '99926000' },
  },
  {
    id: 'BANKNIFTY',
    name: 'BANKNIFTY',
    lotSize: 30,
    strikeStep: 100,
    upstoxKey: 'NSE_INDEX|Nifty Bank',
    angel: { exchange: 'NSE', tradingsymbol: 'BANKNIFTY', symboltoken: '99926009' },
  },
];

function angelConfigured() {
  const a = config.angel;
  return Boolean(a.apiKey && (a.jwtToken || (a.clientCode && a.password && a.totpSecret)));
}

module.exports = { config, SYMBOLS, angelConfigured };
