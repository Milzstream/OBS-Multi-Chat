import type { AlertSoundGroup } from './alerts'

/** Short synthesized clips, one per alert group. Notes are [frequency Hz, start s, length s]. */
const CLIPS: Record<AlertSoundGroup, { wave: OscillatorType; notes: [number, number, number][] }> = {
  follow: { wave: 'sine', notes: [[660, 0, 0.14], [880, 0.12, 0.22]] },
  sub: { wave: 'triangle', notes: [[523, 0, 0.14], [659, 0.12, 0.14], [784, 0.24, 0.3]] },
  cheer: { wave: 'square', notes: [[880, 0, 0.08], [1175, 0.08, 0.08], [1568, 0.16, 0.2]] },
  donation: { wave: 'sine', notes: [[988, 0, 0.1], [1319, 0.1, 0.4]] },
  superchat: { wave: 'triangle', notes: [[392, 0, 0.12], [587, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.35]] },
  raid: { wave: 'sawtooth', notes: [[196, 0, 0.2], [262, 0.2, 0.2], [392, 0.4, 0.45]] },
}

let context: AudioContext | null = null

export function playAlertSound(group: AlertSoundGroup) {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    context ||= new Ctor()
    if (context.state === 'suspended') void context.resume()
    const clip = CLIPS[group]
    const start = context.currentTime + 0.02
    for (const [frequency, offset, length] of clip.notes) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = clip.wave
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start + offset)
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + length)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(start + offset)
      oscillator.stop(start + offset + length + 0.02)
    }
  } catch { /* audio is best effort */ }
}
