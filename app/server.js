// The process under instrumentation: a Node/Express-shaped service that serves
// inbound requests on :8080 and, for each one, makes a pooled keep-alive
// HTTP/1.1 call to the peer. This is the shape the defect was first observed
// on in production (a Node gateway calling several peers over plaintext
// HTTP/1.1 with an agent pool).
//
// Every knob a scenario varies is an environment variable, so the same binary
// covers the whole scenario table.
'use strict';
const http = require('http');

const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8080);
const PEER_HOST = process.env.PEER_HOST || 'peer';
const PEER_PORT = Number(process.env.PEER_PORT || 9000);

const KEEPALIVE = (process.env.KEEPALIVE || 'true') === 'true';
const MAX_SOCKETS = Number(process.env.MAX_SOCKETS || 8);
// Node's own idle keep-alive timer. Left long by default so that when a
// scenario wants sockets reaped it does so explicitly, at a time it controls.
const KEEPALIVE_MSECS = Number(process.env.KEEPALIVE_MSECS || 30000);
// If > 0, a reaper destroys every idle pooled socket on this interval. This is
// what a real connection pool's idle eviction does.
const REAP_MS = Number(process.env.REAP_MS || 0);

const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), role: 'app', ...o }) + '\n');

const agent = new http.Agent({
  keepAlive: KEEPALIVE,
  keepAliveMsecs: KEEPALIVE_MSECS,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_SOCKETS,
});

// Counters the assertion uses as ground truth for "the call actually
// succeeded", independent of anything OBI reports.
const stats = { calls: 0, ok200: 0, non200: 0, errors: 0, bytes: 0 };

function callPeer() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: PEER_HOST, port: PEER_PORT, path: '/r', method: 'GET', agent },
      (res) => {
        let n = 0;
        res.on('data', (c) => { n += c.length; });
        res.on('end', () => resolve({ status: res.statusCode, bytes: n, port: req.socket ? req.socket.localPort : 0 }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let n = 0;
const server = http.createServer(async (req, res) => {
  const id = ++n;
  const start = process.hrtime.bigint();
  if (req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
  try {
    const r = await callPeer();
    stats.calls++;
    stats.bytes += r.bytes;
    if (r.status === 200) stats.ok200++; else stats.non200++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, peer_status: r.status, peer_bytes: r.bytes }));
    log({ msg: 'call', id, peer_status: r.status, peer_bytes: r.bytes, local_port: r.port, duration_ms: Number(process.hrtime.bigint() - start) / 1e6 });
  } catch (e) {
    stats.calls++;
    stats.errors++;
    res.writeHead(502).end(JSON.stringify({ error: String(e) }));
    log({ msg: 'call_failed', id, error: String(e), duration_ms: Number(process.hrtime.bigint() - start) / 1e6 });
  }
});

// Idle-socket reaping. Destroys only sockets sitting in the agent's free list,
// i.e. connections with no request in flight -- exactly what a pool's idle
// eviction touches, and never an active request.
if (REAP_MS > 0) {
  setInterval(() => {
    let destroyed = 0;
    for (const k of Object.keys(agent.freeSockets)) {
      for (const s of agent.freeSockets[k].slice()) { s.destroy(); destroyed++; }
    }
    if (destroyed) log({ msg: 'reaped_idle_sockets', destroyed });
  }, REAP_MS).unref();
}

process.on('SIGTERM', () => {
  log({ msg: 'summary', ...stats });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

server.listen(LISTEN_PORT, () =>
  log({ msg: 'listening', port: LISTEN_PORT, keepalive: KEEPALIVE, max_sockets: MAX_SOCKETS, keepalive_msecs: KEEPALIVE_MSECS, reap_ms: REAP_MS })
);
