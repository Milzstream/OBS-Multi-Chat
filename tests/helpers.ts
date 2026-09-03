import type { ChatMessage } from '../server/types.js'

export function chat(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'user' | 'text'>): ChatMessage {
  return {
    platform: 'YouTube',
    time: '2026-09-02T12:00:00.000Z',
    ...partial,
  }
}

export function own(name: string) {
  return new Set([name.toLowerCase()])
}
