'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { EFFECTIVE_DISPATCHABLE_CHAT_MODELS } from '@routeshift/shared';
import { CURRENT_MODEL_ROLES, CURRENT_MODELS } from '@/lib/current-models';
import { Brain, ChevronDown, X } from 'lucide-react';
import { providerBadgeClass } from '@/lib/providers';

export interface ModelAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  allowAnyValue?: boolean;
  disabled?: boolean;
}

type ModelOption = {
  canonical_name: string;
  api_model_id: string;
  provider: string;
};

const MODEL_OPTIONS: readonly ModelOption[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS.map((model) => ({
  canonical_name: model.canonical_name,
  api_model_id: model.api_model_id,
  provider: model.provider,
}));
const MODEL_BY_NAME = new Map(MODEL_OPTIONS.map((model) => [model.canonical_name, model]));

// Keep the quick-pick order tied to the generated role fixture. The first
// role remains the "press Enter on empty query" default as the catalog rotates,
// while the complete dispatchable chat catalog remains searchable below.
const POPULAR_MODEL_NAMES = CURRENT_MODEL_ROLES.map((role) => CURRENT_MODELS[role]);
const POPULAR_ROWS = POPULAR_MODEL_NAMES
  .map((name) => MODEL_BY_NAME.get(name))
  .filter((model): model is ModelOption => model !== undefined);
const POPULAR_NAME_SET = new Set(POPULAR_MODEL_NAMES);
const OTHER_MODEL_OPTIONS = MODEL_OPTIONS.filter((model) => !POPULAR_NAME_SET.has(model.canonical_name));

export function ModelAutocomplete({
  value,
  onChange,
  placeholder = 'Select a model…',
  id,
  allowAnyValue = true,
  disabled = false,
}: ModelAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const popularRows = POPULAR_ROWS;

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return MODEL_OPTIONS;
    return MODEL_OPTIONS.filter(
      (m) =>
        m.canonical_name.toLowerCase().includes(q) ||
        m.api_model_id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
    );
  }, [query]);

  const isFiltering = query.toLowerCase().trim().length > 0;

  function selectModel(canonicalName: string) {
    onChange(canonicalName);
    setQuery(canonicalName);
    setOpen(false);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQuery(v);
    if (allowAnyValue) onChange(v);
    setOpen(true);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Empty query: select the top frontier pick. Filtered: select the
      // first match.
      if (!isFiltering && popularRows.length > 0) {
        selectModel(popularRows[0].canonical_name);
        return;
      }
      if (filtered.length > 0) {
        selectModel(filtered[0].canonical_name);
        return;
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Input */}
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={query}
          onChange={handleInputChange}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
          className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 pr-8 text-sm text-white placeholder-neutral-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:text-neutral-500"
        />
        {value && !disabled && (
          <button
            type="button"
            aria-label="Clear model selection"
            onClick={() => {
              onChange('');
              setQuery('');
              inputRef.current?.focus();
            }}
            className="absolute right-7 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-neutral-400"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <ChevronDown
          className={`absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1.5 max-h-72 w-full overflow-auto rounded-lg border border-white/[0.08] bg-[#0f0f12] py-1 shadow-xl shadow-black/40">
          {isFiltering ? (
            filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-neutral-500">
                {allowAnyValue ? 'Press Enter to use this value' : 'No models found'}
              </div>
            ) : (
              filtered.map((model) => (
                <ModelRow
                  key={model.canonical_name}
                  model={model}
                  onSelect={selectModel}
                />
              ))
            )
          ) : (
            <>
              {popularRows.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                    Popular
                  </div>
                  {popularRows.map((model) => (
                    <ModelRow
                      key={`popular:${model.canonical_name}`}
                      model={model}
                      onSelect={selectModel}
                    />
                  ))}
                </>
              )}
              <div className="mt-1 border-t border-white/[0.04] px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                All models
              </div>
              {OTHER_MODEL_OPTIONS.map((model) => (
                <ModelRow
                  key={model.canonical_name}
                  model={model}
                  onSelect={selectModel}
                />
              ))}
            </>
          )}
        </div>
      )}

    </div>
  );
}

function ModelRow({
  model,
  onSelect,
}: {
  model: ModelOption;
  onSelect: (canonicalName: string) => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSelect(model.canonical_name)}
      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-white/[0.04]"
    >
      <div className="flex items-center gap-2">
        <Brain className="h-3.5 w-3.5 text-neutral-500" />
        <span className="font-medium text-white">{model.canonical_name}</span>
      </div>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${providerBadgeClass(model.provider)}`}>
        {model.provider}
      </span>
    </button>
  );
}
