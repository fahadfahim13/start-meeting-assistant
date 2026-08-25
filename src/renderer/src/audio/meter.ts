/** Live RMS meter for any MediaStream (mic preview). */
export interface MeterHandle {
  getLevel(): number
  stop(): void
}

export async function startMeter(stream: MediaStream): Promise<MeterHandle> {
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const timeData = new Float32Array(analyser.fftSize)

  let level = 0
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(timeData)
    let sum = 0
    for (let i = 0; i < timeData.length; i++) sum += timeData[i]! * timeData[i]!
    level = Math.sqrt(sum / timeData.length)
  }, 50)

  await ctx.resume()
  return {
    getLevel: () => level,
    stop: () => {
      clearInterval(timer)
      void ctx.close()
    },
  }
}
