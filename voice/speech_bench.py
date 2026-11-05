#!/usr/bin/env python3
"""Measure Jarvis's speech stack on this machine.

Generates spoken commands with Piper, then measures speech to text, the wake word, the
voice, and the whole chain with Ollama. Synthetic speech is good for timing. Accuracy on a
real voice needs real recordings: pass a folder of WAV files named like "en__open firefox.wav".

Usage: speech_bench.py [--recordings DIR]
"""
import argparse
import glob
import json
import os
import re
import resource
import statistics
import sys
import time
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bench"))

HOME = Path.home() / ".Jarvis"
MODELS = HOME / "models"
SAMPLES = HOME / "samples"
THREADS = 4

VOICES = {
    "en": ["en_GB-alan-medium"],
}
PHRASES = {
    "en": [
        "what time is it", "open firefox", "google the weather in Tunis", "set the volume to forty",
        "let's start coding my Luminelle project", "add dark mode to the settings page",
        "minimize firefox", "tell me a joke",
    ],
}
SPOKEN = {
    "en": ["Welcome back, sir. All systems online.", "It's nineteen forty, sir.",
           "Claude wants to run npm test. Allow it, sir?"],
}


def norm(text):
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9 ]+", " ", text).split()


def word_errors(want, got):
    """Word error rate: edits needed to turn got into want, over the words wanted."""
    a, b = norm(want), norm(got)
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (x != y))
    return row[-1] / max(1, len(a))


def to_16k(audio, rate):
    if rate == 16000:
        return audio.astype(np.float32)
    n = int(len(audio) * 16000 / rate)
    return np.interp(np.linspace(0, len(audio), n, endpoint=False), np.arange(len(audio)), audio).astype(np.float32)


def load_voice(name):
    from piper import PiperVoice
    return PiperVoice.load(str(MODELS / "piper" / f"{name}.onnx"))


def speak(voice, text):
    """Return (seconds to first audio, total seconds, audio as float, sample rate)."""
    begin = time.perf_counter()
    first, parts, rate = None, [], None
    for chunk in voice.synthesize(text):
        if first is None:
            first = time.perf_counter() - begin
        parts.append(chunk.audio_float_array)
        rate = chunk.sample_rate
    return first, time.perf_counter() - begin, np.concatenate(parts), rate


def test_voices(voices):
    print("\n=== Voice: Piper on CPU")
    print(f"{'voice':<38}{'first audio':>12}{'worst':>8}{'speed vs real time':>20}")
    SAMPLES.mkdir(parents=True, exist_ok=True)
    out = {}
    for lang, names in VOICES.items():
        for name in names:
            firsts, ratios = [], []
            clips = []
            for text in SPOKEN[lang]:
                first, total, audio, rate = speak(voices[name], text)
                firsts.append(first)
                ratios.append((len(audio) / rate) / total)
                clips.extend([audio, np.zeros(int(rate * 0.5), dtype=np.float32)])
            sf.write(SAMPLES / f"{name}.wav", np.concatenate(clips), rate)
            out[name] = {"first_ms": round(statistics.median(firsts) * 1000), "worst_ms": round(max(firsts) * 1000)}
            print(f"{name:<38}{out[name]['first_ms']:>10}ms{out[name]['worst_ms']:>6}ms{statistics.median(ratios):>18.0f}x")
    print(f"Samples to listen to: {SAMPLES}")
    return out


def make_clips(voices, recordings):
    clips = []
    for lang, names in VOICES.items():
        for name in names:
            for text in PHRASES[lang]:
                _, _, audio, rate = speak(voices[name], text)
                clips.append({"lang": lang, "text": text, "source": name, "audio": to_16k(audio, rate)})
    if recordings:
        for path in sorted(glob.glob(os.path.join(recordings, "*.wav"))):
            lang, text = Path(path).stem.split("__", 1)
            if lang == "wake":
                continue
            audio, rate = sf.read(path, dtype="float32", always_2d=True)
            clips.append({"lang": lang, "text": text, "source": "real voice", "audio": to_16k(audio.mean(axis=1), rate)})
    return clips


