import { useState } from 'react'
import { Alert, Form, Input } from 'antd'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '../firebase'
import { Glass } from '../design/Glass'
import { Button } from '../design/Button'
import { BRAND } from '../theme'

export default function LoginPage() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onFinish = async ({ email, password }: { email: string; password: string }) => {
    setBusy(true)
    setError('')
    try {
      await signInWithEmailAndPassword(auth, email, password)
    } catch {
      setError('Email or password is incorrect.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      {/* Same ambient wash as the app shell; the sign-in panel is large glass over it. */}
      <div className="ambient" aria-hidden />
      <Glass variant="large" style={{ width: 'min(380px, 100%)', padding: 28 }}>
        <h1 style={{ color: 'var(--c-primary)', margin: '0 0 var(--s-1)', fontSize: 'var(--fs-title)', fontWeight: 600 }}>{BRAND.name}</h1>
        <p style={{ color: 'var(--c-on-surface-variant)', margin: '0 0 var(--s-4)' }}>Sign in to the lab portal</p>
        {error && <Alert type="error" title={error} style={{ marginBottom: 16 }} showIcon role="alert" />}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button variant="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </Form>
      </Glass>
    </main>
  )
}
