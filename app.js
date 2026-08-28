const WS_URL = window.RIVER_WS_URL || 'ws://localhost:4000/ws';
let token = localStorage.getItem('river-club-token');
let socket;
let socketPromise;
let requestId = 0;
const pending = new Map();
let user = null;
let roomFilter = 'all';
let rooms = [];
let currentRoom = null;
let currentGame = null;
let savedRoomId = localStorage.getItem('river-club-room');
let pollId;
let clockId;
let authMode = 'login';
let lastActionKey = '';
let lastChipKey = '';
let lastSettlementKey = '';
let autoReadyQueued = false;
let lastVisualActionKey = '';
let lastRenderedGame = null;
let localVoiceStream = null;
let voiceMuted = false;
const voicePeers = new Map();
const SHOWDOWN_COOLDOWN_MS = 5000;
let showdownCooldownUntil = 0;

const $ = id => document.getElementById(id);
function setText(id, value) { const element = $(id); if (element) element.textContent = value; }
const money = cents => (Number(cents || 0) / 100).toFixed(2);
const fmt = value => Number(value || 0).toLocaleString('en-US');
const playingStatuses = ['preflop', 'flop', 'turn', 'river'];
const suits = { s: '♠', h: '♥', d: '♦', c: '♣' };
const ranks = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const actionText = { fold: '弃牌', check: '过牌', call: '跟注', raise: '加注', allin: 'All-in' };

function onSocketMessage(event) {
  const message = JSON.parse(event.data);
  if (message.type === 'voice.signal') { handleVoiceSignal(message.data); return; }
  if (message.type === 'response') {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    message.ok ? task.resolve(message.data) : task.reject(new Error(message.error || '请求失败'));
    return;
  }
  if (message.type === 'room.update' && currentRoom?.id === message.data.room.id) {
    currentRoom = message.data.room;
    currentGame = message.data.game;
    renderMessages(message.data.messages || []);
    renderGame(currentGame);
  }
}

function voiceSignal(target, signal) { return rpc('voice.signal', { roomId: currentRoom?.id, signal: { ...signal, target } }); }
function closeVoicePeers() { voicePeers.forEach(peer => peer.close()); voicePeers.clear(); document.querySelectorAll('audio[data-voice-peer]').forEach(audio => audio.remove()); }
function createVoicePeer(peerId, initiator) {
  if (voicePeers.has(peerId)) return voicePeers.get(peerId);
  const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  peer.pendingCandidates = [];
  localVoiceStream?.getTracks().forEach(track => peer.addTrack(track, localVoiceStream));
  peer.onicecandidate = event => { if (event.candidate) voiceSignal(peerId, { type: 'candidate', candidate: event.candidate }); };
  peer.ontrack = event => {
    let audio = document.querySelector(`audio[data-voice-peer="${CSS.escape(peerId)}"]`);
    if (!audio) { audio = document.createElement('audio'); audio.autoplay = true; audio.dataset.voicePeer = peerId; document.body.appendChild(audio); }
    audio.srcObject = event.streams[0];
  };
  peer.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
      peer.close();
      voicePeers.delete(peerId);
      document.querySelector(`audio[data-voice-peer="${CSS.escape(peerId)}"]`)?.remove();
    }
  };
  voicePeers.set(peerId, peer);
  if (initiator) peer.createOffer().then(offer => peer.setLocalDescription(offer).then(() => voiceSignal(peerId, { type: 'offer', description: offer }))).catch(() => {});
  return peer;
}
function syncVoicePeers(game) {
  if (!localVoiceStream || !user?.id) return;
  const ids = new Set((game?.players || []).filter(player => !player.isBot && player.userId !== user.id && !player.left).map(player => player.userId));
  voicePeers.forEach((peer, peerId) => {
    if (!ids.has(peerId)) { peer.close(); voicePeers.delete(peerId); document.querySelector(`audio[data-voice-peer="${CSS.escape(peerId)}"]`)?.remove(); }
  });
  ids.forEach(peerId => {
    if (!voicePeers.has(peerId)) createVoicePeer(peerId, String(user.id) < String(peerId));
  });
}
async function handleVoiceSignal(data) {
  if (!currentRoom || data.roomId !== currentRoom.id || !data.from?.id) return;
  const peerId = data.from.id;
  try {
    if (data.signal.type === 'offer') {
      const peer = createVoicePeer(peerId, false);
      await peer.setRemoteDescription(data.signal.description);
      for (const candidate of peer.pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await voiceSignal(peerId, { type: 'answer', description: answer });
    } else if (data.signal.type === 'answer') {
      const peer = voicePeers.get(peerId);
      if (peer) {
        await peer.setRemoteDescription(data.signal.description);
        for (const candidate of peer.pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
      }
    } else if (data.signal.type === 'candidate') {
      const peer = createVoicePeer(peerId, false);
      if (peer.remoteDescription) await peer.addIceCandidate(data.signal.candidate);
      else peer.pendingCandidates.push(data.signal.candidate);
    }
  } catch (error) { console.warn('Voice connection failed:', error); }
}
async function toggleVoice() {
  const button = $('voiceToggle');
  if (localVoiceStream) {
    voiceMuted = !voiceMuted;
    localVoiceStream.getAudioTracks().forEach(track => { track.enabled = !voiceMuted; });
    button.classList.toggle('active', !voiceMuted); button.setAttribute('aria-pressed', String(!voiceMuted)); button.querySelector('span:last-child').textContent = voiceMuted ? '开麦' : '闭麦'; return;
  }
  if (!navigator.mediaDevices?.getUserMedia) return toast('当前页面不支持麦克风，请使用 HTTPS 或 localhost 打开');
  try {
    localVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    voiceMuted = false;
    button.classList.add('active'); button.setAttribute('aria-pressed', 'true'); button.querySelector('span:last-child').textContent = '闭麦';
    syncVoicePeers(currentGame);
  } catch { toast('无法使用麦克风，请检查浏览器权限'); }
}

function connectSocket() {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (socketPromise) return socketPromise;
  socketPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    socket = ws;
    ws.addEventListener('message', onSocketMessage);
    ws.addEventListener('open', async () => {
      try {
        if (token) await rpcOnSocket(ws, 'auth.token', { token });
        resolve(ws);
      } catch (error) {
        setToken(null);
        reject(error);
      } finally {
        socketPromise = null;
      }
    });
    ws.addEventListener('error', () => { socketPromise = null; reject(new Error('无法连接牌桌服务器')); });
    ws.addEventListener('close', () => {
      socketPromise = null;
      pending.forEach(task => task.reject(new Error('连接已断开，请重试')));
      pending.clear();
    });
  });
  return socketPromise;
}

