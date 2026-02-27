const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// --- Game State ---
const state = {
  config: {
    sharesPerParticipant: 100,
    preAuctionPrice: 52,
    buybackPool: 1000,
    priceMin: 50,
    priceMax: 58,
  },
  phase: 'waiting', // waiting | open | closed | results
  participants: {},  // { id: { name, tenders: [{qty, price}], submittedAt } }
  strikePrice: null,
  results: null,
};

let clientIdCounter = 0;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// QR code endpoint
app.get('/qr', async (req, res) => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 2 });
    res.json({ url, qr: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// --- WebSocket handling ---
wss.on('connection', (ws) => {
  const clientId = ++clientIdCounter;
  ws.clientId = clientId;
  ws.role = null; // 'admin' or 'participant'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'register-admin':
        ws.role = 'admin';
        sendTo(ws, { type: 'state', state: getPublicState() });
        break;

      case 'register-participant':
        ws.role = 'participant';
        ws.participantId = clientId;
        sendTo(ws, {
          type: 'registered',
          id: clientId,
          config: state.config,
          phase: state.phase,
        });
        break;

      case 'update-config':
        if (ws.role !== 'admin') return;
        Object.assign(state.config, msg.config);
        broadcastAll({ type: 'config-updated', config: state.config });
        broadcastAdmin({ type: 'state', state: getPublicState() });
        break;

      case 'open-auction':
        if (ws.role !== 'admin') return;
        state.phase = 'open';
        state.participants = {};
        state.strikePrice = null;
        state.results = null;
        broadcastAll({ type: 'phase', phase: 'open', config: state.config });
        break;

      case 'submit-tender':
        if (state.phase !== 'open') {
          sendTo(ws, { type: 'error', message: 'Auction is not open' });
          return;
        }
        const { name, tenders } = msg;
        if (!name || !tenders || !Array.isArray(tenders)) {
          sendTo(ws, { type: 'error', message: 'Invalid submission' });
          return;
        }
        // Validate tenders
        const validTenders = tenders
          .filter(t => t.qty > 0 && t.price >= state.config.priceMin && t.price <= state.config.priceMax)
          .map(t => ({
            qty: Math.min(Math.round(t.qty), state.config.sharesPerParticipant),
            price: Math.round(t.price * 100) / 100,
          }));

        // Check total qty doesn't exceed shares
        const totalQty = validTenders.reduce((s, t) => s + t.qty, 0);
        if (totalQty > state.config.sharesPerParticipant) {
          sendTo(ws, { type: 'error', message: `Total quantity cannot exceed ${state.config.sharesPerParticipant} shares` });
          return;
        }

        state.participants[ws.participantId] = {
          name,
          tenders: validTenders,
          submittedAt: Date.now(),
        };

        sendTo(ws, { type: 'submitted', tenders: validTenders });
        broadcastAdmin({ type: 'state', state: getPublicState() });
        break;

      case 'close-auction':
        if (ws.role !== 'admin') return;
        state.phase = 'closed';
        broadcastAll({ type: 'phase', phase: 'closed' });
        broadcastAdmin({ type: 'state', state: getPublicState() });
        break;

      case 'calculate':
        if (ws.role !== 'admin') return;
        if (!msg.strikePrice) return;
        state.strikePrice = parseFloat(msg.strikePrice);
        state.results = calculateAuction(state.strikePrice);
        state.phase = 'results';
        broadcastAll({ type: 'results', results: state.results, strikePrice: state.strikePrice });
        broadcastAdmin({ type: 'state', state: getPublicState() });
        break;

      case 'reset':
        if (ws.role !== 'admin') return;
        state.phase = 'waiting';
        state.participants = {};
        state.strikePrice = null;
        state.results = null;
        broadcastAll({ type: 'phase', phase: 'waiting' });
        broadcastAdmin({ type: 'state', state: getPublicState() });
        break;
    }
  });

  ws.on('close', () => {
    // Clean up if needed
  });
});

// --- Dutch Auction Calculation ---
function calculateAuction(strikePrice) {
  const { sharesPerParticipant, preAuctionPrice, buybackPool } = state.config;

  // Collect all tenders at or below strike price
  const acceptedTenders = [];
  for (const [pid, p] of Object.entries(state.participants)) {
    for (const t of p.tenders) {
      if (t.price <= strikePrice) {
        acceptedTenders.push({ pid, name: p.name, qty: t.qty, price: t.price });
      }
    }
  }

  // Total shares tendered at or below strike
  const totalAccepted = acceptedTenders.reduce((s, t) => s + t.qty, 0);

  // Pro-rata factor
  const proRataFactor = totalAccepted > buybackPool
    ? buybackPool / totalAccepted
    : 1;

  // Calculate per-participant results
  const participantResults = {};
  for (const [pid, p] of Object.entries(state.participants)) {
    const accepted = p.tenders.filter(t => t.price <= strikePrice);
    const rejected = p.tenders.filter(t => t.price > strikePrice);

    let sharesAccepted = accepted.reduce((s, t) => s + t.qty, 0);
    let sharesActuallyTendered = Math.floor(sharesAccepted * proRataFactor);

    // Shares rejected (price too high)
    const sharesRejected = rejected.reduce((s, t) => s + t.qty, 0);

    // Shares remaining = starting - actually tendered
    const sharesRemaining = sharesPerParticipant - sharesActuallyTendered;

    // All accepted tenders are paid at the STRIKE price (Dutch auction mechanic)
    const cashReceived = sharesActuallyTendered * strikePrice;

    // Value of remaining shares at pre-auction price
    const remainingValue = sharesRemaining * preAuctionPrice;

    // Original portfolio value
    const originalValue = sharesPerParticipant * preAuctionPrice;

    // PnL
    const pnl = (cashReceived + remainingValue) - originalValue;

    participantResults[pid] = {
      name: p.name,
      tenders: p.tenders,
      sharesAccepted,
      proRataFactor: Math.round(proRataFactor * 10000) / 10000,
      sharesActuallyTendered,
      sharesRejected,
      sharesRemaining,
      cashReceived: Math.round(cashReceived * 100) / 100,
      remainingValue: Math.round(remainingValue * 100) / 100,
      originalValue,
      pnl: Math.round(pnl * 100) / 100,
    };
  }

  return {
    strikePrice,
    totalTenderedAtOrBelow: totalAccepted,
    buybackPool,
    proRataFactor: Math.round(proRataFactor * 10000) / 10000,
    oversubscribed: totalAccepted > buybackPool,
    participants: participantResults,
  };
}

// --- Helpers ---
function getPublicState() {
  return {
    config: state.config,
    phase: state.phase,
    participantCount: Object.keys(state.participants).length,
    participants: Object.fromEntries(
      Object.entries(state.participants).map(([id, p]) => [
        id,
        { name: p.name, tenderCount: p.tenders.length, submittedAt: p.submittedAt },
      ])
    ),
    strikePrice: state.strikePrice,
    results: state.results,
  };
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

function broadcastAdmin(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && c.role === 'admin') c.send(data);
  });
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n  Dutch Auction Game Server`);
  console.log(`  ========================`);
  console.log(`  Admin panel:       http://localhost:${PORT}/admin.html`);
  console.log(`  Participant link:  http://${ip}:${PORT}`);
  console.log(`\n  Share the participant link or scan QR from admin panel\n`);
});
