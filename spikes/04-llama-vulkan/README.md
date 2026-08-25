# Spike 4 — llama.cpp CPU vs Vulkan

**Question:** how fast does a 4B summarizer run on this machine's Vega 7 iGPU compared to
CPU-only, and does that make map-reduce summarization of a 1-hour meeting practical?

## Why the method is what it is

**The same Vulkan-capable binary is used for both runs — only `-ngl` differs** (0 layers
offloaded vs all). Comparing a separately-compiled CPU build against a Vulkan build would
confound compiler flags and kernel selection with the thing being measured. One binary, one
variable.

`llama-bench -r 3` runs each configuration three times and reports mean and standard deviation,
so a single unlucky run does not become the headline number.

## Expectation being tested

From a published Ryzen 5 5600H + Vega 7 datapoint — near-identical hardware to this machine
([llama.cpp discussion #10879](https://github.com/ggml-org/llama.cpp/discussions/10879)):

| | CPU | Vulkan | Speedup |
|---|---|---|---|
| Prompt processing | ~34 t/s | ~76 t/s | **~2.2×** |
| Token generation | ~10 t/s | ~10 t/s | **~1.0×** |

Generation is expected to be flat because it is bound by DDR4 memory bandwidth, not compute.
Offload cannot fix a bandwidth wall.

**This matters because summarization is prompt-heavy** — it reads a long transcript and writes
a short summary — so a 2× prompt speedup is worth having even with flat generation.

## Setup

```bash
# binary (33 MB) - official llama.cpp Windows Vulkan build
curl -L -o bin/llama-vulkan.zip \
  https://github.com/ggml-org/llama.cpp/releases/download/b10622/llama-b10622-bin-win-vulkan-x64.zip
cd bin && unzip -o llama-vulkan.zip && cd ..

# confirm the GPU is seen BEFORE downloading 2.5 GB of model
./bin/llama-cli.exe --list-devices
# expect: Vulkan0: AMD Radeon(TM) Graphics

# model (2.5 GB)
curl -L -C - -o models/qwen3-4b-instruct-q4_k_m.gguf \
  https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf

npm run bench
```

## Device note

`llama-cli --list-devices` on the reference machine reports:

```
Vulkan0: AMD Radeon(TM) Graphics (12191 MiB, 11581 MiB free)
```

Two things worth knowing:

- **12 GB of GPU-accessible memory**, not the 512 MB the BIOS UMA setting suggests. The Vulkan
  driver exposes shared system RAM (GTT), so a 4B Q4 model fits comfortably and an 8B would too.
- It selected the **native AMD driver**, not one of the Microsoft D3D12 mapping layers ("Dozen")
  that also appear in `vulkaninfo`. If a future driver update changes that, inference will
  silently get much slower — check this output first.

## Model provenance

The benchmark uses a `bartowski` quantization because the official Qwen repo does not publish a
Q4_K_M GGUF. That is fine for a throughput measurement, but **for shipping, model provenance
needs deciding**: either pin the exact file by SHA-256 in `models.lock.json` (the plan's
approach), or quantize from the official weights ourselves.

## Reading the result

`out/result.json`. The projection section translates raw t/s into the number that actually
matters: estimated minutes to summarize a 1-hour meeting, against the 10-minute budget in
`docs/testing.md`.