function rpcOnSocket(ws, action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${++requestId}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, action, payload }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error('服务器响应超时')); }, 12000);
  });
}

async function rpc(action, payload = {}) {
  const ws = await connectSocket();
  return rpcOnSocket(ws, action, payload);
}

async function api(path, options = {}) {
  const body = options.body ? JSON.parse(options.body) : {};
  if (path === '/auth/login') return rpc('auth.login', body);
  if (path === '/auth/register') return rpc('auth.register', body);
  if (path === '/me') return rpc('me');
  if (path === '/rooms' && options.method === 'POST') return rpc('rooms.create', body);
  if (path === '/rooms') return rpc('rooms.list');
  const match = path.match(/^\/rooms\/([^/]+)(?:\/(join|leave|actions|messages|bots))?$/);
  if (!match) throw new Error('不支持的请求');
  const [, roomId, operation] = match;
  if (!operation) return rpc('room.get', { roomId });
  if (operation === 'join') return rpc('room.join', { roomId, password: body.password, buyIn: body.buyIn });
  if (operation === 'leave') return rpc('room.leave', { roomId });
  if (operation === 'actions') return rpc('room.action', { roomId, action: body.action, raiseTo: body.raiseTo, buyIn: body.buyIn });
  if (operation === 'bots') return rpc('room.addBot', { roomId });
  return rpc('room.message', { roomId, text: body.text });
}

function show(view) { ['authView', 'lobbyView', 'tableView'].forEach(id => $(id).classList.toggle('hidden', id !== view)); }
function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function setToken(value) { token = value; if (value) localStorage.setItem('river-club-token', value); else localStorage.removeItem('river-club-token'); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }

function updateBalance() {
  if (!user) return;
  ['pointsBalance', 'sidePoints'].forEach(id => setText(id, money(user.points)));
  const mySeat = currentGame?.players?.find(player => player.userId === user.id);
  const stack = mySeat?.stack ?? user.stack ?? 0;
  setText('tableStack', fmt(stack));
  setText('sideStack', fmt(stack));
  const initial = user.name.slice(0, 1).toUpperCase();
  if ($('selfAvatar')) $('selfAvatar').textContent = initial;
  setText('userAvatar', initial);
  setText('userName', user.name);
  if ($('tableUserName')) $('tableUserName').textContent = user.name;
}