def parakeet():
    import sherpa_onnx
    folder = next((MODELS / "parakeet").iterdir())
    find = lambda stem: str(next(folder.glob(f"{stem}*.onnx")))
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=find("encoder"), decoder=find("decoder"), joiner=find("joiner"),
        tokens=str(folder / "tokens.txt"), num_threads=THREADS, model_type="nemo_transducer",
    )

    def run(audio):
        stream = rec.create_stream()
        stream.accept_waveform(16000, audio)
        rec.decode_stream(stream)
        return stream.result.text, getattr(stream.result, "lang", "") or None
    return run


def whisper(size):
    from faster_whisper import WhisperModel
    model = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=THREADS,
                         download_root=str(MODELS / "whisper"))

    def run(audio):
        segments, info = model.transcribe(audio, beam_size=1, vad_filter=False, without_timestamps=True)
        return " ".join(s.text.strip() for s in segments), info.language
    return run


def test_stt(clips):
    results = {}
    engines = {"parakeet-v3": parakeet, "whisper-small": lambda: whisper("small"), "whisper-base": lambda: whisper("base")}
    for name, build in engines.items():
        print(f"\n=== Speech to text: {name}", flush=True)
        begin = time.perf_counter()
        run = build()
        load = time.perf_counter() - begin
        run(np.zeros(16000, dtype=np.float32))
        rows = []
        for clip in clips:
            begin = time.perf_counter()
            text, lang = run(clip["audio"])
            seconds = time.perf_counter() - begin
            rows.append({**{k: clip[k] for k in ("lang", "text", "source")}, "heard": text.strip(), "detected": lang,
                         "seconds": seconds, "wer": word_errors(clip["text"], text),
                         "audio_seconds": len(clip["audio"]) / 16000})
        summary = {"load_seconds": round(load, 1)}
        for lang in ("en",):
            part = [r for r in rows if r["lang"] == lang]
            summary[lang] = {
                "median_ms": round(statistics.median(r["seconds"] for r in part) * 1000),
                "worst_ms": round(max(r["seconds"] for r in part) * 1000),
                "wer_percent": round(100 * statistics.mean(r["wer"] for r in part), 1),
                "language_correct": sum(r["detected"] == lang for r in part),
                "language_known": sum(r["detected"] is not None for r in part),
                "clips": len(part),
            }
            s = summary[lang]
            print(f"{lang}: median {s['median_ms']}ms, worst {s['worst_ms']}ms, word errors {s['wer_percent']}%, "
                  f"language right {s['language_correct']}/{s['clips']}")
        for r in rows:
            if r["wer"] > 0:
                print(f"  {r['source'][:22]:<23} want {r['text']!r} heard {r['heard']!r}")
        summary["rows"] = rows
        results[name] = summary
        del run
    return results


