import { Check, ExternalLink, RefreshCw, Send, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { apiPatch, apiPost, type DraftDetail } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusDot } from '@/components/ui/status-dot'
import { Textarea } from '@/components/ui/textarea'
import { formatRelative } from '@/lib/format'

import { OutgoingEmailPreview } from './OutgoingEmailPreview'

export function DraftDetailPanel({
  detail,
  onChanged,
  onError
}: {
  detail: DraftDetail
  onChanged: () => void
  onError: (msg: string | null) => void
}) {
  const { draft, company, mailbox, person, strategy, sentEmails } = detail
  const isPending = draft.status === 'pending_review'
  const [toEmail, setToEmail] = useState(draft.toEmail)
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [reviewNotes, setReviewNotes] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [approving, setApproving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [showStrategy, setShowStrategy] = useState(false)
  const [showSentEmails, setShowSentEmails] = useState(true)
  const [saveInstAccount, setSaveInstAccount] = useState(false)
  const [saveInstMailbox, setSaveInstMailbox] = useState(false)

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
    if (!reviewNotes.trim()) {
      onError('Add review notes describing what to change, then click Regenerate.')
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">
              {company?.name ?? '(unknown company)'}
            </span>
            <StatusDot status={draft.status} size="sm" />
            {draft.gmailMessageId ? (
              <a
                href={
                  'https://mail.google.com/mail/u/0/#sent/' + draft.gmailMessageId
                }
                target="_blank"
                rel="noreferrer"
                className="text-xs text-ink-muted underline-offset-4 hover:text-accent hover:underline"
              >
                <span className="inline-flex items-center gap-1">
                  Open in Gmail <ExternalLink className="size-3" />
                </span>
              </a>
            ) : null}
          </div>
          <div className="truncate text-xs text-ink-muted">
            From {mailbox?.email ?? '(no mailbox)'}
            {person ? ' • ' + (person.fullName ?? '(no name)') : ''}
            {' • '} {formatRelative(draft.createdAt) ?? '-'}
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
                variant="primary"
                size="md"
                iconLeft={dirty ? Check : Send}
                loading={approving || savingEdit}
                onClick={approve}
              >
                {dirty ? 'Save & send' : 'Approve & send'}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {draft.agentRationale ? (
          <section className="rounded-md border border-line bg-surface-muted/40 p-3">
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-ink-faint">
              Agent rationale
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink">{draft.agentRationale}</p>
          </section>
        ) : null}

        <section className="rounded-md border border-line bg-surface">
          <button
            type="button"
            onClick={() => setShowStrategy((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-ink-faint hover:text-ink"
          >
            <span>Account strategy</span>
            <span className="text-ink-faint">{showStrategy ? 'Hide' : 'Show'}</span>
          </button>
          {showStrategy ? (
            <div className="border-t border-line p-3">
              {strategy?.trim() ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[18px] text-ink">
                  {strategy}
                </pre>
              ) : (
                <p className="text-sm text-ink-faint">No strategy yet for this account.</p>
              )}
            </div>
          ) : null}
        </section>

        <section className="rounded-md border border-line bg-surface">
          <button
            type="button"
            onClick={() => setShowSentEmails((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-ink-faint hover:text-ink"
          >
            <span>Sent on this account ({sentEmails.length})</span>
            <span className="text-ink-faint">{showSentEmails ? 'Hide' : 'Show'}</span>
          </button>
          {showSentEmails ? (
            <ul className="divide-y divide-line border-t border-line">
              {sentEmails.length === 0 ? (
                <li className="px-3 py-3 text-sm text-ink-faint">
                  No emails sent to this account yet.
                </li>
              ) : (
                sentEmails.map((email) => (
                  <li key={email.id} className="px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">
                          {email.person?.fullName ?? email.toEmail}
                        </div>
                        {email.person?.fullName ? (
                          <div className="truncate text-2xs text-ink-muted">{email.toEmail}</div>
                        ) : null}
                        <div className="mt-0.5 truncate text-sm text-ink">{email.subject}</div>
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
                        className="mt-1 inline-flex items-center gap-1 text-2xs text-ink-muted underline-offset-4 hover:text-accent hover:underline"
                      >
                        Open in Gmail <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </section>

        <section className="rounded-md border border-line bg-surface p-3 space-y-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
              To
            </label>
            <Input
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              disabled={!isPending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
              Subject
            </label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={!isPending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
              Body
              {isPending ? (
                <span className="ml-1.5 font-normal normal-case tracking-normal text-ink-faint">
                  (signature added on send)
                </span>
              ) : null}
            </label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={!isPending}
              className="min-h-[200px]"
            />
          </div>
        </section>

        <OutgoingEmailPreview
          fromEmail={mailbox?.email ?? ''}
          fromDisplayName={mailbox?.displayName ?? null}
          toEmail={toEmail}
          subject={subject}
          body={body}
          signature={mailbox?.signature ?? null}
        />

        {draft.sendError ? (
          <section className="rounded-md border border-bad/30 bg-bad/5 p-3 text-sm text-ink">
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-bad">
              Last send error
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px]">
              {draft.sendError}
            </pre>
          </section>
        ) : null}

        {isPending ? (
          <section className="rounded-md border border-line bg-surface p-3 space-y-2">
            <div className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
              Don't like this draft?
            </div>
            <Textarea
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              placeholder="Tell the agent what to do differently: 'too generic', 'lead with the SaaStr connection', 'shorter', etc."
              className="min-h-[80px]"
            />
            <div className="flex flex-col gap-2 rounded-md border border-line/80 bg-surface-muted/30 px-3 py-2.5">
              <div className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
                Save notes as standing instructions
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="size-3.5 rounded border-line"
                  checked={saveInstAccount}
                  onChange={(e) => setSaveInstAccount(e.target.checked)}
                />
                This account only
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="size-3.5 rounded border-line"
                  checked={saveInstMailbox}
                  onChange={(e) => setSaveInstMailbox(e.target.checked)}
                />
                All outreach from this mailbox
              </label>
            </div>
            <div className="flex justify-end gap-2">
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
              >
                Regenerate with notes
              </Button>
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
  )
}
