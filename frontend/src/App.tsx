import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { apiAuthMe, apiPost, setUnauthorizedHandler, type AuthSession } from '@/api'
import { FlashApp } from '@/app/FlashApp'
import { LoginPage } from '@/pages/LoginPage'
import { InviteAcceptPage, OrgAccessPage, OrgSignupPage } from '@/pages/OrgSignupPage'

function NavigateToLogin() {
  const loc = useLocation()
  const target = loc.pathname + (loc.search || '')
  return <Navigate to="/login" replace state={{ from: target || '/' }} />
}

function HomeRoute({ authSession }: { authSession: AuthSession | null }) {
  if (authSession?.activeOrganization) return <Navigate to="/people" replace />
  if (authSession?.user) return <Navigate to="/onboarding" replace />
  return <Navigate to="/login" replace state={{ from: '/' }} />
}

export default function App() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  async function refreshSession() {
    const data = await apiAuthMe()
    setAuthSession(data.user ? (data as AuthSession) : null)
    return data.user ? (data as AuthSession) : null
  }

  async function handleSignOut() {
    await apiPost('/auth/logout')
    setAuthSession(null)
  }

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthSession(null)
    })
    return () => {
      setUnauthorizedHandler(undefined)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await apiAuthMe()
        if (!cancelled) {
          setAuthSession(data.user ? (data as AuthSession) : null)
        }
      } catch {
        if (!cancelled) setAuthSession(null)
      } finally {
        if (!cancelled) setAuthChecked(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!authChecked) {
    return (
      <div className="flex h-svh items-center justify-center bg-bg text-sm text-ink-muted">
        Loading…
      </div>
    )
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          authSession?.activeOrganization ? (
            <Navigate to="/people" replace />
          ) : (
            <LoginPage onAuthed={setAuthSession} />
          )
        }
      />
      <Route path="/" element={<HomeRoute authSession={authSession} />} />
      <Route
        path="/onboarding"
        element={
          authSession?.user ? (
            authSession.activeOrganization ? (
              <Navigate to="/people" replace />
            ) : authSession.needsOrganizationSetup ? (
              <OrgSignupPage
                user={authSession.user}
                onCreated={() => void refreshSession()}
                onSignOut={() => void handleSignOut()}
              />
            ) : (
              <OrgAccessPage user={authSession.user} onSignOut={() => void handleSignOut()} />
            )
          ) : (
            <NavigateToLogin />
          )
        }
      />
      <Route
        path="/invites/:token"
        element={
          authSession?.user ? (
            <InviteAcceptPage
              user={authSession.user}
              onAccepted={() => void refreshSession()}
              onSignOut={() => void handleSignOut()}
            />
          ) : (
            <NavigateToLogin />
          )
        }
      />
      <Route
        path="/:tab"
        element={
          authSession?.activeOrganization ? (
            <FlashApp
              authUser={authSession.user}
              activeOrganization={authSession.activeOrganization}
              setAuthSession={setAuthSession}
            />
          ) : authSession?.user ? (
            <Navigate to="/onboarding" replace />
          ) : (
            <NavigateToLogin />
          )
        }
      />
      <Route
        path="*"
        element={authSession ? <Navigate to="/people" replace /> : <NavigateToLogin />}
      />
    </Routes>
  )
}
