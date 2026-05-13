"use client";
import { useEffect, useRef } from "react";
import * as ToastEditor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";

type EditorInstance = import("@toast-ui/editor").Editor;
// Turbopack drops named/default toast-ui imports during minification.
// Resolve the constructor off the namespace at runtime instead.
const Editor: typeof import("@toast-ui/editor").Editor = ToastEditor.Editor;

export interface Props {
  path: string;
  initialContent: string;
  mode: "raw" | "rendered";
  onChange: (next: string) => void;
  onWikiLinkClick?: (title: string) => void;
}

export function DocEditorInner({ path, initialContent, mode, onChange, onWikiLinkClick }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorInstance | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWikiLinkClickRef = useRef(onWikiLinkClick);
  onWikiLinkClickRef.current = onWikiLinkClick;

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const editor = new Editor({
      el: host,
      initialValue: initialContent,
      previewStyle: "vertical",
      height: "100%",
      initialEditType: "markdown",
      hideModeSwitch: true,
      usageStatistics: false,
      toolbarItems: [
        ["heading", "bold", "italic", "strike"],
        ["hr", "quote"],
        ["ul", "ol", "task", "indent", "outdent"],
        ["table", "image", "link"],
        ["code", "codeblock"],
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customHTMLRenderer: {
        text(node: any) {
          const literal: string = node.literal ?? "";
          const escaped = literal
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          const html = escaped.replace(/\[\[([^\]]+)\]\]/g, (_: string, title: string) => {
            const safe = title.replace(/"/g, "&quot;");
            return `<span class="wiki-link" title="${safe}">${title}</span>`;
          });
          return [{ type: "html", content: html }];
        },
      },
      events: {
        change: () => onChangeRef.current(editor.getMarkdown()),
      },
    });
    editorRef.current = editor;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest(".wiki-link") as HTMLElement | null;
      if (link && onWikiLinkClickRef.current) {
        onWikiLinkClickRef.current(link.getAttribute("title") ?? link.textContent ?? "");
      }
    };
    host.addEventListener("click", handleClick);

    return () => {
      host.removeEventListener("click", handleClick);
      editor.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.getMarkdown() !== initialContent) ed.setMarkdown(initialContent);
  }, [initialContent]);

  return <div ref={hostRef} data-mode={mode} style={{ height: "100%" }} />;
}
