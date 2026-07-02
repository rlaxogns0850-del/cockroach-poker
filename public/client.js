// public/client.js
const socket = io();

const BUG_META = {
  Cockroach: { emoji: '\u{1FAB3}', ko: '바퀴벌레' },
  Bat: { emoji: '\u{1F987}', ko: '박쥐' },
  Fly: { emoji: '\u{1FAB0}', ko: '파리' },
  Toad: { emoji: '\u{1F438}', ko: '두꺼비' },
  Rat: { emoji: '\u{1F400}', ko: '쥐' },
  Scorpion: { emoji: '\u{1F982}', ko: '전갈' },
  StinkBug: { emoji: '\u{1FAB2}', ko: '노린재' },
  Mosquito: { emoji: '\u{1F99F}', ko: '모기' },
};

let myId = null;
let myName = '';
let currentRoomId = null;
let lastState = null;

// Local selection state
let sel = { targetId: null, cardId: null, declaredType: null };
let passSel = { targetId: null, declaredType: null };

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function showScreen(name) {
  ['home', 'waiting', 'game', 'over'].forEach((s) => {
    $(`screen-${s}`).classList.toggle('hidden-force', s !== name);
  });
}
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden-force');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden-force'), 3200);
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- Drawer ----------
const drawer = $('drawer');
const drawerBackdrop = $('drawer-backdrop');
function openDrawer() {
  drawer.classList.remove('-translate-x-full');
  drawerBackdrop.classList.remove('hidden-force');
}
function closeDrawer() {
  drawer.classList.add('-translate-x-full');
  drawerBackdrop.classList.add('hidden-force');
}
$('waiting-menu-btn').addEventListener('click', openDrawer);
$('game-menu-btn').addEventListener('click', openDrawer);
drawerBackdrop.addEventListener('click', closeDrawer);
$('drawer-lobby').addEventListener('click', () => { closeDrawer(); leaveRoom(); });
$('drawer-rules').addEventListener('click', () => {
  closeDrawer();
  toast('게임 규칙은 로비 화면 상단에서 확인할 수 있어요.');
});

// ---------- Home screen ----------
$('btn-create-room').addEventListener('click', () => {
  myName = $('input-host-name').value.trim() || '호스트';
  $('drawer-name').textContent = myName;
  socket.emit('createRoom', { name: myName });
});
$('btn-join-room').addEventListener('click', () => {
  myName = $('input-join-name').value.trim() || '플레이어';
  $('drawer-name').textContent = myName;
  const code = $('input-room-code').value.trim().toUpperCase();
  if (!code) return toast('방 번호를 입력하세요.');
  socket.emit('joinRoom', { roomId: code, name: myName });
});
$('btn-vs-ai').addEventListener('click', () => {
  myName = $('input-host-name').value.trim() || $('input-join-name').value.trim() || '플레이어';
  $('drawer-name').textContent = myName;
  socket.emit('createRoom', { name: myName });
  window._autoAddBots = 2; // add bots once room is created
});

// ---------- Waiting room ----------
$('btn-leave-waiting').addEventListener('click', () => leaveRoom());
$('btn-add-bot').addEventListener('click', () => socket.emit('addBot', { roomId: currentRoomId }));
$('btn-start-game').addEventListener('click', () => socket.emit('startGame', { roomId: currentRoomId }));
$('btn-delete-room').addEventListener('click', () => {
  if (confirm('방을 삭제하시겠습니까? 모든 플레이어가 나가게 됩니다.')) {
    socket.emit('deleteRoom', { roomId: currentRoomId });
  }
});

// ---------- Game screen ----------
$('btn-leave-game').addEventListener('click', () => leaveRoom());
$('btn-guess-truth').addEventListener('click', () => socket.emit('respondGuess', { roomId: currentRoomId, guessedTruth: true }));
$('btn-guess-lie').addEventListener('click', () => socket.emit('respondGuess', { roomId: currentRoomId, guessedTruth: false }));

