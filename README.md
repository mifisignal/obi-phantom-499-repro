# obi-phantom-499-repro

OBI reports successful HTTP client calls as `499` errors.

A request is sent, the peer answers `200`, the calling application reads the
whole response and logs success. OBI emits a CLIENT span carrying
`http.response.status_code = 499`, `status = STATUS_CODE_ERROR`, and
`http.response.body.size = 0`. The peer's own SERVER span, produced by a second
OBI instance watching the peer, reports `200` for the same call.

`499` is not a status any server sent. It is OBI's internal sentinel for "I
force-finished a request whose response I never observed"
([`bpf/generictracer/protocol_http.h:207-213`](https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation/blob/main/bpf/generictracer/protocol_http.h#L207-L213)),
written into the same field a real HTTP status goes into.

The state is not merely inaccurate, it is impossible. 499 is nginx's convention
for a *server* recording that the client went away before it could respond; it is
logged, never transmitted. A CLIENT span carrying it claims the client received a
status meaning "the client stopped waiting". OTel semantic conventions require
`http.response.status_code` "if and only if one was received/sent", and then
correctly map a 4xx on a CLIENT span to an error — so the error status is the
right handling of a wrong attribute, and an instrumentation gap is published as
an application failure.

[`upstream-issue.md`](upstream-issue.md) is the writeup filed with the OBI
maintainers, including the code history: 499 entered in PR #767, which was about
eager TLS termination and never discussed status semantics.

## Reproduce

```sh
./run.sh C0     # control: no defect
./run.sh S1     # the defect, on every request
./run.sh S2     # the defect at a production-like minority rate
./run.sh S3     # the same missed responses, with no close to convert them
./run.sh all    # all four, about 5 minutes
```

Docker and git are the only host requirements. Each scenario writes
`out/<scenario>/` with the raw spans, both applications' access logs, OBI's log,
the image digest under test, and the assertion result. `check.py` holds the
assertions and runs against any previous scenario directory.

`check.py` **exits 1 when the defect is present**. It is written as a regression
test, so a future fix turns every scenario green with no edit here.

## Scenarios

| | Response segmentation | App's outbound pool | Phantom 499s | `check.py` |
|---|---|---|---|---|
| **C0** | one segment | connection per request | 0 of 10,819 | exit 0 |
| **S1** | first byte on its own segment | connection per request | 8,433 of 8,435 (99.98%) | exit 1 |
| **S2** | first byte on its own segment | keep-alive, 250 ms idle reaping | 216 of 9,422 (2.29%) | exit 1 |
| **S3** | first byte on its own segment | keep-alive, never reaped | 2 of 9,475 (0.02%) | exit 1 |

Every scenario ran ~8,000–11,000 requests in 40 seconds at concurrency 2. In all
four the peer answered `200` to every request, logged no abort, and its SERVER
spans all report `200`.

## Trigger condition

Two things have to coincide, and each is necessary on its own:

1. **OBI does not observe the response** on a client connection, so its
   `http_info_t` for that request keeps `status == 0`.
2. **`tcp_close` fires on that connection** while the incomplete record is still
   in the `ongoing_http` map.

The close is what converts a missed response into a published error. S1, S2 and
S3 differ only in how often the connection closes, and the phantom rate tracks
that exactly: a connection per request gives one per request, a pool with 250 ms
idle reaping gives a continuous 2.3% minority, and a pool that is never reaped
gives two — the pair closed at shutdown. Every one of the ~9,200 missed responses
in S3 was silently dropped rather than reported. C0 holds the close behaviour of
S1 constant and removes only the missed response, and the defect vanishes.

The reproduction realises "OBI does not observe the response" by re-segmenting it
on the wire: the `relay` container flushes the first byte of each response on its
own TCP segment, then the rest 2 ms later. `tcp_cleanup_rbuf` returns early on
any read of one byte or fewer
([`bpf/generictracer/k_tracer.c`](https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation/blob/main/bpf/generictracer/k_tracer.c),
`if (copied_len <= 1) return 0;`), and the remainder of the response arrives in a
read that does not begin with a status line, so no probe ever parses the `200`.
The relay applies this to the app's read side only, which is what lets the peer's
SERVER span stand as an independent control: same call, one side 499, the other
200.

**What is established and what is not.** The reproduction establishes condition 2
— that a missed response plus a close deterministically yields the phantom 499 —
and that the defect is entirely absent when the response is observed. It does
**not** establish which condition caused OBI to miss responses in the production
incident this came from. A one-byte first segment is a synthetic way to induce
the miss, and a real origin is unlikely to send one. Whatever the production
cause, it produces the same incomplete `http_info_t` and lands in the same
branch.

## What OBI emits, and what happened

The same call, from both sides, out of `out/S1/`:

```
CLIENT (app)   GET  server.address=relay:9100
               http.response.status_code=499  http.response.body.size=0
               status=STATUS_CODE_ERROR       duration=18.244ms

SERVER (peer)  GET  url.path=/r  client.address=172.19.0.4
               http.response.status_code=200  http.response.body.size=227
               status=unset                   duration=4.660ms
```

`check.py` pairs each phantom span with the peer SERVER span whose whole
lifetime falls inside it: 8,433 of 8,433 in S1.

The applications agree with the peer, not with OBI:

```
{"role":"app", "msg":"call","id":1,"peer_status":200,"peer_bytes":64,"duration_ms":30.33}
{"role":"peer","msg":"request","id":1,"status":200,"bytes":64,"aborted":false,"response_completed":true}
```

The span's duration is not the request's. It runs from the request write to
`bpf_ktime_get_ns()` at `tcp_close`, so it measures how long the socket stayed
open. In S2 the median phantom span is 64.9 ms against a median actual call of
3.1 ms; in S3, where the pool is never reaped, the two spans are 6.0 **seconds**
long.

## What else this affects

RED metrics are affected, contrary to what the `span.metrics.skip` marking on
some other force-finished spans would suggest. These spans carry no
`span.metrics.skip` attribute, and with `OTEL_EBPF_METRICS_FEATURES=application`
the collector receives `http.client.request.duration`,
`http.client.request.body.size` and `http.client.response.body.size` series
labelled `http.response.status_code=499` alongside the `200` series.

## Workaround

`OTEL_EBPF_BPF_HIGH_REQUEST_VOLUME=true` removes the phantom 499 completely — it
gates the whole branch. Measured on S1: 0 phantom spans out of 6,310 requests.
It is a trade, not a fix: the missed responses then produce no CLIENT span at
all, 6,309 of 6,310 in that run. This is an explicit boolean setting, not a rate
threshold, so it does not engage on its own under load.

## Environment

```
host    EC2 c7g, Ubuntu 24.04, aarch64 (Graviton)
kernel  7.0.0-1010-aws
BTF     /sys/kernel/btf/vmlinux present
docker  29.7.2
OBI     otel/ebpf-instrument:main
        sha256:6f38eb3e3c5d556773002855a660e0e96b787f630bd3e6886aabfb3e36c574db
        Version=7b96052 Revision=7b96052
```

Both `obi` containers run privileged and share their target's PID and network
namespaces, as a co-located agent would. `OBI_IMAGE=grafana/beyla:<tag> ./run.sh S1`
runs the same scenarios against Grafana Beyla's vendored copy; the `BEYLA_*`
aliases in `docker-compose.yml` cover it.

The code is unchanged on upstream `main` as of commit `4a6614e` (2026-08-17).

## Layout

```
app/        the process under test: serves :8080, calls the peer per request
peer/       the origin: answers 200, logs every request
relay/      transparent TCP relay that re-segments the response
loadgen/    inbound traffic against app:8080
collector/  OTLP sink writing every span to out/traces.jsonl
run.sh      single entrypoint
check.py    the assertions
```

## Notes

- `OBI_BPF_DEBUG=true ./run.sh S1` puts the probes' `bpf_dbg_printk` output in
  `out/S1/obi-app.log`, including `"forcing HTTP event finish"` at the point of
  emission.
- Adjacent behaviour found while characterising the trigger, not asserted on
  here. A first segment of 7 bytes makes OBI drop the response silently: no
  CLIENT span at all, and no 499 even with a close on every request. A first
  segment of 11 bytes — one byte short of `HTTP/1.1 200` — makes OBI emit
  `http.response.status_code=152` on 8,454 of 8,456 requests, so a truncated
  status line is parsed into a fabricated status rather than rejected.
- Scenario duration and load are tunable: `DURATION_S`, `CONCURRENCY`,
  `THINK_MS`, `START_DELAY_S`.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
