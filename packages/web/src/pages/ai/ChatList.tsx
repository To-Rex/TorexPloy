/**
 * The person's conversations with TorexAi: pinned ones first, then by when
 * they were last touched, with a search that looks through titles and
 * everything that was said.
 */
import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Pencil, Pin, PinOff, Search, SquarePen, Trash2 } from 'lucide-react';
import type { AiChatDto } from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { aiKeys, deleteAiChat, updateAiChat, useAiChats } from './aiApi.ts';

type Group = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';
const ORDER: Group[] = ['pinned', 'today', 'yesterday', 'week', 'older'];

function groupOf(chat: AiChatDto, now: number): Group {
  if (chat.pinned) return 'pinned';
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const updated = Date.parse(chat.updatedAt);
  if (updated >= start.getTime()) return 'today';
  if (updated >= start.getTime() - 86_400_000) return 'yesterday';
  if (updated >= start.getTime() - 6 * 86_400_000) return 'week';
  return 'older';
}

export function ChatList({ activeId, onPick }: { activeId: string | null; onPick: () => void }) {
  const { m } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<AiChatDto | null>(null);
  const [name, setName] = useState('');
  const chats = useAiChats(query, true);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);

  const groups = useMemo(() => {
    const now = Date.now();
    const out = new Map<Group, AiChatDto[]>();
    for (const chat of chats.data ?? []) {
      const group = groupOf(chat, now);
      out.set(group, [...(out.get(group) ?? []), chat]);
    }
    return out;
  }, [chats.data]);

  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: aiKeys.allChats });

  const patch = async (chat: AiChatDto, change: { pinned?: boolean; title?: string }): Promise<void> => {
    try {
      await updateAiChat(chat.id, change);
      await refresh();
    } catch (error) {
      toast.error(error);
    }
  };

  const remove = async (chat: AiChatDto): Promise<void> => {
    const answer = await confirm({ title: m.ai.deleteChat, text: m.ai.deleteConfirm, confirmLabel: m.common.delete, danger: true });
    if (!answer.confirmed) return;
    try {
      await deleteAiChat(chat.id);
      await refresh();
      if (chat.id === activeId) await navigate('/ai');
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <aside className="tai-list" aria-label={m.ai.chats}>
      <div className="tai-list__top">
        <Button
          block
          icon={<SquarePen />}
          onClick={() => {
            onPick();
            void navigate('/ai');
          }}
        >
          {m.ai.newChat}
        </Button>
        <label className="tai-list__search">
          <Search aria-hidden="true" />
          <input type="search" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={m.ai.searchChats} aria-label={m.ai.searchChats} />
        </label>
      </div>
      <nav className="tai-list__scroll">
        {chats.data === undefined ? (
          <div style={{ padding: 12, display: 'grid', gap: 10 }}>
            <Skeleton height={16} />
            <Skeleton height={16} width="70%" />
            <Skeleton height={16} width="85%" />
          </div>
        ) : chats.data.length === 0 ? (
          <p className="tai-list__empty">{query.length > 0 ? m.ai.noMatches : m.ai.noChats}</p>
        ) : (
          ORDER.filter((group) => groups.has(group)).map((group) => (
            <div key={group} className="tai-list__group">
              <div className="tai-list__label">{m.ai.groups[group]}</div>
              {groups.get(group)!.map((chat) => (
                <div key={chat.id} className="tai-list__item" data-active={chat.id === activeId || undefined}>
                  <NavLink to={`/ai/${chat.id}`} onClick={onPick} title={chat.title}>
                    {(chat.running || chat.waiting) && <span className="tai-list__dot" data-waiting={chat.waiting || undefined} aria-hidden="true" />}
                    <span className="truncate">{chat.title.length > 0 ? chat.title : m.ai.untitled}</span>
                  </NavLink>
                  <Menu
                    label={chat.title}
                    trigger={(props) => (
                      <button type="button" className="tai-list__more" {...props} aria-label={m.ai.chatMenu}>
                        <Ellipsis aria-hidden="true" />
                      </button>
                    )}
                  >
                    <MenuItem
                      icon={<Pencil />}
                      onSelect={() => {
                        setName(chat.title);
                        setRenaming(chat);
                      }}
                    >
                      {m.ai.rename}
                    </MenuItem>
                    <MenuItem icon={chat.pinned ? <PinOff /> : <Pin />} onSelect={() => void patch(chat, { pinned: !chat.pinned })}>
                      {chat.pinned ? m.ai.unpin : m.ai.pin}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 />} danger onSelect={() => void remove(chat)}>
                      {m.ai.deleteChat}
                    </MenuItem>
                  </Menu>
                </div>
              ))}
            </div>
          ))
        )}
      </nav>
      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title={m.ai.rename}
        onSubmit={(event) => {
          event.preventDefault();
          const chat = renaming;
          if (chat === null || name.trim().length === 0) return;
          setRenaming(null);
          void patch(chat, { title: name.trim() });
        }}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>{m.common.cancel}</Button>
            <Button variant="primary" type="submit" disabled={name.trim().length === 0}>
              {m.common.save}
            </Button>
          </>
        }
      >
        <Field label={m.ai.chatTitle}>
          <Input value={name} maxLength={120} autoFocus onChange={(event) => setName(event.target.value)} />
        </Field>
      </Dialog>
    </aside>
  );
}