$('btn-open-propose').addEventListener('click', () => {
  if (!sel.cardId) return toast('먼저 아래 손패에서 카드를 선택하세요.');
  openProposeModal();
});
$('btn-cancel-propose').addEventListener('click', () => $('modal-propose').classList.add('hidden-force'));
$('btn-confirm-propose').addEventListener('click', () => {
  socket.emit('startTurn', {
    roomId: currentRoomId,
    targetId: sel.targetId,
    cardId: sel.cardId,
    declaredType: sel.declaredType,
  });
  $('modal-propose').classList.add('hidden-force');
  sel = { targetId: null, cardId: null, declaredType: null };
});

$('btn-open-pass').addEventListener('click', () => {
  passSel = { targetId: null, declaredType: null }; // always start fresh for this holder turn
  openPassModal();
});
$('btn-cancel-pass').addEventListener('click', () => $('modal-pass').classList.add('hidden-force'));
$('btn-confirm-pass').addEventListener('click', () => {
  socket.emit('respondPass', {
    roomId: currentRoomId,
    targetId: passSel.targetId,
    declaredType: passSel.declaredType,
  });
  $('modal-pass').classList.add('hidden-force');
  passSel = { targetId: null, declaredType: null };
});

// ---------- Game over ----------
$('btn-rematch').addEventListener('click', () => socket.emit('rematch', { roomId: currentRoomId }));
$('btn-back-home').addEventListener('click', () => leaveRoom());

function leaveRoom() {
  if (currentRoomId) socket.emit('leaveRoom', { roomId: currentRoomId });
  currentRoomId = null;
  lastState = null;
  sel = { targetId: null, cardId: null, declaredType: null };
  showScreen('home');
}

// ---------- Socket events ----------
socket.on('connect', () => { myId = socket.id; });

socket.on('roomCreated', ({ roomId }) => {
  currentRoomId = roomId;
  if (window._autoAddBots) {
    for (let i = 0; i < window._autoAddBots; i++) socket.emit('addBot', { roomId });
    window._autoAddBots = 0;
  }
});
socket.on('roomJoined', ({ roomId }) => { currentRoomId = roomId; });
socket.on('roomDeleted', () => {
  toast('호스트가 방을 삭제했습니다.');
  currentRoomId = null;
  lastState = null;
  showScreen('home');
});
socket.on('errorMessage', ({ message }) => toast(message));

socket.on('gameState', (state) => {
  lastState = state;
  currentRoomId = state.roomId;
  render(state);
});

// ---------- Master render ----------
function render(state) {
  closeDrawer();
  if (state.state === 'WAITING_ROOM') {
    renderWaiting(state);
    showScreen('waiting');
  } else if (state.state === 'PLAYING') {
    renderGame(state);
    showScreen('game');
  } else if (state.state === 'GAME_OVER') {
    renderGameOver(state);
    showScreen('over');
  }
}

// ---------- Waiting room render ----------
function renderWaiting(state) {
  $('waiting-room-code').textContent = state.roomId;
  $('waiting-status').textContent = `로비 상태: ${state.players.length}/6 접속 중`;

  const list = $('waiting-player-list');
  list.innerHTML = '';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between bg-surface-container-high/40 border border-outline-variant/30 rounded-lg px-4 py-3';
    const tags = [];
    if (p.id === state.hostId) tags.push('<span class="text-[10px] px-2 py-0.5 rounded-full bg-primary-fixed/15 text-primary-fixed font-label-mono">호스트</span>');
    if (p.isBot) tags.push('<span class="text-[10px] px-2 py-0.5 rounded-full bg-tertiary-fixed/15 text-tertiary-fixed font-label-mono">🤖 봇</span>');
    if (p.id === myId) tags.push('<span class="text-[10px] px-2 py-0.5 rounded-full bg-outline/15 text-outline font-label-mono">나</span>');
    li.innerHTML = `<span class="font-body-md text-sm">${escapeHtml(p.name)}</span><span class="flex gap-1">${tags.join(' ')}</span>`;
    list.appendChild(li);
  });

  const isHost = state.hostId === myId;
  $('host-controls').classList.toggle('hidden-force', !isHost);
  $('non-host-hint').classList.toggle('hidden-force', isHost);
  $('btn-start-game').disabled = state.players.length < 2;
}

