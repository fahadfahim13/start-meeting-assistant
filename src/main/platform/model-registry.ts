/**
 * The model registry: file, EXACT size, SHA-256, source URL, and which tier
 * needs it. Hashes were computed from verified local downloads (M-009/M-013:
 * a model is what its hash says, not what its filename claims).
 *
 * URLs are the download allowlist — the model manager fetches from these
 * hosts and nothing else (SECURITY.md T6).
 */

export type ModelId =
  | 'whisper-large-v3-turbo-q5'
  | 'silero-vad'
  | 'pyannote-segmentation'
  | '3dspeaker-embedding'
  | 'smolvlm2'
  | 'smolvlm2-mmproj'
  | 'qwen3-4b'
  | 'tesseract-eng'

export interface ModelSpec {
  file: string
  bytes: number
  sha256: string
  url: string
  /** What breaks without it — shown in the wizard. */
  purpose: string
  /** required: transcription works; recommended: full pipeline. */
  tier: 'required' | 'recommended'
}

export const MODEL_REGISTRY: Record<ModelId, ModelSpec> = {
  'whisper-large-v3-turbo-q5': {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    purpose: 'Speech-to-text transcription',
    tier: 'required',
  },
  'silero-vad': {
    file: 'ggml-silero-v5.1.2.bin',
    bytes: 885_098,
    sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
    purpose: 'Voice activity detection (skips silence)',
    tier: 'required',
  },
  'pyannote-segmentation': {
    file: 'pyannote-segmentation-3-0.onnx',
    bytes: 5_992_913,
    sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
    purpose: 'Speaker diarization (segmentation)',
    tier: 'recommended',
  },
  '3dspeaker-embedding': {
    file: '3dspeaker-eres2net-base.onnx',
    bytes: 39_593_761,
    sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
    purpose: 'Speaker diarization (voice embeddings)',
    tier: 'recommended',
  },
  smolvlm2: {
    file: 'SmolVLM2-2.2B-Instruct-Q4_K_M.gguf',
    bytes: 1_112_602_656,
    sha256: '0cf76814555b8665149075b74ab6b5c1d428ea1d3d01c1918c12012e8d7c9f58',
    url: 'https://huggingface.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF/resolve/main/SmolVLM2-2.2B-Instruct-Q4_K_M.gguf',
    purpose: 'Screen content descriptions',
    tier: 'recommended',
  },
  'smolvlm2-mmproj': {
    file: 'mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf',
    bytes: 592_523_200,
    sha256: 'ae07ea1facd07dd3230c4483b63e8cda96c6944ad2481f33d531f79e892dd024',
    url: 'https://huggingface.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf',
    purpose: 'Screen content descriptions (vision projector)',
    tier: 'recommended',
  },
  'qwen3-4b': {
    file: 'qwen3-4b-instruct-q4_k_m.gguf',
    bytes: 2_497_280_736,
    sha256: '2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e',
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    purpose: 'Meeting summaries and action items',
    tier: 'recommended',
  },
  'tesseract-eng': {
    file: 'eng.traineddata',
    bytes: 4_113_088,
    sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
    url: 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata',
    purpose: 'On-screen text extraction (OCR)',
    tier: 'recommended',
  },
}

export const ALLOWED_DOWNLOAD_HOSTS = ['huggingface.co', 'github.com', 'objects.githubusercontent.com', 'cdn-lfs.huggingface.co']
