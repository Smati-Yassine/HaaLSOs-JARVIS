// Conversations: project folders Jarvis makes himself, folders you make, then the rest by day.
// A chat moves by dragging it onto a folder, or with the move button on its row.
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Icon } from "./icons";

export type Chat = { id: number; title: string; updated: number; turns: number; folder: number | null };
export type Folder = { id: number; name: string; project: string | null };

const DAY = 86_400_000;
function dayOf(time: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return "Today";
  if (time >= start.getTime() - DAY) return "Yesterday";
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
const clock = (time: number) => new Date(time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Which folders are open is remembered between launches.
function savedOpen(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem("jarvis-open-folders") ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}
function saveOpen(open: Set<number>) {
  try {
    localStorage.setItem("jarvis-open-folders", JSON.stringify([...open]));
  } catch {
    // It just won't be remembered.
  }
}

const onEnterOrSpace = (act: () => void) => (event: ReactKeyboardEvent) => {
  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  act();
};

// A name being typed, for a new folder or a renamed one. Enter saves, Esc or leaving cancels.
function NameField({ initial, sub, onSave, onCancel }: { initial: string; sub?: boolean; onSave(name: string): void; onCancel(): void }) {
  const [name, setName] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div className={`item naming${sub ? " sub" : ""}`}>
      <Icon name="folder" />
      <input
        ref={field}
        value={name}
        maxLength={60}
        aria-label="Folder name"
        placeholder="Folder name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (name.trim()) onSave(name.trim());
            else onCancel();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => (name.trim() && name.trim() !== initial ? onSave(name.trim()) : onCancel())}
      />
    </div>
  );
}

type Naming = { kind: "new"; moving: number | null } | { kind: "rename"; id: number } | null;
type Confirm = { kind: "chat" | "folder"; id: number } | null;
type MoveMenu = { chat: number; x: number; y: number } | null;

