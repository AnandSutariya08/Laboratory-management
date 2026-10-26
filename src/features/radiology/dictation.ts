import { useCallback, useEffect, useRef, useState } from 'react'

// Dictation (RAD-19) through the browser's Web Speech API. Nothing is recorded or uploaded by the app;
// supported browsers are Chrome, Edge and Safari. `supported` is false elsewhere.
interface Rec {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
type Ctor = new () => Rec

const ctor = (): Ctor | null => {
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const DICTATION_LANGS = [
  { value: 'en-IN', label: 'English (India)' }, { value: 'en-GB', label: 'English (UK)' }, { value: 'en-US', label: 'English (US)' }, { value: 'hi-IN', label: 'Hindi' },
]

// onText gets each finished phrase. Spoken punctuation ("full stop", "new line") is turned into marks.
export function useDictation(onText: (text: string) => void, lang = 'en-IN') {
  const supported = typeof window !== 'undefined' && !!ctor()
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  const rec = useRef<Rec | null>(null)
  const cb = useRef(onText)
  cb.current = onText

  const stop = useCallback(() => {
    rec.current?.stop()
    setListening(false)
  }, [])
  const start = useCallback(() => {
    const C = ctor()
    if (!C) return setError('Dictation is not supported in this browser. Use Chrome, Edge or Safari.')
    setError('')
    const r = new C()
    r.lang = lang
    r.continuous = true
    r.interimResults = false
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue
        const t = e.results[i][0].transcript
          .replace(/\s*\bfull stop\b/gi, '.').replace(/\s*\bcomma\b/gi, ',').replace(/\s*\bnew (line|paragraph)\b\s*/gi, '\n')
          .trim()
        if (t) cb.current(`${t} `)
      }
    }
    r.onerror = (e) => {
      setError(e.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in the browser address bar and try again.' : e.error === 'no-speech' ? '' : `Dictation stopped: ${e.error}`)
      setListening(false)
    }
    r.onend = () => setListening(false)
    rec.current = r
    try {
      r.start()
      setListening(true)
    } catch {
      setError('Dictation could not start. Try again.')
    }
  }, [lang])
  useEffect(() => () => rec.current?.stop(), [])
  return { supported, listening, error, start, stop }
}
