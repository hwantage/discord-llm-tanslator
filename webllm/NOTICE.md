# Third-party components

- WebLLM 0.2.85, MLC runtime, Web Tokenizers, Web XGrammar and the compiled
  WebGPU model libraries: Apache License 2.0. See `licenses/APACHE-2.0.txt`.
  Upstream: https://github.com/mlc-ai/web-llm and https://github.com/mlc-ai/mlc-llm.
- loglevel: MIT License. See `licenses/LOGLEVEL-MIT.txt`.
- Default model Qwen2.5-7B-Instruct: Apache License 2.0. The MLC project converted the
  original model to `q4f16_1`; this extension does not modify those weights.
  Original: https://huggingface.co/Qwen/Qwen2.5-7B-Instruct.
  Converted model: https://huggingface.co/mlc-ai/Qwen2.5-7B-Instruct-q4f16_1-MLC.

WebLLM 0.2.85 maps the Qwen2.5 weights to the shared model library named
`Qwen2-7B-Instruct-q4f16_1_cs1k-webgpu.wasm`. This extension follows that
upstream mapping; the model weights and tokenizer are Qwen2.5-7B-Instruct.

The catalog includes 159 text-generating entries from WebLLM's official `config.ts`
at commit `5f742443179a5463e83a19f704d7c19f1f019f98`, matching WebLLM 0.2.85.
The four embedding-only entries and their dedicated library metadata are excluded.
Model weights and tokenizers are not bundled. They are downloaded only for a
model the user selects and are cached in the extension's browser storage.
Each model has its own license and terms; the settings page links to the model
repository through the catalog's `repositoryUrl`. The default model's Apache
license does not describe the terms of every selectable model.

The common JavaScript runtime and model metadata are packaged inside the
extension. Model-specific WASM libraries are not bundled. Only a selected model's
required library is downloaded from the pinned MLC GitHub repository, verified
with SHA-256, and cached. Execution takes place in a sandboxed page without
extension APIs or network access. The packaged host provides only allowlisted
model artifacts and inference commands through a MessagePort.

`catalog.json` pins each model revision and each WASM revision, size and SHA-256
checksum. `model.json` retains the default model's existing metadata for cache
and test compatibility.
