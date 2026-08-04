#!/usr/bin/env python3
"""
Example Kitchen heartbeat monitor — runs from launchd every minute on Mac Mini.

Layers:
  L1: public HTTPS probes (backoffice, kds-web, analytics)
  L2: container health via SSH to Oracle (docker ps; checks expected services)

State persists in ~/rop-heartbeat/state.json so Slack only sees
state transitions, not repeated unhealthy spam.

Designed for solo-operator scale; no external deps beyond stdlib + ssh.

Env: read from ~/rop-heartbeat/.env (chmod 600), required keys:
  SLACK_WEBHOOK_URL
Optional:
  ORACLE_SSH_HOST    (default "Oracle" — i.e. ~/.ssh/config Host entry)
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
ROOT = HOME / "rop-heartbeat"
STATE_FILE = ROOT / "state.json"
ENV_FILE = ROOT / ".env"

# Layer 1: public HTTPS endpoints.
#
# Each probe is (name, url, accepted_status_classes) where
# accepted_status_classes is the set of first-digits of the HTTP status that
# count as "healthy".
#
# Two flavors:
#   {"2", "3"}      — page should render or redirect cleanly. Use for unauth
#                     entry points and the customer display (no auth gate).
#   {"2", "3", "4"} — auth-gated business endpoint. Anonymous curl gets 401,
#                     but 401 PROVES the request reached the handler — i.e.
#                     env validator + framework routing are alive. Only 5xx
#                     and network failures count as broken. This catches the
#                     class of incident from 2026-05-21, where backoffice's
#                     env validator threw 500 on every API call for 22 hours
#                     while the root `/` page (which redirects to /login at
#                     middleware level) kept returning a clean 200/307.
L1_PROBES = [
    ("backoffice", "https://backoffice.example.com/", {"2", "3"}),
    ("backoffice-api-today",
     "https://backoffice.example.com/api/today", {"2", "3", "4"}),
    ("kds-web", "https://kds.example.com/", {"2", "3"}),
    ("kds-display", "https://kds.example.com/display", {"2", "3"}),
    ("kds-api-health",
     "https://kds.example.com/api/health", {"2", "3"}),
    ("analytics", "https://analytics.example.com/admin", {"2", "3"}),
]

# Layer 2: name-fragment → human label + required minimum running count.
# Plain compose names containers "<project>-<service>-<n>" (e.g.
# rop-kds-kds-api-1), so we match name substrings, not exact names.
L2_EXPECT = [
    ("backoffice-web", "backoffice-web", 1),
    ("kds-api", "kds-api", 1),
    ("kds-web", "kds-web", 1),
    ("kds-worker", "kds-worker (replicas=2)", 2),
    ("analytics-api", "analytics-api", 1),
]

# Don't false-alarm on these — they're one-shot containers (compose `migrate`)
# that exit cleanly with code 0.
L2_IGNORE_EXITED_OK = ("migrate",)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        return {}
    env = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_state(state: dict) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True))


def post_slack(webhook: str, title: str, desc: str, color: str) -> bool:
    # Slack incoming-webhook payload. The colored bar is an `attachments` entry
    # with `color` (a hex string, or one of "good"/"warning"/"danger"), which
    # renders the colored bar. Top-level `text` is the fallback/notification
    # line (channel list + mobile push).
    payload = json.dumps(
        {
            "text": title,
            "attachments": [
                {
                    "color": color,
                    "title": title,
                    "text": desc[:3800],
                    "fallback": f"{title}: {desc[:200]}",
                }
            ],
        }
    ).encode()
    req = urllib.request.Request(
        webhook, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=8).read()
        return True
    except urllib.error.URLError as exc:
        print(f"[slack] failed: {exc}", file=sys.stderr)
        return False


def probe_l1() -> dict[str, tuple[str, str]]:
    """Returns {probe_key: (status, detail)}."""
    out: dict[str, tuple[str, str]] = {}
    for name, url, accepted in L1_PROBES:
        try:
            r = subprocess.run(
                [
                    "curl",
                    "-sk",
                    "-o",
                    "/dev/null",
                    "-w",
                    "%{http_code}",
                    "--max-time",
                    "5",
                    "--connect-timeout",
                    "3",
                    url,
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            code = (r.stdout or "").strip() or "000"
            ok = code[:1] in accepted
            out[f"l1.{name}"] = (
                "healthy" if ok else "unhealthy",
                f"HTTP {code} {url}",
            )
        except subprocess.TimeoutExpired:
            out[f"l1.{name}"] = ("unhealthy", f"curl timeout: {url}")
        except Exception as exc:
            out[f"l1.{name}"] = ("unhealthy", f"{type(exc).__name__}: {exc}"[:200])
    return out


def probe_l2(env: dict) -> dict[str, tuple[str, str]]:
    """SSH to Oracle, parse `docker ps -a` output, check each expected service."""
    host = env.get("ORACLE_SSH_HOST", "Oracle")
    try:
        r = subprocess.run(
            [
                "ssh",
                "-o",
                "ConnectTimeout=5",
                "-o",
                "BatchMode=yes",
                host,
                # tab-separated so embedded spaces in Status don't break parse
                "docker ps -a --format '{{.Names}}\\t{{.Status}}'",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if r.returncode != 0:
            err = (r.stderr or "")[:120]
            return {
                f"l2.{label}": ("unknown", f"ssh failed: {err}")
                for _, label, _ in L2_EXPECT
            }
        statuses: list[tuple[str, str]] = []
        for line in r.stdout.strip().splitlines():
            if "\t" in line:
                n, s = line.split("\t", 1)
                statuses.append((n, s))
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        return {
            f"l2.{label}": ("unknown", f"ssh error: {exc}")
            for _, label, _ in L2_EXPECT
        }

    out: dict[str, tuple[str, str]] = {}
    for fragment, label, expected_count in L2_EXPECT:
        matches = [
            (n, s)
            for n, s in statuses
            if fragment in n and not any(ig in n for ig in L2_IGNORE_EXITED_OK)
        ]
        # Container "Up" prefix in Status string is the canonical alive marker.
        # "Up X seconds (unhealthy)" still counts as Up — process is running,
        # healthcheck is the concern of L1.
        up = [(n, s) for n, s in matches if s.startswith("Up")]
        bad = [(n, s) for n, s in matches if not s.startswith("Up")]

        if len(up) >= expected_count:
            extras = [s for _, s in up[:1]]
            out[f"l2.{label}"] = ("healthy", f"{len(up)}/{expected_count} up; {extras[0] if extras else ''}")
        else:
            detail_lines = []
            if bad:
                detail_lines.extend(f"{n}: {s}" for n, s in bad[:3])
            if len(up) < expected_count:
                detail_lines.append(
                    f"got {len(up)} up, want {expected_count}"
                )
            if not matches:
                detail_lines.append(f"no containers matching '{fragment}'")
            out[f"l2.{label}"] = ("unhealthy", " | ".join(detail_lines)[:400])
    return out


def diff_state(
    prev: dict, current: dict[str, tuple[str, str]]
) -> tuple[list[tuple[str, str, str, str]], list[tuple[str, str, str]]]:
    """
    Returns (flips, discoveries) where:
      flips = [(key, prev_status, new_status, detail)] for status changes
      discoveries = [(key, status, detail)] for first-time unhealthy with no prior state
    """
    flips = []
    discoveries = []
    for key, (status, detail) in current.items():
        prev_status = prev.get(key, {}).get("status")
        if prev_status is None:
            if status != "healthy":
                discoveries.append((key, status, detail))
        elif prev_status != status:
            flips.append((key, prev_status, status, detail))
    return flips, discoveries


def main() -> int:
    env = load_env()
    webhook = env.get("SLACK_WEBHOOK_URL")
    state = load_state()
    timestamp = now_iso()

    current: dict[str, tuple[str, str]] = {}
    current.update(probe_l1())
    current.update(probe_l2(env))

    flips, discoveries = diff_state(state, current)

    # Update state for everything (including unchanged).
    for key, (status, detail) in current.items():
        state.setdefault(key, {})
        state[key].update(
            {"status": status, "detail": detail, "checked_at": timestamp}
        )
    save_state(state)

    # Slack alerts: only on transitions (and first-time unhealthy discoveries).
    if webhook:
        downs = [
            (k, d) for k, _p, s, d in flips if s != "healthy"
        ]
        ups = [(k, d) for k, p, s, d in flips if s == "healthy" and p is not None]
        # Discoveries are "we just turned on the monitor and found these already bad"
        discovered_bad = [(k, f"{s}: {d}") for k, s, d in discoveries]

        if downs:
            body = "\n".join(f"• `{k}` — {d}" for k, d in downs)
            post_slack(webhook, f"🔴 {len(downs)} service flipped → unhealthy", body, "danger")
        if ups:
            body = "\n".join(f"• `{k}` — {d}" for k, d in ups)
            post_slack(webhook, f"🟢 {len(ups)} service recovered", body, "good")
        if discovered_bad:
            body = "\n".join(f"• `{k}` — {d}" for k, d in discovered_bad)
            post_slack(
                webhook,
                f"⚠️ heartbeat just started; {len(discovered_bad)} already-unhealthy probe(s)",
                body,
                "warning",
            )

    # Log a compact summary line that's grep-able in launchd's StandardOutPath.
    summary = " ".join(
        f"{k}={'OK' if s == 'healthy' else s.upper()[:3]}"
        for k, (s, _d) in sorted(current.items())
    )
    print(f"{timestamp} {summary}")

    # Exit non-zero if anything is unhealthy so a launchd "did it succeed" log
    # query (or a manual run) reflects the state. launchd won't restart based
    # on this — restarts are driven by StartInterval, not exit code.
    if any(s != "healthy" for s, _ in current.values()):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