// ---------- Game render ----------
function renderGame(state) {
  $('game-room-code').textContent = state.roomId;
  const me = state.players.find((p) => p.id === myId);
  const isMyTurn = state.activePlayerId === myId && !state.pending;
  const iAmHolder = state.pending && state.pending.currentHolderId === myId;

  const activeName = (state.players.find((p) => p.id === state.activePlayerId) || {}).name || '\u2014';
  const ti = $('turn-indicator');
  if (state.pending) {
    const holderName = (state.players.find((p) => p.id === state.pending.currentHolderId) || {}).name;
    ti.textContent = iAmHolder ? '카드가 당신에게 왔습니다 — 결정하세요!' : `${holderName}님이 고민 중...`;
  } else {
    ti.textContent = isMyTurn ? '당신의 차례 — 카드를 제안하세요' : `${activeName}님의 차례`;
  }

  renderOpponents(state);
  renderArena(state, iAmHolder, isMyTurn);
  renderHolderActions(state, iAmHolder);
  $('turn-cta').classList.toggle('hidden-force', !isMyTurn);
  renderMyArea(state, me, isMyTurn);
  renderLog(state);
}

function renderOpponents(state) {
  const row = $('opponents-row');
  row.innerHTML = '';
  state.players
    .filter((p) => p.id !== myId)
    .forEach((p) => {
      const isActive = state.activePlayerId === p.id && !state.pending;
      const isHolder = state.pending && state.pending.currentHolderId === p.id;

      const borderCls = isActive
        ? 'border-2 border-primary-fixed-dim neon-glow-primary energy-flicker'
        : isHolder
        ? 'border-2 border-tertiary-fixed neon-glow-tertiary'
        : 'border border-outline-variant/40';

      const chips = Object.entries(p.faceUp || {})
        .filter(([, c]) => c > 0)
        .map(([type, c]) => {
          const colorCls = c >= 3 ? 'bg-error-container/20 text-error' : c === 2 ? 'bg-tertiary-container/20 text-tertiary-fixed' : 'bg-surface-variant/30 text-on-surface-variant';
          return `<span class="text-[10px] ${colorCls} px-1.5 py-0.5 rounded font-label-mono">${BUG_META[type].emoji} x${c}</span>`;
        })
        .join('');

      const div = document.createElement('div');
      div.className = `relative flex flex-col items-center gap-1 bg-surface-container/40 rounded-xl px-4 py-3 min-w-[130px] ${borderCls}`;
      div.innerHTML = `
        <div class="flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full ${p.connected ? 'bg-primary-fixed-dim' : 'bg-error'}"></span>
          <h3 class="font-label-mono text-xs font-bold text-on-surface">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</h3>
        </div>
        <span class="font-label-mono text-[10px] text-outline uppercase">${isActive ? '생각 중...' : isHolder ? '선택 중...' : `${p.handCount}장 보유`}</span>
        <div class="flex flex-wrap gap-1 justify-center mt-1">${chips || '<span class="text-[10px] text-outline font-label-mono">클린</span>'}</div>
      `;
      row.appendChild(div);
    });
}

function renderArena(state, iAmHolder, isMyTurn) {
  const idle = $('arena-idle');
  const pendingBox = $('arena-pending');
  const myCardBox = $('arena-mycard');
  idle.classList.add('hidden-force');
  pendingBox.classList.add('hidden-force');
  myCardBox.classList.add('hidden-force');

  if (state.pending && iAmHolder) {
    myCardBox.classList.remove('hidden-force');
    const card = state.pending.card;
    $('my-pending-card-emoji').textContent = BUG_META[card.type].emoji;
    $('my-pending-card-label').textContent = BUG_META[card.type].ko;
    $('my-pending-declared').textContent = BUG_META[state.pending.declaredType].ko;
  } else if (state.pending) {
    pendingBox.classList.remove('hidden-force');
    const senderName = (state.players.find((p) => p.id === state.pending.lastSenderId) || {}).name;
    const holderName = (state.players.find((p) => p.id === state.pending.currentHolderId) || {}).name;
    $('pending-claim-text').innerHTML = `<span class="text-primary-fixed font-bold">${escapeHtml(senderName)}</span><span class="text-on-surface-variant">님이 이 카드를 </span><span class="text-secondary-fixed font-bold tracking-widest">[${BUG_META[state.pending.declaredType].ko}]</span><span class="text-on-surface-variant">(이)라고 주장하며 ${escapeHtml(holderName)}님에게 넘겼습니다.</span>`;
  } else {
    idle.classList.remove('hidden-force');
    $('arena-idle-text').textContent = isMyTurn ? '아래에서 카드를 선택해 제안하세요.' : '다음 차례를 기다리는 중...';
  }
}

