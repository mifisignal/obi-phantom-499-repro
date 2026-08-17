# CLIENT spans carry a synthesized `http.response.status_code = 499` for calls that returned 200

## Nature of the bug

OBI can sometimes emit an HTTP CLIENT span carrying `http.response.status_code =
499` and span status `Error` for a request that succeeded. The peer's own server
span for the same call reports `200`, and both applications' logs record
success. The span also reports `http.response.body.size = 0`, and its duration
is the socket's lifetime rather than the request's. No 499 is ever sent or
received on the wire: the value is synthesized in `force_finish_http()` when OBI
reaches `tcp_close` having never observed the response.

## Discussion

A trace span is a story about what happened. One such story is, "gateway sent a
POST to router. The router answered 499. The call failed, in 3.6 ms."

This framing is nonsensical. First, there's no such HTTP error as 499; it's an
nginx logging convention that indicates the client socket was shut down before
the respose could be returned. In reality, the call returned 200 after about a
second, and 3.6 ms is when OBI stopped watching rather than when the request
ended. 

What it should say instead is, "client sent an HTTP request at T. I observed the
request. I never observed the outcome, because the connection went away. Duration
was at least X; the true duration and result are unknown."

The current code can't express the latter story. Instrumentation is an observer,
and observers lose track when a buffer is unreadable or a socket is torn down
mid-flight. A model offering only "worked" or "failed" forces the observer to
lie when it does not know. The good news is that the OTel model provides a span
status of `Unset` to mean that no explicit judgment was made. The problem is
that OBI cannot reach it because `status == 0` is already taken internally by
"still reading."

