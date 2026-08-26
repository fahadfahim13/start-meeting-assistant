// Standalone sherpa-onnx diarization check, plain Node.
// Windows: the native DLLs live in sherpa-onnx-win-x64 and must be on PATH
// before the addon loads (per sherpa's nodejs-addon-examples README).
const path = require('path')
process.env.PATH = path.join(__dirname, '..', '..', 'node_modules', 'sherpa-onnx-win-x64') + ';' + process.env.PATH

const sherpa = require('sherpa-onnx-node')
const models = path.join(process.env.APPDATA, 'meetfroge', 'models')

const config = {
  segmentation: {
    pyannote: { model: path.join(models, 'pyannote-segmentation-3-0.onnx') },
  },
  embedding: { model: path.join(models, '3dspeaker-eres2net-base.onnx') },
  clustering: { numClusters: -1, threshold: 0.5 },
  minDurationOn: 0.3,
  minDurationOff: 0.5,
}

const sd = new sherpa.OfflineSpeakerDiarization(config)
console.log('sample rate expected:', sd.sampleRate)

const wave = sherpa.readWave(process.argv[2])
console.log('wave:', wave.samples.length, 'samples @', wave.sampleRate)

const t0 = Date.now()
const segments = sd.process(wave.samples)
console.log(`diarized in ${Date.now() - t0} ms`)
console.log(JSON.stringify(segments, null, 2))
