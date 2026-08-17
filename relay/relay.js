// A transparent TCP relay between app and peer. It forwards both directions
// byte-for-byte and changes only one thing: how the peer's response bytes are
// segmented on the wire towards the app.
//
// RESEG_AT=N flushes the first N bytes of each response on their own segment
// (TCP_NODELAY is on), waits RESEG_DELAY_MS, then writes the rest. The bytes
// the app receives are identical either way; only the read boundaries differ.
//
// The relay exists so the segmentation is applied to the app's read side alone.
// The peer remains an ordinary Node HTTP origin whose own response write is a
// single flush, so the peer-side OBI instance sees a normal 200 exchange. That
// is what makes the peer's SERVER span usable as the independent control:
// same request, one side says 200, the other says 499.
//
// RESEG_AT=0 disables the re-segmentation entirely, which is the control
// scenario's only difference from the defect scenario.
'use strict';
const net = require('net');

const LISTEN_PORT = Number(process.env.RELAY_PORT || 9100);
const PEER_HOST = process.env.PEER_HOST || 'peer';
const PEER_PORT = Number(process.env.PEER_PORT || 9000);
const RESEG_AT = Number(process.env.RESEG_AT || 0);
const RESEG_DELAY_MS = Number(process.env.RESEG_DELAY_MS || 2);

const log = (o) =>
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), role: 'relay', ...o }) + '\n');

const stats = { conns: 0, resegmented: 0, bytes_up: 0, bytes_down: 0 };

const server = net.createServer((down) => {
  stats.conns++;
  down.setNoDelay(true);
  const up = net.connect({ host: PEER_HOST, port: PEER_PORT }, () => up.setNoDelay(true));

  // app -> peer, untouched.
  down.on('data', (c) => { stats.bytes_up += c.length; up.write(c); });

  // peer -> app, re-segmented.
  let queue = Promise.resolve();
  up.on('data', (c) => {
    stats.bytes_down += c.length;
    if (RESEG_AT <= 0 || c.length <= RESEG_AT) { down.write(c); return; }
    // Serialise, so a chunk's two pieces are never interleaved with the next
    // chunk's. Byte order on the wire is preserved exactly.
    queue = queue.then(
      () =>
        new Promise((resolve) => {
          down.write(c.subarray(0, RESEG_AT));
          stats.resegmented++;
          setTimeout(() => { down.write(c.subarray(RESEG_AT)); resolve(); }, RESEG_DELAY_MS);
        })
    );
  });

  const bye = () => { up.destroy(); down.destroy(); };
  down.on('end', () => up.end());
  up.on('end', () => down.end());
  down.on('error', bye);
  up.on('error', bye);
});

process.on('SIGTERM', () => { log({ msg: 'summary', ...stats }); process.exit(0); });

server.listen(LISTEN_PORT, () =>
  log({ msg: 'listening', port: LISTEN_PORT, peer: `${PEER_HOST}:${PEER_PORT}`, reseg_at: RESEG_AT, reseg_delay_ms: RESEG_DELAY_MS })
);