function cardHtml(card) {
  if (!card) return '<div class="card-placeholder"></div>';
  const red = card.suit === 'h' || card.suit === 'd';
  return `<div class="playing-card${red ? ' red' : ''}"><span>${ranks[card.rank] || card.rank}</span><small>${suits[card.suit] || card.suit}</small></div>`;
}

function cardBackHtml() { return '<div class="card-back" aria-label="盖牌"></div><div class="card-back" aria-label="盖牌"></div>'; }

function renderRooms() {
  const search = $('roomSearch').value.toLowerCase();
  const visible = rooms.filter(room => (roomFilter === 'all' || room.owner === user.name) && (!search || room.id.toLowerCase().includes(search)));
  $('allCount').textContent = rooms.length;
  $('roomGrid').innerHTML = visible.map(room => `
    <article class="room-card" data-id="${room.id}">
      <div class="room-card-top">
        <div>
          <div class="room-name">${escapeHtml(room.id)}</div>
          <div class="room-meta"><span>房间代码 <strong>${room.id}</strong></span><span>盲注 <strong>${room.stakes}</strong></span><span>${room.hasPassword ? '密码房' : '公开'}</span></div>
        </div>
        <span class="stakes">${room.gameStatus === 'waiting' ? '等待中' : room.gameStatus === 'showdown' ? '结算中' : '进行中'}</span>
      </div>
      <div class="room-card-bottom">
        <span class="room-players"><b>${room.players}</b> / ${room.max} 入座 · ${room.spectators || 0} 观战</span>
        <button class="room-join" data-join="${room.id}">进入房间 <span>→</span></button>
      </div>
    </article>`).join('');
  $('emptyRooms').classList.toggle('hidden', visible.length > 0);
  document.querySelectorAll('.room-card').forEach(card => card.addEventListener('click', event => {
    const id = event.target.dataset.join || card.dataset.id;
    const room = rooms.find(item => item.id === id);
    if (room) joinRoom(room);
  }));
}

function openModal(html) { $('modalContent').innerHTML = html; $('modalBackdrop').classList.remove('hidden'); }
function closeModal() { $('modalBackdrop').classList.add('hidden'); }

async function joinRoom(room) {
  const submitJoin = async password => {
    const result = await api(`/rooms/${room.id}/join`, { method: 'POST', body: JSON.stringify({ password }) });
    user = result.user;
    rooms = rooms.map(item => item.id === room.id ? result.room : item);
    closeModal();
    await enterTable(result.room, result.game);
    toast(result.room.gameStatus === 'waiting' ? '已进入房间，可以买入坐下' : '牌局进行中，已进入观战区');
  };
  if (!room.hasPassword) {
    try { await submitJoin(''); } catch (error) { toast(error.message); }
    return;
  }
  openModal(`<p class="eyebrow">PRIVATE ROOM</p><h3>输入房间密码</h3><p class="modal-intro">房间代码 ${room.id}</p><label>房间密码<input id="roomPassword" type="password" autocomplete="off"></label><button class="btn btn-primary" id="confirmJoin">进入房间 <span>→</span></button>`);
  $('confirmJoin').addEventListener('click', async () => { try { await submitJoin($('roomPassword').value); } catch (error) { toast(error.message); } });
}

function renderActionCue(game) {
  const action = game?.lastAction;
  if (!action) return;
  const key = `${action.userId}-${action.action}-${action.at}`;
  if (key === lastActionKey) return;
  lastActionKey = key;
  const cue = document.createElement('div');
  cue.className = `action-cue cue-${action.action}`;
  cue.textContent = `${action.name} ${actionText[action.action] || action.action}${action.committed > 0 ? ` +${fmt(action.committed)}` : ''}`;
  $('pokerTable').appendChild(cue);
  setTimeout(() => cue.remove(), 1500);
}

function updateClock() {
  const deadline = currentGame?.actionDeadline;
  if (!deadline || !playingStatuses.includes(currentGame.status)) {
    return;
  }
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  document.querySelectorAll('.seat.thinking .countdown-ring').forEach(ring => { ring.style.setProperty('--progress', `${left / 20 * 360}deg`); ring.classList.toggle('urgent', left < 5); });
}

