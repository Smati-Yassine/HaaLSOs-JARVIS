#!/usr/bin/env python3
"""Benchmark Ollama models on the tool choices Jarvis has to make.

Usage: model_bench.py MODEL [MODEL ...] [--out results.json]
Uses only the standard library. Nothing here executes a tool: it only checks
which tool each model picks and how long it takes.
"""
import argparse
import json
import statistics
import time
import urllib.error
import urllib.request

OLLAMA = "http://localhost:11434"

SYSTEM = (
    "You are Jarvis, the user's personal assistant on his Linux computer. Address him as sir. "
    "Keep spoken replies to one or two short sentences. Use a tool whenever the request "
    "is an action on the computer or needs live information. Answer directly, without tools, "
    "for jokes, general knowledge, thanks and conversation. Only use google_search when he "
    "explicitly says google or search. Any request to add, fix, change or build something in code "
    "goes to ask_claude. A website or web address goes to open_website."
)


def tool(tool_name, description, /, **params):
    """Build an Ollama tool definition. Every parameter is a required string."""
    return {
        "type": "function",
        "function": {
            "name": tool_name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {k: {"type": "string", "description": v} for k, v in params.items()},
                "required": list(params),
            },
        },
    }


TOOLS = [
    tool("get_time", "Get the current time and date."),
    tool("open_app", "Open a program on the computer.", name="Program name, like firefox or spotify"),
    tool("close_app", "Close a running program.", name="Program name"),
    tool("window_control", "Minimize, maximize or focus a program's window.",
         action="minimize, maximize or focus", name="Program name"),
    tool("google_search", "Search Google in a new Brave browser tab.", query="What to search for"),
    tool("open_website", "Open a website in a new Brave browser tab.", url="Website address"),
    tool("set_volume", "Set the system volume.", level="Volume from 0 to 100, or mute or unmute"),
    tool("media_control", "Control music or video playback. Next song means next.", action="play, pause, next or previous"),
    tool("system_info", "Read battery, CPU, memory, disk or network status.",
         what="battery, cpu, memory, disk or network"),
    tool("start_coding", "Open a coding project in the Claude window.", project="Project name"),
    tool("ask_claude", "Send a coding task to the open Claude session: adding features, fixing bugs, "
                       "changing code or pages.", task="The user's exact request"),
    tool("close_project", "Close the open coding project and everything in it, when he says he is done coding."),
    tool("run_command", "Run a shell command for anything no other tool covers, "
                        "like managing files or installing software.", command="The shell command"),
]

# (spoken request, expected tool or None for a direct answer, {argument: text it must contain})
CASES = [
    ("What time is it?", "get_time", {}),
    ("Jarvis what time is it", "get_time", {}),
    ("what's today's date", "get_time", {}),
    ("Open Firefox", "open_app", {"name": "firefox"}),
    ("jarvis open spotify please", "open_app", {"name": "spotify"}),
    ("launch visual studio code", "open_app", {"name": "code"}),
    ("close discord", "close_app", {"name": "discord"}),
    ("quit spotify", "close_app", {"name": "spotify"}),
    ("minimize firefox", "window_control", {"action": "minimize", "name": "firefox"}),
    ("maximize the terminal", "window_control", {"action": "maximize", "name": "terminal"}),
    ("google the weather in Tunis", "google_search", {"query": "weather"}),
    ("google how to center a div", "google_search", {"query": "center a div"}),
    ("search google for best pizza near me", "google_search", {"query": "pizza"}),
    ("open youtube", "open_website", {"url": "youtube"}),
    ("go to github.com", "open_website", {"url": "github"}),
    ("set the volume to 40", "set_volume", {"level": "40"}),
    ("mute the sound", "set_volume", {"level": "mute"}),
    ("pause the music", "media_control", {"action": "pause"}),
    ("next song", "media_control", {"action": "next"}),
    ("how much battery do I have", "system_info", {"what": "battery"}),
    ("how much disk space is left", "system_info", {"what": "disk"}),
    ("let's start coding my Luminelle project", "start_coding", {"project": "luminelle"}),
    ("time to work on Quizzer", "start_coding", {"project": "quizzer"}),
    ("open the portfolio project in claude", "start_coding", {"project": "portfolio"}),
    ("add dark mode to the settings page", "ask_claude", {"task": "dark mode"}),
    ("fix the login bug", "ask_claude", {"task": "login"}),
    ("close the project", "close_project", {}),
    ("we're done coding", "close_project", {}),
    ("delete the file notes.txt in my Downloads", "run_command", {"command": "notes.txt"}),
    ("install docker", "run_command", {"command": "docker"}),
    ("Tell me a joke", None, {}),
    ("who wrote Hamlet", None, {}),
    ("how are you today", None, {}),
    ("what is the capital of Japan", None, {}),
    ("thanks Jarvis", None, {}),
]