Additionally, per [OTel HTTP
semconv](https://opentelemetry.io/docs/specs/semconv/http/http-spans/),
`http.response.status_code` is required "If and only if one was received/sent".
The bug manifests itself when OBI's 499 doesn't correspond to received status
code, and so populating the attribute when this happens is a spec violation.

## Symptom

A client sends a request, the peer answers 200, the client reads the whole
response and logs success. OBI emits a CLIENT span with
`http.response.status_code = 499`, `status = STATUS_CODE_ERROR`, and
`http.response.body.size = 0`. A second OBI instance watching the peer emits a
SERVER span reporting 200 for the same call.

The duration measures the socket's lifetime rather than the request's, running
from the request write to `bpf_ktime_get_ns()` at `tcp_close`: a median of
64.9 ms against a median actual call of 3.1 ms in one scenario, and 6 full
seconds when the connection sits in a pool that is never reaped.

## Suspected cause

`force_finish_http()` (`protocol_http.h:200-216`):

```c
    if (!high_request_volume) {
        if (!http_info_complete(info)) {
            info->resp_len = 0;
            info->end_monotime_ns = bpf_ktime_get_ns();
            info->status = 499;
        }
    }

    finish_http(info, pid_conn, current_key);
```

`finish_http()` emits only when `http_info_complete(info)` holds, and that
predicate is:

```c
return (info->start_monotime_ns != 0 && info->status != 0 && info->pid.host_pid != 0);
```

A request whose response was never observed has `status == 0`, so it is silently
dropped. `force_finish_http()` is reached from
`force_finish_possible_delayed_http_request()` on the socket-teardown path: the
connection is going away and everything known about that request is about to be
lost. Yet the fields set include the current time, `resp_len = 0` for the
response it never saw, and a non-zero `status` to get past the `status != 0`
gate.

The neighbouring helper confirms the overload:

```c
static __always_inline bool still_reading(http_info_t *info) {
    return info->status == 0 && info->start_monotime_ns != 0;
}
```

The status field is thus serving as both a state-machine flag ("have I seen the
response yet") and the reported HTTP status. Under that design, "finished,
outcome unknown" is unrepresentable: `0` is taken by in-flight, and every other
value is a status code.

We suspect the intent was not to report a client abort. It was to avoid losing
the span, and 499 is the least-wrong non-zero value when the meaning is "the
connection went away before I saw a response" — `0` means in-flight, and any 5xx
would falsely blame the server. `high_request_volume` gating the whole branch
fits the same reading: with that option set the fabrication is skipped and the
span is dropped instead. That is a deliberate trade-off between losing a record
and inventing a status, made inside a struct that offered only those two
options.

Nothing in #767 mentions status semantics, so whether
the author foresaw that 499 would surface as an OTel `Error` on a CLIENT span is
unknown.

## Reproduction

https://github.com/mifisignal/obi-phantom-499-repro

### How it is triggered

The following two conditions must coincide:

1. OBI does not observe the response, so the `http_info_t` keeps
   `status == 0`. The reproduction induces this by re-segmenting the response so
   its first TCP segment is one byte, with the rest 2 ms later: `tcp_cleanup_rbuf`
   returns early on `copied_len <= 1`, and the remainder arrives in a read that
   does not begin with a status line.
2. `tcp_close` fires while that incomplete entry is still in `ongoing_http`.

Condition 2 publishes the error, and the rate precisely tracks the close rate.
Holding the segmentation constant and varying only the client's connection pool:

| App's outbound pool | Phantom 499s |
|---|---|
| connection per request | 8,433 of 8,435 (99.98%) |
| keep-alive, 250 ms idle reaping | 216 of 9,422 (2.29%) |
| keep-alive, never reaped | 2 of 9,475 (0.02%) — the pair closed at shutdown |

We know that a missed response plus a`tcp_close` deterministically produces the
phantom 499, and that the defect is entirely absent when the response is
observed. We don't know, though, what exactly caused the missed responses that
are necessary to make the bug appear. 

## Evidence

The same call from both sides. `check.py` pairs each phantom span with the peer
SERVER span whose whole lifetime falls inside it: 8,433 of 8,433 matched.

```
CLIENT (app)   GET  server.address=relay:9100
               http.response.status_code=499  http.response.body.size=0
               status=STATUS_CODE_ERROR       duration=18.244ms

SERVER (peer)  GET  url.path=/r  client.address=172.19.0.4
               http.response.status_code=200  http.response.body.size=227
               status=unset                   duration=4.660ms
```

Both applications' access logs, same traffic:

```
{"role":"app", "msg":"call","id":1,"peer_status":200,"peer_bytes":64,"duration_ms":30.33}
{"role":"peer","msg":"request","id":1,"status":200,"bytes":64,"aborted":false,"response_completed":true}
```

Aggregates for that run: 8,435 calls made, 8,435 returned 200, 0 failed; the peer
served 8,435 requests with 0 aborted or partial; all 8,435 peer SERVER spans
report 200.

## Impact

Healthy requests are published as errors. Error-based trace search returns them,
tail-sampling policies keyed on span status retain them preferentially, and the
service graph draws a failing edge between two healthy services. The inflated
duration compounds it, pulling the same spans into latency-based sampling and
alerting.

RED metrics are affected as well. These spans carry no `span.metrics.skip`
attribute — verified on the exported spans rather than assumed — and with
`OTEL_EBPF_METRICS_FEATURES=application` the collector receives
`http.client.request.duration`, `http.client.request.body.size` and
`http.client.response.body.size` series labelled
`http.response.status_code=499` alongside the 200 series.

Because the rate follows connection churn rather than request failures, the
result is a steady low-percentage error floor on a healthy service.

## Version / environment

```
OBI     otel/ebpf-instrument:main
        sha256:6f38eb3e3c5d556773002855a660e0e96b787f630bd3e6886aabfb3e36c574db
        Version=7b96052 Revision=7b96052
host    EC2 c7g, Ubuntu 24.04, aarch64 (Graviton)
kernel  7.0.0-1010-aws
BTF     /sys/kernel/btf/vmlinux present
docker  29.7.2
```

Generic tracer, plaintext HTTP/1.1, Node workloads on both ends. The code quoted
above is unchanged on upstream `main` at commit `4a6614e` (2026-08-17), verified
against a fresh clone rather than the tested image.

## AI assistance disclosure

Per the project's Generative AI Policy: this report was drafted with AI
assistance. The reproduction, the parameter sweep behind the trigger analysis,
and every span, log line and count quoted here were produced by running the
attached code on the system described above, and were reviewed by a human before
submission.
