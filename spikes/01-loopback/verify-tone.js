const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
const view = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength/2);
const SR = 48000, CH = 2;
// take a 1s window from the middle (tone is definitely playing there)
const frames = view.length / CH;
const start = Math.floor(frames*0.45), N = SR;
const x = new Float64Array(N);
for (let i=0;i<N;i++) x[i] = view[(start+i)*CH]/32768; // left channel

// Goertzel: energy at a target frequency
function goertzel(x, f, sr) {
  const k = 2*Math.cos(2*Math.PI*f/sr);
  let s0=0,s1=0,s2=0;
  for (let i=0;i<x.length;i++){ s0 = x[i] + k*s1 - s2; s2=s1; s1=s0; }
  return Math.sqrt(s1*s1 + s2*s2 - k*s1*s2)/x.length;
}
const probes = [110,220,330,440,550,660,770,880,1000,1320,2000,4000];
console.log('freq(Hz)  magnitude');
let results = probes.map(f => ({f, m: goertzel(x, f, SR)}));
const max = Math.max(...results.map(r=>r.m));
for (const {f,m} of results) {
  const bar = '#'.repeat(Math.round(m/max*40));
  console.log(String(f).padStart(7), ' ', m.toExponential(3), bar);
}
const e440 = results.find(r=>r.f===440).m, e660 = results.find(r=>r.f===660).m;
const others = results.filter(r=>r.f!==440 && r.f!==660).map(r=>r.m);
const noiseFloor = others.reduce((a,b)=>a+b,0)/others.length;
console.log('\n440 Hz / noise floor :', (e440/noiseFloor).toFixed(1)+'x');
console.log('660 Hz / noise floor :', (e660/noiseFloor).toFixed(1)+'x');
console.log(e440/noiseFloor > 10 && e660/noiseFloor > 10
  ? '\nVERIFIED: captured audio contains the 440 Hz + 660 Hz test tone.'
  : '\nNOT VERIFIED: tone not dominant.');
