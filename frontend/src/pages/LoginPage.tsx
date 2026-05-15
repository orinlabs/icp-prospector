import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { apiPost, type AuthSession } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface LoginPageProps {
  onAuthed: (session: AuthSession) => void
}

export function LoginPage({ onAuthed }: LoginPageProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await apiPost('/auth/request-code', { email: email.trim() })
      setStep('code')
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send code')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const trimmed = email.trim()
      const data = await apiPost<AuthSession>('/auth/verify-code', {
        email: trimmed,
        code: code.trim()
      })
      onAuthed(data)
      const raw = (location.state as { from?: string } | null)?.from
      const dest =
        data.needsOrganizationSetup || !data.activeOrganization
          ? '/onboarding'
          : raw && raw.startsWith('/') && !raw.startsWith('/login')
            ? raw
            : '/people'
      navigate(dest, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-bg px-4 text-ink">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Sign in to Flash</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Use your work email. Flash will email you a one-time code and match access to your
          organization domain.
        </p>

        {error ? (
          <p className="mt-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        ) : null}

        {step === 'email' ? (
          <form className="mt-6 space-y-4" onSubmit={handleRequestCode}>
            <div className="space-y-2">
              <Label htmlFor="login-email">Work email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Sending…' : 'Email me a code'}
            </Button>
          </form>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={handleVerify}>
            <p className="text-sm text-ink-muted">
              Code sent to <span className="font-medium text-ink">{email.trim()}</span>
            </p>
            <div className="space-y-2">
              <Label htmlFor="login-code">6-digit code</Label>
              <Input
                id="login-code"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                variant="mono"
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
                disabled={loading}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Button type="submit" className="w-full" disabled={loading || code.length !== 6}>
                {loading ? 'Verifying…' : 'Sign in'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full text-ink-muted"
                disabled={loading}
                onClick={() => {
                  setStep('email')
                  setCode('')
                  setError(null)
                }}
              >
                Use a different email
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