export function Sidebar({ chats, folders, current, onOpen, onNew, onChanged, onDeleted }: {
  chats: Chat[];
  folders: Folder[];
  current: number | null;
  onOpen(id: number): void;
  onNew(): void;
  onChanged(): void;
  onDeleted(id: number): void;
}) {
  const [open, setOpen] = useState(savedOpen);
  const [naming, setNaming] = useState<Naming>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [menu, setMenu] = useState<MoveMenu>(null);
  const [dropOn, setDropOn] = useState<number | "loose" | null>(null);
  const dragging = useRef<number | null>(null);

  // The folder holding the chat you're in opens by itself.
  const currentFolder = chats.find((chat) => chat.id === current)?.folder ?? null;
  useEffect(() => {
    if (currentFolder === null) return;
    setOpen((now) => (now.has(currentFolder) ? now : new Set(now).add(currentFolder)));
  }, [currentFolder]);
  useEffect(() => saveOpen(open), [open]);

  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => !(event.target as HTMLElement).closest(".move-menu") && setMenu(null);
    const esc = (event: KeyboardEvent) => event.key === "Escape" && setMenu(null);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const toggle = (id: number) => setOpen((now) => {
    const next = new Set(now);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const move = (chat: number, folder: number | null) => {
    setMenu(null);
    if (folder !== null) setOpen((now) => new Set(now).add(folder));
    window.jarvis.moveChat(chat, folder).then(onChanged);
  };
  const createFolder = (name: string, moving: number | null) => {
    setNaming(null);
    window.jarvis.createFolder(name).then((id) => {
      setOpen((now) => new Set(now).add(id));
      return moving === null ? undefined : window.jarvis.moveChat(moving, id);
    }).then(onChanged);
  };

  // Dragging a chat onto a folder files it there. Onto the dated list, it leaves its folder.
  const dropTarget = (target: number | "loose") => ({
    onDragOver(event: DragEvent) {
      if (dragging.current === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dropOn !== target) setDropOn(target);
    },
    onDragLeave(event: DragEvent) {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) setDropOn((now) => (now === target ? null : now));
    },
    onDrop(event: DragEvent) {
      event.preventDefault();
      const chat = dragging.current;
      dragging.current = null;
      setDropOn(null);
      if (chat === null) return;
      const from = chats.find((item) => item.id === chat)?.folder ?? null;
      const to = target === "loose" ? null : target;
      if (from !== to) move(chat, to);
    },
  });

  const chatRow = (chat: Chat, inFolder: boolean) => {
    if (confirm?.kind === "chat" && confirm.id === chat.id) {
      return (
        <div key={chat.id} className={`item confirm${inFolder ? " sub" : ""}`}>
          <span className="t">Delete for good?</span>
          <button
            type="button"
            className="mini danger"
            onClick={() => {
              setConfirm(null);
              window.jarvis.deleteChat(chat.id).then(() => onDeleted(chat.id));
            }}
          >
            Delete
          </button>
          <button type="button" className="mini" onClick={() => setConfirm(null)}>Keep</button>
        </div>
      );
    }
    const today = dayOf(chat.updated) === "Today";
    return (
      <div
        key={chat.id}
        className={`item${inFolder ? " sub" : ""}`}
        role="button"
        tabIndex={0}
        draggable
        aria-current={chat.id === current}
        title={chat.title}
        onClick={() => onOpen(chat.id)}
        onKeyDown={onEnterOrSpace(() => onOpen(chat.id))}
        onDragStart={(event) => {
          dragging.current = chat.id;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", chat.title);
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDropOn(null);
        }}
      >
        <Icon name="chat" />
        <span className="t">{chat.title}</span>
        {today && <span className="m">{clock(chat.updated)}</span>}
        <span className="acts">
          <button
            type="button"
            className="x"
            aria-label={`Move ${chat.title} to a folder`}
            title="Move to a folder"
            onClick={(event) => {
              event.stopPropagation();
              const box = ((event.currentTarget as HTMLElement).closest(".item") ?? (event.currentTarget as HTMLElement)).getBoundingClientRect();
              setMenu(menu?.chat === chat.id ? null : { chat: chat.id, x: box.right, y: box.bottom + 4 });
            }}
          >
            <Icon name="folderMove" />
          </button>
          <button
            type="button"
            className="x danger"
            aria-label={`Delete ${chat.title}`}
            title="Delete"
            onClick={(event) => {
              event.stopPropagation();
              setConfirm({ kind: "chat", id: chat.id });
            }}
          >
            <Icon name="trash" />
          </button>
        </span>
      </div>
    );
  };

  const folderBlock = (folder: Folder) => {
    const inside = chats.filter((chat) => chat.folder === folder.id).sort((a, b) => b.updated - a.updated);
    const isOpen = open.has(folder.id);
    if (naming?.kind === "rename" && naming.id === folder.id) {
      return (
        <NameField
          key={folder.id}
          initial={folder.name}
          onCancel={() => setNaming(null)}
          onSave={(name) => {
            setNaming(null);
            window.jarvis.renameFolder(folder.id, name).then(onChanged);
          }}
        />
      );
    }
    return (
      <div key={folder.id} className={`folder${dropOn === folder.id ? " drop" : ""}`} {...dropTarget(folder.id)}>
        {confirm?.kind === "folder" && confirm.id === folder.id ? (
          <div className="item confirm">
            <span className="t">Delete folder? Its chats stay.</span>
            <button
              type="button"
              className="mini danger"
              onClick={() => {
                setConfirm(null);
                window.jarvis.deleteFolder(folder.id).then(onChanged);
              }}
            >
              Delete
            </button>
            <button type="button" className="mini" onClick={() => setConfirm(null)}>Keep</button>
          </div>
        ) : (
          <div
            className="item folder-row"
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
            title={folder.project ? `Chats that opened ${folder.project}` : folder.name}
            onClick={() => toggle(folder.id)}
            onKeyDown={onEnterOrSpace(() => toggle(folder.id))}
          >
            <Icon name="folder" />
            <span className="t">{folder.name}</span>
            <span className="m">{inside.length || ""}</span>
            <span className="chev"><Icon name="chevron" /></span>
            <span className="acts">
              {!folder.project && (
                <button
                  type="button"
                  className="x"
                  aria-label={`Rename ${folder.name}`}
                  title="Rename"
                  onClick={(event) => {
                    event.stopPropagation();
                    setNaming({ kind: "rename", id: folder.id });
                  }}
                >
                  <Icon name="pencil" />
                </button>
              )}
              <button
                type="button"
                className="x danger"
                aria-label={`Delete folder ${folder.name}`}
                title="Delete folder. Its chats stay."
                onClick={(event) => {
                  event.stopPropagation();
                  setConfirm({ kind: "folder", id: folder.id });
                }}
              >
                <Icon name="trash" />
              </button>
            </span>
          </div>
        )}
        {isOpen && (
          <div className="group">
            {inside.length === 0 && <p className="empty-note sub">Drag chats here.</p>}
            {inside.map((chat) => chatRow(chat, true))}
          </div>
        )}
      </div>
    );
  };

  const projectFolders = folders.filter((folder) => folder.project);
  const ownFolders = folders.filter((folder) => !folder.project);
  const loose = chats.filter((chat) => chat.folder === null || !folders.some((folder) => folder.id === chat.folder));
  const days: [string, Chat[]][] = [];
  for (const chat of [...loose].sort((a, b) => b.updated - a.updated)) {
    const day = dayOf(chat.updated);
    const group = days.find(([name]) => name === day);
    if (group) group[1].push(chat);
    else days.push([day, [chat]]);
  }
  const menuChat = menu ? chats.find((chat) => chat.id === menu.chat) : null;

  return (
    <aside className="rail" aria-label="Conversations">
      <div className="rail-head">
        <button type="button" className="btn wide" onClick={onNew}><Icon name="plus" />New conversation</button>
        <button type="button" className="tb-btn sq" aria-label="New folder" title="New folder" onClick={() => setNaming({ kind: "new", moving: null })}>
          <Icon name="folderPlus" />
        </button>
      </div>
      <div className="rail-scroll">
        {projectFolders.length > 0 && (
          <div>
            <div className="label">Projects</div>
            <div className="group">{projectFolders.map(folderBlock)}</div>
          </div>
        )}
        {(ownFolders.length > 0 || naming?.kind === "new") && (
          <div>
            <div className="label">Folders</div>
            <div className="group">
              {naming?.kind === "new" && (
                <NameField initial="" onCancel={() => setNaming(null)} onSave={(name) => createFolder(name, naming.moving)} />
              )}
              {ownFolders.map(folderBlock)}
            </div>
          </div>
        )}
        <div className={`loose${dropOn === "loose" ? " drop" : ""}`} {...dropTarget("loose")}>
          {days.length === 0 && chats.length === 0 && <p className="empty-note">Your conversations will appear here.</p>}
          {days.map(([day, list]) => (
            <div key={day}>
              <div className="label">{day}</div>
              <div className="group">{list.map((chat) => chatRow(chat, false))}</div>
            </div>
          ))}
        </div>
      </div>

      {menu && menuChat && (
        <div className="pop move-menu" role="menu" aria-label="Move to a folder" style={{ left: Math.max(8, menu.x - 220), top: Math.max(8, Math.min(menu.y, window.innerHeight - 60 - 36 * (folders.length + 3))) }}>
          <div className="pop-head"><b>Move to</b></div>
          <hr />
          <div className="pop-list">
            {folders.filter((folder) => folder.id !== menuChat.folder).map((folder) => (
              <button key={folder.id} type="button" role="menuitem" onClick={() => move(menuChat.id, folder.id)}>
                <Icon name="folder" />
                <span>{folder.name}</span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setNaming({ kind: "new", moving: menuChat.id });
              }}
            >
              <Icon name="folderPlus" />
              <span>New folder…</span>
            </button>
            {menuChat.folder !== null && (
              <>
                <hr />
                <button type="button" role="menuitem" onClick={() => move(menuChat.id, null)}>
                  <Icon name="x" />
                  <span>Take out of folder</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
