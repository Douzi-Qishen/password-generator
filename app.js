import { generatePassword, getKeyInfo, analyzePassword, SYMBOLS, KEYBOARD_COST_MODEL } from './generator.js';

const $ = id => document.getElementById(id);
const state = { length: 10, friendly: true, memorable: true, result: null, hidden: false, selected: 0 };
let copyAttempt = 0;
const practice = { cursor: 0, error: '' };

function clearPressedKeys() {
  document.querySelectorAll('.key.pressed').forEach(key => key.classList.remove('pressed'));
}

function resetPractice() {
  practice.cursor = 0;
  practice.error = '';
  state.selected = 0;
  clearPressedKeys();
}

function renderPractice() {
  const available = Boolean(state.result) && !state.hidden;
  const length = state.result?.password.length ?? state.length;
  $('practice-area').tabIndex = available ? 0 : -1;
  $('practice-area').setAttribute('aria-disabled', String(!available));
  const active = available && document.activeElement === $('practice-area');
  $('practice-mode').textContent = !available ? '练习暂不可用'
    : active ? '正在练习 · Esc 退出 · ⌫ 回退' : '点击此处，开始练习';
  $('practice-reset').disabled = !available;
  $('practice-progress').textContent = available ? `${practice.cursor} / ${length}` : '—';
  $('practice-status').classList.toggle('error', Boolean(practice.error));
  $('practice-status').textContent = !available
    ? '显示密码后可练习输入。'
    : practice.error || (practice.cursor === length
      ? '全部正确，已完成一遍输入。'
      : '');
  for (const step of $('steps').children) {
    const index = Number(step.dataset.index);
    step.classList.toggle('completed', available && index < practice.cursor);
    step.classList.toggle('mistake', available && Boolean(practice.error) && index === practice.cursor);
  }
}

function characterClass(char) {
  if (/[A-Z]/.test(char)) return 'upper';
  if (/[a-z]/.test(char)) return 'lower';
  if (/[0-9]/.test(char)) return 'digit';
  return 'symbol';
}

function coloredText(text) {
  const fragment = document.createDocumentFragment();
  for (const character of text) {
    const span = document.createElement('span');
    span.textContent = character;
    span.className = characterClass(character);
    fragment.append(span);
  }
  return fragment;
}

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}

