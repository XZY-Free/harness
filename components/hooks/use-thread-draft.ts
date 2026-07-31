"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "snowharness:draft:";

function storageKey(draftKey: string): string {
  return `${STORAGE_PREFIX}${draftKey}`;
}

export function clearStoredThreadDraft(draftKey: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(storageKey(draftKey));
}

function readDraft(draftKey: string): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(storageKey(draftKey)) ?? "";
}

export function useThreadDraft(draftKey: string) {
  const [text, setTextState] = useState(() => readDraft(draftKey));

  useEffect(() => {
    setTextState(readDraft(draftKey));
  }, [draftKey]);

  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      if (typeof window === "undefined") return;
      if (next) {
        window.sessionStorage.setItem(storageKey(draftKey), next);
      } else {
        clearStoredThreadDraft(draftKey);
      }
    },
    [draftKey],
  );

  const clear = useCallback(() => setText(""), [setText]);

  return { text, setText, clear };
}
