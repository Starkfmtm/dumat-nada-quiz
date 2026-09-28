let mqttClient = null;
let roomTopic = '';

function getUniqueSessionClientId() {
  try {
    let id = sessionStorage.getItem('dumat_client_id_session');
    if (!id) {
      id = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
      sessionStorage.setItem('dumat_client_id_session', id);
    }
    return id;
  } catch (e) {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
  }
}

const myClientId = getUniqueSessionClientId();

let gameState = {
  isHost: false,
  roomCode: null,
  players: [],
  currentRound: 1,
  totalRounds: 25,
  roundStage: 'lobby',
  basketThemes: [],
  roundsData: [],
  activeQuestionIdx: 0,
  activePlayerIdx: 0,
  activePlayerClientId: '',
  showOptions: false,
  feedbackData: null,
  gameOver: false,
  rt: {},
  myThemesSubmitted: false,
  hasAnsweredCurrent: false,
  lastRoundSeen: 0,
  name: '',
  selectedAvatarIdx: 0
};

// ==========================================================
// ГИБРИДНАЯ ШИНА С ДЕДУПЛИКАЦИЕЙ
// ==========================================================
const NetworkBus = {
  bc: null,
  roomCode: '',
  onMessageHandler: null,
  recentMsgIds: new Set(),

  init(code, onMessage) {
    this.roomCode = code;
    this.onMessageHandler = onMessage;

    if (this.bc) {
      try { this.bc.close(); } catch(e) {}
    }
    try {
      this.bc = new BroadcastChannel('dumat_hub_' + code);
      this.bc.onmessage = (event) => {
        if (event.data) this.handleInbound(event.data);
      };
    } catch(e) {}
  },

  handleInbound(payload) {
    if (payload && payload.__msgId) {
      if (this.recentMsgIds.has(payload.__msgId)) return;
      this.recentMsgIds.add(payload.__msgId);
      if (this.recentMsgIds.size > 200) {
        const first = this.recentMsgIds.values().next().value;
        this.recentMsgIds.delete(first);
      }
    }
    if (this.onMessageHandler) {
      this.onMessageHandler(payload);
    }
  },

  send(topic, payload) {
    if (!payload.__msgId) {
      payload.__msgId = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    }
    if (this.bc) {
      try { this.bc.postMessage(payload); } catch(e) {}
    }
    if (mqttClient && mqttClient.connected) {
      try {
        mqttClient.publish(topic, JSON.stringify(payload));
      } catch(e) {}
    }
  },

  destroy() {
    if (this.bc) {
      try { this.bc.close(); } catch(e) {}
      this.bc = null;
    }
    this.recentMsgIds.clear();
  }
};

window.NetworkBus = NetworkBus;

