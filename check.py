#!/usr/bin/env python3
"""Assert that OBI never reports a successful HTTP call as a 499 error.

Reads one scenario's artifacts -- the collector's OTLP-JSON file sink plus the
two applications' access logs -- and applies a single assertion:

    no CLIENT span emitted for the app may carry http.response.status_code=499
    or status=STATUS_CODE_ERROR, given that the peer answered every request 200
    and neither application recorded an abort.

This is a regression test, so the exit code is inverted relative to a
demonstration script: exit 1 means the defect is present, exit 0 means the run
is clean. A future OBI fix turns every scenario green without editing anything
here.

    ./check.py S1 [out/S1]

Standard library only.
"""

import bisect
import json
import os
import sys

KIND_SERVER, KIND_CLIENT = 2, 3

SCENARIOS = {
    "C0": "control: response in one segment, connection per request",
    "S1": "response first byte on its own segment, connection per request",
    "S2": "same, over a keep-alive pool with 250ms idle reaping",
    "S3": "same, over a keep-alive pool that is never reaped",
}


def attrs(span):
    out = {}
    for a in span.get("attributes", []):
        v = a.get("value", {})
        for k in ("stringValue", "intValue", "boolValue", "doubleValue"):
            if k in v:
                out[a["key"]] = int(v[k]) if k == "intValue" else v[k]
                break
    return out


def load_spans(path):
    spans = []
    if not os.path.exists(path):
        return spans
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                doc = json.loads(line)
            except json.JSONDecodeError:
                continue
            for rs in doc.get("resourceSpans", []):
                res = {}
                for a in rs.get("resource", {}).get("attributes", []):
                    res[a["key"]] = a.get("value", {}).get("stringValue")
                for ss in rs.get("scopeSpans", []):
                    for sp in ss.get("spans", []):
                        sp["_svc"] = res.get("service.name")
                        sp["_attrs"] = attrs(sp)
                        spans.append(sp)
    # The file exporter can repeat a span if an export was retried; de-duplicate
    # so counts mean what they look like.
    seen, uniq = set(), []
    for sp in spans:
        k = (sp.get("traceId"), sp.get("spanId"), sp.get("startTimeUnixNano"))
        if k in seen:
            continue
        seen.add(k)
        uniq.append(sp)
    return uniq


