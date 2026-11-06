"""Compares local models on general knowledge: right answers and real waiting time.
Usage: python3 bench/deep_model.py qwen3.5:2b qwen3.5:9b  (add :cpu to force the processor)"""
import json
import re
import sys
import time
import urllib.request

SYSTEM = "You are Jarvis, a calm English butler. Answer in one or two short plain sentences. Call him sir. If you don't know, say so."
CASES = [
    ("who painted the Mona Lisa", "vinci"), ("how old was Leonardo da Vinci when he died", "67"),
    ("what is the capital of Australia", "canberra"), ("what is the chemical symbol for gold", "au"),
    ("who wrote Crime and Punishment", "dostoevsk"), ("what is the boiling point of water in fahrenheit", "212"),
    ("how many bones are in the adult human body", "206"), ("what year did the Berlin Wall fall", "1989"),
    ("what planet has the most moons known", "saturn"), ("what is the square root of 144", "12"),
    ("who discovered penicillin", "fleming"), ("what is the largest ocean", "pacific"),
    ("what does HTTP stand for", "hypertext"), ("what language is spoken in Brazil", "portuguese"),
    ("what is the speed of light in km per second", "299|300000"), ("who was the first person on the moon", "armstrong"),
    ("in what country is Timbuktu", "mali"), ("what gas do plants absorb", "carbon dioxide"),
    ("what is the smallest prime number", "2"), ("who wrote the Odyssey", "homer"),
]

def ask(model, cpu, question):
    options = {"temperature": 0.1, "num_ctx": 4096, "num_predict": 120}
    if cpu:
        options["num_gpu"] = 0
    body = {"model": model, "stream": False, "think": False, "keep_alive": -1, "options": options,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}]}
    request = urllib.request.Request("http://localhost:11434/api/chat", json.dumps(body).encode())
    begin = time.time()
    with urllib.request.urlopen(request, timeout=300) as response:
        data = json.load(response)
    return data["message"]["content"].strip(), time.time() - begin

# Harder: needs some reasoning, or knowing something less common.
CASES += [
    ("a bat and a ball cost 1.10 in total and the bat costs 1.00 more than the ball. How much is the ball", "0.05"),
    ("if I have 3 apples and eat one then buy 4 more how many do I have", "6|six"),
    ("how many letter r are in the word strawberry", "3|three"),
    ("which is heavier, a kilo of feathers or a kilo of steel", "same|both|exactly one"),
    ("what is the capital of Kazakhstan", "astana"),
    ("who won the first FIFA World Cup", "uruguay"),
    ("what does the Linux command chmod 755 give the owner", "execute"),
    ("what is the time complexity of binary search", "log"),
    ("what causes the tides", "moon"),
    ("what is the difference between TCP and UDP in one sentence", "connection|reliab"),
    ("which element has atomic number 79", "gold"),
    ("who wrote One Hundred Years of Solitude", "garc"),
    ("what is the largest desert in the world", "antarctic"),
    ("if today is Friday what day is it in 10 days", "monday"),
    ("what is 17 times 23", "391|three hundred ninety-one"),
    ("what is the main ingredient of hummus", "chickpea"),
    ("in Python what does len return for an empty list", "0|zero"),
    ("what is the tallest mountain measured from base to peak", "mauna"),
    ("what vitamin does sunlight help produce", "d"),
    ("who painted The Starry Night", "gogh"),
]

for spec in sys.argv[1:]:
    model, _, mode = spec.partition("@")
    cpu = mode == "cpu"
    _, load = ask(model, cpu, "hello")
    right, times, wrong = 0, [], []
    for question, key in CASES:
        answer, took = ask(model, cpu, question)
        ok = re.search(key, answer.lower().replace(",", "")) is not None
        right += ok
        times.append(took)
        if not ok:
            wrong.append(f"    {question} -> {answer[:90]}")
    times.sort()
    print(f"{spec}: {right}/{len(CASES)} right, first load {load:.1f}s, median {times[len(times) // 2]:.1f}s, worst {times[-1]:.1f}s")
    print("\n".join(wrong))