const keyboardRows = [
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', ['delete', 'wide']],
  [['tab', 'wide'], 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
  [['caps lock', 'extra-wide'], 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", ['return', 'wide']],
  [['shift-left', 'extra-wide'], 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', ['shift-right', 'extra-wide']],
  [['control', 'wide'], ['option', 'wide'], ['command', 'extra-wide'], ['space', 'space'], ['command', 'extra-wide'], ['option', 'wide']],
];

for (const row of keyboardRows) {
  const rowElement = document.createElement('div');
  rowElement.className = 'key-row';
  for (const entry of row) {
    const [key, width] = Array.isArray(entry) ? entry : [entry, ''];
    const keyElement = document.createElement('span');
    keyElement.className = `key ${width}`;
    keyElement.dataset.key = key;
    keyElement.textContent = key.startsWith('shift-') ? 'shift' : key === 'space' ? '' : key.length === 1 ? key.toUpperCase() : key;
    rowElement.append(keyElement);
  }
  $('keyboard').append(rowElement);
}

function renderHint() {
  renderPractice();
  document.querySelectorAll('.key.active').forEach(key => key.classList.remove('active'));
  $('current-character').replaceChildren();
  $('key-instruction').replaceChildren();
  const visible = Boolean(state.result) && !state.hidden;
  $('hidden-hint').hidden = !state.hidden;
  for (const step of $('steps').children) {
    step.setAttribute('aria-pressed', String(!state.hidden && Number(step.dataset.index) === state.selected));
  }
  if (!visible) {
    $('current-character').textContent = state.hidden ? '•' : '—';
    $('key-instruction').textContent = state.hidden ? '显示密码后可查看输入提示。' : '生成密码后可查看输入提示。';
    return;
  }
  if (state.selected === state.result.password.length) {
    $('current-character').textContent = '✓';
    $('key-instruction').textContent = '输入完成。可以重新练习，或换一个密码。';
    return;
  }
  const character = state.result.password[state.selected];
  const info = getKeyInfo(character);
  const hand = info.hand === 'left' ? '左手' : '右手';
  $('current-character').append(coloredText(character));
  const line = document.createElement('p');
  line.append(`${hand}${info.finger}，按 `);
  const key = document.createElement('kbd');
  key.textContent = info.key.toUpperCase();
  line.append(key, ' 键。');
  const shiftLine = document.createElement('p');
  shiftLine.textContent = info.shift
    ? `同时按住${info.shiftHand === 'left' ? '左' : '右'}侧 Shift。`
    : '无需按住 Shift。';
  $('key-instruction').append(line, shiftLine);
  for (const keyElement of document.querySelectorAll('.key')) {
    if (keyElement.dataset.key === info.key ||
        (info.shift && keyElement.dataset.key === `shift-${info.shiftHand}`)) {
      keyElement.classList.add('active');
    }
  }
}

function selectStep(index) {
  state.selected = index;
  renderHint();
}

function render() {
  const password = state.result?.password ?? '';
  $('password').replaceChildren();
  $('chunks').replaceChildren();
  $('steps').replaceChildren();
  if (state.hidden) {
    $('password').textContent = '•'.repeat(password.length);
    $('password').setAttribute('aria-label', '密码已隐藏');
  } else {
    $('password').append(coloredText(password));
    $('password').setAttribute('aria-label', '生成的密码');
  }
  if (password) {
    state.result.segments.forEach((segment, index) => {
      if (index > 0) {
        const separator = document.createElement('span');
        separator.className = 'chunk-separator';
        separator.textContent = '·';
        separator.setAttribute('aria-hidden', 'true');
        $('chunks').append(separator);
      }
      const block = document.createElement('span');
      block.className = 'chunk-block';
      const text = document.createElement('span');
      if (state.hidden) text.textContent = '•'.repeat(segment.text.length);
      else text.append(coloredText(segment.text));
      block.append(text);
      if (!state.hidden && state.memorable) {
        const reading = document.createElement('span');
        reading.className = 'chunk-reading';
        if (segment.kind === 'word') {
          reading.textContent = segment.readingParts.join('·');
        } else {
          reading.textContent = '数字 / 符号';
        }
        block.append(reading);
      }
      $('chunks').append(block);
    });
    for (const [index, character] of [...password].entries()) {
      const step = document.createElement('button');
      step.type = 'button';
      step.className = 'step';
      step.dataset.index = index;
      step.setAttribute('aria-pressed', String(index === state.selected));
      step.setAttribute('aria-label', state.hidden ? `第 ${index + 1} 个字符已隐藏` : `第 ${index + 1} 个字符 ${character}`);
      step.disabled = state.hidden;
      if (state.hidden) {
        step.textContent = '•';
      } else {
        step.append(coloredText(character));
        const hand = document.createElement('span');
        hand.className = 'step-hand';
        hand.textContent = getKeyInfo(character).hand === 'left' ? '左' : '右';
        hand.setAttribute('aria-hidden', 'true');
        step.append(hand);
      }
      step.addEventListener('click', () => selectStep(index));
      step.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + password.length) % password.length;
        selectStep(next);
        $('steps').children[next].focus();
      });
      $('steps').append(step);
    }
  }
  $('copy').disabled = !password;
  $('visibility').disabled = !password;
  $('visibility').setAttribute('aria-pressed', String(state.hidden));
  $('visibility').querySelector('span').textContent = state.hidden ? '显示密码' : '隐藏密码';
  $('entropy').textContent = state.result ? `${state.result.entropyBits.toFixed(1)} bit` : '—';
  const analysis = state.result ? analyzePassword(password) : null;
  const metric = value => state.hidden && analysis ? '已隐藏' : analysis ? value : '—';
  const limit = state.result?.friendlyCostLimit;
  $('typing-cost').textContent = metric(analysis
    ? `${analysis.ergonomicCost}${limit === null ? ' · 不限' : ` / ${limit}`}`
    : '');
  $('shift-count').textContent = state.hidden && analysis ? '已隐藏' : analysis ? `${analysis.shiftCount} 个` : '—';
  $('shift-presses').textContent = metric(analysis ? `${analysis.shiftPresses} 次` : '');
  $('alternation').textContent = state.hidden && analysis ? '已隐藏' : analysis ? `${analysis.handSwitchCount} / ${password.length - 1}` : '—';
  $('rhythm-summary').textContent = state.hidden && analysis
    ? '输入节奏已隐藏'
    : analysis ? `输入成本 ${analysis.ergonomicCost}${limit === null ? '（不限）' : `/${limit}`} · 主键换手 ${analysis.handSwitchCount}/${password.length - 1} · Shift 按下 ${analysis.shiftPresses} 次` : '';
  const costRows = [
    ['sameHand', 'sameHandTransitions', '次'],
    ['shiftPress', 'shiftPresses', '次'],
    ['shiftSwitch', 'shiftSideSwitches', '次'],
    ['rowTravel', 'rowTravel', '排'],
    ['pinky', 'pinkyKeyCount', '次'],
  ];
  for (const [costKey, countKey, unit] of costRows) {
    $(`cost-${costKey}`).textContent = metric(analysis
      ? `${analysis[countKey]} ${unit} × ${KEYBOARD_COST_MODEL[costKey]} = ${analysis.costBreakdown[costKey]}`
      : '');
  }
  $('cost-rule').textContent = state.friendly
    ? `总成本上限为长度 × ${KEYBOARD_COST_MODEL.costPerCharacter}，当前 ${state.length * KEYBOARD_COST_MODEL.costPerCharacter}；同时禁止相邻重复同一个物理键（例如 aA 或 2@）。`
    : '键盘友好已关闭：仍显示输入成本供参考，但不限制总成本或相邻重复键。';
  $('symbol-set').textContent = SYMBOLS;
  $('memory-title').textContent = '分段记忆';
  $('memory-note').textContent = '· 仅用于分组';
  $('length-advice').textContent = state.length === 10 ? '默认 10 位。更长通常更安全。' : `当前 ${state.length} 位。允许时建议选择 10 位。`;
  $('mode-description').textContent = state.friendly ? '综合考虑换手、Shift、跨排移动和小指负担。' : '保留全部符号，不限制输入成本和按键顺序。';
  const memoryPolicy = state.memorable
    ? '词形助记：保留常规辅音–元音结构，加入段首 qu、词尾 x 和音节开头 y；两段 3–4 位拟词配合数字/符号段，按真实词形边界分组。'
    : '完全随机：从全部大小写字母、数字和所选符号中抽取，分组仅供显示，不约束词形。';
  const keyboardPolicy = state.friendly
    ? '键盘友好：在总输入成本上限内随机抽取，换手与 Shift 操作等因素共同决定是否保留；不单独限定大写数量或同手次数。'
    : '关闭键盘友好：不按输入成本筛选。';
  $('policy-description').textContent = `${memoryPolicy} ${keyboardPolicy}`;
  renderHint();
}

