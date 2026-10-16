/**
 * The AI explanation drawer: a collapsible strip between the toolbar and the panes
 * that streams the model's markdown in. Rendering is a deliberately tiny subset —
 * escape everything first, then re-introduce only headings, bold, code, and lists —
 * so no third-party renderer enters the webview's CSP surface.
 */

export interface ExplainDrawer {
  openLoading(conflictCount: number): void;
  appendDelta(text: string): void;
  /** A muted tool-progress line ("⚙ Read src/x.ts") in the stream's flow. */
  appendActivity(text: string): void;
  finish(truncated?: boolean): void;
  showError(message: string, unconfigured: boolean): void;
  /** Marks the resolve request in flight: disables the button, shows progress. */
  setResolving(active: boolean): void;
  /** Renders the outcome line after resolutions were applied. */
  showResolveReport(
    applied: number,
    requested: number,
    remaining: number,
    mechanical?: number,
  ): void;
  /** The raw explanation text accumulated so far — context for the resolve request. */
  explanationText(): string;
  /** Appends the user's question and switches into streaming for the answer. */
  askStart(question: string): void;
  readonly isOpen: boolean;
}

export interface ExplainDrawerCallbacks {
  /** Fired when the user closes the drawer while a response is still streaming. */
  onCancel(): void;
  /** Fired from the "Set Anthropic API key" button in the unconfigured panel. */
  onSetup(): void;
  /** Fired from the "Resolve with AI" header button. */
  onResolve(): void;
  /** Fired when the user submits a follow-up question. */
  onAsk(question: string): void;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Bold and code spans over already-escaped text. */
function inline(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Renders the supported markdown subset to an HTML string; input is untrusted. */
export function renderMarkdown(source: string): string {
  const parts: string[] = [];
  // Fenced blocks first, so their contents are never treated as markdown.
  const segments = source.split(/```[^\n]*\n?/);
  for (const [index, segment] of segments.entries()) {
    if (index % 2 === 1) {
      parts.push(`<pre><code>${escapeHtml(segment)}</code></pre>`);
      continue;
    }
    let listOpen = false;
    for (const line of segment.split('\n')) {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const listItem = /^[-*]\s+(.*)$/.exec(line);
      if (listItem && !heading) {
        if (!listOpen) {
          parts.push('<ul>');
          listOpen = true;
        }
        parts.push(`<li>${inline(escapeHtml(listItem[1] ?? ''))}</li>`);
        continue;
      }
      if (listOpen) {
        parts.push('</ul>');
        listOpen = false;
      }
      if (heading) {
        const level = Math.min((heading[1] ?? '###').length + 2, 6);
        parts.push(`<h${level}>${inline(escapeHtml(heading[2] ?? ''))}</h${level}>`);
      } else if (line.trim() !== '') {
        parts.push(`<p>${inline(escapeHtml(line))}</p>`);
      }
    }
    if (listOpen) {
      parts.push('</ul>');
    }
  }
  return parts.join('');
}

export function createExplainDrawer(
  host: HTMLElement,
  callbacks: ExplainDrawerCallbacks,
): ExplainDrawer {
  const header = document.createElement('div');
  header.className = 'mf-explain-header';
  const title = document.createElement('span');
  title.className = 'mf-explain-title';
  title.textContent = '✦ AI explanation';
  const resolve = document.createElement('button');
  resolve.className = 'mf-explain-resolve';
  resolve.textContent = '✦ Resolve with AI';
  resolve.title = 'Let the AI write a merged version of every unresolved conflict into the result';
  resolve.addEventListener('click', () => callbacks.onResolve());
  const close = document.createElement('button');
  close.className = 'mf-explain-close';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close explanation');
  const closeGlyph = document.createElement('span');
  closeGlyph.className = 'codicon codicon-close';
  close.append(closeGlyph);
  header.append(title, resolve, close);

  const body = document.createElement('div');
  body.className = 'mf-explain-body';

  // The follow-up chat row: a question about these conflicts, answered in-stream.
  const askRow = document.createElement('form');
  askRow.className = 'mf-explain-ask';
  const askInput = document.createElement('input');
  askInput.type = 'text';
  askInput.placeholder = 'Ask about these conflicts…';
  askInput.setAttribute('aria-label', 'Ask about these conflicts');
  const askSend = document.createElement('button');
  askSend.type = 'submit';
  askSend.textContent = 'Ask';
  askRow.append(askInput, askSend);
  askRow.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = askInput.value.trim();
    if (question !== '') {
      askInput.value = '';
      callbacks.onAsk(question);
    }
  });

  host.classList.add('mf-explain', 'mf-hidden');
  host.replaceChildren(header, body, askRow);

  let streaming = false;
  let resolving = false;
  // The stream interleaves markdown with tool-activity lines; explanationText()
  // (the resolve request's context) must carry only the markdown.
  let parts: Array<{ kind: 'md' | 'activity'; text: string }> = [];
  let stickToBottom = true;

  const appendMd = (text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.kind === 'md') {
      last.text += text;
    } else {
      parts.push({ kind: 'md', text });
    }
  };

  const RESOLVING_HTML =
    '<p class="mf-explain-waiting">Resolving conflicts<span class="mf-explain-cursor"></span></p>';

  const syncResolveButton = (): void => {
    const busy = streaming || resolving;
    resolve.toggleAttribute('disabled', busy);
    askInput.toggleAttribute('disabled', busy);
    askSend.toggleAttribute('disabled', busy);
  };

  body.addEventListener('scroll', () => {
    stickToBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  });

  const render = (extraHtml = ''): void => {
    const html = parts
      .map((part) =>
        part.kind === 'activity'
          ? `<p class="mf-explain-activity">${escapeHtml(part.text)}</p>`
          : renderMarkdown(part.text),
      )
      .join('');
    body.innerHTML = `${html}${
      streaming ? '<span class="mf-explain-cursor"></span>' : ''
    }${extraHtml}`;
    if (stickToBottom) {
      body.scrollTop = body.scrollHeight;
    }
  };

  close.addEventListener('click', () => {
    if (streaming || resolving) {
      callbacks.onCancel();
      streaming = false;
      resolving = false;
      syncResolveButton();
    }
    host.classList.add('mf-hidden');
  });

  return {
    get isOpen() {
      return !host.classList.contains('mf-hidden');
    },
    openLoading(conflictCount) {
      streaming = true;
      parts = [];
      stickToBottom = true;
      syncResolveButton();
      // The scope in the header: one section per unresolved conflict is coming, no more —
      // so a single section on a single-conflict file doesn't read as an early stop.
      title.textContent = `✦ AI explanation — ${conflictCount} unresolved conflict${
        conflictCount === 1 ? '' : 's'
      }`;
      host.classList.remove('mf-hidden');
      body.innerHTML =
        '<p class="mf-explain-waiting">Thinking<span class="mf-explain-cursor"></span></p>';
    },
    appendDelta(text) {
      if (!streaming) {
        return;
      }
      appendMd(text);
      render();
    },
    appendActivity(text) {
      if (!streaming && !resolving) {
        return;
      }
      parts.push({ kind: 'activity', text });
      render(resolving ? RESOLVING_HTML : '');
    },
    finish(truncated) {
      streaming = false;
      syncResolveButton();
      render(
        truncated
          ? '<p class="mf-explain-truncated">⚠ Output limit reached — the explanation may be incomplete.</p>'
          : '',
      );
    },
    setResolving(active) {
      resolving = active;
      syncResolveButton();
      if (active) {
        host.classList.remove('mf-hidden');
        render(RESOLVING_HTML);
      }
    },
    showResolveReport(applied, requested, remaining, mechanical = 0) {
      resolving = false;
      syncResolveButton();
      const alsoApplied =
        mechanical > 0
          ? ` + applied ${mechanical} non-conflicting change${mechanical === 1 ? '' : 's'}`
          : '';
      const left =
        remaining > 0
          ? ` ${remaining} conflict${remaining === 1 ? '' : 's'} left for you.`
          : ' All conflicts are resolved.';
      render(
        `<p class="mf-explain-report">✦ Resolved ${applied} of ${requested} conflict${
          requested === 1 ? '' : 's'
        }${alsoApplied} — review the result; Cmd+Z reverts.${left}</p>`,
      );
    },
    explanationText() {
      return parts
        .filter((part) => part.kind === 'md')
        .map((part) => part.text)
        .join('');
    },
    askStart(question) {
      streaming = true;
      stickToBottom = true;
      syncResolveButton();
      host.classList.remove('mf-hidden');
      const hasText = parts.some((part) => part.kind === 'md' && part.text.trim() !== '');
      appendMd(`${hasText ? '\n\n---\n\n' : ''}**You:** ${question}\n\n`);
      render();
    },
    showError(message, unconfigured) {
      streaming = false;
      host.classList.remove('mf-hidden');
      if (!unconfigured) {
        body.innerHTML = `<p class="mf-explain-error">${escapeHtml(message)}</p>`;
        return;
      }
      // Setup guidance rather than a bare failure: the backends, one button.
      body.replaceChildren();
      const info = document.createElement('p');
      info.textContent =
        'No AI backend is available. In VS Code with GitHub Copilot this works out of the box; ' +
        'in Cursor (which does not expose its models to extensions) or without Copilot, ' +
        'set an API key for Anthropic, OpenAI, DeepSeek, Kimi, or any OpenAI-compatible ' +
        'endpoint (OpenRouter, local Ollama, …). Keys are stored in secure storage and used ' +
        'only for explanations.';
      const setup = document.createElement('button');
      setup.className = 'mf-explain-setup';
      setup.textContent = 'Set AI provider & key';
      setup.addEventListener('click', callbacks.onSetup);
      body.append(info, setup);
    },
  };
}
