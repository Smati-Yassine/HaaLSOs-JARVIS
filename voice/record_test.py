#!/usr/bin/env python3
"""Record your own voice for Jarvis's accuracy test.

Shows one phrase at a time. Press Enter to start speaking and Enter again to stop.
Recordings stay on this computer in ~/.Jarvis/recordings. Type s to skip, q to quit.
Run it again at any time: phrases already recorded are skipped.
"""
import subprocess
from pathlib import Path

OUT = Path.home() / ".Jarvis" / "recordings"

PHRASES = [
    ("wake", "1", "Hey Jarvis"),
    ("wake", "2", "Hey Jarvis"),
    ("wake", "3", "Hey Jarvis"),
    ("wake", "4", "Hey Jarvis (a bit quieter)"),
    ("wake", "5", "Hey Jarvis (from a little further away)"),
    ("en", "what time is it", "What time is it?"),
    ("en", "open firefox", "Open Firefox"),
    ("en", "google the weather in Tunis", "Google the weather in Tunis"),
    ("en", "set the volume to forty", "Set the volume to forty"),
    ("en", "let's start coding my Luminelle project", "Let's start coding my Luminelle project"),
    ("en", "add dark mode to the settings page", "Add dark mode to the settings page"),
    ("en", "minimize firefox", "Minimize Firefox"),
    ("en", "tell me a joke", "Tell me a joke"),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print(__doc__)
    default = subprocess.run(["wpctl", "inspect", "@DEFAULT_AUDIO_SOURCE@"], capture_output=True, text=True).stdout
    name = next((line.split('"')[1] for line in default.splitlines() if "node.description" in line), "unknown")
    print(f"Microphone: {name}\nIf that's not your headset, change it in Settings > Sound first.\n")

    total = len(PHRASES)
    for number, (lang, key, shown) in enumerate(PHRASES, 1):
        path = OUT / f"{lang}__{key}.wav"
        if path.exists():
            continue
        answer = input(f"[{number}/{total}] Say: {shown}\n  Enter to start > ").strip().lower()
        if answer == "q":
            break
        if answer == "s":
            continue
        recorder = subprocess.Popen(["pw-record", "--rate", "16000", "--channels", "1", str(path)])
        input("  Recording... Enter to stop > ")
        recorder.terminate()
        recorder.wait()
    print(f"\nDone. Recordings: {OUT}\nTell Claude they're ready.")


if __name__ == "__main__":
    main()