function regenerate() {
  copyAttempt += 1;
  feedback('');
  resetPractice();
  try {
    state.result = generatePassword({ length: state.length, friendly: state.friendly, memorable: state.memorable });
    state.selected = 0;
    render();
  } catch {
    // Do not retain an old password when the requested configuration fails.
    state.result = null;
    render();
    feedback('无法安全生成密码。请使用支持 Web Crypto 的现代浏览器，并通过本地启动地址访问。', true);
  }
}

document.querySelectorAll('[data-length]').forEach(button => {
  button.addEventListener('click', () => {
    if (state.length === Number(button.dataset.length)) return;
    state.length = Number(button.dataset.length);
    document.querySelectorAll('[data-length]').forEach(item => {
      item.setAttribute('aria-pressed', String(item === button));
    });
    regenerate();
  });
});
document.querySelectorAll('[data-memorable]').forEach(button => {
  button.addEventListener('click', () => {
    const memorable = button.dataset.memorable === 'true';
    if (state.memorable === memorable) return;
    state.memorable = memorable;
    document.querySelectorAll('[data-memorable]').forEach(item => {
      item.setAttribute('aria-pressed', String(item === button));
    });
    regenerate();
  });
});
$('friendly').addEventListener('change', event => {
  state.friendly = event.target.checked;
  regenerate();
});
$('generate').addEventListener('click', regenerate);
$('visibility').addEventListener('click', () => {
  state.hidden = !state.hidden;
  resetPractice();
  render();
});