function renderSeats(game) {
  const layer = $('seatLayer');
  const visiblePlayers = (game.players || []).filter(player => !player.left);
  const me = visiblePlayers.find(player => player.userId === user.id);
  // The engine advances player indexes clockwise. Rotate the same seat order so
  // the local player stays at the bottom without changing who acts next.
  const myIndex = me ? visiblePlayers.findIndex(player => player.userId === user.id) : -1;
  const orderedPlayers = myIndex >= 0
    ? visiblePlayers.slice(myIndex).concat(visiblePlayers.slice(0, myIndex))
    : visiblePlayers;
  const players = orderedPlayers.slice(0, 10);
  layer.innerHTML = players.map((player, index) => {
    const thinking = game.currentUserId === player.userId && playingStatuses.includes(game.status);
    const winner = (game.winners || []).some(item => item.userId === player.userId);
    const folded = player.folded;
    const prepared = player.isBot || (game.readyPlayers || []).includes(player.userId);
    const blind = game.smallBlindUserId === player.userId ? '小盲' : game.bigBlindUserId === player.userId ? '大盲' : '';
    const cards = player.userId === user.id ? (player.hole?.length ? player.hole.map(cardHtml).join('') : '<span class="spectator-badge">观战中</span>') : folded ? '' : game.status === 'showdown' && player.hole?.length ? player.hole.map(cardHtml).join('') : cardBackHtml();
    const state = thinking ? '思考中' : folded ? '弃牌' : player.allIn ? 'ALL-IN' : player.isBot ? '机器人' : player.userId === user.id ? '你' : '';
    const angle = 90 + index * (360 / Math.max(1, players.length));
    const x = 50 + 49 * Math.cos(angle * Math.PI / 180);
    const y = 50 + 48 * Math.sin(angle * Math.PI / 180);
    return `<div class="seat ${thinking ? 'thinking' : ''} ${winner ? 'winner-seat' : ''} ${folded ? 'folded' : ''}" data-user-id="${escapeHtml(player.userId)}" style="left:${x}%;top:${y}%">
      <div class="hole-cards">${cards}</div><div class="player-panel"><div class="countdown-ring"><div class="seat-avatar ${player.userId === user.id ? 'seat-self' : player.isBot ? 'seat-gold' : 'seat-blue'}">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</div>${prepared ? '<span class="ready-check" aria-label="已准备">✓</span>' : ''}</div><div class="seat-meta"><strong>${escapeHtml(player.name)}</strong><span>${fmt(player.stack)} 筹码</span><small class="seat-state">${blind || state}</small></div>${blind ? `<span class="blind-badge ${blind === '大盲' ? 'big-blind' : ''}">${blind}</span>` : ''}</div></div>`;
  }).join('');
  updateClock();
}

function renderWinners(game) {
  let panel = $('winnerPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'winnerPanel';
    panel.className = 'winner-panel hidden';
    document.querySelector('.table-stage').appendChild(panel);
  }
  if (panel.parentElement !== document.querySelector('.table-stage')) document.querySelector('.table-stage').appendChild(panel);
  const winners = game.status === 'showdown' ? (game.winners || []) : [];
  panel.classList.toggle('hidden', winners.length === 0);
  panel.innerHTML = winners.length ? `<div class="winner-title">本局胜者</div>${winners.map(winner => {
    const player = game.players.find(item => item.userId === winner.userId);
    const hand = winner.hand || player?.hand || '牌型未公开';
    return `<div class="winner-row"><strong>${escapeHtml(winner.name || player?.name || '玩家')}</strong><span>${escapeHtml(hand)} · +${fmt(winner.amount)}</span></div>`;
  }).join('')}<div class="settlement-list">${(game.settlement || []).map(item => `<div><span>${escapeHtml(item.name)}</span><strong class="${item.delta >= 0 ? 'gain' : 'loss'}">${item.delta >= 0 ? '+' : ''}${fmt(item.delta)}</strong></div>`).join('')}</div>` : '';
}

function animateChip(text, from, to, className) {
  const source = from?.getBoundingClientRect();
  const target = to?.getBoundingClientRect();
  if (!source || !target) return;
  const chip = document.createElement('div');
  chip.className = `flying-chip ${className || ''}`;
  chip.textContent = text;
  chip.style.left = `${source.left + source.width / 2}px`;
  chip.style.top = `${source.top + source.height / 2}px`;
  chip.style.setProperty('--dx', `${target.left + target.width / 2 - source.left - source.width / 2}px`);
  chip.style.setProperty('--dy', `${target.top + target.height / 2 - source.top - source.height / 2}px`);
  document.body.appendChild(chip);
  setTimeout(() => chip.remove(), 850);
}

