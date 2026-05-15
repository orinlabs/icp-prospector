import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiPost, type AuthSession, type AuthUser, type Organization } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type OrgSignupPageProps = {
  user: AuthUser
  onCreated: (organization: Organization) => void
  onSignOut: () => void
}

function domainFromEmail(email: string): string {
  const parts = email.trim().toLowerCase().split('@')
  return parts.length === 2 ? parts[1] : ''
}

export function OrgSignupPage({ user, onCreated, onSignOut }: OrgSignupPageProps) {
  const emailDomain = useMemo(() => domainFromEmail(user.email), [user.email])
  const [name, setName] = useState('')
  const [domain, setDomain] = useState(emailDomain)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const data = await apiPost<{ organization: Organization }>('/organizations', {
        name: name.trim(),
        emailDomain: domain.trim()
      })
      onCreated(data.organization)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create organization')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-bg px-4 text-ink">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Set up your organization</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Your organization domain controls who can be invited and sign in. It must match your
          email domain.
        </p>

        {error ? (
          <p className="mt-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="org-name">Organization name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Company, Inc."
              required
              disabled={loading}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-domain">Email domain</Label>
            <Input
              id="org-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={emailDomain || 'company.com'}
              required
              disabled={loading}
            />
            <p className="text-xs text-ink-muted">Signed in as {user.email}</p>
          </div>
          <Button type="submit" className="w-full" disabled={loading || !name.trim() || !domain.trim()}>
            {loading ? 'Creating...' : 'Create organization'}
          </Button>
        </form>

        <Button type="button" variant="ghost" className="mt-3 w-full text-ink-muted" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  )
}

export function OrgAccessPage({
  user,
  onSignOut
}: {
  user: AuthSession['user']
  onSignOut: () => void
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-bg px-4 text-ink">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Organization access required</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          You are signed in as {user.email}, but this account is not an active member of an
          organization yet. Ask an admin to invite you, or create your organization if this domain is
          not already claimed.
        </p>
        <Button type="button" className="mt-6 w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  )
}

export function InviteAcceptPage({
  user,
  onAccepted,
  onSignOut
}: {
  user: AuthSession['user']
  onAccepted: () => void
  onSignOut: () => void
}) {
  const { token } = useParams<{ token: string }>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAccept() {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      await apiPost('/organizations/invites/' + token + '/accept')
      onAccepted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept invite')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-bg px-4 text-ink">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Accept organization invite</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          You are signed in as {user.email}. Accept this invite to join the organization.
        </p>
        {error ? (
          <p className="mt-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        ) : null}
        <Button type="button" className="mt-6 w-full" disabled={loading || !token} onClick={handleAccept}>
          {loading ? 'Accepting...' : 'Accept invite'}
        </Button>
        <Button type="button" variant="ghost" className="mt-3 w-full text-ink-muted" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  )
}
