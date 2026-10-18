import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { PermissionPanelProps } from '../../configs/permissionPanelRegistry';
import type { Question } from '../../../types/types';

export const AskUserQuestionPanel: React.FC<PermissionPanelProps> = ({
  request,
  onDecision,
  isSubmitting = false,
}) => {
  const input = request.input as { questions?: Question[] } | undefined;
  const questions: Question[] = input?.questions || [];

  const [currentStep, setCurrentStep] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(() => new Map());
  const [otherActive, setOtherActive] = useState<Map<number, boolean>>(() => new Map());
  const [mounted, setMounted] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  // Focus the container for keyboard events when step changes
  useEffect(() => {
    if (!otherActive.get(currentStep)) {
      containerRef.current?.focus();
    }
  }, [currentStep, otherActive]);

  useEffect(() => {
    if (otherActive.get(currentStep)) {
      otherInputRef.current?.focus();
    }
  }, [otherActive, currentStep]);

  const toggleOption = useCallback((qIdx: number, label: string, multiSelect: boolean) => {
    setSelections(prev => {
      const next = new Map(prev);
      const current = new Set(next.get(qIdx) || []);
      if (multiSelect) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
        setOtherActive(p => { const n = new Map(p); n.set(qIdx, false); return n; });
      }
      next.set(qIdx, current);
      return next;
    });
  }, []);

  const toggleOther = useCallback((qIdx: number, multiSelect: boolean) => {
    setOtherActive(prev => {
      const next = new Map(prev);
      const wasActive = next.get(qIdx) || false;
      next.set(qIdx, !wasActive);
      if (!multiSelect && !wasActive) {
        setSelections(p => { const n = new Map(p); n.set(qIdx, new Set()); return n; });
      }
      return next;
    });
  }, []);

  const setOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts(prev => { const next = new Map(prev); next.set(qIdx, text); return next; });
  }, []);

  const buildAnswers = useCallback(() => {
    const answers: Record<string, string> = {};
    questions.forEach((q, idx) => {
      const selected = Array.from(selections.get(idx) || []);
      const isOther = otherActive.get(idx) || false;
      const otherText = (otherTexts.get(idx) || '').trim();
      if (isOther && otherText) selected.push(otherText);
      if (selected.length > 0) answers[q.question] = selected.join(', ');
    });
    return answers;
  }, [questions, selections, otherActive, otherTexts]);

  const handleSubmit = useCallback(() => {
    if (isSubmitting) return;
    onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers: buildAnswers() } });
  }, [isSubmitting, onDecision, request.requestId, input, buildAnswers]);

  const handleSkip = useCallback(() => {
    if (isSubmitting) return;
    onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers: {} } });
  }, [isSubmitting, onDecision, request.requestId, input]);

  // Keyboard handler for number keys and navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't capture keys when typing in the "Other" input
    if (e.target instanceof HTMLInputElement) return;

    const q = questions[currentStep];
    if (!q) return;
    const multi = q.multiSelect || false;
    const optCount = q.options.length;

    // Number keys 1-9 for options
    const num = parseInt(e.key);
    if (!isNaN(num) && num >= 1 && num <= optCount) {
      e.preventDefault();
      toggleOption(currentStep, q.options[num - 1].label, multi);
      return;
    }

    // The number after the options (as shown on the card), or 0, for "Other"
    if (e.key === '0' || num === optCount + 1) {
      e.preventDefault();
      toggleOther(currentStep, multi);
      return;
    }

    // Enter to advance / submit
    if (e.key === 'Enter') {
      e.preventDefault();
      const isLast = currentStep === questions.length - 1;
      if (isLast) handleSubmit();
      else setCurrentStep(s => s + 1);
      return;
    }

    // Escape to skip
    if (e.key === 'Escape') {
      e.preventDefault();
      handleSkip();
      return;
    }
  }, [currentStep, questions, toggleOption, toggleOther, handleSubmit, handleSkip]);

  if (questions.length === 0) return null;

  const total = questions.length;
  const isSingle = total === 1;
  const q = questions[currentStep];
  const multi = q.multiSelect || false;
  const selected = selections.get(currentStep) || new Set<string>();
  const isOtherOn = otherActive.get(currentStep) || false;
  const isLast = currentStep === total - 1;
  const isFirst = currentStep === 0;
  const hasCurrentSelection = selected.size > 0 || (isOtherOn && (otherTexts.get(currentStep) || '').trim().length > 0);

  const otherNumber = q.options.length + 1;

  // Claude desktop question card (references C1–C11, 2026-07/08): a rounded
  // card, "1/2" step badge + question in bold, one row per option (title,
  // muted description, number on the right), an "Other" row with its input,
  // then Back / Skip / Next-or-Submit. Colours use the current tokens; the
  // references come from an older theme (page #20201f instead of #151515).
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={`w-full outline-none transition-all duration-300 ease-out ${mounted ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}
    >
      <div className="rounded-[12px] bg-c-surface px-3 pb-3 pt-[11px] text-[14px] leading-5 text-c-text">
        <div className="mb-[9px] flex items-start gap-2">
          {!isSingle && (
            <span className="mt-px flex-shrink-0 rounded-[4px] bg-[#4a3f1a] px-[5px] text-[12px] font-semibold leading-[18px] text-[#e8c255]">
              {currentStep + 1}/{total}
            </span>
          )}
          <p className="min-w-0 flex-1 font-semibold">{q.question}</p>
          <button
            type="button"
            onClick={handleSkip}
            disabled={isSubmitting}
            aria-label="Skip"
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-c-text-3 hover:bg-c-active hover:text-c-text"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="space-y-[3px]" role={multi ? 'group' : 'radiogroup'} aria-label={q.question}>
          {q.options.map((option, index) => {
            const isSelected = selected.has(option.label);
            return (
              <button
                key={option.label}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={isSelected}
                onClick={() => toggleOption(currentStep, option.label, multi)}
                className={`flex w-full items-center gap-3 rounded-[6px] px-2 py-[7px] text-left transition-colors ${isSelected ? 'bg-[#3a3a39] ring-1 ring-inset ring-c-text-3/60' : 'bg-[#2a2a2a] hover:bg-[#303030]'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-c-text">{option.label}</span>
                  {option.description && <span className="block text-[13px] leading-[18px] text-c-text-3">{option.description}</span>}
                </span>
                <span className="flex-shrink-0 text-[13px] tabular-nums text-c-text-3">{index + 1}</span>
              </button>
            );
          })}

          <div className={`rounded-[6px] px-2 py-[7px] ${isOtherOn ? 'bg-[#3a3a39] ring-1 ring-inset ring-c-text-3/60' : 'bg-[#2a2a2a]'}`}>
            <button type="button" onClick={() => toggleOther(currentStep, multi)} aria-pressed={isOtherOn} className="flex w-full items-center gap-3 text-left">
              <span className="min-w-0 flex-1 font-semibold">Other</span>
              <span className="flex-shrink-0 text-[13px] tabular-nums text-c-text-3">{otherNumber}</span>
            </button>
            <input
              ref={otherInputRef}
              type="text"
              value={otherTexts.get(currentStep) || ''}
              onFocus={() => { if (!isOtherOn) toggleOther(currentStep, multi); }}
              onChange={(event) => setOtherText(currentStep, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (isLast) handleSubmit(); else setCurrentStep((step) => step + 1);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  handleSkip();
                }
              }}
              placeholder="Type your own answer here"
              className="mt-[6px] block h-[30px] w-full rounded-[6px] bg-[#383838] px-2 text-[13px] text-c-text outline-none placeholder:text-c-text-3"
            />
          </div>
        </div>

        <div className="mt-[10px] flex items-center gap-2">
          {!isFirst && (
            <button type="button" onClick={() => setCurrentStep((step) => step - 1)} className="h-[26px] rounded-[6px] bg-[#383838] px-[9px] text-[13px] font-medium text-c-text-2 hover:text-c-text">
              Back
            </button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={handleSkip} disabled={isSubmitting} className="h-[26px] rounded-[6px] bg-[#383838] px-[9px] text-[13px] font-medium text-c-text-2 hover:text-c-text disabled:opacity-50">
            Skip
          </button>
          <button
            type="button"
            onClick={() => (isLast ? handleSubmit() : setCurrentStep((step) => step + 1))}
            disabled={isSubmitting || (!hasCurrentSelection && isLast && total === 1)}
            className="h-[26px] rounded-[6px] bg-c-text px-[9px] text-[13px] font-medium text-c-bg disabled:bg-[#2a2a2a] disabled:text-c-text-3"
          >
            {isSubmitting ? 'Sending…' : (<>{isLast ? 'Submit' : 'Next'} <span className="text-[12px] opacity-60">Enter</span></>)}
          </button>
        </div>
      </div>
    </div>
  );
};