function renderAnimations(game) {
  const action = game.lastAction;
  const actionKey = action && `${action.userId}-${action.at}`;
  if (actionKey && action.committed > 0 && actionKey !== lastChipKey) {
    lastChipKey = actionKey;
    animateChip(`+${fmt(action.committed)}`, document.querySelector(`[data-user-id="${CSS.escape(action.userId)}"]`), $('potAmount'), 'chip-to-pot');
  }
  const settlementKey = game.status === 'showdown' && game.handNo ? `${game.handNo}-${(game.winners || []).map(item => item.userId).join(',')}` : '';
  if (settlementKey && settlementKey !== lastSettlementKey) {
    lastSettlementKey = settlementKey;
    const winner = game.winners?.[0];
    const target = winner && document.querySelector(`[data-user-id="${CSS.escape(winner.userId)}"]`);
    if (target) animateChip(`+${fmt(winner.amount)}`, $('potAmount'), target, 'chip-to-winner');
  }
}

function renderRoundAnimations(previous, game) {
  const previousPlayers = new Map((previous?.players || []).map(player => [player.userId, player]));
  const newHand = game.status === 'preflop' && (!previous || game.handNo !== previous.handNo);
  if (newHand) {
    document.querySelectorAll('.seat .hole-cards .playing-card, .seat .hole-cards .card-back').forEach((card, index) => {
      card.classList.add('deal-in');
      card.style.setProperty('--deal-delay', `${(index % 2) * 90}ms`);
    });
  }
  if (game.status === 'showdown' && previous?.status !== 'showdown') {
    document.querySelectorAll('.seat .hole-cards .playing-card').forEach((card, index) => {
      card.classList.add('reveal-card');
      card.style.setProperty('--reveal-delay', `${(index % 2) * 110}ms`);
    });
  }
  const oldBoardLength = previous?.board?.length || 0;
  if ((game.board?.length || 0) > oldBoardLength) {
    document.querySelectorAll('.community-cards .playing-card').forEach((card, index) => {
      if (index >= oldBoardLength) { card.classList.add('reveal-card'); card.style.setProperty('--reveal-delay', `${(index - oldBoardLength) * 100}ms`); }
    });
  }
  (game.players || []).forEach(player => {
    const oldPlayer = previousPlayers.get(player.userId);
    if (oldPlayer && !oldPlayer.folded && player.folded) {
      const seat = document.querySelector(`[data-user-id="${CSS.escape(player.userId)}"]`);
      seat?.classList.add('fold-animation');
    }
  });
  const action = game.lastAction;
  const actionKey = action && `${action.userId}-${action.at}`;
  if (actionKey && actionKey !== lastVisualActionKey) {
    lastVisualActionKey = actionKey;
    const seat = document.querySelector(`[data-user-id="${CSS.escape(action.userId)}"]`);
    seat?.classList.add('action-bounce');
    if (action.committed > 0) $('potAmount')?.classList.add('pot-pulse');
    setTimeout(() => { seat?.classList.remove('action-bounce'); $('potAmount')?.classList.remove('pot-pulse'); }, 700);
  }
}

