# The Interrogation: a GameDecider browser demo

A small detective game in which the suspect NPC's reactions are decided by **GameDecider**, a compact on-device
decision model for games. It runs **entirely in your browser** with ONNX Runtime Web: WebGPU when available, WASM
otherwise. There is no server and no cloud AI, and nothing you type leaves your machine.

Each turn, GameDecider answers several structured questions about what you just said, for example:
- does it **contradict** her statements?
- how strong is the **persuasion**?
- what is your **attitude**?
- is it a **threat**?
- is it a **jailbreak or meta attempt**?
- is the **conversation ending**?

A guard also checks that her reply doesn't **leak her secret**. The game turns those decisions into her composure,
her cooperation and her lines. The side panel shows each decision, its confidence and the model time.

## Play
- Open the page in a recent Chrome or Edge (WebGPU). Other browsers fall back to WASM, which is slower.
- The first visit downloads about **330 MB** (the model is about 300 MB). The browser caches it afterwards.
- The first turn is slow while GPU shaders compile. After that a turn takes about 0.5 s on a laptop RTX 3080 with
  WebGPU, or about 3 s on WASM.
- Tips: catch her in a contradiction ("You said X, but Y"), make an appeal that matters to her, try a threat, or
  try a jailbreak and watch her stay in character.

## Run locally
```
python -m http.server 8000
```
Then open http://localhost:8000. Pages must be served over http(s); `file://` won't work.

## Model
- A ModernBERT-base encoder (150M parameters) fine-tuned for game decision questions, exported to ONNX (weights
  stored in fp16, computed in fp32), and split into 24 MiB parts.
- It is a research prototype: it makes mistakes, especially on unusual phrasings.

See [NOTICE.md](NOTICE.md) for licences and attributions.