function escapeHTML(str) {
  if (!str) return '';
  return str.toString().replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast-msg ${isError ? '!border-red-500 !text-red-600' : ''}`;
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-15px)';
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }, 2800);
}

// ПОЛНЫЙ И ЧИСТЫЙ СБРОС ПРИ ВЫХОДЕ В МЕНЮ
function goBackToMenu() {
  window.__roomVerified = false;
  clearInterval(window.__joinInterval);

  if (roomTopic) {
    NetworkBus.send(`${roomTopic}/host`, { type: "LEAVE", clientId: myClientId });
  }

  setTimeout(() => {
    NetworkBus.destroy();
    if (mqttClient) {
      try {
        if (gameState.isHost) {
          mqttClient.publish(`${roomTopic}/broadcast`, JSON.stringify({ type: "TERMINATE" }));
        }
        mqttClient.end(true);
      } catch(e) {}
      mqttClient = null;
    }
  }, 150);

  const arenaStage = document.getElementById('arena-stage');
  const entryScreen = document.getElementById('screen-entry');
  if (arenaStage) arenaStage.classList.add('hidden');
  if (entryScreen) entryScreen.classList.remove('hidden');

  try { localStorage.removeItem('dumat_session'); } catch (e) {}

  // ПОЛНАЯ ОЧИСТКА СОСТОЯНИЯ ТЕМ И ИГРЫ
  gameState.isHost = false;
  gameState.roomCode = null;
  gameState.players = [];
  gameState.basketThemes = [];
  gameState.myThemesSubmitted = false;
  gameState.hasAnsweredCurrent = false;
  gameState.roundsData = [];
  gameState.currentRound = 1;
  gameState.roundStage = 'lobby';

  for (let i = 1; i <= 6; i++) {
    const el = document.getElementById(`theme-in-${i}`);
    if (el) el.value = '';
  }

  const inStage = document.getElementById('my-themes-input-stage');
  const lockStage = document.getElementById('my-themes-locked-stage');
  if (inStage) inStage.classList.remove('hidden');
  if (lockStage) lockStage.classList.add('hidden');

  const bThemes = document.getElementById('lobby-basket-themes');
  if (bThemes) bThemes.innerHTML = '';

  const pList = document.getElementById('lobby-players-list');
  if (pList) pList.innerHTML = '';
}

window.addEventListener('beforeunload', () => {
  if (roomTopic) {
    NetworkBus.send(`${roomTopic}/host`, { type: "LEAVE", clientId: myClientId });
  }
});

// ==========================================================
// ЗВУКОВОЙ ДВИЖОК
// ==========================================================
const SoundManager = {
  currentVolume: 30,
  isMuted: false,

  playGameOn() {
    const audio = document.getElementById('sfx-game-on');
    if (audio) {
      audio.currentTime = 0;
      audio.volume = this.isMuted ? 0 : 0.6;
      audio.play().catch(() => {});
    }
  },

  playGameIn() {
    const audio = document.getElementById('sfx-game-in');
    if (audio) {
      audio.currentTime = 0;
      audio.volume = this.isMuted ? 0 : (this.currentVolume / 100);
      audio.play().catch(() => {});
    }
  },

  playError() {
    const audio = document.getElementById('sfx-error');
    if (audio) {
      audio.currentTime = 0;
      audio.volume = this.isMuted ? 0 : (this.currentVolume / 100);
      audio.play().catch(() => {});
    }
  },

  startMusic() {
    const bg = document.getElementById('bg-music');
    if (bg) {
      bg.volume = this.isMuted ? 0 : (this.currentVolume / 100);
      bg.play().catch(e => console.log("Фоновая музыка ожидает взаимодействия:", e));
    }
  },

  setVolume(percent) {
    this.currentVolume = parseInt(percent, 10) || 0;
    const v = Math.max(0, Math.min(1, this.currentVolume / 100));

    const bg = document.getElementById('bg-music');
    if (bg) bg.volume = this.isMuted ? 0 : v;

    const muteIcon = document.getElementById('audio-mute-icon');
    if (muteIcon) muteIcon.innerText = (this.currentVolume === 0 || this.isMuted) ? '🔇' : '🔊';

    if (v > 0 && bg && bg.paused) {
      bg.play().catch(() => {});
    }
  },

  toggleMute() {
    this.isMuted = !this.isMuted;
    this.setVolume(this.isMuted ? 0 : 30);
  },

  playTone(freq, type, duration, vol = 0.1) {
    if (this.isMuted) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(vol * (this.currentVolume / 100), ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch(e) {}
  },

  playCountdownTick() {
    this.playTone(180, 'triangle', 0.15, 0.25);
  },

  playCountdownBoom() {
    this.playTone(90, 'sawtooth', 0.5, 0.35);
  },

  playOptionReveal() {
    this.playTone(700, 'sine', 0.04, 0.08);
  },

  playTensionTick() {
    this.playTone(280, 'sine', 0.08, 0.15);
  },

  playSound(event) {
    if (event === 'click') this.playTone(900, 'sine', 0.04, 0.08);
    if (event === 'boing') this.playTone(240, 'sine', 0.15, 0.2);
    if (event === 'correct') {
      this.playTone(523, 'triangle', 0.12, 0.2);
      setTimeout(() => this.playTone(659, 'triangle', 0.15, 0.2), 90);
      setTimeout(() => this.playTone(784, 'triangle', 0.25, 0.25), 180);
    }
    if (event === 'wrong') {
      this.playError();
    }
    if (event === 'bomb') {
      this.playError();
    }
  }
};

window.SoundManager = SoundManager;

function playSound(event) {
  try { SoundManager.playSound(event); } catch(e) {}
}

function setMusicVolume(val) {
  const num = parseInt(val, 10);
  SoundManager.setVolume(num);
  document.querySelectorAll('.music-vol-slider').forEach(s => s.value = num);
}

function toggleMuteAudio() { SoundManager.toggleMute(); }

function renderMenuAvatar() {
  const slot = document.getElementById('menu-avatar-display');
  if (!slot) return;
  const pack = window.AVATAR_PACK || [];
  if (pack.length) {
    const idx = (gameState.selectedAvatarIdx + pack.length) % pack.length;
    gameState.selectedAvatarIdx = idx;
    slot.innerHTML = pack[idx];
  }
}

function cycleAvatar(direction) {
  playSound('boing');
  const pack = window.AVATAR_PACK || [];
  const total = pack.length || 12;
  gameState.selectedAvatarIdx = (gameState.selectedAvatarIdx + direction + total) % total;
  renderMenuAvatar();
}

// КЛИК "НАЧАТЬ" -> ЗАПУСК game-in.mp3 И ПЕРЕХОД КРУЖКОМ
function handleMainActionClick() {
  const nameInput = document.getElementById('input-player-name');
  const name = nameInput ? nameInput.value.trim() : '';

  if (!name) {
    playSound('wrong');
    showToast("⚠️ Укажите ваше имя перед началом!", true);
    if (nameInput) {
      nameInput.classList.add('!border-red-500', 'animate__animated', 'animate__headShake');
      nameInput.focus();
      setTimeout(() => nameInput.classList.remove('!border-red-500', 'animate__animated', 'animate__headShake'), 700);
    }
    return;
  }

  // ЗАПУСК game-in.mp3 В МОМЕНТ ПЕРЕХОДА
  if (window.SoundManager) {
    window.SoundManager.playGameIn();
  }

  gameState.name = name;

  let roomCode = document.getElementById('input-room-code')?.value.trim().toUpperCase();
  if (!roomCode && window.__initialRoomCode) roomCode = window.__initialRoomCode;

  if (roomCode) {
    joinRoomAsPlayer(roomCode);
  } else {
    createRoomAsHost();
  }
}

function copyInviteLink() {
  const code = gameState.roomCode;
  if (!code) return;
  const url = window.location.origin + window.location.pathname + '?room=' + code;
  playSound('click');
  navigator.clipboard.writeText(url).then(() => {
    showToast("🔗 Ссылка скопирована! Отправьте её друзьям.");
  }).catch(() => {
    prompt("Скопируйте ссылку для друзей:", url);
  });
}

const THEMES_PRESET = ["Кино 90-х", "Космос", "Мемы", "Советский рок", "Фастфуд", "Гарри Поттер", "Странные законы", "Игры на ПК", "Супергерои", "География", "Автомобили", "Мультфильмы", "Литература", "Наука", "Рекорды Гиннесса", "Сериалы"];

function fillRandomThemesLocal() {
  playSound('click');
  const shuffled = [...THEMES_PRESET].sort(() => 0.5 - Math.random());
  for (let i = 1; i <= 6; i++) {
    const el = document.getElementById(`theme-in-${i}`);
    if (el) el.value = shuffled[i - 1] || `Тема ${i}`;
  }
}

function submitMyThemes() {
  const entered = [];
  for (let i = 1; i <= 6; i++) {
    const val = document.getElementById(`theme-in-${i}`)?.value.trim();
    if (val) entered.push(val);
  }

  const result = [...entered];
  const pool = [...THEMES_PRESET].sort(() => 0.5 - Math.random());
  for (let t of pool) {
    if (result.length >= 6) break;
    if (!result.includes(t)) result.push(t);
  }
  while (result.length < 6) result.push("Тема " + (result.length + 1));

  playSound('click');
  gameState.myThemesSubmitted = true;
  document.getElementById('my-themes-input-stage').classList.add('hidden');
  document.getElementById('my-themes-locked-stage').classList.remove('hidden');

  if (gameState.isHost) {
    hostHandleThemesSubmit(myClientId, result);
  } else {
    NetworkBus.send(`${roomTopic}/host`, {
      type: "SUBMIT_THEMES",
      clientId: myClientId,
      themes: result
    });
  }
  showToast("✨ Ваши 6 тем в корзине!");
}

function reopenMyThemesInput() {
  playSound('click');
  document.getElementById('my-themes-locked-stage').classList.add('hidden');
  document.getElementById('my-themes-input-stage').classList.remove('hidden');
}

function loadDefaultMasterPack() {
  if (!window.DEFAULT_MASTER_ROUNDS || !window.DEFAULT_MASTER_ROUNDS.length) {
    showToast("Ошибка: база вопросов не найдена!", true);
    return;
  }
  gameState.roundsData = JSON.parse(JSON.stringify(window.DEFAULT_MASTER_ROUNDS));
  gameState.totalRounds = gameState.roundsData.length;
  playSound('correct');
  showToast(`⚡ Готовая игра из ${gameState.totalRounds} раундов загружена!`);
  closeHostAIModal();
  hostBroadcastState();
}

function copyMasterGamePrompt() {
  const themes = (gameState.basketThemes && gameState.basketThemes.length > 0)
    ? gameState.basketThemes.join(', ')
    : "Кино, Космос, Мемы, История, Игры, Еда, Рок-музыка, Наука, Сериалы, Автомобили, Спорт, Мифы";

  const promptText = `Ты — создатель интеллектуального квиз-баттла «ДУМАТЬ НАДО».
Сгенерируй ПОЛНУЮ ИГРУ ИЗ 25 РАУНДОВ в формате строго валидного JSON (без markdown, без \`\`\`json).

ТЕМЫ ИЗ КОРЗИНЫ ИГРОКОВ: [${themes}].

ВАЖНЕЙШЕЕ ТРЕБОВАНИЕ: НАРАСТАЮЩАЯ СЛОЖНОСТЬ (1-8 легкие, 9-16 средние, 17-24 хардкор, 25 финал).
Ритм: каждые 2 раунда classic, 3-й — спец-режим:
1,2: classic | 3: blind (chests: [{value:1, difficulty:"Легкий", q, a, c}, {value:2, difficulty:"Средний", q, a, c}, {value:3, difficulty:"Хардкор", q, a, c}]) | 4,5: classic | 6: order (items: 4 шт по порядку) | 7,8: classic | 9: mine (a: 9 шт, c: верный, mines: [2 индекса]) | 10,11: classic | 12: king | 13,14: classic | 15: sabotage | 16,17: classic | 18: auction | 19,20: classic | 21: snowball (chain: [{q,a,c} 3 шт]) | 22,23: classic | 24: union | 25: veto (categories: 6 шт).`;

  navigator.clipboard.writeText(promptText).then(() => {
    playSound('correct');
    showToast("✅ Промпт скопирован! Отправьте его в нейросеть.");
  }).catch(() => prompt("Скопируйте промпт:", promptText));
}

function parseMasterJSON() {
  const raw = document.getElementById('host-ai-textarea').value.trim();
  if (!raw) { showToast("Вставьте JSON в поле!", true); return; }

  try {
    let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) cleaned = cleaned.substring(firstBrace, lastBrace + 1);

    const parsed = JSON.parse(cleaned);
    const rounds = parsed.rounds || [];
    if (!Array.isArray(rounds) || !rounds.length) { showToast("Нет массива rounds в JSON!", true); return; }

    gameState.roundsData = rounds;
    gameState.totalRounds = rounds.length;
    playSound('correct');
    showToast(`✅ Загружено ${rounds.length} раундов от ИИ!`);
    closeHostAIModal();
    hostBroadcastState();
  } catch(e) {
    playSound('wrong');
    showToast("Ошибка синтаксиса JSON!", true);
  }
}

