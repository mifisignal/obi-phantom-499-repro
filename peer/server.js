// The far end. Answers every request 200 and logs one line per request, so its
// own access log is independent evidence of what actually happened on the wire.
//
// Two modes:
//
//   PEER_MODE=http (default)  a normal Node HTTP/1.1 origin.
//   PEER_MODE=raw             a raw TCP listener that speaks HTTP/1.1 itself,
//                             so a scenario can control exactly how the
//                             response bytes are split across writes. The
//                             response is byte-for-byte identical in both
//                             modes; only the segmentation differs.
//
// SPLIT_AT splits the response after that many bytes, flushing the first piece
// on its own segment (TCP_NODELAY is on) before writing the rest after
// SPLIT_DELAY_MS. SPLIT_AT=0 sends the whole response in one write.
'use strict';
const http = require('http');
const net = require('net');

const PORT = Number(process.env.PEER_PORT || 9000);
const MODE = process.env.PEER_MODE || 'http';
const BODY_BYTES = Number(process.env.BODY_BYTES || 64);
const RESP_CHUNKS = Number(process.env.RESP_CHUNKS || 1);
const KEEPALIVE_TIMEOUT_MS = Number(process.env.PEER_KEEPALIVE_TIMEOUT_MS || 5000);
const SPLIT_AT = Number(process.env.SPLIT_AT || 0);
const SPLIT_DELAY_MS = Number(process.env.SPLIT_DELAY_MS || 2);

const log = (o) =>
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), role: 'peer', ...o }) + '\n');

const BODY = Buffer.alloc(BODY_BYTES, 'x');

let n = 0;

if (MODE === 'raw') {
  const RESPONSE = Buffer.concat([
    Buffer.from(
      'HTTP/1.1 200 OK\r\n' +
        'content-type: application/octet-stream\r\n' +
        `content-length: ${BODY_BYTES}\r\n` +
        'connection: keep-alive\r\n\r\n'
    ),
    BODY,
  ]);

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      // One response per complete request head. Requests here never have a body.
      let idx;
      while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
        buf = buf.subarray(idx + 4);
        const id = ++n;
        if (SPLIT_AT > 0 && SPLIT_AT < RESPONSE.length) {
          sock.write(RESPONSE.subarray(0, SPLIT_AT));
          setTimeout(() => {
            sock.write(RESPONSE.subarray(SPLIT_AT));
            log({ msg: 'request', id, status: 200, bytes: BODY_BYTES, aborted: false, response_completed: true, split_at: SPLIT_AT, remote: `${sock.remoteAddress}:${sock.remotePort}` });
          }, SPLIT_DELAY_MS);
        } else {
          sock.write(RESPONSE);
          log({ msg: 'request', id, status: 200, bytes: BODY_BYTES, aborted: false, response_completed: true, split_at: 0, remote: `${sock.remoteAddress}:${sock.remotePort}` });
        }
      }
    });
    sock.on('error', () => {});
  });
  server.listen(PORT, () =>
    log({ msg: 'listening', mode: 'raw', port: PORT, body_bytes: BODY_BYTES, split_at: SPLIT_AT, split_delay_ms: SPLIT_DELAY_MS, response_bytes: RESPONSE.length })
  );
} else {
  const server = http.createServer((req, res) => {
    const id = ++n;
    const start = process.hrtime.bigint();
    let aborted = false;
    req.on('aborted', () => { aborted = true; });
    res.on('close', () => {
      log({
        msg: 'request',
        id,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        bytes: BODY_BYTES,
        aborted,
        // writableFinished false means the response was never fully flushed --
        // the only way this side could legitimately look like a 499.
        response_completed: res.writableFinished,
        remote: `${req.socket.remoteAddress}:${req.socket.remotePort}`,
        duration_ms: Number(process.hrtime.bigint() - start) / 1e6,
      });
    });

    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(BODY_BYTES),
    });
    if (RESP_CHUNKS <= 1) {
      res.end(BODY);
    } else {
      const per = Math.ceil(BODY_BYTES / RESP_CHUNKS);
      let off = 0;
      const pump = () => {
        if (off >= BODY_BYTES) return res.end();
        const slice = BODY.subarray(off, Math.min(off + per, BODY_BYTES));
        off += per;
        res.write(slice);
        setImmediate(pump);
      };
      pump();
    }
  });

  server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEPALIVE_TIMEOUT_MS + 5000;
  server.listen(PORT, () =>
    log({ msg: 'listening', mode: 'http', port: PORT, body_bytes: BODY_BYTES, resp_chunks: RESP_CHUNKS, keepalive_timeout_ms: KEEPALIVE_TIMEOUT_MS })
  );
}
