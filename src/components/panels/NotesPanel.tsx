"use client";

// The project's team notes (.agentworld/notes.md), pasted into every agent's prompt.

import { ClipboardList, Pin, Plus, User } from "lucide-react";
import { useEffect, useState } from "react";
import { getBackend } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { parseNotes, type NoteLine } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useConnected, useProjectAgents, useSelectedProject } from "../hooks.ts";
import { cx, Empty, ErrorLine, Section } from "../ui.tsx";
import { PanelBody } from "./SidePanel.tsx";

function NoteRow({ note, agentColor }: { note: NoteLine; agentColor: string | null }) {
  if (note.kind === "heading") return <li className="eyebrow pt-2">{note.text}</li>;
  const marker =
    note.kind === "task_log" ? (
      <ClipboardList size={13} className="text-signal" aria-label="Task log" />
    ) : note.kind === "pinned" ? (
      <Pin size={12} className="text-warn" aria-label="Pinned by you" />
    ) : note.kind === "mine" ? (
      <User size={13} className="text-mist-300" aria-label="Written by you" />
    ) : note.kind === "agent" ? (
      <span className="size-2 rounded-full" style={{ background: agentColor ?? "var(--color-mist-500)" }} aria-hidden />
    ) : (
      <span className="size-1 rounded-full bg-mist-500" aria-hidden />
    );
  return (
    <li className={cx("flex gap-2.5 rounded-lg px-2 py-1.5", note.kind === "task_log" && "bg-signal/5")}>
      <span className="mt-1 inline-flex size-3.5 shrink-0 items-center justify-center">{marker}</span>
      <span className="min-w-0 flex-1 text-xs leading-relaxed">
        <span className="text-mist-100">{note.text}</span>
        {note.by !== null && (
          <span className="block text-xs text-mist-500">
            {note.by} · {note.date}
          </span>
        )}
      </span>
    </li>
  );
}

function AddNote({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connected = useConnected();
  const save = () => {
    if (text.trim() === "") return;
    setError(null);
    getBackend()
      .addNote({ projectId, text: text.trim() })
      .then(
        () => setText(""),
        (e: unknown) => setError(errorText(e)),
      );
  };
  return (
    <div className="space-y-1.5">
      <textarea
        className="field min-h-14 resize-y"
        placeholder="A fact every agent should know, e.g. “We deploy on Fridays”"
        aria-label="New note"
        value={text}
        maxLength={CONFIG.noteMaxChars}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <span className={cx("text-xs tabular-nums", text.length >= CONFIG.noteMaxChars ? "text-warn" : "text-mist-500")}>
          {text.length}/{CONFIG.noteMaxChars}
        </span>
        <ErrorLine error={error} />
        <button type="button" className="btn btn-sm btn-primary ml-auto" disabled={disabled || !connected || text.trim() === ""} onClick={save}>
          <Plus size={13} />
          Add note
        </button>
      </div>
    </div>
  );
}

export function NotesPanel() {
  const project = useSelectedProject();
  const agents = useProjectAgents();
  const connected = useConnected();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The newest notes.updated event for this project: a new one reloads the file.
  const lastUpdate = useWorldStore((s) => s.events.find((e) => e.type === "notes.updated" && e.projectId === project?.id)?.id ?? null);
  const projectId = project?.id ?? null;

  useEffect(() => {
    if (projectId === null || !connected) return;
    let live = true;
    getBackend()
      .getNotes({ projectId })
      .then(
        (text) => {
          if (live) setContent(text);
        },
        (e: unknown) => {
          if (live) setError(errorText(e));
        },
      );
    return () => {
      live = false;
    };
  }, [projectId, lastUpdate, connected]);

  if (project === null) return <PanelBody>{null}</PanelBody>;
  const notes = content === null ? [] : parseNotes(content);
  const colorOf = (by: string | null) => {
    const agent = agents.find((a) => a.name === by);
    return agent === undefined ? null : ROLE_DEFINITIONS[agent.role].color;
  };

  return (
    <PanelBody>
      <p className="text-xs leading-relaxed text-mist-500">
        Shared memory for {project.name}: every agent gets these notes in its prompt, in every chat and task. They live in{" "}
        <code className="font-mono text-mist-300">{CONFIG.notesPath}</code>.
      </p>
      <Section title="Add a note">
        <AddNote projectId={project.id} disabled={project.archived} />
      </Section>
      <Section title={`Notes · ${notes.filter((n) => n.kind !== "heading").length}`}>
        <ErrorLine error={error} />
        {content !== null && notes.length === 0 ? (
          <Empty>No notes yet. Agents add them with add_note, you pin chat messages or write one above, and every finished task adds a line.</Empty>
        ) : (
          <ul className="space-y-0.5">
            {notes.map((note, index) => (
              <NoteRow key={`${index}-${note.text}`} note={note} agentColor={colorOf(note.by)} />
            ))}
          </ul>
        )}
      </Section>
    </PanelBody>
  );
}
