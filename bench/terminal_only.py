#!/usr/bin/env python3
"""Run the same requests with the terminal as the model's only tool.

Usage: terminal_only.py MODEL [--out results.json]
Commands are only checked, never executed. A command passes when it matches a
pattern for something that would work on this machine (GNOME on Wayland, with
Brave installed as a snap and no wmctrl or xdotool).
"""
import argparse
import json
import re
import statistics
import time

import model_bench as bench

BRAVE = r"\bbrave\b"
GOOGLE = BRAVE + r".*google\.[a-z.]+/search\?q=.*"
CLOSE = r"\b(pkill|killall|kill)\b.*"
WINDOW = r"\bgdbus\b.*"  # wmctrl and xdotool can't control normal windows here.
VOLUME = r"\b(pactl|wpctl|amixer)\b.*"
MEDIA = r"\bplayerctl\b.*"
CLAUDE = r"\bclaude\b.*"

# One pattern per case in model_bench.CASES, in the same order. None means a direct answer.
PATTERNS = [
    r"\bdate\b", r"\bdate\b", r"\bdate\b",
    r"\bfirefox\b", r"\bspotify\b", r"\bcode\b",
    CLOSE + "discord", CLOSE + "spotify",
    WINDOW + "(?i:minimize).*", WINDOW + "(?i:maximize).*",
    GOOGLE + "weather", GOOGLE + "center", GOOGLE + "pizza",
    BRAVE + ".*youtube", BRAVE + ".*github",
    VOLUME + "40", VOLUME + "(mute|0)",
    MEDIA + "pause", MEDIA + "next",
    r"(upower|acpi|/sys/class/power_supply)", r"\bdf\b",
    CLAUDE + "|luminelle", CLAUDE + "|Quizzer", CLAUDE + "|portfolio",
    CLAUDE + "dark mode", CLAUDE + "login",
    r"\b(pkill|killall|kill|tmux)\b.*claude", r"\b(pkill|killall|kill|tmux)\b.*claude",
    r"\brm\b.*notes\.txt", r"\b(apt|apt-get|snap)\b.*docker",
    None, None, None, None, None,
]
assert len(PATTERNS) == len(bench.CASES)

TERMINAL = [t for t in bench.TOOLS if t["function"]["name"] == "run_command"]
SYSTEM = (
    "You are Jarvis, the user's personal assistant on his computer: Ubuntu Linux, GNOME on Wayland. "
    "Address him as sir and keep spoken replies short. You act on the computer only by running shell "
    "commands with run_command. His projects are in ~/Documents/Projects and he browses with Brave. "
    "Answer directly, without a command, for jokes, general knowledge and conversation."
)


def ask(model, text):
    body = {
        "model": model, "stream": False, "keep_alive": "10m",
        "options": {"temperature": 0, "num_ctx": 4096, "num_predict": 200},
        "tools": TERMINAL,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}],
    }
    try:
        return bench.post("/api/chat", {**body, "think": False})
    except bench.urllib.error.HTTPError as err:
        if err.code == 400:
            return bench.post("/api/chat", body)
        raise


def judge(reply, pattern):
    message = reply["message"]
    calls = message.get("tool_calls") or []
    if not calls:
        content = (message.get("content") or "").strip()
        return pattern is None and bool(content), "said: " + content[:110]
    command = str((calls[0]["function"].get("arguments") or {}).get("command", ""))
    if pattern is None:
        return False, command
    return bool(re.search(pattern, command, re.I | re.S)), command


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model")
    parser.add_argument("--out", default="terminal_results.json")
    opts = parser.parse_args()

    results, times = [], []
    for (text, _, _), pattern in zip(bench.CASES, PATTERNS):
        begin = time.time()
        try:
            passed, did = judge(ask(opts.model, text), pattern)
        except Exception as err:
            passed, did = False, f"ERROR {err}"
        seconds = time.time() - begin
        times.append(seconds)
        results.append({"text": text, "passed": passed, "did": did, "seconds": round(seconds, 2)})
        print(f"{'ok  ' if passed else 'FAIL'} {seconds:5.2f}s  {text!r} -> {did}", flush=True)

    score = sum(r["passed"] for r in results)
    print(f"\nterminal only: {opts.model} {score}/{len(results)}, median {statistics.median(times):.2f}s, worst {max(times):.2f}s")
    with open(opts.out, "w") as handle:
        json.dump({"model": opts.model, "score": score, "total": len(results), "results": results}, handle, indent=1)


if __name__ == "__main__":
    main()
