# Third-party notices — AbleSpeak desktop

AbleSpeak includes the following third-party software. The full text of the
Apache License 2.0 is at https://www.apache.org/licenses/LICENSE-2.0.

## sherpa-onnx (voice profiles, "only my voice")

`sherpa-onnx-node` and `sherpa-onnx-win-x64`, by the Next-gen Kaldi team.
Licensed under the Apache License 2.0. https://github.com/k2-fsa/sherpa-onnx

It runs the voice model on this computer (`src/voiceprint-worker.cjs`) and
includes ONNX Runtime (Microsoft, MIT License).

## TitaNet-small speaker model (voice profiles)

`nemo_en_titanet_small.onnx`, NVIDIA's TitaNet-S from NeMo, in the ONNX
export published by sherpa-onnx. NVIDIA's model listing says its use is
covered by the license of the NeMo Toolkit (Apache License 2.0).
https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small

Downloaded into `vendor/voice-lock/` by `npm run voice-model`, and installed
with AbleSpeak. Voiceprints made with it stay on the computer.
