'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Circle,
  CreditCard,
  KeyRound,
  PlugZap,
  Rocket,
  X,
} from 'lucide-react';
import { CopyButton } from '@/components/copy-button';
import { PUBLIC_PROXY_CHAT_COMPLETIONS_URL } from '@/lib/public-urls';
import { useDialogA11y } from '@/lib/use-dialog-a11y';
import { DialogPortal } from '@/components/ui/dialog-portal';

const DISMISS_KEY_PREFIX = 'routeshift.quick-start.dismissed.v1';

interface OverviewQuickStartProps {
  autoOpen: boolean;
  billingMode: 'subscription' | 'credits';
  hasApiKey: boolean;
  hasModelAccess: boolean;
  canManage: boolean;
  workspaceId: string;
}

interface SetupStepProps {
  complete: boolean;
  number: number;
  title: string;
  description: string;
  icon: typeof KeyRound;
  children?: ReactNode;
}

function SetupStep({ complete, number, title, description, icon: Icon, children }: SetupStepProps) {
  return (
    <li className="flex gap-4">
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
          complete
            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
            : 'border-white/[0.06] bg-white/[0.03] text-neutral-400'
        }`}
      >
        {complete ? <Check className="h-5 w-5" aria-hidden="true" /> : <Icon className="h-5 w-5" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-semibold text-white">
            <span className="sr-only">Step {number}: </span>
            {title}
          </p>
          <span className={`inline-flex items-center gap-1 text-xs ${complete ? 'text-emerald-400' : 'text-neutral-500'}`}>
            {complete ? <Check className="h-3 w-3" aria-hidden="true" /> : <Circle className="h-2.5 w-2.5" aria-hidden="true" />}
            {complete ? 'Complete' : 'To do'}
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-neutral-400">{description}</p>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

function dismissalKey(workspaceId: string) {
  return `${DISMISS_KEY_PREFIX}:${workspaceId}`;
}

function rememberDismissal(workspaceId: string) {
  try {
    window.localStorage.setItem(dismissalKey(workspaceId), '1');
  } catch {
    // Storage can be unavailable in hardened browsers. Closing the dialog
    // should still work for the current page even when persistence cannot.
  }
}

export function OverviewQuickStart({
  autoOpen,
  billingMode,
  hasApiKey,
  hasModelAccess,
  canManage,
  workspaceId,
}: OverviewQuickStartProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useDialogA11y(dialogRef, open);

  useEffect(() => {
    if (!autoOpen) return;
    try {
      setOpen(window.localStorage.getItem(dismissalKey(workspaceId)) !== '1');
    } catch {
      // If storage cannot be read, favor showing setup for an empty workspace.
      setOpen(true);
    }
  }, [autoOpen, workspaceId]);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      rememberDismissal(workspaceId);
      setOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, workspaceId]);

  function closeAndRemember() {
    rememberDismissal(workspaceId);
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }

  function handleSetupNavigation() {
    rememberDismissal(workspaceId);
  }

  const accessTitle = billingMode === 'credits'
    ? hasModelAccess ? 'Credits ready' : 'Add model credits'
    : hasModelAccess ? 'Provider connected' : 'Connect a provider';
  const accessDescription = billingMode === 'credits'
    ? hasModelAccess
      ? 'Your workspace has credit available for RouteShift-managed model access.'
      : 'Add credits so RouteShift can send requests through managed provider access.'
    : hasModelAccess
      ? 'At least one provider key is enabled for this workspace.'
      : canManage
        ? 'Add at least one provider key so RouteShift can reach a model.'
        : 'Ask a team admin to add at least one provider key for this workspace.';
  const accessHref = billingMode === 'credits' ? '/billing' : '/settings';
  const accessLinkLabel = billingMode === 'credits'
    ? 'Manage credits'
    : hasModelAccess ? 'Manage provider keys' : 'Connect a provider';

  const nextAction = !hasApiKey
    ? { href: '/keys', label: 'Continue to API Keys' }
    : !hasModelAccess
      ? { href: accessHref, label: billingMode === 'credits' ? 'Continue to Billing' : 'Continue to Settings' }
      : { href: '/settings', label: 'Open full setup guide' };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
      >
        Open quick start
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {open && (
        <DialogPortal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <div
            className="fixed inset-0 cursor-default bg-black/70 backdrop-blur-sm"
            aria-hidden="true"
            onClick={closeAndRemember}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="overview-quick-start-title"
            aria-describedby="overview-quick-start-description"
            className="relative max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/[0.08] bg-[#0c0c0e] shadow-2xl shadow-black/50"
          >
            <div className="border-b border-white/[0.06] px-5 py-5 sm:px-6">
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeAndRemember}
                aria-label="Close quick start"
                className="absolute right-4 top-4 rounded-md p-1 text-neutral-500 transition-colors hover:bg-white/[0.05] hover:text-neutral-300"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
              <div className="flex items-start gap-3 pr-10">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
                  <Rocket className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <h3 id="overview-quick-start-title" className="text-lg font-semibold text-white">
                    Set up RouteShift
                  </h3>
                  <p id="overview-quick-start-description" className="mt-0.5 text-sm text-neutral-400">
                    Three steps to your first routed request.
                  </p>
                </div>
              </div>
            </div>

            <ol className="space-y-6 px-5 py-6 sm:px-6">
              <SetupStep
                complete={hasApiKey}
                number={1}
                title={hasApiKey ? 'API key ready' : 'Create a RouteShift API key'}
                description={hasApiKey
                  ? 'An active proxy key is ready to authenticate requests.'
                  : canManage
                    ? 'Create the proxy key your application will use to authenticate.'
                    : 'Ask a team admin to create a proxy key for your application.'}
                icon={KeyRound}
              >
                <Link
                  href="/keys"
                  onClick={handleSetupNavigation}
                  className="text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
                >
                  {hasApiKey ? 'Manage API keys' : 'Create an API key'}
                </Link>
              </SetupStep>

              <SetupStep
                complete={hasModelAccess}
                number={2}
                title={accessTitle}
                description={accessDescription}
                icon={billingMode === 'credits' ? CreditCard : PlugZap}
              >
                <Link
                  href={accessHref}
                  onClick={handleSetupNavigation}
                  className="text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
                >
                  {accessLinkLabel}
                </Link>
              </SetupStep>

              <SetupStep
                complete={false}
                number={3}
                title="Send your first request"
                description="Keep your OpenAI-compatible request shape and point it at the RouteShift endpoint."
                icon={Rocket}
              >
                <div className="flex min-w-0 items-center rounded-lg border border-white/[0.06] bg-white/[0.03] pl-3">
                  <code className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-xs text-emerald-400 sm:text-sm">
                    {PUBLIC_PROXY_CHAT_COMPLETIONS_URL}
                  </code>
                  <CopyButton text={PUBLIC_PROXY_CHAT_COMPLETIONS_URL} />
                </div>
              </SetupStep>
            </ol>

            <div className="flex flex-col-reverse gap-3 border-t border-white/[0.06] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <button
                type="button"
                onClick={closeAndRemember}
                className="rounded-lg px-3 py-2 text-sm font-medium text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-neutral-200"
              >
                I’ll do this later
              </button>
              <Link
                href={nextAction.href}
                onClick={handleSetupNavigation}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/20"
              >
                {nextAction.label}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
        </DialogPortal>
      )}
    </>
  );
}
