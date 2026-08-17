# CLIENT spans carry a synthesized `http.response.status_code = 499` for calls that returned 200

## Component(s)

`bpf/generictracer/protocol_http.h` — `force_finish_http()`, `http_info_complete()`
`bpf/generictracer/k_tracer.c` — `obi_kprobe_tcp_close`, `tcp_cleanup_rbuf`
`bpf/generictracer/k_send_receive.h` — `force_sent_event()`, `should_ignore_unreadable()`

## Nature of the bug

OBI emits an HTTP CLIENT span carrying `http.response.status_code = 499` and span
status `Error` for a request that succeeded. The peer's own SERVER span for the
same call reports `200`, and both applications' logs record success. The span
also reports `http.response.body.size = 0`, and its duration is the socket's
lifetime rather than the request's. No 499 is ever sent or received on the wire:
the value is synthesized in `force_finish_http()` when OBI reaches `tcp_close`
having never observed the response.

Read the span as a story about what happened. Today it says: *"gateway sent a
POST to router. The router answered 499. The call failed, in 3.6 ms."* Every
clause is false — nothing sent a 499, the call returned 200 after about a second,
and 3.6 ms is when OBI stopped watching rather than when the request ended. The
dangerous property is that the story is complete and coherent: no gap, no null,
nothing that looks wrong, so a reader acts on it and chases a failure that never
happened, or concludes the callee is flaky. A fabricated status is an unknown
unknown; a missing span is at least a known one.

What it should say: *"this process sent an HTTP request at T. I observed the
request. I never observed the outcome, because the connection went away. Duration
was at least X; the true duration and result are unknown."* That is three useful
facts rather than an absence — the call happened, so the service-graph edge is
real; the duration is a lower bound rather than a measurement; and the outcome is
unknown, which is distinct from both success and failure.

The distinction the current design cannot express is **absence of evidence versus
evidence of failure**. Instrumentation is an observer, and observers lose track —
an unreadable buffer, a socket torn down mid-flight. A model offering only
"worked" or "failed" forces the observer to lie when it does not know. OTel
already has the right container: span status is `Unset` / `Ok` / `Error`, and
`Unset` means no explicit judgment was made. "Unknown" is expressible in the
spec. OBI cannot reach it only because `status == 0` is already taken internally
by "still reading" — the overloaded field described below.

Given such a span, a consumer should be able to render it in the trace without
colouring it as an error; exclude it from error rates without silently counting
it as a success, which is the quieter lie; leave error-based tail-sampling
policies untriggered, where ours currently force-keeps every trace containing
one; and draw the service-graph edge without marking it failed. None of that is
possible while the span asserts a status code.

## The invariant

A CLIENT span carrying `http.response.status_code = 499` describes a state that
cannot exist.

499 is nginx's convention for a server recording that *the client went away
before I could respond*. It is written to a log and never transmitted. A CLIENT
span asserting it therefore claims the client received a status meaning "the
client stopped waiting" — and a client that abandoned a request is not there to
be told about it.

Three consequences, none of which need this reproduction to accept:

- Per [OTel HTTP semconv](https://opentelemetry.io/docs/specs/semconv/http/http-spans/),
  `http.response.status_code` is required "If and only if one was received/sent".
  OBI's 499 was never received. Populating the attribute at all is a spec
  violation, independent of any error mapping.
- Semconv further says a 4xx "MUST be left unset in case of `SpanKind.SERVER` and
  SHOULD be set to `Error` in case of `SpanKind.CLIENT`". The resulting
  `STATUS_CODE_ERROR` is therefore the *correct* handling of a bad attribute. The
  fix is not to stop mapping 499 to an error.
- A legitimately-placed 499 could only ever sit on a SERVER span, where 4xx
  leaves the span status unset. A correct 499 is never an error.

To be precise so this cannot be swatted: a proxy *can* put 499 on the wire, and a
client that receives one should record it. The claim here is narrower — **OBI
must not synthesize one**, because a synthesized 499 is by construction not a
status anything received.

That yields a testable invariant: *no CLIENT span may carry a status code OBI
synthesized rather than observed.* OBI violates it today.

## What it looks like in practice

A client sends a request, the peer answers 200, the client reads the whole
response and logs success. OBI emits a CLIENT span with
`http.response.status_code = 499`, `status = STATUS_CODE_ERROR`, and
`http.response.body.size = 0`. A second OBI instance watching the peer emits a
SERVER span reporting 200 for the same call.

The duration measures the socket's lifetime rather than the request's, running
from the request write to `bpf_ktime_get_ns()` at `tcp_close`: a median of
64.9 ms against a median actual call of 3.1 ms in one scenario, and 6 full
seconds when the connection sits in a pool that is never reaped.

## This was never specified

499 does not exist in the imported Beyla code. `git log -S'status = 499'` over
`bpf/generictracer/protocol_http.h` returns exactly one commit: `d1760a3b`, PR
#767 "Handle receiving large HTTPS payloads" (2025-10-23), where it appears as
three lines inside a new `force_finish_http()` helper. That PR is about TLS
requests being terminated eagerly because "SSL_close or SSL_shutdown are not
reliably called by frameworks". Its description never mentions 499, status codes,
or error semantics. The value was incidental scaffolding.

The only follow-up is `db495d2d`, PR #1571 "Fix missing requests on pipe splice"
(2026-03-21), which added `should_ignore_unreadable()` with this comment
(`k_send_receive.h:50-53`):

> Unreadable buffers on responses may cause unexpected force closed connections,
> e.g. 499. We track those in unreadable buffer ports, but they are setup on
> demand in tcp_cleanup_rbuf which is too late for the first request. This code
> ensures we don't cause 499 on the first one, but a silently missed event.

So spurious 499s have already been observed upstream, and the response was to
suppress one subset of them — trading a false error for a silently dropped span —
rather than to revisit the value. No issue has ever been filed about 499 in
either this repository or grafana/beyla.

The ask here is not to defend a decision. Nobody made one.

## Suspected cause: the status field is overloaded

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
lost. Its three assignments are exactly the minimum needed to make the record
emittable — an end time it does not have, `resp_len = 0` for the response it
never saw, and a non-zero `status` **to get past the `status != 0` gate**.

The neighbouring helper confirms the overload:

```c
static __always_inline bool still_reading(http_info_t *info) {
    return info->status == 0 && info->start_monotime_ns != 0;
}
```

One field is both a state-machine flag ("have I seen the response yet") and the
reported HTTP status. Under that design, "finished, outcome unknown" is
unrepresentable: `0` is taken by in-flight, and every other value is a status
code.

Read that way the intent was almost certainly not to report a client abort. It
was to avoid losing the span, and 499 is the least-wrong non-zero value when the
meaning is "the connection went away before I saw a response" — `0` means
in-flight, and any 5xx would falsely blame the server. `high_request_volume`
gating the whole branch fits the same reading: with that option set the
fabrication is skipped and the span is dropped instead. That is a deliberate trade between
losing a record and inventing a status, made inside a struct that offered only
those two options.

What cannot be established: nothing in #767 mentions status semantics, so whether
the author foresaw that 499 would surface as an OTel `Error` on a CLIENT span is
unknown. It is probably not visible from inside the BPF code.

One consequence worth flagging before anyone reaches for it: because the gate is
`status != 0`, simply deleting the `status = 499` line reverts to silently
dropping the span, which is the regression #767 was fixing. The fix has to change
the representation, not remove the assignment.

## Suggested fix

The change is small — those three lines, with `finish_http()` called either way.
The open question is what the record should carry when the response was never
observed, and that is yours to answer rather than ours:

1. **Leave the status unset** and omit `http.response.status_code` entirely. This
   matches semconv's "if and only if one was received/sent" wording most
   directly.
2. **Set `Error` with a low-cardinality `error.type`**, per semconv's guidance for
   requests that fail without a response. This is only correct if OBI can
   distinguish "the connection died" from "I stopped watching" at
   `force_finish_http()` time. That distinction is the crux, and we cannot tell
   from outside whether it is available there.
3. **Do not emit the span.** This is already what happens to these same requests
   when `high_request_volume` is set, so the behaviour exists and is survivable.

Whichever is chosen, the underlying ask is representational: give the record a
way to say *the response was never observed* — a separate flag, or a sentinel
that userspace maps to unknown and never exports as `http.response.status_code`.
That is a smaller change than altering status semantics.

Separately, the end timestamp should not be `bpf_ktime_get_ns()` at `tcp_close`
when that moment is unrelated to the request. An unreaped pooled connection turns
a 3 ms call into a 6-second span.

## Reproduction

https://github.com/mifisignal/obi-phantom-499-repro

```sh
git clone https://github.com/mifisignal/obi-phantom-499-repro
cd obi-phantom-499-repro
./run.sh all
```

Docker and git are the only host requirements. `check.py` exits 1 when the defect
is present, so it works as a regression test against a fix. It includes a control
that fails the run if OBI produced no SERVER spans for either process, so "no
spans" cannot masquerade as "no defect", and it establishes from the
applications' own access logs — not from OBI — that every call succeeded before
asserting anything about the spans.

### How it is triggered

Two conditions must coincide; each was varied independently and each is
necessary.

1. **OBI does not observe the response**, so the `http_info_t` keeps
   `status == 0`. The reproduction induces this by re-segmenting the response so
   its first TCP segment is one byte, with the rest 2 ms later: `tcp_cleanup_rbuf`
   returns early on `copied_len <= 1`, and the remainder arrives in a read that
   does not begin with a status line.
2. **`tcp_close` fires** while that incomplete entry is still in `ongoing_http`.

Condition 2 is what publishes the error, and the rate tracks the close rate
precisely. Holding the segmentation constant and varying only the client's
connection pool:

| App's outbound pool | Phantom 499s |
|---|---|
| connection per request | 8,433 of 8,435 (99.98%) |
| keep-alive, 250 ms idle reaping | 216 of 9,422 (2.29%) |
| keep-alive, never reaped | 2 of 9,475 (0.02%) — the pair closed at shutdown |

In the never-reaped run the other ~9,200 missed responses were dropped silently.
Holding the first row's pool behaviour constant and removing only the
re-segmentation gives 0 of 10,819. Reproduced on every run of the worst scenario
across five runs; the control was clean on every run.

Varied without producing it, at 8,000–50,000 requests per run: connection reuse
alone; first-vs-later request on a connection; body sizes 64 B, 200 KB, 1 MB;
responses written in 20 application chunks; concurrency 2/4/64 at 200–1,300 req/s;
server-initiated close (1 ms `keepAliveTimeout`, so the origin FINs mid-read);
and a response head split at 12 bytes or later. All plaintext HTTP/1.1 — TLS was
not tested, and this report makes no claim about that path.

**`high_request_volume` is not a rate threshold**, so the bug does not disappear
under load. It is the explicit boolean `OTEL_EBPF_BPF_HIGH_REQUEST_VOLUME`
(`pkg/config/ebpf_tracer.go:99`), default false, set by nothing automatically.
Setting it true does remove the phantom 499 completely — 0 of 6,310 on the worst
scenario — by dropping those CLIENT spans entirely (6,309 of 6,310 produced none).
A workaround, not a fix.

**Where the uncertainty is.** What is established is that a missed response plus a
`tcp_close` deterministically produces the phantom 499, and that the defect is
entirely absent when the response is observed. What is **not** established is what
caused the missed responses in the production incident behind this report — a
Node service making pooled keep-alive plaintext HTTP/1.1 calls to an Apollo
Router, a Java service and a Go service, where a continuous minority of calls
carried this exact signature. A one-byte first segment is a synthetic way to
induce the miss; a real origin is unlikely to send one. It reaches the same
branch, but the production cause of the miss remains unidentified.

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
result is a steady low-percentage error floor on a healthy service, which is the
hardest kind to attribute.

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
