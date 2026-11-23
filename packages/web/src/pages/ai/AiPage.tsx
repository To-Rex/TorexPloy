/**
 * TorexAi: the assistant that runs the platform and its servers in plain
 * words. Conversations on the left, the one in hand on the right.
 *
 * The page stays out of the way of the answer: what the assistant looked at
 * folds into a line, what it changed is a card that asks first, and the rest
 * is prose, charts and files.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowDown, Check, Copy, PanelLeft, Settings, ShieldCheck, Sparkles, SquarePen } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AiActionDto, AiContextInput, AiMessageDto, AiStatusDto } from '@ploy/shared';
import { writeClipboard } from '../../components/Copy.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, EmptyState, Skeleton, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useBootstrap } from '../../lib/queries.ts';
import { ActionRun, FileChips } from './Actions.tsx';
import { aiKeys, createAiChat, sendAiMessage, stopAiChat, updateAiChat, uploadAiFile, useAiStatus, useConversation, type Conversation } from './aiApi.ts';
import { ChatList } from './ChatList.tsx';
import { Composer } from './Composer.tsx';
import { Markdown } from './Markdown.tsx';
import './ai.css';

const SUGGESTIONS = ['health', 'deploy', 'domain', 'disk', 'database', 'token'] as const;

/** The mark of the assistant: a small spark in a soft tile. */
export function AiMark({ size = 28 }: { size?: number }) {
  return (
    <span className="tai-mark" style={{ width: size, height: size }} aria-hidden="true">
      <Sparkles style={{ width: size * 0.56, height: size * 0.56 }} />
    </span>
  );
}

function Unavailable({ status }: { status: AiStatusDto }) {
  const { m } = useI18n();
  const reason = status.reason ?? 'not_configured';
  const text = m.ai.unavailable[reason];
  return (
    <div className="page">
      <EmptyState
        icon={<Sparkles />}
        title={text.title}
        action={
          status.canConfigure ? (
            <Link className="btn btn--primary" to="/settings/ai" style={{ textDecoration: 'none' }}>
              <Settings aria-hidden="true" />
              {m.ai.openSettings}
            </Link>
          ) : undefined
        }
      >
        {status.canConfigure ? text.admin : text.text}
      </EmptyState>
    </div>
  );
}

/** What the conversation is about when it was opened from another page. */
function useCarried(): { prompt: string; context: AiContextInput | undefined } {
  const [params] = useSearchParams();
  return useMemo(() => {
    const context: AiContextInput = {};
    const set = (key: keyof AiContextInput, value: string | null): void => {
      if (value !== null && value.length > 0) context[key] = value;
    };
    set('applicationId', params.get('app'));
    set('serviceId', params.get('service'));
    set('serverId', params.get('server'));
    set('deploymentId', params.get('deployment'));
    set('projectId', params.get('project'));
    return { prompt: params.get('prompt') ?? '', context: Object.keys(context).length > 0 ? context : undefined };
  }, [params]);
}