function renderHolderActions(state, iAmHolder) {
  const box = $('holder-actions');
  if (!iAmHolder) {
    box.classList.add('hidden-force');
    return;
  }
  box.classList.remove('hidden-force');
  const canPass = state.pending.canPass;
  $('btn-open-pass').classList.toggle('hidden-force', !canPass);
  $('must-guess-note').classList.toggle('hidden-force', canPass);
}

function openProposeModal() {
  const state = lastState;
  const card = (state.players.find((p) => p.id === myId).hand || []).find((c) => c.id === sel.cardId);
  $('propose-selected-card').textContent = card ? `${BUG_META[card.type].emoji} (비공개)` : '—';

  const others = state.players.filter((p) => p.id !== myId && p.connected);
  const tGrid = $('propose-target-grid');
  tGrid.innerHTML = '';
  others.forEach((p) => {
    const chip = document.createElement('button');
    chip.className = `px-3 py-2 rounded-full text-xs font-label-mono border ${sel.targetId === p.id ? 'border-primary-fixed text-primary-fixed bg-primary-fixed/10' : 'border-outline-variant text-on-surface-variant'}`;
    chip.textContent = p.name + (p.isBot ? ' 🤖' : '');
    chip.addEventListener('click', () => { sel.targetId = p.id; openProposeModal(); });
    tGrid.appendChild(chip);
  });

  const dGrid = $('propose-declare-grid');
  dGrid.innerHTML = '';
  Object.keys(BUG_META).forEach((type) => {
    const chip = document.createElement('button');
    const active = sel.declaredType === type;
    chip.className = `flex flex-col items-center justify-center gap-1 py-2 rounded-lg text-[11px] font-label-mono border ${active ? 'border-primary-fixed text-primary-fixed bg-primary-fixed/10' : 'border-outline-variant text-on-surface-variant'}`;
    chip.innerHTML = `<span class="text-lg">${BUG_META[type].emoji}</span>${BUG_META[type].ko}`;
    chip.addEventListener('click', () => { sel.declaredType = type; openProposeModal(); });
    dGrid.appendChild(chip);
  });

  $('btn-confirm-propose').disabled = !(sel.targetId && sel.cardId && sel.declaredType);
  $('modal-propose').classList.remove('hidden-force');
}

function openPassModal() {
  const state = lastState;
  const pending = state.pending;
  if (!passSel.declaredType) passSel.declaredType = pending.declaredType;

  const validTargets = state.players.filter((p) => p.id !== myId && p.connected && !pending.seenBy.includes(p.id));
  const tGrid = $('pass-target-grid');
  tGrid.innerHTML = '';
  validTargets.forEach((p) => {
    const chip = document.createElement('button');
    chip.className = `px-3 py-2 rounded-full text-xs font-label-mono border ${passSel.targetId === p.id ? 'border-tertiary-fixed text-tertiary-fixed bg-tertiary-fixed/10' : 'border-outline-variant text-on-surface-variant'}`;
    chip.textContent = p.name + (p.isBot ? ' 🤖' : '');
    chip.addEventListener('click', () => { passSel.targetId = p.id; openPassModal(); });
    tGrid.appendChild(chip);
  });

  const dGrid = $('pass-declare-grid');
  dGrid.innerHTML = '';
  Object.keys(BUG_META).forEach((type) => {
    const chip = document.createElement('button');
    const active = passSel.declaredType === type;
    chip.className = `flex flex-col items-center justify-center gap-1 py-2 rounded-lg text-[11px] font-label-mono border ${active ? 'border-tertiary-fixed text-tertiary-fixed bg-tertiary-fixed/10' : 'border-outline-variant text-on-surface-variant'}`;
    chip.innerHTML = `<span class="text-lg">${BUG_META[type].emoji}</span>${BUG_META[type].ko}`;
    chip.addEventListener('click', () => { passSel.declaredType = type; openPassModal(); });
    dGrid.appendChild(chip);
  });

  $('btn-confirm-pass').disabled = !passSel.targetId;
  $('modal-pass').classList.remove('hidden-force');
}

