"use client";
import { useCallback, useEffect, useState } from "react";

export interface LogEntry {
  id: string;
  path: string;
  title: string;
  action: "edit" | "create" | "delete";
  timestamp: number;
  previousContent?: string;
}

const MAX_ENTRIES = 60;
const CONTENT_CAP = 80_000;

function storageKey(ns: string) {
  return `emdee_log_${ns}`;
}

export function useDocLog(namespace: string) {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey(namespace));
      if (raw) setEntries(JSON.parse(raw));
    } catch {}
  }, [namespace]);

  const push = useCallback((entry: Omit<LogEntry, "id" | "timestamp">) => {
    const newEntry: LogEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      previousContent: entry.previousContent?.slice(0, CONTENT_CAP),
    };
    setEntries((prev) => {
      const next = [newEntry, ...prev].slice(0, MAX_ENTRIES);
      try { localStorage.setItem(storageKey(namespace), JSON.stringify(next)); } catch {}
      return next;
    });
  }, [namespace]);

  const remove = useCallback((id: string) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      try { localStorage.setItem(storageKey(namespace), JSON.stringify(next)); } catch {}
      return next;
    });
  }, [namespace]);

  const clear = useCallback(() => {
    setEntries([]);
    try { localStorage.removeItem(storageKey(namespace)); } catch {}
  }, [namespace]);

  return { entries, push, remove, clear };
}