function CopyReply({ text }: { text: string }) {
  const { m } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tai-reply__tool"
      aria-label={m.common.copy}
      title={m.common.copy}
      onClick={() => {
        void writeClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}

/**
 * One assistant message: what it said, then what it did. The actions are
 * found by the message they belong to, not by the message's own list: a
 * message is announced before its actions exist, and they arrive one by one.
 */
function AssistantBlocks({ message, actions, live }: { message: AiMessageDto; actions: AiActionDto[]; live: boolean }) {
  const text = message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n');
  return (
    <>
      {text.length > 0 && <Markdown text={text} />}
      {actions.length > 0 && <ActionRun actions={actions} live={live} />}
    </>
  );
}

function Transcript({ conversation, onContinue }: { conversation: Conversation; onContinue: (text: string) => void }) {
  const { m, t, formatNumber } = useI18n();
  const { messages, actions, draft, state } = conversation;
  const running = state !== 'idle';
  const [openSummary, setOpenSummary] = useState<string | null>(null);

  // Consecutive assistant messages are the steps of one reply and read as one.
  const turns: ({ kind: 'user'; message: AiMessageDto } | { kind: 'summary'; message: AiMessageDto } | { kind: 'assistant'; messages: AiMessageDto[] })[] = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push({ kind: 'user', message });
    else if (message.role === 'summary') turns.push({ kind: 'summary', message });
    else {
      const last = turns[turns.length - 1];
      if (last !== undefined && last.kind === 'assistant') last.messages.push(message);
      else turns.push({ kind: 'assistant', messages: [message] });
    }
  }
  const byMessage = useMemo(() => {
    const map = new Map<string, AiActionDto[]>();
    for (const action of Object.values(actions)) map.set(action.messageId, [...(map.get(action.messageId) ?? []), action]);
    for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return map;
  }, [actions]);
  const lastTurn = turns[turns.length - 1];
  const replyOpen = running && lastTurn?.kind === 'assistant';

  const errorText = (error: { code: string; message: string }): string => {
    const known = m.ai.errors as Record<string, string>;
    return known[error.code] ?? (error.message.length > 0 ? error.message : m.ai.errors.generic);
  };

  const status =
    state === 'waiting' ? m.ai.state.waiting : state === 'tool' ? m.ai.state.tool : state === 'thinking' ? m.ai.state.thinking : null;

  return (
    <div className="tai-thread">
      {turns.map((turn, index) => {
        if (turn.kind === 'user') {
          const files = turn.message.blocks.flatMap((block) => (block.type === 'file' ? [block.file] : []));
          const text = turn.message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
          return (
            <div key={turn.message.id} className="tai-user">
              <FileChips files={files} />
              <div className="tai-user__bubble">{text}</div>
            </div>
          );
        }
        if (turn.kind === 'summary') {
          const text = turn.message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
          const open = openSummary === turn.message.id;
          return (
            <div key={turn.message.id} className="tai-summary">
              <button type="button" onClick={() => setOpenSummary(open ? null : turn.message.id)} aria-expanded={open}>
                {m.ai.summaryDivider}
              </button>
              {open && <Markdown text={text} />}
            </div>
          );
        }
        const last = index === turns.length - 1;
        const whole = turn.messages.flatMap((message) => message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))).join('\n\n');
        const usage = turn.messages.reduce((sum, message) => sum + (message.usage === null ? 0 : message.usage.input - message.usage.cached + message.usage.output), 0);
        const model = [...turn.messages].reverse().find((message) => message.model !== null)?.model ?? null;
        return (
          <div key={turn.messages[0]!.id} className="tai-reply">
            {turn.messages.map((message, position) => (
              <div key={message.id} className="tai-reply__part">
                <AssistantBlocks message={message} actions={byMessage.get(message.id) ?? []} live={running && last && position === turn.messages.length - 1} />
                {message.error !== null && <p className="tai-reply__error">{errorText(message.error)}</p>}
              </div>
            ))}
            {last && running && draft.length > 0 && (
              <div className="tai-reply__part" data-streaming>
                <Markdown text={draft} />
              </div>
            )}
            {!(last && running) && whole.length > 0 && (
              <div className="tai-reply__foot">
                <CopyReply text={whole} />
                {model !== null && <span>{model.slice(model.indexOf(':') + 1)}</span>}
                {usage > 0 && <span>{t(m.ai.tokens, { count: formatNumber(Math.round(usage)) })}</span>}
              </div>
            )}
          </div>
        );
      })}

      {running && !replyOpen && draft.length > 0 && (
        <div className="tai-reply">
          <div className="tai-reply__part" data-streaming>
            <Markdown text={draft} />
          </div>
        </div>
      )}
      {running && status !== null && (
        <div className="tai-status" data-state={state} role="status">
          <span className="tai-status__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {status}
        </div>
      )}
      {!running && conversation.ended !== null && (
        <div className="tai-ended" data-reason={conversation.ended.reason}>
          <span>{conversation.ended.error !== undefined ? errorText(conversation.ended.error) : m.ai.ended[conversation.ended.reason]}</span>
          <Button size="sm" onClick={() => onContinue(m.ai.continuePrompt)}>
            {m.ai.continue}
          </Button>
        </div>
      )}
    </div>
  );
}