function renderMyArea(state, me, isMyTurn) {
  const faceWrap = $('my-facecards');
  faceWrap.innerHTML = '';
  if (me) {
    Object.entries(me.faceUp || {})
      .filter(([, c]) => c > 0)
      .forEach(([type, c]) => {
        const colorCls = c >= 3 ? 'bg-error-container/20 text-error border-error/40' : c === 2 ? 'bg-tertiary-container/20 text-tertiary-fixed border-tertiary-fixed/40' : 'bg-surface-variant/30 text-on-surface-variant border-outline-variant';
        const span = document.createElement('span');
        span.className = `text-[10px] px-2 py-1 rounded-full border font-label-mono ${colorCls}`;
        span.textContent = `${BUG_META[type].emoji} ${BUG_META[type].ko} x${c}/4`;
        faceWrap.appendChild(span);
      });
  }

  const handWrap = $('my-hand');
  handWrap.innerHTML = '';
  if (me && me.hand) {
    me.hand.forEach((card) => {
      const div = document.createElement('div');
      const selected = sel.cardId === card.id;
      div.className = `group relative w-20 md:w-24 aspect-[2.5/3.5] shrink-0 bg-surface-container rounded-lg border ${selected ? 'border-primary-fixed neon-glow-primary -translate-y-4' : 'border-outline-variant'} ${isMyTurn ? 'cursor-pointer hover:-translate-y-4 hover:scale-105' : ''} transition-all overflow-hidden shadow-xl flex flex-col items-center justify-center p-2`;
      div.innerHTML = `
        <div class="absolute top-1.5 left-1.5 font-label-mono text-[9px] text-outline">${BUG_META[card.type].ko}</div>
        <span class="text-3xl">${BUG_META[card.type].emoji}</span>
        <div class="absolute bottom-0 w-full h-1 ${selected ? 'bg-primary-fixed' : 'bg-outline-variant'}"></div>
      `;
      if (isMyTurn) {
        div.addEventListener('click', () => { sel.cardId = card.id; renderGame(state); });
      }
      handWrap.appendChild(div);
    });
  }
}

function renderLog(state) {
  const feed = $('log-feed');
  feed.innerHTML = '';
  (state.log || []).forEach((entry) => {
    const div = document.createElement('div');
    div.className = 'text-[11px] text-on-surface-variant border-l-2 border-outline-variant pl-2 font-label-mono';
    div.textContent = entry.msg;
    feed.appendChild(div);
  });
}

// ---------- Game over render ----------
function renderGameOver(state) {
  const loser = state.players.find((p) => p.id === state.loserId);
  $('over-title').textContent = loser ? `${loser.name}님 패배!` : '게임 종료';
  $('over-reason').textContent = state.loseReason ? `사유: ${translateReason(state.loseReason)}` : '';

  const standings = $('over-standings');
  standings.innerHTML = '';
  state.players
    .slice()
    .sort((a, b) => {
      const totalA = Object.values(a.faceUp || {}).reduce((s, v) => s + v, 0);
      const totalB = Object.values(b.faceUp || {}).reduce((s, v) => s + v, 0);
      return totalA - totalB;
    })
    .forEach((p) => {
      const total = Object.values(p.faceUp || {}).reduce((s, v) => s + v, 0);
      const row = document.createElement('div');
      row.className = 'flex justify-between items-center bg-surface-dim border border-outline-variant/40 rounded-lg px-4 py-2 text-sm';
      row.innerHTML = `<span>${escapeHtml(p.name)}${p.id === state.loserId ? ' \u{1F480}' : ''}</span><span class="font-label-mono text-xs text-on-surface-variant">앞면 ${total}장 · 손패 ${p.handCount}장</span>`;
      standings.appendChild(row);
    });

  $('btn-rematch').classList.toggle('hidden-force', state.hostId !== myId);
}

function translateReason(reason) {
  if (/collected 4x (.+)/.test(reason)) {
    const type = reason.match(/collected 4x (.+)/)[1];
    const meta = BUG_META[type];
    return meta ? `${meta.ko} 카드 4장 수집` : reason;
  }
  if (reason.includes('ran out of cards')) return '차례 시작 시 손패가 없음';
  if (reason.includes('disconnected')) return '게임 중 연결 끊김';
  return reason;
}
