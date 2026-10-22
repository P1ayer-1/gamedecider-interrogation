# Licences and attributions

## Code
The game code in this repository (HTML, JS) is released under the MIT License (see LICENSE).

## Third-party software
- **ONNX Runtime Web 1.30.0** (`vendor/onnxruntime-web/`), © Microsoft Corporation, MIT License. Its LICENSE and
  ThirdPartyNotices are included in that folder.

## Model
- Base model: **answerdotai/ModernBERT-base** (revision `8949b909ec900327062f0ebf497f51aef5e6f0c8`), Apache License
  2.0. The fine-tuned weights in `model/` are a derivative work, distributed under the Apache License 2.0.
- Fine-tuning data: synthetic, generated and labelled with open-weight models (GLM-5.3-Flash, DeepSeek-V4.1-Flash)
  through providers whose terms permit training on outputs, plus recast examples from these public datasets (used under
  their licences; listed with attribution):
  - MASSIVE, Amazon Science (CC BY 4.0), https://huggingface.co/datasets/AmazonScience/massive
  - Banking77, PolyAI (CC BY 4.0), https://huggingface.co/datasets/PolyAI/banking77
  - Civil Comments, Google / Jigsaw (CC0 1.0), https://huggingface.co/datasets/google/civil_comments
  - GoEmotions, Google Research (Apache 2.0), https://huggingface.co/datasets/google-research-datasets/go_emotions
  - ProsocialDialog, AllenAI (CC BY 4.0), https://huggingface.co/datasets/allenai/prosocial-dialog
  - prompt-injections, deepset (Apache 2.0), https://huggingface.co/datasets/deepset/prompt-injections
  - NLU-Evaluation-Data / HWU64, X. Liu et al. (CC BY 4.0), https://github.com/xliuhw/NLU-Evaluation-Data
  - SNIPS NLU benchmark, Sonos (CC0 1.0), https://github.com/sonos/nlu-benchmark
  - SNIPS built-in intents, Sonos (CC0 1.0), https://huggingface.co/datasets/sonos-nlu-benchmark/snips_built_in_intents
  - CaSiNo, K. Chawla et al. (CC BY 4.0), https://huggingface.co/datasets/kchawla123/casino
  - HateCheck, P. Röttger et al. (CC BY 4.0), https://huggingface.co/datasets/Paul/hatecheck
  - Taskmaster-2, Google Research (CC BY 4.0), https://github.com/google-research-datasets/Taskmaster
  - CLINC150, Larson et al. (CC BY 3.0), https://huggingface.co/datasets/clinc/clinc_oos
  - MultiDoGO, Amazon (CDLA-Permissive-1.0), https://github.com/awslabs/multi-domain-goal-oriented-dialogues-dataset
