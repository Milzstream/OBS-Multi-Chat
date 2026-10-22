/**
 * Non-English detection and translation provider config/parse.
 */

const NON_ENGLISH = /[\u0400-\u052F\u0600-\u06FF\u0750-\u077F\u1100-\u11FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0590-\u05FF]/

export function needsTranslation(text: string) {
  return NON_ENGLISH.test(text)
}


export type TranslateProvider = 'gtx' | 'google-v2' | 'libre'

/**
 * Choose the translation backend from env: `TRANSLATE_URL` → LibreTranslate,
 * a Google API key → official `google-v2`, and the default is the unofficial
 * `gtx` Google endpoint which needs no key at all.
 */
export function resolveTranslateConfig(env: Record<string, string | undefined> = process.env): { provider: TranslateProvider; url: string; key?: string } {
  const key = String(env.TRANSLATE_API_KEY || env.GOOGLE_TRANSLATE_API_KEY || '').trim() || undefined
  const url = String(env.TRANSLATE_URL || '').trim()
  if (url) return { provider: 'libre', url, key }
  if (key) return { provider: 'google-v2', url: 'https://translation.googleapis.com/language/translate/v2', key }
  return { provider: 'gtx', url: 'https://translate.googleapis.com/translate_a/single' }
}

/**
 * Pull the translated text from each provider's response shape: `gtx` returns
 * sentence rows, `google-v2` nests under `data.translations`, LibreTranslate
 * uses a flat `translatedText`. Returns `undefined` when translation didn't
 * change the text.
 */
export function parseTranslatedText(provider: TranslateProvider, data: any, original: string) {
  let translated = ''
  if (provider === 'gtx') translated = Array.isArray(data?.[0]) ? data[0].map((row: any) => String(row?.[0] || '')).join('').trim() : ''
  else if (provider === 'google-v2') translated = String(data?.data?.translations?.[0]?.translatedText || '').trim()
  else translated = String(data?.translatedText || data?.translation || '').trim()
  if (!translated || translated === original) return
  return translated
}

export function translateFailureMessage(provider: TranslateProvider) {
  if (provider === 'google-v2') return 'Chat translation failed (Google Translate API). Check TRANSLATE_API_KEY.'
  if (provider === 'libre') return 'Chat translation failed (TRANSLATE_URL). Messages stay untranslated.'
  return 'Chat translation failed (unofficial Google endpoint). Set TRANSLATE_API_KEY or TRANSLATE_URL, or turn translation off.'
}

