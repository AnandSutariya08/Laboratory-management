import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Form, Input } from 'antd'
import { LockOutlined, UserOutlined, ArrowRightOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, functions, LAB_ID } from '../firebase'
import { BRAND } from '../theme'
import './login.css'

interface Values { email: string; password: string }

const FEATURES: { title: string; text: string; icon: ReactNode }[] = [
  {
    title: 'Results in minutes',
    text: 'Registration, sample tracking and approval in one smooth flow.',
    icon: <path d="M9 3h6M10 3v6L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3M7.5 14h9" />,
  },
  {
    title: 'Reports that reach patients',
    text: 'Signed PDF reports by WhatsApp, SMS and email, with a secure link.',
    icon: <path d="M4 5h16v11H8l-4 4zM8 9h8M8 12h5" />,
  },
  {
    title: 'Quality you can audit',
    text: 'Westgard QC, NABL logs and a full audit trail, built in.',
    icon: <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM9 12l2 2 4-4" />,
  },
]

// Resolve a username to its email on the server; an email passes through unchanged.
async function loginEmailFor(identifier: string): Promise<string> {
  const id = identifier.trim()
  if (id.includes('@')) return id
  try {
    const r = await httpsCallable<{ labId: string; identifier: string }, { email: string }>(functions, 'resolveLogin')({ labId: LAB_ID, identifier: id })
    return r.data.email
  } catch {
    return id // the sign-in below then fails with the generic message
  }
}

export default function LoginPage() {
  const [form] = Form.useForm<Values>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const onFinish = async ({ email, password }: Values) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await signInWithEmailAndPassword(auth, await loginEmailFor(email), password)
    } catch {
      setError('Email or password is incorrect.')
    } finally {
      setBusy(false)
    }
  }

  const forgot = async () => {
    setError('')
    setNotice('')
    const id = String(form.getFieldValue('email') ?? '').trim()
    if (!id) return setError('Enter your email or username first, then choose "Forgot password".')
    const email = await loginEmailFor(id)
    if (!email.includes('@')) return setError('We could not find that username. Ask your lab admin to reset your password.')
    try {
      await sendPasswordResetEmail(auth, email)
    } catch {
      // Same message either way, so the page never reveals which accounts exist.
    }
    setNotice('If an account exists for that login, a password reset link is on its way to the registered email.')
  }

  return (
    <main className="login">
      <section className="login__hero" aria-label={`${BRAND.name} introduction`}>
        <div className="login__orb login__orb--a" aria-hidden />
        <div className="login__orb login__orb--b" aria-hidden />

        <div className="login__brand">
          <span className="login__mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3c3 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 3-6.8 6-11z" />
              <path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" />
            </svg>
          </span>
          <span className="login__brandname">{BRAND.name}</span>
        </div>

        <div className="login__pitch">
          <h1>Lab operations,<br />beautifully simple.</h1>
          <p>Everything your lab runs on, from the front desk to the final signed report, in one secure place.</p>
          <ul className="login__features">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <span className="login__ficon" aria-hidden>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{f.icon}</svg>
                </span>
                <span>
                  <b>{f.title}</b>
                  <small>{f.text}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="login__badges">
          <span>Role-based access</span>
          <span>Encrypted</span>
          <span>Data stored in India</span>
        </div>
      </section>

      <section className="login__panel">
        <div className="login__card">
          <header className="login__head">
            <h2>Welcome back</h2>
            <p>Sign in to continue to your lab.</p>
          </header>

          {error && <Alert type="error" title={error} showIcon role="alert" className="login__alert" />}
          {notice && <Alert type="success" title={notice} showIcon role="status" className="login__alert" />}

          <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false} className="login__form">
            <Form.Item name="email" label="Email or username" rules={[{ required: true, message: 'Enter your email or username' }]}>
              <Input size="large" aria-label="Email or username" prefix={<UserOutlined aria-hidden />} autoComplete="username" autoFocus placeholder="you@lab.com" />
            </Form.Item>
            <Form.Item
              name="password"
              label={
                <span className="login__pwlabel">
                  <span>Password</span>
                  <button type="button" className="login__link" onClick={() => void forgot()}>Forgot password?</button>
                </span>
              }
              rules={[{ required: true, message: 'Enter your password' }]}
            >
              <Input.Password size="large" aria-label="Password" prefix={<LockOutlined aria-hidden />} autoComplete="current-password" placeholder="Your password" />
            </Form.Item>
            <button type="submit" className="login__submit" disabled={busy}>
              {busy ? <span className="login__spinner" aria-hidden /> : null}
              <span>{busy ? 'Signing in' : 'Sign in'}</span>
              {!busy && <ArrowRightOutlined aria-hidden />}
            </button>
          </Form>

          <div className="login__divider"><span>or</span></div>
          <Link to="/my-reports" className="login__patient">
            <span>
              <b>Are you a patient?</b>
              <small>View and download your reports</small>
            </span>
            <ArrowRightOutlined aria-hidden />
          </Link>

          <p className="login__secure">
            <SafetyCertificateOutlined aria-hidden /> Protected sign-in. Your session is private to this device.
          </p>
        </div>
        <footer className="login__foot">© {new Date().getFullYear()} {BRAND.name}</footer>
      </section>
    </main>
  )
}