def test_wake(voices, recordings=None):
    from openwakeword.model import Model
    print("\n=== Wake word: openWakeWord 'hey jarvis'", flush=True)
    model = Model(wakeword_model_paths=[str(MODELS / "openwakeword" / "hey_jarvis_v0.1.onnx")], vad_threshold=0)
    frame = 1280

    def peak(audio):
        model.reset()
        pcm = (np.concatenate([np.zeros(16000, dtype=np.float32), audio, np.zeros(8000, dtype=np.float32)]) * 32767).astype(np.int16)
        best = 0.0
        for i in range(0, len(pcm) - frame, frame):
            best = max(best, list(model.predict(pcm[i:i + frame]).values())[0])
        return best

    yes, no = [], []
    for lang, names in VOICES.items():
        for name in names:
            _, _, audio, rate = speak(voices[name], "Hey Jarvis")
            yes.append((name, peak(to_16k(audio, rate))))
            for text in PHRASES[lang][:4]:
                _, _, audio, rate = speak(voices[name], text)
                no.append(peak(to_16k(audio, rate)))
    if recordings:
        for path in sorted(glob.glob(os.path.join(recordings, "wake__*.wav"))):
            audio, rate = sf.read(path, dtype="float32", always_2d=True)
            yes.append((f"your voice: {Path(path).stem}", peak(to_16k(audio.mean(axis=1), rate))))
    silence = np.zeros(1280, dtype=np.int16)
    model.reset()
    begin = time.perf_counter()
    for _ in range(200):
        model.predict(silence)
    per_frame = (time.perf_counter() - begin) / 200
    for name, score in yes:
        print(f"{name:<38} 'hey jarvis' score {score:.2f}")
    print(f"highest score on non-wake phrases: {max(no):.2f}")
    print(f"cost: {per_frame * 1000:.1f}ms per 80ms of audio on the CPU ({per_frame / .08 * 100:.1f}% of one thread)")
    return {"wake_scores": {n: round(s, 3) for n, s in yes}, "max_non_wake": round(float(max(no)), 3),
            "ms_per_frame": round(per_frame * 1000, 2)}


def test_chain(voices, clips, engine):
    """From the end of your speech to Jarvis's first sound, with Ollama loaded."""
    import model_bench as brain
    print(f"\n=== Whole chain with {engine} and qwen3.5:2b", flush=True)
    run = parakeet() if engine == "parakeet-v3" else whisper(engine.split("-")[1])
    model = "qwen3.5:2b"
    brain.ask(model, "hello")
    voice_for = {"en": voices[VOICES["en"][0]]}
    totals, rows = [], []
    for clip in [c for c in clips if c["source"] in (VOICES["en"][0], "real voice")]:
        t0 = time.perf_counter()
        heard, _ = run(clip["audio"])
        t1 = time.perf_counter()
        reply = brain.ask(model, heard)
        t2 = time.perf_counter()
        calls = reply["message"].get("tool_calls") or []
        words = "Right away, sir."
        if not calls:
            words = (reply["message"].get("content") or words).strip()[:160]
        first, _, _, _ = speak(voice_for[clip["lang"]], words)
        total = time.perf_counter() - t0
        totals.append(total)
        action = calls[0]["function"]["name"] if calls else "(spoke)"
        rows.append({"text": clip["text"], "stt": t1 - t0, "brain": t2 - t1, "voice": first, "total": total, "action": action})
        print(f"{total:5.2f}s = stt {t1 - t0:.2f} + brain {t2 - t1:.2f} + voice {first:.2f}  {clip['text']!r} -> {action}", flush=True)
    print(f"median {statistics.median(totals):.2f}s, worst {max(totals):.2f}s, excluding end-of-speech detection")
    return {"engine": engine, "median_seconds": round(statistics.median(totals), 2), "worst_seconds": round(max(totals), 2), "rows": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recordings")
    parser.add_argument("--skip-stt", action="store_true", help="Skip the speech-to-text comparison")
    parser.add_argument("--out", default=str(HOME / "speech_results.json"))
    opts = parser.parse_args()

    voices = {n: load_voice(n) for names in VOICES.values() for n in names}
    report = {"voices": test_voices(voices)}
    clips = make_clips(voices, opts.recordings)
    print(f"\n{len(clips)} test clips")
    if not opts.skip_stt:
        report["stt"] = test_stt(clips)
    report["wake"] = test_wake(voices, opts.recordings)
    report["chain"] = {e: test_chain(voices, clips, e) for e in ("parakeet-v3", "whisper-small")}
    report["peak_ram_gb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20, 2)
    print(f"\npeak memory of this process: {report['peak_ram_gb']} GB")
    Path(opts.out).write_text(json.dumps(report, indent=1, default=float))
    print(f"results: {opts.out}")


if __name__ == "__main__":
    main()
