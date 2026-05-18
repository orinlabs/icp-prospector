import {
  ChevronRight,
  ExternalLink,
  Info,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'

import { apiPatch, apiPost, type DraftDetail, type SentEmailRow } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { StatusDot } from '@/components/ui/status-dot'
import { Textarea } from '@/components/ui/textarea'
import { formatRelative } from '@/lib/format'
import { formatFromHeader } from '@/lib/outgoingEmail'
import { cn } from '@/lib/utils'

const QUICK_NOTES = [
  'Shorter — keep it to ~80 words.',
  'Open with a more specific hook tied to their company.',
  'Drop the hard pitch — make it a curious, low-pressure ask.',
  'Sound more human, less marketing.',
  'Wrong angle — this isn’t the right pain point for them.'
]

export type DraftDetailPanelHandle = {
  approve: () => Promise<void>
  discard: () => Promise<void>
  focusRegenerate: () => void
}

interface Props {
  detail: DraftDetail
  railOpen: boolean
  onToggleRail: () => void
  onChanged: () => void
  onError: (msg: string | null) => void
}

export const DraftDetailPanel = forwardRef<DraftDetailPanelHandle, Props>(function DraftDetailPanel(
  { detail, railOpen, onToggleRail, onChanged, onError },
  ref
) {
  const { draft, company, mailbox, person, strategy, sentEmails } = detail
  const isPending = draft.status === 'pending_review'
  const isFailed = draft.status === 'failed'

  const [toEmail, setToEmail] = useState(draft.toEmail)
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [reviewNotes, setReviewNotes] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [approving, setApproving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [saveInstAccount, setSaveInstAccount] = useState(false)
  const [saveInstMailbox, setSaveInstMailbox] = useState(false)

  const notesRef = useRef<HTMLTextAreaElement | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setToEmail(draft.toEmail)
    setSubject(draft.subject)
    setBody(draft.body)
    setReviewNotes('')
    setSaveInstAccount(false)
    setSaveInstMailbox(false)
  }, [draft.id, draft.toEmail, draft.subject, draft.body])

  const dirty =
    toEmail !== draft.toEmail || subject !== draft.subject || body !== draft.body

  const fromHeader = mailbox?.email
    ? formatFromHeader(mailbox.email, mailbox.displayName)
    : '(no mailbox assigned)'

  async function saveEdits() {
    if (!dirty) return true
    setSavingEdit(true)
    onError(null)
    try {
      await apiPatch('/drafts/' + draft.id, { toEmail, subject, body })
      onChanged()
      return true
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed')
      return false
    } finally {
      setSavingEdit(false)
    }
  }

  async function approve() {
    if (!isPending && !isFailed) return
    if (dirty) {
      const saved = await saveEdits()
      if (!saved) return
    }
    setApproving(true)
    onError(null)
    try {
      await apiPost('/drafts/' + draft.id + '/approve')
      onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setApproving(false)
    }
  }

  async function discard() {
    if (!isPending) return
    if (!confirm('Discard this draft?')) return
    setDiscarding(true)
    onError(null)
    try {
      const res = await apiPost<{ instructionAppend?: { error?: string } }>(
        '/drafts/' + draft.id + '/discard',
        {
          reviewNotes: reviewNotes || undefined,
          saveInstructionsToAccount: saveInstAccount,
          saveInstructionsToMailbox: saveInstMailbox
        }
      )
      if (res.instructionAppend?.error) {
        onError('Could not save standing instructions: ' + res.instructionAppend.error)
      }
      onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Discard failed')
    } finally {
      setDiscarding(false)
    }
  }

  async function regenerate() {
    if (!isPending) return
    if (!reviewNotes.trim()) {
      notesRef.current?.focus()
      onError('Add notes describing what to change, then click Regenerate.')
      return
    }
    setRegenerating(true)
    onError(null)
    try {
      const res = await apiPost<{
        ok?: boolean
        instructionAppend?: { error?: string }
      }>('/drafts/' + draft.id + '/regenerate', {
        reviewNotes,
        saveInstructionsToAccount: saveInstAccount,
        saveInstructionsToMailbox: saveInstMailbox
      })
      if (res.instructionAppend?.error) {
        onError('Could not save standing instructions: ' + res.instructionAppend.error)
      }
      onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Regenerate failed')
    } finally {
      setRegenerating(false)
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      approve,
      discard,
      focusRegenerate: () => notesRef.current?.focus()
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [approve, discard]
  )

  function appendQuickNote(text: string) {
    setReviewNotes((current) => {
      const trimmed = current.trim()
      if (!trimmed) return text
      if (trimmed.includes(text)) return current
      return trimmed + '\n' + text
    })
    notesRef.current?.focus()
  }

  const sentCount = sentEmails.length
  const wordCount = useMemo(
    () => body.trim().split(/\s+/).filter(Boolean).length,
    [body]
  )
  const statusLabel = formatRelative(draft.createdAt)

  const personLine = person?.fullName
    ? person.fullName + (person.title ? ' · ' + person.title : '')
    : null

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Sticky action bar */}
        <div className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
          <div className="flex items-start justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-ink">
                  {company?.name ?? '(unknown company)'}
                </span>
                <StatusDot status={draft.status} size="sm" />
                {draft.gmailMessageId ? (
                  <a
                    href={'https://mail.google.com/mail/u/0/#sent/' + draft.gmailMessageId}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-2xs text-ink-muted underline-offset-4 hover:text-accent hover:underline"
                  >
                    Open in Gmail <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </div>
              <div className="mt-0.5 truncate text-xs text-ink-muted">
                {personLine ? personLine + ' · ' : ''}
                {draft.toEmail}
                {statusLabel ? ' · drafted ' + statusLabel : ''}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {isPending ? (
                <>
                  <Button
                    variant="outline"
                    size="md"
                    iconLeft={X}
                    loading={discarding}
                    onClick={discard}
                  >
                    Discard
                  </Button>
                  <Button
                    variant="outline"
                    size="md"
                    iconLeft={RefreshCw}
                    loading={regenerating}
                    onClick={regenerate}
                    disabled={!reviewNotes.trim()}
                    title={
                      reviewNotes.trim()
                        ? 'Regenerate using your notes'
                        : 'Add notes below first'
                    }
                  >
                    Regenerate
                  </Button>
                  <Button
                    variant="primary"
                    size="md"
                    iconLeft={Send}
                    loading={approving || savingEdit}
                    onClick={approve}
                  >
                    {dirty ? 'Save & send' : 'Approve & send'}
                  </Button>
                </>
              ) : isFailed ? (
                <Button
                  variant="primary"
                  size="md"
                  iconLeft={Send}
                  loading={approving}
                  onClick={approve}
                >
                  Retry send
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={railOpen ? 'Hide context' : 'Show context'}
                onClick={onToggleRail}
                title={railOpen ? 'Hide context' : 'Show context'}
              >
                {railOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            </div>
          </div>

          {isPending ? (
            <div className="flex items-center gap-3 border-t border-line/60 bg-surface-muted/40 px-5 py-1.5 text-2xs text-ink-faint">
              <span className="inline-flex items-center gap-1">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
                <span>send</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>R</Kbd> <span>regenerate</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>D</Kbd> <span>discard</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>J</Kbd>/<Kbd>K</Kbd> <span>next · prev</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>[</Kbd> <span>toggle context</span>
              </span>
              {dirty ? (
                <span className="ml-auto inline-flex items-center gap-1 text-accent">
                  <span className="size-1.5 rounded-full bg-accent" />
                  Unsaved edits — will save on send
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Scrollable content */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[760px] space-y-5 px-5 py-5">
            {/* Agent rationale callout */}
            {draft.agentRationale ? (
              <section className="rounded-lg border border-accent/20 bg-accent-soft/40 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-accent">
                  <Sparkles className="size-3" />
                  Why the agent drafted this
                </div>
                <p className="whitespace-pre-wrap text-sm text-ink">
                  {draft.agentRationale}
                </p>
              </section>
            ) : null}

            {/* The email — unified inline-editable canvas */}
            <section
              className={cn(
                'overflow-hidden rounded-lg border bg-surface shadow-sm',
                isPending ? 'border-line' : 'border-line/70'
              )}
            >
              <div className="border-b border-line/70 bg-surface-muted/40 px-4 py-2">
                <div className="flex items-center justify-between gap-2 text-2xs text-ink-faint">
                  <span className="font-medium uppercase tracking-wide">
                    Outgoing email
                  </span>
                  <span>
                    {isPending
                      ? 'Edit any field — the recipient sees exactly this.'
                      : 'Read-only — this draft is ' + draft.status.replace(/_/g, ' ') + '.'}
                  </span>
                </div>
              </div>

              <HeaderRow label="From" value={fromHeader} />
              <HeaderEditableRow
                label="To"
                value={toEmail}
                onChange={setToEmail}
                disabled={!isPending}
                placeholder="recipient@example.com"
                type="email"
              />
              <HeaderEditableRow
                label="Subject"
                value={subject}
                onChange={setSubject}
                disabled={!isPending}
                placeholder="Subject line"
                emphasized
              />

              <div className="px-4 py-4">
                <Textarea
                  ref={bodyRef}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={!isPending}
                  className={cn(
                    'min-h-[260px] resize-y border-0 bg-transparent px-0 py-0 text-[14px] leading-[22px] text-ink shadow-none',
                    'focus-visible:ring-0 disabled:opacity-100'
                  )}
                  placeholder="Email body…"
                />

                {mailbox?.signature?.trim() ? (
                  <div className="mt-4 border-t border-dashed border-line/70 pt-3">
                    <div className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">
                      Signature (from mailbox)
                    </div>
                    <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-[20px] text-ink-muted">
                      {mailbox.signature.trim()}
                    </pre>
                  </div>
                ) : (
                  <div className="mt-3 inline-flex items-center gap-1.5 text-2xs text-ink-faint">
                    <Info className="size-3" />
                    No mailbox signature configured.
                  </div>
                )}

                <div className="mt-3 flex items-center justify-between text-2xs text-ink-faint">
                  <span>{wordCount} words</span>
                  {dirty && isPending ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setToEmail(draft.toEmail)
                        setSubject(draft.subject)
                        setBody(draft.body)
                      }}
                    >
                      Revert edits
                    </Button>
                  ) : null}
                </div>
              </div>
            </section>

            {draft.sendError ? (
              <section className="rounded-md border border-bad/30 bg-bad/5 p-3">
                <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-bad">
                  Last send error
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-ink">
                  {draft.sendError}
                </pre>
              </section>
            ) : null}

            {/* Teach the agent */}
            {isPending ? (
              <section className="rounded-lg border border-line bg-surface">
                <div className="border-b border-line/70 px-4 py-2">
                  <div className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
                    Teach the agent
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Notes here power <span className="font-medium text-ink">Regenerate</span>
                    {' '}and can be saved as standing instructions for next time.
                  </p>
                </div>
                <div className="space-y-3 p-3">
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_NOTES.map((text) => (
                      <button
                        key={text}
                        type="button"
                        onClick={() => appendQuickNote(text)}
                        className="rounded-full border border-line bg-surface px-2 py-1 text-2xs text-ink-muted transition-colors hover:border-line-strong hover:bg-surface-muted hover:text-ink"
                      >
                        + {text}
                      </button>
                    ))}
                  </div>
                  <Textarea
                    ref={notesRef}
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    placeholder="Tell the agent what to do differently — e.g., 'Lead with the SaaStr connection. Drop the second paragraph.'"
                    className="min-h-[88px]"
                  />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        className="size-3.5 rounded border-line"
                        checked={saveInstAccount}
                        onChange={(e) => setSaveInstAccount(e.target.checked)}
                      />
                      Remember for{' '}
                      <span className="font-medium text-ink">
                        {company?.name ?? 'this account'}
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        className="size-3.5 rounded border-line"
                        checked={saveInstMailbox}
                        onChange={(e) => setSaveInstMailbox(e.target.checked)}
                      />
                      Remember for all outreach from{' '}
                      <span className="font-medium text-ink">
                        {mailbox?.email ?? 'this mailbox'}
                      </span>
                    </label>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-2xs text-ink-faint">
                      {reviewNotes.trim()
                        ? 'Regenerate will discard this draft and write a new one.'
                        : 'Add notes to enable Regenerate.'}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        iconLeft={Trash2}
                        loading={discarding}
                        onClick={discard}
                      >
                        Discard
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        iconLeft={RefreshCw}
                        loading={regenerating}
                        onClick={regenerate}
                        disabled={!reviewNotes.trim()}
                      >
                        Regenerate
                      </Button>
                    </div>
                  </div>
                </div>
              </section>
            ) : draft.reviewNotes ? (
              <section className="rounded-md border border-line bg-surface-muted/40 p-3">
                <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-ink-faint">
                  Review notes (saved)
                </div>
                <p className="whitespace-pre-wrap text-sm text-ink">{draft.reviewNotes}</p>
              </section>
            ) : null}
          </div>
        </div>
      </div>

      {/* Context rail */}
      {railOpen ? (
        <aside className="hidden w-80 shrink-0 border-l border-line bg-surface-muted/25 lg:flex lg:flex-col">
          <ContextRail
            companyName={company?.name ?? null}
            mailboxEmail={mailbox?.email ?? null}
            strategy={strategy}
            sentEmails={sentEmails}
            sentCount={sentCount}
          />
        </aside>
      ) : null}
    </div>
  )
})

function HeaderRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 border-b border-line/70 px-4 py-2">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      <span className="truncate text-sm text-ink-muted">{value}</span>
    </div>
  )
}

function HeaderEditableRow({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  type,
  emphasized
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
  type?: string
  emphasized?: boolean
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 border-b border-line/70 px-4 py-1.5">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        type={type}
        className={cn(
          'border-transparent bg-transparent shadow-none focus-visible:border-accent',
          'disabled:opacity-100 disabled:bg-transparent',
          emphasized && 'text-[15px] font-medium'
        )}
      />
    </div>
  )
}

function ContextRail({
  companyName,
  mailboxEmail,
  strategy,
  sentEmails,
  sentCount
}: {
  companyName: string | null
  mailboxEmail: string | null
  strategy: string | null
  sentEmails: SentEmailRow[]
  sentCount: number
}) {
  const [showStrategy, setShowStrategy] = useState(false)
  const [showSent, setShowSent] = useState(true)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-4 py-3">
        <div className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
          Account context
        </div>
        <div className="mt-0.5 truncate text-sm font-medium text-ink">
          {companyName ?? '(unknown company)'}
        </div>
        {mailboxEmail ? (
          <div className="truncate text-2xs text-ink-faint">From {mailboxEmail}</div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Strategy */}
        <CollapsibleCard
          title="Account strategy"
          open={showStrategy}
          onToggle={() => setShowStrategy((v) => !v)}
          rightSlot={
            strategy?.trim() ? null : (
              <span className="text-2xs text-ink-faint">none</span>
            )
          }
        >
          {strategy?.trim() ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-ink">
              {strategy}
            </pre>
          ) : (
            <p className="text-2xs text-ink-faint">No strategy yet for this account.</p>
          )}
        </CollapsibleCard>

        {/* Sent history */}
        <CollapsibleCard
          title={'Sent on this account'}
          open={showSent}
          onToggle={() => setShowSent((v) => !v)}
          rightSlot={
            <Badge variant={sentCount > 0 ? 'accent' : 'soft'} className="h-5 px-1.5 text-2xs">
              {sentCount}
            </Badge>
          }
        >
          {sentEmails.length === 0 ? (
            <p className="text-2xs text-ink-faint">
              No prior emails. This is the first touch.
            </p>
          ) : (
            <ul className="space-y-2">
              {sentEmails.map((email) => (
                <li
                  key={email.id}
                  className="rounded-md border border-line/70 bg-surface p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-ink">
                        {email.person?.fullName ?? email.toEmail}
                      </div>
                      {email.person?.fullName ? (
                        <div className="truncate text-2xs text-ink-muted">
                          {email.toEmail}
                        </div>
                      ) : null}
                      <div className="mt-1 line-clamp-2 text-2xs text-ink-muted">
                        {email.subject}
                      </div>
                    </div>
                    <span className="shrink-0 text-2xs text-ink-faint">
                      {formatRelative(email.sentAt) ?? '-'}
                    </span>
                  </div>
                  {email.gmailMessageId ? (
                    <a
                      href={
                        'https://mail.google.com/mail/u/0/#sent/' + email.gmailMessageId
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 text-2xs text-ink-muted underline-offset-4 hover:text-accent hover:underline"
                    >
                      Open in Gmail <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CollapsibleCard>
      </div>
    </div>
  )
}

function CollapsibleCard({
  title,
  open,
  onToggle,
  rightSlot,
  children
}: {
  title: string
  open: boolean
  onToggle: () => void
  rightSlot?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-muted/60"
      >
        <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-ink-faint">
          <ChevronRight
            className={cn(
              'size-3 transition-transform',
              open && 'rotate-90'
            )}
          />
          {title}
        </span>
        {rightSlot}
      </button>
      {open ? <div className="border-t border-line/70 p-3">{children}</div> : null}
    </section>
  )
}