function openHostAIModal() {
  playSound('click');
  document.getElementById('host-ai-modal')?.classList.remove('hidden');
}
function closeHostAIModal() {
  playSound('click');
  document.getElementById('host-ai-modal')?.classList.add('hidden');
}
function openRulesModal() {
  playSound('click');
  const modal = document.getElementById('rules-modal');
  const list = document.getElementById('rules-modal-list');
  if (modal && list) {
    const modes = window.GAME_MODES_INFO || {};
    list.innerHTML = Object.keys(modes).map(key => {
      const m = modes[key];
      return `
        <div class="bg-[#180315] p-2.5 rounded-xl border border-[#300D21] text-left flex items-start gap-2.5">
          <span class="text-xl shrink-0">${m.icon}</span>
          <div>
            <h5 class="neon-font text-xs uppercase text-[#FDB813]">${m.name}</h5>
            <p class="text-[11px] text-white/80 leading-relaxed font-semibold">${m.rules}</p>
          </div>
        </div>
      `;
    }).join('');
    modal.classList.remove('hidden');
  }
}
function closeRulesModal() {
  playSound('click');
  document.getElementById('rules-modal')?.classList.add('hidden');
}

function applyInitialURLState() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room') || urlParams.get('code') || window.__initialRoomCode;
    const mainBtn = document.getElementById('btn-main-action');
    const banner = document.getElementById('invite-detected-banner');

    if (roomFromUrl) {
      const cleanCode = roomFromUrl.trim().toUpperCase().slice(0, 6);
      window.__initialRoomCode = cleanCode;
      const codeInput = document.getElementById('input-room-code');
      if (codeInput) codeInput.value = cleanCode;
      if (mainBtn) mainBtn.innerText = "ВОЙТИ В ИГРУ 🚀";
      if (banner) banner.classList.remove('hidden');
    }

    const saved = localStorage.getItem('dumat_session');
    if (saved) {
      const data = JSON.parse(saved);
      if (data.name) document.getElementById('input-player-name').value = data.name;
    }
  } catch(e) {}
  renderMenuAvatar();
  setMusicVolume(30);
}

applyInitialURLState();