function renderGame(game) {
  if (!game) return;
  const previousGame = lastRenderedGame;
  currentGame = game;
  const me = game.players?.find(player => player.userId === user.id);
  const seated = Boolean(me && !me.left);
  const playing = playingStatuses.includes(game.status);
  const myTurn = game.currentUserId === user.id && playing && seated;
  const showdown = game.status === 'showdown';
  const canPrepare = seated && ['waiting', 'showdown'].includes(game.status);
  if (showdown && previousGame?.status !== 'showdown') showdownCooldownUntil = Date.now() + SHOWDOWN_COOLDOWN_MS;
  if (!showdown) showdownCooldownUntil = 0;
  const prepareCoolingDown = showdown && Date.now() < showdownCooldownUntil;

  $('communityCards').innerHTML = Array.from({ length: 5 }, (_, index) => cardHtml((game.board || [])[index])).join('');
  setText('potAmount', fmt(game.pot || 0));
  setText('roomInfoName', currentRoom.id);
  setText('roomInfoPlayers', `${currentRoom.players} / ${currentRoom.max}`);
  setText('roomInfoStakes', currentRoom.stakes);
  setText('roomInfoPassword', currentRoom.hasPassword ? '已设置' : '公开');
  setText('roomOnline', (currentRoom.players || 0) + (currentRoom.spectators || 0));

  renderSeats(game);
  syncVoicePeers(game);
  renderWinners(game);
  updateBalance();
  updateClock();
  renderActionCue(game);
  renderAnimations(game);
  renderRoundAnimations(previousGame, game);
  lastRenderedGame = JSON.parse(JSON.stringify(game));

  $('actionBar').classList.toggle('hidden', !myTurn && !canPrepare);
  setText('actionLabel', showdown ? '本局已结束' : myTurn ? '你的回合' : seated ? '等待其他玩家' : '观战中');
  setText('moveLabel', myTurn ? '轮到你行动' : !seated ? '可在本局结束后买入坐下' : showdown ? '准备下一局' : '等待牌局推进');
  ['foldBtn', 'checkBtn', 'callBtn', 'raiseBtn', 'allinBtn'].forEach(id => $(id).classList.toggle('hidden', !myTurn));
  $('nextHandBtn').classList.toggle('hidden', !canPrepare);
  $('nextHandBtn').textContent = game.readyPlayers?.includes(user.id) ? '已准备' : '准备';
  $('nextHandBtn').disabled = game.readyPlayers?.includes(user.id) || prepareCoolingDown;
  if (me && playing) {
    const toCall = Math.max(0, game.currentBet - me.streetBet);
    $('checkBtn').disabled = toCall > 0;
    $('callBtn').disabled = toCall === 0;
    $('callBtn').textContent = toCall ? `跟注 ${Math.min(toCall, me.stack)}` : '跟注';
    $('raiseBtn').querySelector('span').textContent = game.currentBet + game.minRaise;
  }
  renderTableControls(seated, game);
  if (showdown && seated && $('autoReady').checked && !game.readyPlayers?.includes(user.id) && !autoReadyQueued) {
    autoReadyQueued = true;
    const delay = Math.max(0, showdownCooldownUntil - Date.now());
    setTimeout(() => {
      autoReadyQueued = false;
      if (currentGame?.status === 'showdown' && !currentGame.readyPlayers?.includes(user.id)) tableAction('ready');
    }, delay);
  }
}

function renderTableControls(seated, game) {
  $('buyInBtn').textContent = seated ? '＋ 补筹码' : '＋ 买入坐下';
  $('buyInBtn').classList.toggle('hidden', playingStatuses.includes(game.status) && !seated);
  let addBotBtn = $('addBotBtn');
  if (!addBotBtn) {
    addBotBtn = document.createElement('button');
    addBotBtn.id = 'addBotBtn';
    addBotBtn.className = 'text-btn hidden';
    addBotBtn.textContent = '＋ 机器人';
    $('buyInBtn').parentElement.appendChild(addBotBtn);
    addBotBtn.addEventListener('click', addBot);
  }
  addBotBtn.classList.remove('hidden');
  addBotBtn.disabled = currentRoom.players >= currentRoom.max;
}

