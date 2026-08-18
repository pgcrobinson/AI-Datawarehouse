"use client";

import { useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, MSSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap, EditorView } from "@codemirror/view";
import { useTheme } from "@/context/ThemeContext";

const baseTheme = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-content": { padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "hsl(var(--muted))", borderRight: "1px solid hsl(var(--border))" },
  ".cm-activeLineGutter": { backgroundColor: "hsl(var(--accent))" },
  ".cm-activeLine": { backgroundColor: "hsl(var(--accent) / 0.25)" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",monospace' },
});

interface Props {
  value: string;
  onChange: (val: string) => void;
  onExecute: () => void;
}

export function SqlEditor({ value, onChange, onExecute }: Props) {
  const { theme } = useTheme();
  const executeRef = useRef(onExecute);
  executeRef.current = onExecute;

  const runKey = keymap.of([
    { key: "Ctrl-Enter", run: () => { executeRef.current(); return true; } },
    { key: "F5",         run: () => { executeRef.current(); return true; } },
  ]);

  const extensions = [
    sql({ dialect: MSSQL }),
    ...(theme === "dark" ? [oneDark] : []),
    baseTheme,
    runKey,
  ];

  return (
    <CodeMirror
      value={value}
      height="100%"
      theme={theme === "dark" ? "dark" : "light"}
      extensions={extensions}
      onChange={onChange}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightActiveLine: true,
        foldGutter: true,
        autocompletion: true,
      }}
      style={{ height: "100%", fontSize: "13px" }}
    />
  );
}