def load_jsonl_logs(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def dur_ms(sp):
    return (int(sp["endTimeUnixNano"]) - int(sp["startTimeUnixNano"])) / 1e6


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else float("nan")


def is_error(sp):
    return sp.get("status", {}).get("code") == 2


def describe(sp):
    a = sp["_attrs"]
    return (
        f'    name={sp["name"]!r} kind=CLIENT '
        f'http.response.status_code={a.get("http.response.status_code")} '
        f'status={"STATUS_CODE_ERROR" if is_error(sp) else "unset"}\n'
        f'      http.response.body.size={a.get("http.response.body.size")} '
        f'http.request.body.size={a.get("http.request.body.size")} '
        f'server.address={a.get("server.address")}:{a.get("server.port")}\n'
        f'      duration={dur_ms(sp):.3f}ms traceId={sp.get("traceId")} spanId={sp.get("spanId")}'
    )


def main():
    if len(sys.argv) < 2 or sys.argv[1].upper() not in SCENARIOS:
        print(f"usage: {sys.argv[0]} <{'|'.join(SCENARIOS)}> [outdir]")
        return 2
    scenario = sys.argv[1].upper()
    outdir = sys.argv[2] if len(sys.argv) > 2 else f"out/{scenario}"

    spans = load_spans(os.path.join(outdir, "traces.jsonl"))
    app_log = load_jsonl_logs(os.path.join(outdir, "app.log"))
    peer_log = load_jsonl_logs(os.path.join(outdir, "peer.log"))

    app_server = [s for s in spans if s["_svc"] == "app" and s.get("kind") == KIND_SERVER]
    app_client = [s for s in spans if s["_svc"] == "app" and s.get("kind") == KIND_CLIENT]
    peer_server = [s for s in spans if s["_svc"] == "peer" and s.get("kind") == KIND_SERVER]

    app_calls = [l for l in app_log if l.get("msg") == "call"]
    app_failed = [l for l in app_log if l.get("msg") == "call_failed"]
    peer_reqs = [l for l in peer_log if l.get("msg") == "request"]
    peer_aborted = [l for l in peer_reqs if l.get("aborted") or l.get("response_completed") is False]

    print(f"scenario {scenario}: {SCENARIOS[scenario]}")
    print()
    print("  what actually happened, per the applications' own access logs")
    print(f"    app  outbound calls           {len(app_calls)}")
    print(f"    app  calls that returned 200  {sum(1 for l in app_calls if l.get('peer_status') == 200)}")
    print(f"    app  calls that failed        {len(app_failed)}")
    print(f"    peer requests served          {len(peer_reqs)}")
    print(f"    peer requests aborted/partial {len(peer_aborted)}")
    print()
    print("  what OBI emitted")
    print(f"    app  SERVER spans             {len(app_server)}")
    print(f"    app  CLIENT spans             {len(app_client)}")
    print(f"    peer SERVER spans             {len(peer_server)}")
    peer_bad = [s for s in peer_server if s["_attrs"].get("http.response.status_code") not in (None, 200)]
    print(f"    peer SERVER spans not 200     {len(peer_bad)}")

    # ---- Control. Without it, "no spans" is indistinguishable from "no defect".
    if not app_server or not peer_server:
        print("\nFAIL  control: OBI produced no SERVER spans for app and/or peer, so it")
        print("      never instrumented the workload. This run says nothing about the")
        print("      defect either way.")
        return 1
    if not app_calls or not peer_reqs:
        print("\nFAIL  control: the applications recorded no traffic. Nothing was exercised.")
        return 1

    # ---- Ground truth. The assertion below is only meaningful if the calls
    # really did succeed, so establish that from the applications, not from OBI.
    if app_failed or any(l.get("peer_status") != 200 for l in app_calls):
        print("\nFAIL  control: the app recorded a failed or non-200 outbound call. The")
        print("      workload is not producing the all-succeeded traffic this asserts over.")
        return 1
    if peer_aborted:
        print("\nFAIL  control: the peer recorded an aborted or incomplete response. A 499")
        print("      would not be phantom in that case.")
        return 1
    if peer_bad:
        print("\nFAIL  control: a peer SERVER span reports a status other than 200.")
        return 1

    # ---- The assertion.
    phantom = [
        s
        for s in app_client
        if s["_attrs"].get("http.response.status_code") == 499 or is_error(s)
    ]

    print()
    print(f"  CLIENT spans reporting 499 or STATUS_CODE_ERROR   {len(phantom)}")
    if app_client:
        rate = 100.0 * len(phantom) / len(app_client)
        print(f"  as a share of CLIENT spans emitted                {rate:.2f}%")
    print(f"  as a share of calls the app actually made         "
          f"{100.0 * len(phantom) / len(app_calls):.2f}%")

    if phantom:
        print()
        for sp in phantom[:5]:
            print(describe(sp))
        if len(phantom) > 5:
            print(f"    ... and {len(phantom) - 5} more")
        print()
        print(f"  median 499 CLIENT span duration   {median([dur_ms(s) for s in phantom]):.3f}ms")
        print(f"  median peer SERVER span duration  {median([dur_ms(s) for s in peer_server]):.3f}ms")
        print(f"  median app-logged call duration   "
              f"{median([l['duration_ms'] for l in app_calls]):.3f}ms")
        sizes = {s['_attrs'].get('http.response.body.size') for s in phantom}
        print(f"  http.response.body.size on them   {sorted(x for x in sizes if x is not None)}")

    if phantom:
        # Per-span correlation. Aggregates already establish that the peer
        # answered 200 to everything, but pairing each phantom span with the
        # peer SERVER span whose whole lifetime falls inside it removes any
        # doubt that these are the same calls.
        peer_calls = sorted(
            (s for s in peer_server if s["name"].startswith("GET ")),
            key=lambda s: int(s["startTimeUnixNano"]),
        )
        starts = [int(s["startTimeUnixNano"]) for s in peer_calls]
        matched = 0
        example = None
        for c in phantom:
            lo, hi = int(c["startTimeUnixNano"]), int(c["endTimeUnixNano"])
            i = bisect.bisect_left(starts, lo)
            if i < len(peer_calls) and starts[i] < hi:
                matched += 1
                if example is None:
                    example = (c, peer_calls[i])
        print(f"\n  phantom CLIENT spans with a peer SERVER span inside their window  "
              f"{matched}/{len(phantom)}")
        if example:
            c, p = example
            print("    the same call, from both sides:")
            print(f"      app  CLIENT status={c['_attrs'].get('http.response.status_code')} "
                  f"body.size={c['_attrs'].get('http.response.body.size')} "
                  f"error={is_error(c)} duration={dur_ms(c):.3f}ms")
            print(f"      peer SERVER status={p['_attrs'].get('http.response.status_code')} "
                  f"body.size={p['_attrs'].get('http.response.body.size')} "
                  f"error={is_error(p)} duration={dur_ms(p):.3f}ms")

    # Reported, never asserted on: responses OBI missed without a close to
    # convert them into a 499 vanish instead, which is a separate defect.
    missing = len(app_calls) - len(app_client)
    if missing > 0:
        print(f"\n  note: {missing} of {len(app_calls)} outbound calls produced no CLIENT span at all.")

    if phantom:
        print()
        print(f"FAIL  DEFECT PRESENT: {len(phantom)} CLIENT span(s) report the call as a 499")
        print( "      error. The peer answered 200 on every one of them, its own SERVER")
        print( "      spans say 200, and neither application recorded an abort. 499 here is")
        print( "      OBI's internal sentinel for 'I force-finished a request whose response")
        print( "      I never observed' (bpf/generictracer/protocol_http.h, force_finish_http),")
        print( "      surfaced to callers as a real HTTP status on a CLIENT span, which OTel")
        print( "      semantic conventions then mark as an error.")
        return 1

    print()
    print("PASS  no CLIENT span reports 499 or an error status. Every call the app")
    print("      made is either represented faithfully or not at all.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
