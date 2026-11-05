#!/usr/bin/env python3
"""Jarvis's ears and mouth: wake word, speech to text and voice.

Talks to the app with one JSON object per line on stdin and stdout. Audio stays in memory
and is never saved. Muting stops the microphone process completely.

Test mode: --input-file WAV [WAV ...] plays recordings into the pipeline instead of the
microphone, and --silent skips playing sound.
"""
import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

MODELS = Path.home() / ".Jarvis" / "models"
RATE = 16000
FRAME = 1280  # 80ms, the size the wake word expects.
VOICE_RATE = 24000
VOICE_THREADS = 6  # ONNX Runtime's default was about 6x slower on this hybrid CPU.

WAKE_THRESHOLD = 0.5
SPEECH_THRESHOLD = 0.5
END_SILENCE = 0.7  # Seconds of quiet that end a command.
NUDGE_AFTER = 1.2  # Quiet this long after the wake word: Jarvis says "Yes, sir?"
GIVE_UP_AFTER = 6.0
MAX_COMMAND = 15.0
PRE_ROLL = 0.8  # Voice detection reacts late, so keep what came just before it.

COMMON = ["Yes, sir?", "Right away, sir.", "Done, sir.", "Cancelled, sir."]


def emit(kind, **fields):
    sys.stdout.write(json.dumps({"type": kind, **fields}) + "\n")
    sys.stdout.flush()


class Mouth:
    """Turns text into speech in the background, one sentence at a time, so Jarvis starts
    talking when the first sentence is ready rather than the whole reply."""

    def __init__(self, silent):
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        options = ort.SessionOptions()
        options.intra_op_num_threads = VOICE_THREADS
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        session = ort.InferenceSession(
            str(MODELS / "kokoro" / "kokoro-v1.0.onnx"), options, providers=["CPUExecutionProvider"]
        )
        self.kokoro = Kokoro.from_session(session, str(MODELS / "kokoro" / "voices-v1.0.bin"))
        # The voice the user chose: half George, half Daniel.
        self.style = self.kokoro.get_voice_style("bm_george") * 0.5 + self.kokoro.get_voice_style("bm_daniel") * 0.5
        self.silent = silent
        self.jobs = queue.Queue()
        self.generation = 0
        self.player = None
        self.lock = threading.Lock()
        self.busy = threading.Event()
        self.cache = {}
        for phrase in COMMON:
            self.cache[phrase] = self._synth(phrase)
        threading.Thread(target=self._run, daemon=True).start()

    def _synth(self, text):
        audio, _ = self.kokoro.create(text, voice=self.style, speed=1.0, lang="en-gb")
        return audio

    @staticmethod
    def sentences(text):
        parts = re.split(r"(?<=[.!?])\s+", text.strip())
        return [part for part in parts if part.strip()]

    def say(self, text, then_listen=False):
        self.busy.set()
        self.jobs.put((self.generation, text, then_listen))

    def stop(self):
        """Interrupted: drop everything queued and cut the current sound."""
        with self.lock:
            self.generation += 1
            player = self.player
        if player:
            player.terminate()
        emit("speaking", active=False)

    def _play(self, audio):
        if self.silent:
            time.sleep(min(0.05, len(audio) / VOICE_RATE))
            return
        player = subprocess.Popen(
            ["pw-play", "--raw", "--rate", str(VOICE_RATE), "--channels", "1", "--format", "f32", "-"],
            stdin=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        with self.lock:
            self.player = player
        try:
            player.stdin.write(audio.astype(np.float32).tobytes())
            player.stdin.close()
            player.wait()
        except (BrokenPipeError, ValueError):
            pass
        with self.lock:
            self.player = None

    def _run(self):
        while True:
            generation, text, then_listen = self.jobs.get()
            first = True
            begin = time.perf_counter()
            for sentence in self.sentences(text):
                if generation != self.generation:
                    break
                audio = self.cache.get(sentence)
                if audio is None:
                    try:
                        audio = self._synth(sentence)
                    except Exception as error:  # A bad sentence shouldn't kill the voice.
                        emit("error", message=f"voice: {error}")
                        continue
                if generation != self.generation:
                    break
                if first:
                    first = False
                    emit("speaking", active=True, first_audio_ms=round((time.perf_counter() - begin) * 1000))
                self._play(audio)
            if generation == self.generation:
                emit("speaking", active=False)
                if then_listen:
                    emit("follow_up")
            if self.jobs.empty():
                self.busy.clear()


class Ears:
    def __init__(self):
        import sherpa_onnx
        from openwakeword.model import Model
        from openwakeword.vad import VAD

        self.wake = Model(wakeword_model_paths=[str(MODELS / "openwakeword" / "hey_jarvis_v0.1.onnx")], vad_threshold=0)
        self.vad = VAD()
        folder = next((MODELS / "parakeet").iterdir())
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(folder / "encoder.int8.onnx"), decoder=str(folder / "decoder.int8.onnx"),
            joiner=str(folder / "joiner.int8.onnx"), tokens=str(folder / "tokens.txt"),
            num_threads=4, model_type="nemo_transducer",
        )

    def wake_score(self, frame):
        return float(list(self.wake.predict(frame).values())[0])

    def is_speech(self, frame):
        return float(self.vad.predict(frame[:960], frame_size=480)) >= SPEECH_THRESHOLD

    def reset(self):
        # The wake model keeps a window of recent audio, and a plain reset doesn't clear it.
        # Without this flush it hears the old "Hey Jarvis" again and fires by itself.
        silence = np.zeros(FRAME, dtype=np.int16)
        for _ in range(30):
            self.wake.predict(silence)
        self.wake.reset()
        self.vad.reset_states()

    def transcribe(self, frames):
        audio = np.concatenate(frames).astype(np.float32) / 32768
        # Quiet microphones made Parakeet return nothing, so level the volume and add a
        # little silence on both sides.
        audio = audio / max(float(np.abs(audio).max()), 1e-3) * 0.9
        pad = np.zeros(int(RATE * 0.4), dtype=np.float32)
        stream = self.recognizer.create_stream()
        stream.accept_waveform(RATE, np.concatenate([pad, audio, pad]))
        self.recognizer.decode_stream(stream)
        return stream.result.text.strip()