def post(path, body, timeout=180):
    req = urllib.request.Request(
        OLLAMA + path, json.dumps(body).encode(), {"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def get(path):
    with urllib.request.urlopen(OLLAMA + path, timeout=10) as resp:
        return json.load(resp)


def ask(model, text):
    body = {
        "model": model,
        "stream": False,
        "keep_alive": "10m",
        "options": {"temperature": 0, "num_ctx": 4096, "num_predict": 200},
        "tools": TOOLS,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}],
    }
    try:
        return post("/api/chat", {**body, "think": False})
    except urllib.error.HTTPError as err:
        if err.code == 400:  # The model doesn't accept the think option.
            return post("/api/chat", body)
        raise


def judge(reply, expected, args):
    """Return (passed, what the model did)."""
    message = reply["message"]
    calls = message.get("tool_calls") or []
    if not calls:
        content = (message.get("content") or "").strip()
        return expected is None and bool(content), "said: " + content[:110]
    call = calls[0]["function"]
    got_args = call.get("arguments") or {}
    did = call["name"] + " " + json.dumps(got_args)
    if len(calls) > 1:
        did += f" (+{len(calls) - 1} more)"
    if call["name"] != expected:
        return False, did
    for key, want in args.items():
        if want.lower() not in str(got_args.get(key, "")).lower():
            return False, did
    return True, did


def run_model(model):
    print(f"\n=== {model}", flush=True)
    started = time.time()
    post("/api/generate", {"model": model, "prompt": "", "keep_alive": "10m"}, timeout=300)
    load = time.time() - started
    loaded = next((m for m in get("/api/ps")["models"] if m["name"] == model), {})
    size, vram = loaded.get("size", 0), loaded.get("size_vram", 0)
    print(f"loaded in {load:.1f}s, {size / 2**30:.2f} GB total, {vram / 2**30:.2f} GB on GPU", flush=True)

    results, times = [], []
    for text, expected, args in CASES:
        begin = time.time()
        try:
            reply = ask(model, text)
            seconds = time.time() - begin
            passed, did = judge(reply, expected, args)
        except Exception as err:  # A crash or timeout counts as a failed case.
            seconds, passed, did = time.time() - begin, False, f"ERROR {err}"
        times.append(seconds)
        results.append({"text": text, "expected": expected, "passed": passed, "did": did,
                        "seconds": round(seconds, 2)})
        print(f"{'ok  ' if passed else 'FAIL'} {seconds:5.2f}s  {text!r} -> {did}", flush=True)

    score = sum(r["passed"] for r in results)
    summary = {
        "model": model, "score": score, "total": len(CASES), "load_seconds": round(load, 1),
        "size_gb": round(size / 2**30, 2), "gpu_gb": round(vram / 2**30, 2),
        "median_seconds": round(statistics.median(times), 2), "worst_seconds": round(max(times), 2),
        "results": results,
    }
    print(f"score {score}/{len(CASES)}, median {summary['median_seconds']}s, worst {summary['worst_seconds']}s", flush=True)
    post("/api/generate", {"model": model, "prompt": "", "keep_alive": 0})
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", nargs="+")
    parser.add_argument("--out", default="results.json")
    opts = parser.parse_args()

    summaries = []
    for model in opts.models:
        try:
            summaries.append(run_model(model))
        except Exception as err:
            print(f"could not test {model}: {err}", flush=True)
        with open(opts.out, "w") as handle:
            json.dump(summaries, handle, indent=1)

    print("\nmodel                     score   median  worst   size   on GPU")
    for s in sorted(summaries, key=lambda s: (-s["score"], s["median_seconds"])):
        print(f"{s['model']:<25} {s['score']:>2}/{s['total']}  {s['median_seconds']:>5}s  "
              f"{s['worst_seconds']:>5}s  {s['size_gb']:>4}G  {s['gpu_gb']:>4}G")


if __name__ == "__main__":
    main()
