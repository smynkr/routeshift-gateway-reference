'use client';

import { createPortal } from 'react-dom';
import type { ReactNode, ReactPortal } from 'react';

export function DialogPortal({ children }: { children: ReactNode }): ReactPortal | null {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