function openBuyin(room) {
  const mySeat = currentGame?.players?.find(player => player.userId === user.id && !player.left);
  const currentStack = mySeat?.stack || 0;
  const preview = amount => {
    const n = Math.max(0, Number(amount) || 0);
    const added = Math.min(n, Math.max(0, 2000 - currentStack));
    const refund = n - added;
    return `实际增加 ${fmt(added)} 筹码 · 消耗 ${money(n - refund)} 积分${refund ? ` · 退回 ${money(refund)} 积分` : ''}`;
  };
  openModal(`<p class="eyebrow">BUY IN</p><h3>房间 ${escapeHtml(room.id)}</h3><p class="modal-intro">盲注 ${room.stakes}</p><div class="rule-note">请先进入房间再兑换筹码。每次兑换 100–2,000 筹码，桌上最多保留 2,000 筹码。</div><label>买入筹码数量<input id="buyinAmount" type="number" min="100" max="2000" step="100" value="1000"></label><p id="buyinCost" class="modal-intro" style="margin:-5px 0 18px">${preview(1000)}</p><button class="btn btn-primary" id="confirmBuyin">确认买入坐下 <span>→</span></button>`);
  $('buyinAmount').addEventListener('input', event => $('buyinCost').textContent = preview(event.target.value));
  $('confirmBuyin').addEventListener('click', async () => {
    const amount = Number($('buyinAmount').value);
    if (!Number.isInteger(amount) || amount < 100 || amount > 2000 || amount % 100 !== 0) return toast('请输入 100–2,000 的整百筹码');
    try {
      const result = await api(`/rooms/${room.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'buyin', buyIn: amount }) });
      user = result.user;
      currentRoom = result.room;
      closeModal();
      renderGame(result.game);
      toast(result.refund ? `已增加 ${fmt(result.added)} 筹码，${money(result.refund)} 积分已退回` : `已买入 ${fmt(result.added)} 筹码`);
    } catch (error) { toast(error.message); }
  });
}

async function enterTable(room, game = null) {
  currentRoom = room;
  currentGame = game;
  savedRoomId = room.id;
  localStorage.setItem('river-club-room', room.id);
  setText('tableTitle', room.id);
  setText('potAmount', fmt(room.pot || 0));
  setText('roomInfoName', room.id);
  renderMessages([]);
  show('tableView');
  updateBalance();
  clearInterval(pollId);
  clearInterval(clockId);
  clockId = setInterval(updateClock, 250);
  const refresh = async () => {
    try {
      const result = await api(`/rooms/${room.id}`);
      currentRoom = result.room;
      currentGame = result.game;
      renderMessages(result.messages || []);
      renderGame(currentGame);
    } catch (error) {
      if (error.message === '房间不存在') { toast('房间已销毁'); show('lobbyView'); clearInterval(pollId); }
    }
  };
  await refresh();
  pollId = setInterval(refresh, 2000);
}

function renderMessages(messages) {
  $('chatMessages').innerHTML = (messages.length ? messages : [{ user: '系统', text: '欢迎来到牌桌，祝你好运。' }]).map(message => `<p><b>${escapeHtml(message.user)}</b><span>${escapeHtml(message.text)}</span></p>`).join('');
}

async function createRoom() {
  openModal(`<p class="eyebrow">NEW TABLE</p><h3>创建一张牌桌</h3><p class="modal-intro">系统会自动生成唯一的五位房间代码。</p><div class="modal-grid"><label>小盲<input id="newSmallBlind" type="number" min="1" max="100" step="1" value="1"></label><label>大盲<input id="newBigBlind" type="number" min="2" max="200" step="1" value="2"></label></div><label>人数上限<select id="newRoomMax"><option value="6">6 人</option><option value="9">9 人</option><option value="10">10 人</option></select></label><label class="check-row"><input id="useRoomPassword" type="checkbox"> 设置房间密码</label><label id="roomPasswordWrap" class="hidden">房间密码<input id="newRoomPassword" type="password" autocomplete="off" maxlength="20"></label><button class="btn btn-primary" id="confirmCreate">创建并进入 <span>→</span></button>`);
  $('useRoomPassword').addEventListener('change', event => $('roomPasswordWrap').classList.toggle('hidden', !event.target.checked));
  $('confirmCreate').addEventListener('click', async () => {
    try {
      const result = await api('/rooms', { method: 'POST', body: JSON.stringify({ smallBlind: Number($('newSmallBlind').value), bigBlind: Number($('newBigBlind').value), max: Number($('newRoomMax').value), password: $('useRoomPassword').checked ? $('newRoomPassword').value : '' }) });
      user = result.user;
      rooms.unshift(result.room);
      closeModal();
      await enterTable(result.room, result.game);
      toast(`牌桌已创建，房号 ${result.room.id}`);
    } catch (error) { toast(error.message); }
  });
}

async function doAuth(event) {
  event.preventDefault();
  const name = $('usernameInput').value.trim();
  const password = $('passwordInput').value;
  if (name.length < 2 || password.length < 6) return toast('请检查昵称和密码格式');
  try {
    const result = await api(`/auth/${authMode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify({ name, password }) });
    setToken(result.token);
    user = result.user;
    show('lobbyView');
    await loadRooms();
    updateBalance();
    toast(authMode === 'register' ? '账号创建成功，欢迎来到 River Club' : '登录成功');
  } catch (error) { toast(error.message); }
}

async function loadRooms() {
  const result = await api('/rooms');
  rooms = result.rooms;
  renderRooms();
}

function setAuthMode(mode) {
  authMode = mode;
  $('authTitle').textContent = mode === 'login' ? '登录大厅' : '创建账号';
  $('authSubtitle').textContent = mode === 'login' ? '登录后继续你的牌局。' : '只需一个昵称，马上开始。';
  $('authSubmit').innerHTML = mode === 'login' ? '登录 <span>→</span>' : '创建账号 <span>→</span>';
  $('switchAuth').innerHTML = mode === 'login' ? '还没有账号？<strong>创建一个</strong>' : '已经有账号？<strong>登录</strong>';
}

function logout(showAuth = true) {
  clearInterval(pollId);
  clearInterval(clockId);
  if (socket) socket.close();
  localVoiceStream?.getTracks().forEach(track => track.stop()); localVoiceStream = null; voiceMuted = false; closeVoicePeers();
  socket = null;
  socketPromise = null;
  setToken(null);
  user = null;
  currentRoom = null;
  currentGame = null;
  savedRoomId = null;
  localStorage.removeItem('river-club-room');
  if (showAuth) { show('authView'); $('authForm').reset(); setAuthMode('login'); }
}

async function leaveCurrentRoom() {
  if (!currentRoom) return;
  try {
    localVoiceStream?.getTracks().forEach(track => track.stop()); localVoiceStream = null; voiceMuted = false; closeVoicePeers();
    const result = await api(`/rooms/${currentRoom.id}/leave`, { method: 'POST', body: JSON.stringify({}) });
    user = result.user;
    currentRoom = null;
    currentGame = null;
    savedRoomId = null;
    localStorage.removeItem('river-club-room');
    clearInterval(pollId);
    clearInterval(clockId);
    show('lobbyView');
    await loadRooms();
    updateBalance();
    toast('已退出房间，剩余筹码已结算为积分');
  } catch (error) { toast(error.message); }
}

async function tableAction(action) {
  try {
    const result = await api(`/rooms/${currentRoom.id}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
    user = result.user;
    currentRoom = result.room;
    currentGame = result.game;
    updateBalance();
    renderGame(result.game);
    toast(action === 'ready' ? '已准备，等待其他玩家' : `你选择${actionText[action] || action}`);
  } catch (error) { toast(error.message); }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api(`/rooms/${currentRoom.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
  } catch (error) { toast(error.message); }
}

async function addBot() {
  try {
    const result = await api(`/rooms/${currentRoom.id}/bots`, { method: 'POST' });
    user = result.user;
    currentRoom = result.room;
    renderGame(result.game);
    toast('机器人已加入');
  } catch (error) { toast(error.message); }
}

async function init() {
  $('authForm').addEventListener('submit', doAuth);
  $('switchAuth').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
  $('logoutBtn').addEventListener('click', () => logout());
  $('createRoomBtn').addEventListener('click', createRoom);
  $('roomSearch').addEventListener('input', renderRooms);
  $('chatForm').addEventListener('submit', sendMessage);
  $('foldBtn').addEventListener('click', () => tableAction('fold'));
  $('checkBtn').addEventListener('click', () => tableAction('check'));
  $('callBtn').addEventListener('click', () => tableAction('call'));
  $('raiseBtn').addEventListener('click', () => tableAction('raise'));
  $('allinBtn').addEventListener('click', () => tableAction('allin'));
  $('nextHandBtn').addEventListener('click', () => tableAction('ready'));
  $('backToLobby').addEventListener('click', leaveCurrentRoom);
  $('voiceToggle').addEventListener('click', toggleVoice);
  $('modalClose').addEventListener('click', closeModal);
  $('modalBackdrop').addEventListener('click', event => { if (event.target.id === 'modalBackdrop') closeModal(); });
  $('buyInBtn').addEventListener('click', () => currentRoom && openBuyin(currentRoom));
  $('autoReady').addEventListener('change', event => {
    if (event.target.checked && currentGame?.status === 'showdown' && !currentGame.readyPlayers?.includes(user.id) && Date.now() >= showdownCooldownUntil) tableAction('ready');
  });
  $('modalContent').addEventListener('click', event => { if (event.target.id === 'rulesClose') closeModal(); });
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
    tab.classList.add('active');
    roomFilter = tab.dataset.filter;
    renderRooms();
  }));
  if (token) {
    try {
      const result = await api('/me');
      user = result.user;
      show('lobbyView');
      await loadRooms();
      updateBalance();
      const savedRoom = rooms.find(room => room.id === savedRoomId);
      if (savedRoom) await enterTable(savedRoom);
      else { savedRoomId = null; localStorage.removeItem('river-club-room'); }
    } catch { logout(); }
  } else show('authView');
}

init();