class Mic:
    """A stream of 80ms frames from the default microphone."""

    def __init__(self):
        self.process = subprocess.Popen(
            ["pw-record", "--raw", "--rate", str(RATE), "--channels", "1", "--format", "s16", "--latency", "40ms", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )

    def read(self):
        raw = self.process.stdout.read(FRAME * 2)
        if not raw or len(raw) < FRAME * 2:
            return None
        return np.frombuffer(raw, dtype=np.int16)

    def close(self):
        self.process.terminate()
        self.process.wait()


class FileMic:
    """Test stand-in that feeds recordings in as if they were spoken, in real time when asked."""

    def __init__(self, paths, realtime=False):
        import soundfile as sf

        pieces = [np.zeros(RATE, dtype=np.int16)]
        for path in paths:
            audio, rate = sf.read(path, dtype="float32", always_2d=True)
            audio = audio.mean(axis=1)
            if rate != RATE:
                audio = np.interp(np.linspace(0, len(audio), int(len(audio) * RATE / rate), endpoint=False),
                                  np.arange(len(audio)), audio)
            pieces += [(audio * 32767).astype(np.int16), np.zeros(int(RATE * 2.0), dtype=np.int16)]
        self.audio = np.concatenate(pieces)
        self.at = 0
        self.realtime = realtime

    def read(self):
        if self.at + FRAME > len(self.audio):
            return None
        frame = self.audio[self.at:self.at + FRAME]
        self.at += FRAME
        if self.realtime:
            time.sleep(0.08)
        return frame

    def close(self):
        pass


class Daemon:
    def __init__(self, opts):
        self.opts = opts
        self.commands = queue.Queue()
        self.muted = threading.Event()
        self.follow_up = threading.Event()
        self.quit = threading.Event()
        begin = time.perf_counter()
        self.mouth = Mouth(opts.silent)
        self.ears = Ears()
        emit("ready", load_seconds=round(time.perf_counter() - begin, 1))
        threading.Thread(target=self._read_commands, daemon=True).start()

    def _read_commands(self):
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = command.get("type")
            if kind == "speak":
                self.mouth.say(str(command.get("text", "")), bool(command.get("then_listen")))
            elif kind == "stop":
                self.mouth.stop()
            elif kind == "mute":
                self.muted.set()
            elif kind == "unmute":
                self.muted.clear()
            elif kind == "listen":
                self.follow_up.set()
            elif kind == "quit":
                self.quit.set()
                return
        if not self.opts.input_file:  # The app closed, so stop listening.
            self.quit.set()

    def capture_command(self, mic, heard_wake):
        """Collects speech until a pause. Returns frames, or None if nothing was said."""
        frames = []
        began = None
        last_voice = None
        elapsed_frames = 0
        nudged = not heard_wake
        while not self.quit.is_set():
            frame = mic.read()
            if frame is None:
                break
            elapsed_frames += 1
            now = elapsed_frames * FRAME / RATE
            if self.ears.is_speech(frame):
                if began is None:
                    began = now
                last_voice = now
            if began is None:
                if not nudged and now >= NUDGE_AFTER:
                    nudged = True
                    self.mouth.say("Yes, sir?")
                if now >= GIVE_UP_AFTER:
                    return None
                frames = (frames + [frame])[-int(PRE_ROLL * RATE / FRAME):]
                continue
            frames.append(frame)
            if now - last_voice >= END_SILENCE or now - began >= MAX_COMMAND:
                break
        return frames if began is not None else None

    def run(self):
        mic = None
        was_muted = None
        try:
            while not self.quit.is_set():
                muted = self.muted.is_set()
                if muted != was_muted:
                    was_muted = muted
                    if muted and mic:
                        mic.close()
                        mic = None
                    emit("mic", on=not muted)
                if muted:
                    time.sleep(0.1)
                    continue
                if mic is None:
                    mic = FileMic(self.opts.input_file, self.opts.realtime) if self.opts.input_file else Mic()
                    self.ears.reset()
                frame = mic.read()
                if frame is None:
                    if self.opts.input_file:
                        break
                    emit("error", message="The microphone stopped")
                    mic.close()
                    mic = None
                    time.sleep(1)
                    continue

                score = self.ears.wake_score(frame)
                follow_up = self.follow_up.is_set() and not self.mouth.busy.is_set()
                if score < WAKE_THRESHOLD and not follow_up:
                    continue
                if follow_up:
                    self.follow_up.clear()
                else:
                    emit("wake", score=round(score, 3))
                    self.mouth.stop()  # Talking over Jarvis interrupts him.
                self.ears.reset()
                frames = self.capture_command(mic, heard_wake=not follow_up)
                if not frames:
                    emit("heard", text="")
                    self.ears.reset()
                    continue
                listen_done = time.perf_counter()
                text = self.ears.transcribe(frames)
                emit("heard", text=text, seconds=round(len(frames) * FRAME / RATE, 2),
                     stt_ms=round((time.perf_counter() - listen_done) * 1000))
                self.ears.reset()
        finally:
            if mic:
                mic.close()
            self.mouth.stop()
        if self.opts.input_file:
            while self.mouth.busy.is_set():
                time.sleep(0.05)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-file", nargs="+")
    parser.add_argument("--realtime", action="store_true")
    parser.add_argument("--silent", action="store_true")
    opts = parser.parse_args()
    os.environ.setdefault("OMP_NUM_THREADS", str(VOICE_THREADS))
    try:
        Daemon(opts).run()
    except Exception as error:
        emit("error", message=str(error), fatal=True)
        raise


if __name__ == "__main__":
    main()
