"use client";

import { useRef, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, MSSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";
import { EditorView } from "@codemirror/view";

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-content": { padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "hsl(var(--card))", borderRight: "1px solid hsl(var(--border))" },
  ".cm-activeLineGutter": { backgroundColor: "hsl(var(--accent))" },
  ".cm-activeLine": { backgroundColor: "hsl(var(--accent)/0.3)" },
});

interface Props {
  value: string;
  onChange: (val: string) => void;
  onExecute: () => void;
}

export function SqlEditor({ value, onChange, onExecute }: Props) {
  const executeRef = useRef(onExecute);
  executeRef.current = onExecute;

  const runKey = keymap.of([
    {
      key: "Ctrl-Enter",
      run: () => {
        executeRef.current();
        return true;
      },
    },
    {
      key: "F5",
      run: () => {
        executeRef.current();
        return true;
      },
    },
  ]);

  const extensions = [
    sql({ dialect: MSSQL }),
    oneDark,
    editorTheme,
    runKey,
  ];

  return (
    <CodeMirror
      value={value}
      height="100%"
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
