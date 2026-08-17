// Drives inbound requests against app:8080. CONCURRENCY workers, each looping
// sequentially, so at most CONCURRENCY requests are outstanding at a time.
// Runs for DURATION_S then stops, which is what bounds a scenario's runtime.
'use strict';
const http = require('http');

const HOST = process.env.APP_HOST || 'app';
const PORT = Number(process.env.APP_PORT || 8080);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const DURATION_S = Number(process.env.DURATION_S || 60);
const START_DELAY_S = Number(process.env.START_DELAY_S || 10);
const THINK_MS = Number(process.env.THINK_MS || 0);

const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), role: 'loadgen', ...o }) + '\n');

// Loadgen -> app uses its own keep-alive pool. It is deliberately not the
// variable under test; only the app -> peer pool is.
const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });

const stats = { sent: 0, ok: 0, bad: 0, err: 0 };

function one() {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: '/work', agent }, (res) => {
      res.resume();
      res.on('end', () => { stats.sent++; if (res.statusCode === 200) stats.ok++; else stats.bad++; resolve(); });
    });
    req.on('error', () => { stats.sent++; stats.err++; resolve(); });
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker(deadline) {
  while (Date.now() < deadline) {
    await one();
    if (THINK_MS) await sleep(THINK_MS);
  }
}

(async () => {
  log({ msg: 'starting', concurrency: CONCURRENCY, duration_s: DURATION_S, think_ms: THINK_MS, start_delay_s: START_DELAY_S });
  await sleep(START_DELAY_S * 1000);
  const deadline = Date.now() + DURATION_S * 1000;
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(deadline)));
  log({ msg: 'summary', ...stats });
})();
