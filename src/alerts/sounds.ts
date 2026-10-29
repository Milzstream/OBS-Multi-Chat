import type { AlertSoundGroup } from './alerts'

/** Short synthesized clips, one per alert group. Notes are [frequency Hz, start s, length s]. */
const CLIPS: Record<AlertSoundGroup, { wave: 'sine' | 'triangle' | 'square' | 'sawtooth'; notes: [number, number, number][] }> = {
  follow: { wave: 'sine', notes: [[660, 0, 0.14], [880, 0.12, 0.22]] },
  sub: { wave: 'triangle', notes: [[523, 0, 0.14], [659, 0.12, 0.14], [784, 0.24, 0.3]] },
  cheer: { wave: 'square', notes: [[880, 0, 0.08], [1175, 0.08, 0.08], [1568, 0.16, 0.2]] },
  donation: { wave: 'sine', notes: [[988, 0, 0.1], [1319, 0.1, 0.4]] },
  superchat: { wave: 'triangle', notes: [[392, 0, 0.12], [587, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.35]] },
  raid: { wave: 'sawtooth', notes: [[196, 0, 0.2], [262, 0.2, 0.2], [392, 0.4, 0.45]] },
}

const SAMPLE_RATE = 22050
const urls = new Map<AlertSoundGroup, string>()

function sample(wave: string, phase: number) {
  const p = phase - Math.floor(phase)
  if (wave === 'square') return p < 0.5 ? 0.5 : -0.5
  if (wave === 'sawtooth') return (p * 2 - 1) * 0.6
  if (wave === 'triangle') return (Math.abs(p * 4 - 2) - 1) * 0.9
  return Math.sin(p * 2 * Math.PI)
}

/** Render a clip to a WAV file once. A plain audio element is routed by OBS more reliably than Web Audio. */
function clipUrl(group: AlertSoundGroup) {
  const cached = urls.get(group)
  if (cached) return cached
  const clip = CLIPS[group]
  const total = Math.ceil(Math.max(...clip.notes.map(([, start, length]) => start + length)) * SAMPLE_RATE) + 200
  const data = new Float32Array(total)
  for (const [frequency, start, length] of clip.notes) {
    const from = Math.floor(start * SAMPLE_RATE)
    const count = Math.floor(length * SAMPLE_RATE)
    for (let i = 0; i < count && from + i < total; i += 1) {
      const t = i / SAMPLE_RATE
      const envelope = Math.min(1, t / 0.015) * Math.pow(1 - i / count, 1.5)
      data[from + i] += sample(clip.wave, frequency * t) * envelope * 0.35
    }
  }
  const buffer = new ArrayBuffer(44 + total * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF')
  view.setUint32(4, 36 + total * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, total * 2, true)
  for (let i = 0; i < total; i += 1) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 32767, true)
  const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
  urls.set(group, url)
  return url
}

function playUrl(url: string) {
  try {
    const audio = new Audio(url)
    audio.volume = 1
    void audio.play().catch(() => undefined)
  } catch { /* audio is best effort */ }
}

export function playAlertSound(group: AlertSoundGroup) {
  playUrl(clipUrl(group))
}

/** Custom look audio. Same `<audio>` path OBS routes when Control audio via OBS is on. */
export function playAlertSoundUrl(url: string) {
  playUrl(url)
}
