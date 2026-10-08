'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { SidebarNav } from '@/components/sidebar-nav';
import { DemoProvenanceBanner } from '@/components/demo-provenance-banner';
import { useDialogA11y } from '@/lib/use-dialog-a11y';
import { DialogPortal } from '@/components/ui/dialog-portal';

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarRef = useRef<HTMLElement>(null);

  useDialogA11y(mobileSidebarRef, sidebarOpen);

  useEffect(() => {
    if (!sidebarOpen) return;
    closeButtonRef.current?.focus();
    const desktopMediaQuery = window.matchMedia('(min-width: 768px)');

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        openButtonRef.current?.focus();
      }
    }

    function onViewportChange() {
      if (desktopMediaQuery.matches) setSidebarOpen(false);
    }

    window.addEventListener('keydown', onKeyDown);
    desktopMediaQuery.addEventListener('change', onViewportChange);
    onViewportChange();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      desktopMediaQuery.removeEventListener('change', onViewportChange);
    };
  }, [sidebarOpen]);

  function closeSidebar() {
    setSidebarOpen(false);
    openButtonRef.current?.focus();
  }

  return (
    <div className="flex h-screen overflow-x-hidden bg-[#09090b]">
      {/* Mobile top bar */}
      <div className="fixed left-0 right-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-white/[0.06] bg-[#09090b] px-4 md:hidden">
        <button
          ref={openButtonRef}
          type="button"
          aria-label="Open dashboard navigation"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/routeshift-mark.svg" alt="" className="h-4 w-4" />
          </div>
          <span className="text-base font-semibold tracking-tight text-white">
            RouteShift
          </span>
        </Link>
      </div>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close dashboard navigation overlay"
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar */}
      <aside
        className="hidden md:flex fixed inset-y-0 left-0 z-50 w-64 flex-col border-r border-white/[0.06] bg-[#09090b] md:static"
      >
        {/* Branding */}
        <div className="flex h-16 items-center justify-between gap-2 px-6">
          <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/routeshift-mark.svg" alt="" className="h-[18px] w-[18px]" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">
              RouteShift
            </span>
          </Link>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav />
        </div>
      </aside>

      {/* Mobile sidebar (overlay) */}
      {sidebarOpen && (
        <DialogPortal>
          <aside
            ref={mobileSidebarRef}
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard navigation"
            className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-white/[0.06] bg-[#09090b] transition-transform duration-300 md:hidden translate-x-0"
          >
        {/* Branding + close */}
        <div className="flex h-16 items-center justify-between gap-2 px-6">
          <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/routeshift-mark.svg" alt="" className="h-[18px] w-[18px]" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">
              RouteShift
            </span>
          </Link>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close dashboard navigation"
            onClick={closeSidebar}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto px-3 py-4" onClick={closeSidebar}>
          <SidebarNav />
        </div>
          </aside>
        </DialogPortal>
      )}

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-[#09090b] p-4 pt-[calc(3.5rem+1rem)] md:p-8 md:pt-8">
        <DemoProvenanceBanner />
        {children}
      </main>
    </div>
  );
}