function ConversationView({ chatId, status, onOpenList }: { chatId: string | null; status: AiStatusDto; onOpenList: () => void }) {
  const { m, t, formatNumber } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const client = useQueryClient();
  const bootstrap = useBootstrap();
  const carried = useCarried();
  const { conversation, noteSent, setChat } = useConversation(chatId);
  const [sending, setSending] = useState(false);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);

  const chat = conversation.chat;
  const model = chat?.model ?? draftModel ?? status.defaultModel;
  const running = conversation.state !== 'idle';

  // Follow the reply as it grows, unless the person has scrolled up to read.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [conversation.messages, conversation.draft, conversation.actions, conversation.state]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinned.current = distance < 80;
    setAway(distance > 400);
  };

  const send = useCallback(
    async (text: string, files: File[]): Promise<boolean> => {
      setSending(true);
      try {
        const id = chatId ?? (await createAiChat(model ?? undefined)).id;
        const uploaded: string[] = [];
        for (const file of files) uploaded.push((await uploadAiFile(id, file)).id);
        const first = chatId === null;
        const message = await sendAiMessage(id, { text, files: uploaded, ...(first && carried.context !== undefined ? { context: carried.context } : {}) });
        pinned.current = true;
        // A conversation that has just begun appears in the list at once.
        void client.invalidateQueries({ queryKey: aiKeys.allChats });
        if (first) await navigate(`/ai/${id}`, { replace: true });
        else noteSent(message);
        return true;
      } catch (error) {
        toast.error(error);
        return false;
      } finally {
        setSending(false);
      }
    },
    [carried.context, chatId, client, model, navigate, noteSent, toast],
  );

  const changeModel = (ref: string): void => {
    if (chat === null) {
      setDraftModel(ref);
      return;
    }
    void updateAiChat(chat.id, { model: ref }).then(setChat, (error: unknown) => toast.error(error));
  };

  const toggleAuto = (value: boolean): void => {
    if (chat === null) return;
    void updateAiChat(chat.id, { autoApprove: value }).then(setChat, (error: unknown) => toast.error(error));
  };

  const firstName = (bootstrap.data?.user?.name ?? '').split(/\s+/)[0] ?? '';
  const empty = chatId === null || (conversation.loaded && conversation.messages.length === 0 && !running);

  return (
    <section className="tai-main">
      <header className="tai-head">
        <button type="button" className="tai-head__list" onClick={onOpenList} aria-label={m.ai.chats}>
          <PanelLeft aria-hidden="true" />
        </button>
        <h1 className="truncate">{chat !== null && chat.title.length > 0 ? chat.title : m.ai.newChat}</h1>
        <span className="grow" />
        {chat !== null && (
          <span className="tai-head__auto" title={m.ai.autoApproveHint}>
            <ShieldCheck aria-hidden="true" />
            <Switch checked={chat.autoApprove} onChange={toggleAuto} label={m.ai.autoApprove} />
          </span>
        )}
        {chat !== null && chat.tokens.input + chat.tokens.output > 0 && <span className="tai-head__tokens">{t(m.ai.tokens, { count: formatNumber(chat.tokens.input + chat.tokens.output, { notation: 'compact' }) })}</span>}
        <button type="button" className="tai-head__new" onClick={() => void navigate('/ai')} aria-label={m.ai.newChat} title={m.ai.newChat}>
          <SquarePen aria-hidden="true" />
        </button>
      </header>

      <div className="tai-scroll" ref={scroller} onScroll={onScroll}>
        {conversation.missing ? (
          <EmptyState icon={<Sparkles />} title={m.ai.missingTitle} action={<Link to="/ai">{m.ai.newChat}</Link>}>
            {m.ai.missingText}
          </EmptyState>
        ) : chatId !== null && !conversation.loaded ? (
          <div className="tai-thread">
            <Skeleton height={18} width="40%" />
            <Skeleton height={18} width="72%" />
            <Skeleton height={18} width="58%" />
          </div>
        ) : empty ? (
          <div className="tai-welcome">
            <AiMark size={52} />
            <h2>{firstName.length > 0 ? t(m.ai.greeting, { name: firstName }) : m.ai.name}</h2>
            <p>{m.ai.greetingText}</p>
            <div className="tai-welcome__grid">
              {SUGGESTIONS.map((key) => (
                <button key={key} type="button" disabled={sending} onClick={() => void send(m.ai.suggestions[key].prompt, [])}>
                  <strong>{m.ai.suggestions[key].title}</strong>
                  <span>{m.ai.suggestions[key].prompt}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Transcript conversation={conversation} onContinue={(text) => void send(text, [])} />
        )}
      </div>

      {away && (
        <button
          type="button"
          className="tai-jump"
          aria-label={m.ai.jumpToEnd}
          onClick={() => {
            pinned.current = true;
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ArrowDown aria-hidden="true" />
        </button>
      )}

      {!conversation.missing && (
        <div className="tai-foot">
          <Composer
            running={running}
            sending={sending}
            models={status.models}
            model={model}
            onModel={changeModel}
            onSend={send}
            onStop={() => {
              if (chatId !== null) void stopAiChat(chatId).catch((error: unknown) => toast.error(error));
            }}
            initialText={chatId === null ? carried.prompt : ''}
            focusKey={chatId ?? 'new'}
          />
          <p className="tai-foot__note">
            {status.usage.limit === null ? m.ai.disclaimer : `${m.ai.disclaimer} · ${t(m.ai.usageToday, { used: formatNumber(status.usage.today, { notation: 'compact' }), limit: formatNumber(status.usage.limit, { notation: 'compact' }) })}`}
          </p>
        </div>
      )}
    </section>
  );
}

export function AiPage() {
  const { chatId } = useParams();
  const { m } = useI18n();
  const status = useAiStatus();
  const [list, setList] = useState(false);
  usePageMeta([{ label: m.ai.name }]);

  if (status.data === undefined) {
    return (
      <div className="page">
        <Skeleton height={120} />
      </div>
    );
  }
  if (!status.data.ready) return <Unavailable status={status.data} />;
  return (
    <div className="tai" data-list={list ? 'open' : undefined}>
      <ChatList activeId={chatId ?? null} onPick={() => setList(false)} />
      <div className="tai-backdrop" onClick={() => setList(false)} aria-hidden="true" />
      <ConversationView key={chatId ?? 'new'} chatId={chatId ?? null} status={status.data} onOpenList={() => setList(true)} />
    </div>
  );
}
