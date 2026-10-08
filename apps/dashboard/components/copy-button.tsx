'use client';
import { useEffect, useRef, useState } from 'react';

type CopyStatus = 'idle' | 'copied' | 'failed';

export function CopyButton({
  text,
  label = 'Copy',
  successLabel = 'Copied!',
  failureLabel = 'Copy failed — select the text',
  className = '',
}: {
  text: string;
  label?: string;
  successLabel?: string;
  failureLabel?: string;
  className?: string;
}) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const attemptRef = useRef(0);
  const currentTextRef = useRef(text);
  currentTextRef.current = text;

  useEffect(() => {
    attemptRef.current += 1;
    setStatus('idle');
  }, [text]);

  useEffect(() => {
    if (status !== 'copied') return;
    const timeout = window.setTimeout(() => setStatus('idle'), 2_000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  async function copy() {
    const attempt = ++attemptRef.current;
    const copyText = text;
    try {
      await navigator.clipboard.writeText(copyText);
      if (attempt !== attemptRef.current || copyText !== currentTextRef.current) return;
      setStatus('copied');
    } catch {
      if (attempt !== attemptRef.current || copyText !== currentTextRef.current) return;
      setStatus('failed');
    }
  }

  const visible = status === 'copied'
    ? successLabel
    : status === 'failed'
      ? failureLabel
      : label;

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className={`ml-2 text-xs text-neutral-300 transition-colors hover:text-emerald-400 ${className}`}
      >
        {visible}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {status === 'copied' ? successLabel : status === 'failed' ? failureLabel : ''}
      </span>
    </>
  );
}