// Only the focused practice region consumes keys; no typed text is stored.
const practiceArea = $('practice-area');
const physicalCodes = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  ShiftLeft: 'shift-left', ShiftRight: 'shift-right', Backspace: 'delete',
  CapsLock: 'caps lock', Space: 'space',
};
function physicalKey(event) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  return physicalCodes[event.code] ?? getKeyInfo(event.key)?.key;
}
function pressKey(key, pressed) {
  for (const element of $('keyboard').querySelectorAll('.key')) {
    if (element.dataset.key === key) element.classList.toggle('pressed', pressed);
  }
}
practiceArea.addEventListener('click', () => {
  if (state.result && !state.hidden) practiceArea.focus({ preventScroll: true });
});
practiceArea.addEventListener('focus', renderPractice);
practiceArea.addEventListener('keydown', event => {
  if (event.target !== practiceArea || !state.result || state.hidden ||
      $('explanation-dialog').open || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Tab') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    practiceArea.blur();
    return;
  }
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') {
    practice.error = '请切换到英文输入，逐字敲击。';
    renderPractice();
    return;
  }
  pressKey(physicalKey(event), true);
  if (event.key !== 'Backspace' && event.key.length !== 1) return;
  event.preventDefault();
  if (event.repeat) return;
  if (event.key === 'Backspace') {
    practice.cursor = Math.max(0, practice.cursor - 1);
    practice.error = '';
  } else if (practice.cursor === state.result.password.length) {
    return;
  } else if (!/^[\x21-\x7e]$/.test(event.key)) {
    practice.error = '请使用英文输入，不输入空格。';
  } else if (event.key === state.result.password[practice.cursor]) {
    practice.cursor += 1;
    practice.error = '';
  } else {
    practice.error = '这一位不匹配，请检查大小写和 Shift 后重试。';
  }
  state.selected = practice.cursor;
  renderHint();
});
practiceArea.addEventListener('keyup', event => pressKey(physicalKey(event), false));
practiceArea.addEventListener('blur', () => {
  clearPressedKeys();
  renderPractice();
});
window.addEventListener('blur', clearPressedKeys);
practiceArea.addEventListener('paste', event => {
  if (event.target !== practiceArea || !state.result || state.hidden) return;
  event.preventDefault();
  practice.error = '请逐字敲击练习，不使用粘贴。';
  renderHint();
});
practiceArea.addEventListener('dragover', event => event.preventDefault());
practiceArea.addEventListener('drop', event => event.preventDefault());
$('practice-reset').addEventListener('click', () => {
  resetPractice();
  renderHint();
  practiceArea.focus({ preventScroll: true });
});

const explanationDialog = $('explanation-dialog');
$('open-explanation').addEventListener('click', () => {
  clearPressedKeys();
  explanationDialog.showModal();
  explanationDialog.scrollTop = 0;
  document.body.classList.add('dialog-open');
});
$('close-explanation').addEventListener('click', () => explanationDialog.close());
explanationDialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));
explanationDialog.addEventListener('click', event => {
  if (event.target !== explanationDialog) return;
  const bounds = explanationDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) explanationDialog.close();
});
$('copy').addEventListener('click', async () => {
  if (!state.result) return;
  const password = state.result.password;
  const attempt = ++copyAttempt;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(password);
    if (attempt === copyAttempt) feedback('已复制完整密码，不包含助记分隔点或空格。');
  } catch {
    if (attempt === copyAttempt) feedback('浏览器未允许复制。请显示密码，选中后按 ⌘C 复制。', true);
  }
});

// Returning from back/forward cache creates a fresh password instead of restoring one.
window.addEventListener('pagehide', () => {
  state.result = null;
  resetPractice();
  if (explanationDialog.open) explanationDialog.close();
  copyAttempt += 1;
  render();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) regenerate();
});

regenerate();
