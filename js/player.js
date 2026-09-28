let playerOrderPicked = [];

function joinRoomAsPlayer(code) {
  playSound('click');
  gameState.isHost = false;
  gameState.roomCode = code;
  roomTopic = `dumat_quiz_v2/${code}`;

  document.getElementById('screen-entry')?.classList.add('hidden');
  document.getElementById('arena-stage')?.classList.remove('hidden');
  document.getElementById('host-lobby-controls')?.classList.add('hidden');

  NetworkBus.init(code, (data) => handleInboundClientData(data));

  const joinPacket = {
    type: "JOIN",
    name: gameState.name,
    clientId: myClientId,
    avatarIdx: gameState.selectedAvatarIdx
  };

  NetworkBus.send(`${roomTopic}/host`, joinPacket);
  NetworkBus.send(`${roomTopic}/host`, { type: "REQUEST_STATE" });

  if (typeof mqtt !== 'undefined' && mqtt.connect) {
    try {
      mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
        clientId: 'dumat_c_' + Math.random().toString(16).substring(2, 10),
        keepalive: 60,
        reconnectPeriod: 1500
      });
      mqttClient.on('connect', () => {
        mqttClient.subscribe([`${roomTopic}/broadcast`, `${roomTopic}/player/${myClientId}`]);
        NetworkBus.send(`${roomTopic}/host`, joinPacket);
        NetworkBus.send(`${roomTopic}/host`, { type: "REQUEST_STATE" });
      });
      mqttClient.on('message', (t, msg) => {
        try { NetworkBus.handleInbound(JSON.parse(msg.toString())); } catch(e) {}
      });
    } catch(err) { console.warn("MQTT client err:", err); }
  }

  if (window.__joinInterval) clearInterval(window.__joinInterval);
  window.__joinInterval = setInterval(() => {
    if (window.__roomVerified) { clearInterval(window.__joinInterval); return; }
    NetworkBus.send(`${roomTopic}/host`, joinPacket);
  }, 800);
}

function handleInboundClientData(data) {
  if (!data) return;

  if (data.type === "TERMINATE") {
    showToast("Комната закрыта 🏁");
    goBackToMenu();
    return;
  }

  if (data.type === "REJECT") {
    clearInterval(window.__joinInterval);
    playSound('wrong');
    showToast(data.reason === "NAME_TAKEN" ? "Имя уже занято!" : "Комната переполнена!", true);
    goBackToMenu();
    return;
  }

  if (data.type === "STATE_UPDATE") {
    window.__roomVerified = true;
    clearInterval(window.__joinInterval);

    // СБРОС БЛОКИРОВКИ ОТВЕТА ДЛЯ НОВОГО ВОПРОСА
    if (data.currentRound !== gameState.lastRoundSeen || (data.roundStage === 'play' && !data.feedback)) {
      gameState.lastRoundSeen = data.currentRound;
      gameState.hasAnsweredCurrent = false;
      playerOrderPicked = [];
    }

    gameState.currentRound = data.currentRound;
    gameState.totalRounds = data.totalRounds;
    gameState.roundStage = data.roundStage;
    gameState.roomCode = data.roomCode;
    gameState.activePlayerIdx = data.activePlayerIdx;
    gameState.activePlayerClientId = data.activePlayerClientId;
    gameState.feedbackData = data.feedback;
    gameState.showOptions = data.showOptions;
    gameState.rt = data.rt || {};
    gameState.roundsData = data.roundsData || [];
    gameState.basketThemes = data.basketThemes || [];
    gameState.players = data.players || [];
    gameState.gameOver = data.gameOver;

    renderGameUI();
  }
}

// ==========================================================
// ГЛАВНЫЙ ИГРОВОЙ РЕНДЕР
// ==========================================================
function renderGameUI() {
  // 1. ОВЕРЛЕЙ ВЕРДИКТА
  const fb = document.getElementById('game-feedback-overlay');
  if (fb) {
    if (gameState.feedbackData) {
      fb.classList.remove('hidden');
      fb.classList.add('flex', gameState.feedbackData.isCorrect ? 'bg-[#34C759]' : 'bg-[#FF3B30]');
      document.getElementById('feedback-icon').innerText = gameState.feedbackData.isCorrect ? "✅" : "❌";
      document.getElementById('feedback-title').innerText = gameState.feedbackData.customText || (gameState.feedbackData.isCorrect ? `${gameState.feedbackData.playerName}: ВЕРНО!` : `${gameState.feedbackData.playerName}: ОШИБКА!`);

      const cBox = document.getElementById('feedback-correct-box');
      const cTxt = document.getElementById('feedback-correct-text');
      if (!gameState.feedbackData.isCorrect && gameState.feedbackData.correctText) {
        if (cTxt) cTxt.innerText = gameState.feedbackData.correctText;
        cBox?.classList.remove('hidden');
      } else {
        cBox?.classList.add('hidden');
      }
    } else {
      fb.classList.add('hidden');
      fb.classList.remove('flex', 'bg-[#34C759]', 'bg-[#FF3B30]');
    }
  }

  const roundData = gameState.roundsData[gameState.currentRound - 1] || {};
  const isMyTurn = gameState.activePlayerClientId === myClientId || 
                   roundData.type === 'union' || 
                   (roundData.type === 'auction' && gameState.rt?.stage === 'bidding');

  const rInd = document.getElementById('round-indicator');
  if (rInd) {
    if (gameState.roundStage === 'lobby') {
      rInd.innerText = '';
    } else {
      rInd.innerText = `РАУНД ${gameState.currentRound}/${gameState.totalRounds}`;
    }
  }

  const rBadge = document.getElementById('round-name-badge');
  if (rBadge) {
    if (gameState.roundStage === 'lobby') {
      rBadge.classList.add('hidden');
    } else {
      rBadge.classList.remove('hidden');
      const mInfo = (window.GAME_MODES_INFO && window.GAME_MODES_INFO[roundData.type]) || { icon: "🎯", name: "Классика" };
      rBadge.innerText = `${mInfo.icon} ${mInfo.name.toUpperCase()}`;
    }
  }

  const topBar = document.getElementById('game-top-bar');
  const logo = document.getElementById('lobby-game-logo');
  const vScore = document.getElementById('game-scoreboard');
  const footer = document.getElementById('game-footer');

  const vLobby = document.getElementById('game-lobby-view');
  const vIntro = document.getElementById('game-intro-view');
  const vCount = document.getElementById('game-countdown-view');
  const vPlay = document.getElementById('game-play-view');
  const vPodium = document.getElementById('game-podium-view');

  [vLobby, vIntro, vCount, vPlay, vPodium].forEach(el => el?.classList.add('hidden'));

  // ИЗОЛИРОВАННЫЙ ОТСЧЕТ
  if (gameState.roundStage === 'countdown') {
    vCount?.classList.remove('hidden');
    topBar?.classList.add('hidden');
    logo?.classList.add('hidden');
    vScore?.classList.add('hidden');
    footer?.classList.add('hidden');

    const cNum = document.getElementById('countdown-num');
    if (cNum) {
      const val = gameState.rt?.countdown;
      cNum.classList.remove('countdown-slam-anim');
      void cNum.offsetWidth;
      cNum.classList.add('countdown-slam-anim');
      cNum.innerText = (val > 0) ? val : "Поехали! 🚀";
    }
    return;
  }

  topBar?.classList.remove('hidden');
  footer?.classList.remove('hidden');

  if (gameState.roundStage === 'lobby') {
    logo?.classList.remove('hidden');
  } else {
    logo?.classList.add('hidden');
  }

  // 1. ЛОББИ
  if (gameState.roundStage === 'lobby') {
    vLobby?.classList.remove('hidden');
    vScore?.classList.add('hidden');

    const listEl = document.getElementById('lobby-players-list');
    const counterEl = document.getElementById('lobby-players-counter');
    if (counterEl) counterEl.innerText = `${gameState.players.length}/8`;

    if (listEl) {
      let html = gameState.players.map(p => `
        <div class="flex items-center gap-2.5 bg-[#180315] p-2 rounded-2xl border-2 border-[#300D21] select-none shadow-[2px_2px_0px_#300D21]">
          <div class="menu-avatar-circle !w-10 !h-10 !p-1 shrink-0">${p.avatar || '🤖'}</div>
          <div class="flex-grow min-w-0 flex items-center justify-between pr-1">
            <span class="text-xs font-black text-white truncate max-w-[120px]">${escapeHTML(p.name)} ${p.clientId === myClientId ? '<span class="text-[#00F0FF]">(Вы)</span>' : ''}</span>
            <span class="text-[9px] font-black px-2 py-0.5 rounded-full uppercase border border-[#300D21] ${p.ready ? 'bg-[#7CB518] text-[#300D21]' : 'bg-[#FDB813] text-[#300D21] animate-pulse'}">
              ${p.ready ? '✅ Готов' : '⏳ Темы...'}
            </span>
          </div>
        </div>
      `).join('');

      if (gameState.players.length < 8) {
        html += `
          <div onclick="copyInviteLink()" class="invite-friend-slot group">
            <div class="w-8 h-8 rounded-full bg-[#FAF6EE] text-[#300D21] border-2 border-[#300D21] flex items-center justify-center font-black text-sm group-hover:scale-110 transition-transform">➕</div>
            <span class="text-xs font-black text-[#FDB813] group-hover:text-[#00F0FF] uppercase tracking-wider transition-colors">Пригласить друга 🔗</span>
          </div>
        `;
      }
      listEl.innerHTML = html;
    }

    const bThemes = document.getElementById('lobby-basket-themes');
    if (bThemes) {
      bThemes.innerHTML = (gameState.basketThemes || []).length
        ? gameState.basketThemes.map(t => `<span class="bg-[#FAF6EE] text-[#300D21] border-2 border-[#300D21] px-2.5 py-0.5 rounded-xl text-xs font-black shadow-[2px_2px_0px_#FF007A] animate__animated animate__bounceIn">🏷️ ${escapeHTML(t)}</span>`).join('')
        : `<span class="text-xs text-white/40 italic">Корзина пока пуста. Заполните темы выше...</span>`;
    }

    const sBanner = document.getElementById('lobby-status-text');
    const allReady = gameState.players.length > 0 && gameState.players.every(p => p.ready);
    const hasQ = gameState.roundsData && gameState.roundsData.length > 0;

    if (sBanner) {
      if (!allReady) sBanner.innerText = `Ждём темы игроков (${gameState.players.filter(p=>p.ready).length}/${gameState.players.length})...`;
      else if (!hasQ) sBanner.innerText = gameState.isHost ? "ВСЕ ГОТОВЫ! Нажмите кнопку «1. Вопросы» ниже." : "Все темы собраны! Создатель выбирает вопросы...";
      else sBanner.innerText = gameState.isHost ? "Вопросы загружены! Можно начинать баттл." : "Игра готова! Создатель запускает раунд...";
    }

    const btnStart = document.getElementById('btn-start-battle');
    if (btnStart) {
      btnStart.disabled = !(allReady && hasQ);
      if (allReady && hasQ) btnStart.classList.add('animate__animated', 'animate__pulse', 'animate__infinite');
      else btnStart.classList.remove('animate__animated', 'animate__pulse', 'animate__infinite');
    }
    return;
  }

  // 2. ЗАСТАВКА ПРАВИЛ С ЧИСТЫМ 5-СЕКУНДНЫМ CSS ТАЙМЕРОМ
  if (gameState.roundStage === 'mode_intro') {
    vIntro?.classList.remove('hidden');
    const mInfo = (window.GAME_MODES_INFO && window.GAME_MODES_INFO[roundData.type]) || { icon: "🎯", name: "Классика", rules: "Внимание на экран!" };
    document.getElementById('intro-icon').innerText = mInfo.icon;
    document.getElementById('intro-title').innerText = mInfo.name;
    document.getElementById('intro-rules').innerText = mInfo.rules;

    const pEl = document.getElementById('intro-progress');
    if (pEl) {
      pEl.classList.remove('intro-timer-running');
      void pEl.offsetWidth; // сброс рефлоу
      pEl.classList.add('intro-timer-running');
    }
    return;
  }

  // 3. ПОДИУМ И ЗАЛ СЛАВЫ (ЧИСТАЯ, КРАСИВАЯ ТАБЛИЦА)
  if (gameState.roundStage === 'podium' || gameState.gameOver) {
    vPodium?.classList.remove('hidden');
    const sorted = [...gameState.players].sort((a,b) => b.score - a.score);
    
    document.getElementById('podium-list').innerHTML = sorted.map((p, idx) => {
      let rankClass = "bg-[#180315] text-white";
      let medal = `<span class="w-8 h-8 rounded-full bg-[#2b0b23] border border-white/20 flex items-center justify-center font-black text-xs text-white/70">${idx + 1}</span>`;

      if (idx === 0) {
        rankClass = "podium-first";
        medal = `<span class="text-3xl animate__animated animate__bounceIn">🥇</span>`;
      } else if (idx === 1) {
        rankClass = "podium-second";
        medal = `<span class="text-2xl">🥈</span>`;
      } else if (idx === 2) {
        rankClass = "podium-third";
        medal = `<span class="text-2xl">🥉</span>`;
      }

      return `
        <div class="podium-rank-card ${rankClass} animate__animated animate__fadeInUp" style="animation-delay: ${idx * 120}ms">
          <div class="flex items-center gap-3">
            ${medal}
            <div class="menu-avatar-circle !w-11 !h-11 !p-1 shadow-sm shrink-0">
              ${p.avatar || '🤖'}
            </div>
            <div class="text-left">
              <span class="font-black text-sm block leading-tight truncate max-w-[130px] sm:max-w-[180px]">${escapeHTML(p.name)}</span>
              <span class="text-[10px] font-bold opacity-70 uppercase tracking-wider">${idx === 0 ? 'Чемпион баттла' : `Участник #${idx+1}`}</span>
            </div>
          </div>
          <div class="bg-[#180315] text-[#FDB813] border-2 border-[#300D21] px-3.5 py-1 rounded-xl font-black text-base shadow-[2px_2px_0px_#300D21]">
            ${p.score} <span class="text-[10px] text-white/60">б.</span>
          </div>
        </div>
      `;
    }).join('');
    return;
  }

  // 4. ИГРОВОЙ ЭКРАН
  if (gameState.roundStage === 'play') {
    vPlay?.classList.remove('hidden');
    vScore?.classList.remove('hidden');

    vScore.innerHTML = gameState.players.map(p => `
      <div class="flex flex-col items-center">
        <div class="menu-avatar-circle !w-10 !h-10 !p-1">${p.avatar || '🤖'}</div>
        <span class="text-[10px] font-black text-white mt-0.5 truncate max-w-[70px]">${escapeHTML(p.name)}</span>
        <span class="text-xs font-black text-[#FDB813]">${p.score} б.</span>
      </div>
    `).join('');

    const activeP = gameState.players.find(p => p.clientId === gameState.activePlayerClientId);
    const turnEl = document.getElementById('active-turn-indicator');
    if (turnEl) {
      if (roundData.type === 'union') {
        turnEl.innerText = "ГОЛОСУЕТ ВСЯ КОМАНДА! 🤝";
      } else if (roundData.type === 'auction' && gameState.rt?.stage === 'bidding') {
        turnEl.innerText = "ТОРГИ: СТАВКИ ДЕЛАЮТ ВСЕ! 🔨";
      } else {
        turnEl.innerText = isMyTurn ? "ВАШ ХОД! 🎯" : `ХОД: ${activeP ? activeP.name : 'Игрок'} 👀`;
      }
    }

    document.getElementById('round-theme-badge').innerText = roundData.theme || '';
    
    // ТЕКСТ ВОПРОСА (С ПОЛНОЙ ПОДДЕРЖКОЙ ВЕТО, СНЕЖНОГО КОМА И РИСКА)
    let qText = '';
    let currentOptions = roundData.a || [];

    if (roundData.type === 'veto') {
      if (gameState.rt?.phase === 'banning') {
        qText = "СУПЕР-ФИНАЛ: ВЫЧЕРКИВАЙТЕ ЛИШНИЕ ТЕМЫ!";
      } else if (gameState.rt?.phase === 'betting') {
        const finalTopicName = roundData.categories[gameState.rt.finalCatIdx]?.name || 'ФИНАЛ';
        qText = `ТЕМА: «${finalTopicName.toUpperCase()}». ДЕЛАЙТЕ ВАШИ СТАВКИ НА ВА-БАНК!`;
      } else if (gameState.rt?.phase === 'answering') {
        const cat = roundData.categories[gameState.rt.finalCatIdx];
        qText = cat ? cat.q : 'ФИНАЛЬНЫЙ ВОПРОС';
        currentOptions = cat ? cat.a : [];
      }
    } else if (roundData.type === 'blind') {
      if (gameState.rt?.blindPhase === 'pick_chest') {
        qText = "ВЫБЕРИТЕ СВОЙ РИСК: СЛОЖНОСТЬ И БАЛЛЫ ЗА ВОПРОС!";
      } else if (gameState.rt?.blindChosenItem) {
        qText = gameState.rt.blindChosenItem.q;
        currentOptions = gameState.rt.blindChosenItem.a || [];
      }
    } else if (roundData.type === 'snowball' && roundData.chain) {
      const stepIdx = gameState.rt?.chainIdx || 0;
      const chainStep = roundData.chain[stepIdx] || {};
      qText = chainStep.q || `СНЕЖНЫЙ КОМ: ШАГ ${stepIdx + 1}/3`;
      currentOptions = chainStep.a || [];
    } else if (roundData.type === 'auction' && gameState.rt?.stage === 'bidding') {
      qText = "ВОПРОС СКРЫТ! СДЕЛАЙТЕ СТАВКУ БАЛЛАМИ НА СВОЮ ЭРУДИЦИЮ:";
    } else {
      qText = roundData.q || '';
    }
    document.getElementById('question-text').innerText = qText;

    const box = document.getElementById('answers-container');
    if (!box) return;

    // А. ВЫБОР РИСКА: СУНДУКИ
    if (roundData.type === 'blind' && gameState.rt?.blindPhase === 'pick_chest') {
      box.className = "grid grid-cols-3 gap-3 pt-2";
      const chestsMeta = [
        { label: "+1 БАЛЛ", diff: "Простой", color: "#7CB518", icon: "🟢" },
        { label: "+2 БАЛЛА", diff: "Средний", color: "#FDB813", icon: "🟡" },
        { label: "+3 БАЛЛА", diff: "Хардкор", color: "#FF007A", icon: "🔴" }
      ];

      box.innerHTML = chestsMeta.map((c, idx) => `
        <button ${isMyTurn ? `onclick="sendAction({type:'BLIND_CHEST_CHOSEN', chestIdx:${idx}})"` : 'disabled'} 
                class="blind-chest-card animate__animated animate__zoomIn ${!isMyTurn ? 'opacity-60 cursor-default' : ''}">
          <span class="text-3xl block mb-1">${c.icon}</span>
          <span class="neon-font text-xs uppercase block" style="color: ${c.color}">${c.label}</span>
          <span class="text-[10px] font-black text-white/80 block mt-1">${c.diff}</span>
          <span class="text-[8px] font-bold text-white/40 block mt-0.5">${isMyTurn ? 'Выбрать' : 'Выбирает игрок'}</span>
        </button>
      `).join('');
      return;
    }

    // Б. СНЕЖНЫЙ КОМ: ВЫБОР РЕШЕНИЯ
    if (roundData.type === 'snowball' && gameState.rt?.awaitingDecision && isMyTurn) {
      box.className = "flex gap-3 pt-2";
      box.innerHTML = `
        <button onclick="sendAction({type:'SNOWBALL_DECIDE', action:'BANK'})" class="flex-1 bg-[#FDB813] text-[#300D21] border-3 border-[#300D21] py-3 rounded-2xl font-black text-xs shadow-[3px_3px_0px_#300D21] active:translate-y-1">
          💰 Забрать банк (+${gameState.rt.bankedPoints} б.)
        </button>
        <button onclick="sendAction({type:'SNOWBALL_DECIDE', action:'CONTINUE'})" class="flex-1 bg-[#FF007A] text-white border-3 border-[#300D21] py-3 rounded-2xl font-black text-xs shadow-[3px_3px_0px_#300D21] active:translate-y-1">
          🔥 Рискнуть дальше!
        </button>
      `;
      return;
    }

    // В. АУКЦИОН
    if (roundData.type === 'auction' && gameState.rt?.stage === 'bidding') {
      const myScore = (gameState.players.find(p => p.clientId === myClientId)?.score) || 1;
      const maxBid = Math.max(1, myScore);
      box.className = "max-w-md mx-auto pt-2";
      box.innerHTML = `
        <div class="bg-[#180315] p-5 rounded-2xl border-3 border-[#FDB813] text-center space-y-3 shadow-[4px_4px_0px_#300D21]">
          <span class="text-xs font-black uppercase text-[#FDB813] block">ВАША СТАВКА (ОТ 1 ДО ${maxBid} Б.):</span>
          <div class="flex gap-2">
            <input id="auction-bid-input" type="number" min="1" max="${maxBid}" value="1" class="flex-grow p-3 border-3 border-[#300D21] rounded-2xl font-black text-xl text-center bg-[#FAF6EE] text-[#300D21]">
            <button onclick="sendAction({type:'SUBMIT_BID', bid: parseInt(document.getElementById('auction-bid-input').value, 10)||1}); showToast('Ставка принята!');" class="bg-[#FDB813] hover:bg-[#ffe278] border-3 border-[#300D21] font-black px-6 rounded-2xl text-[#300D21]">ОК</button>
          </div>
          <span class="text-[10px] font-bold text-white/50 block">Игрок с наибольшей ставкой будет отвечать на вопрос!</span>
        </div>
      `;
      return;
    }

    // Г. САБОТАЖ
    if (roundData.type === 'sabotage' && gameState.rt?.awaitingTarget && isMyTurn) {
      box.className = "space-y-2 pt-2";
      const others = gameState.players.filter(p => p.clientId !== myClientId);
      box.innerHTML = others.map(p => `
        <button onclick="sendAction({type:'SELECT_TARGET', targetId:${p.id}})" class="w-full bg-[#FF007A] text-white border-3 border-[#300D21] p-3 rounded-2xl font-black text-left shadow-[3px_3px_0px_#300D21] active:translate-y-1">
          🥷 Украсть балл у ${escapeHTML(p.name)} (${p.score} б.)
        </button>
      `).join('');
      return;
    }

    // Д. МИННОЕ ПОЛЕ (С 3D FLIP И СОТРЯСЕНИЕМ ЭКРАНА)
    if (roundData.type === 'mine') {
      box.className = "grid grid-cols-3 gap-2.5 pt-2";
      const opts = roundData.a || [];
      const mineList = Array.isArray(roundData.mines) ? roundData.mines : [1, 4];

      box.innerHTML = opts.map((opt, idx) => {
        const isClicked = gameState.rt?.clickedOpts && gameState.rt.clickedOpts.includes(idx);
        const isDefuser = idx === roundData.c;
        const isMine = mineList.includes(idx);

        let badge = '';
        let animClass = '';
        if (isClicked) {
          if (isDefuser) { badge = '🏆'; animClass = 'mine-revealed-safe'; }
          else if (isMine) { badge = '💥'; animClass = 'mine-revealed-boom'; }
          else { badge = '🛡️'; animClass = 'mine-revealed-safe'; }
        }

        return `
          <button ${isMyTurn && !isClicked ? `onclick="sendAnswer(${idx})"` : 'disabled'} 
                  class="mine-grid-card ${animClass} ${isClicked ? 'pointer-events-none' : ''} ${!isMyTurn ? 'cursor-default' : ''}">
            ${badge ? `<span class="text-3xl mb-1">${badge}</span>` : ''}
            <span class="text-xs font-black text-[#FAF6EE] leading-tight">${escapeHTML(opt)}</span>
          </button>
        `;
      }).join('');
      return;
    }

    // Е. ХРОНОЛОГИЯ ПО ПОРЯДКУ
    if (roundData.type === 'order') {
      box.className = "space-y-2 pt-2";
      const opts = gameState.rt?.shuffledOptions || roundData.items || [];
      
      const itemsHtml = opts.map((opt, idx) => {
        const pickedPos = playerOrderPicked.indexOf(idx);
        const isSel = pickedPos !== -1;
        return `
          <button ${isMyTurn ? `onclick="toggleOrderPick(${idx})"` : 'disabled'} 
                  class="order-item-btn ${isSel ? 'selected' : ''} ${!isMyTurn ? 'cursor-default' : ''}">
            <span>${escapeHTML(opt)}</span>
            ${isSel ? `<span class="bg-[#00F0FF] text-[#300D21] text-xs font-black px-2 py-0.5 rounded-lg">${pickedPos + 1}</span>` : '+'}
          </button>
        `;
      }).join('');

      box.innerHTML = `
        <div class="space-y-2">${itemsHtml}</div>
        ${isMyTurn ? `
          <div class="flex gap-2 pt-2">
            <button onclick="playerOrderPicked=[]; renderGameUI();" class="bg-[#FAF6EE] border-3 border-[#300D21] px-4 py-2.5 rounded-xl font-black text-xs text-[#300D21]">Сброс</button>
            <button onclick="sendAction({type:'SUBMIT_ORDER', order: playerOrderPicked})" ${playerOrderPicked.length === 4 ? '' : 'disabled class="opacity-40"'} class="flex-grow bg-[#7CB518] text-[#300D21] border-3 border-[#300D21] py-2.5 rounded-xl font-black text-xs uppercase shadow-[3px_3px_0px_#300D21]">ПОДТВЕРДИТЬ ХРОНОЛОГИЮ ✅</button>
          </div>
        ` : ''}
      `;
      return;
    }

    // Ж. ФИНАЛ: ВЕТО И ВА-БАНК (КРАСИВАЯ СЕТКА КАРТОЧЕК ВМЕСТО КРИВЫХ КНОПОК)
    if (roundData.type === 'veto') {
      // ФАЗА 1: ВЫЧЕРКИВАНИЕ ТЕМ
      if (gameState.rt?.phase === 'banning') {
        box.className = "grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2";
        box.innerHTML = (roundData.categories || []).map((cat, idx) => {
          const isBanned = gameState.rt.banned && gameState.rt.banned.includes(idx);
          return `
            <button onclick="sendAction({type:'VETO_BAN_CATEGORY', catIndex:${idx}})" ${isBanned ? 'disabled' : ''} 
                    class="veto-topic-card ${isBanned ? 'veto-topic-banned' : 'hover:scale-105'} animate__animated animate__zoomIn">
              <span class="text-2xl mb-1">${isBanned ? '❌' : '🎯'}</span>
              <span class="text-xs uppercase">${escapeHTML(cat.name)}</span>
            </button>
          `;
        }).join('');
        return;
      }

      // ФАЗА 2: СТАВКА НА ВА-БАНК
      if (gameState.rt?.phase === 'betting') {
        box.className = "max-w-md mx-auto pt-2";
        const myScore = (gameState.players.find(p => p.clientId === myClientId)?.score) || 1;
        const maxBet = Math.max(1, myScore);
        box.innerHTML = `
          <div class="bg-[#180315] p-5 rounded-3xl border-4 border-[#FDB813] text-center space-y-3 shadow-[6px_6px_0px_#300D21]">
            <span class="text-xs font-black uppercase text-[#FDB813] block">ВАША СТАВКА НА ВА-БАНК (ДО ${maxBet} БАЛЛОВ):</span>
            <input id="veto-bet-input" type="number" min="1" max="${maxBet}" value="${Math.min(2, maxBet)}" class="w-full p-3.5 border-4 border-[#300D21] rounded-2xl font-black text-center text-2xl bg-[#FAF6EE] text-[#300D21]">
            <button onclick="sendAction({type:'VETO_SUBMIT_BET', bet:parseInt(document.getElementById('veto-bet-input').value,10)||1}); showToast('Ставка на финал принята!');" class="w-full bg-[#FDB813] hover:bg-[#ffe278] text-[#300D21] border-3 border-[#300D21] py-3 rounded-2xl font-black uppercase shadow-[3px_3px_0px_#300D21] text-xs">
              Подтвердить ставку 🎲
            </button>
          </div>
        `;
        return;
      }
    }

    // З. СТАНДАРТНЫЕ ВАРИАНТЫ
    if (gameState.showOptions && currentOptions.length) {
      box.className = "grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2";
      box.innerHTML = currentOptions.map((opt, idx) => {
        const isSuspense = gameState.rt?.suspenseChoice === idx;
        const canClick = isMyTurn && !gameState.hasAnsweredCurrent;
        return `
          <button ${canClick ? `onclick="sendAnswer(${idx})"` : 'disabled'} 
                  class="option-cascade-card bg-[#FAF6EE] border-4 border-[#300D21] p-3.5 rounded-2xl font-black text-left shadow-[4px_4px_0px_#300D21] flex items-center gap-3 text-[#300D21] ${canClick ? 'hover:bg-[#00F0FF] active:scale-95 cursor-pointer' : 'cursor-default'} ${isSuspense ? 'answer-selected-suspense' : ''}"
                  style="animation-delay: ${idx * 60}ms">
            <span class="w-7 h-7 rounded-lg bg-[#FDB813] border-2 border-[#300D21] flex items-center justify-center font-black text-xs shrink-0">${String.fromCharCode(1040+idx)}</span>
            <span class="text-xs sm:text-sm font-extrabold truncate">${escapeHTML(opt)}</span>
          </button>
        `;
      }).join('');
    } else {
      box.className = "flex justify-center pt-3";
      box.innerHTML = `
        <div class="suspense-loader-box animate__animated animate__fadeIn">
          <div class="suspense-dots"><span></span><span></span><span></span></div>
          <span class="text-xs font-black uppercase text-[#00F0FF] tracking-wider">Варианты открываются...</span>
        </div>
      `;
    }
  }
}

function toggleOrderPick(idx) {
  if (playerOrderPicked.includes(idx)) playerOrderPicked = playerOrderPicked.filter(i => i !== idx);
  else if (playerOrderPicked.length < 4) playerOrderPicked.push(idx);
  playSound('click');
  renderGameUI();
}

function sendAnswer(idx) {
  playSound('click');
  gameState.hasAnsweredCurrent = true;
  sendAction({ type: "SUBMIT_ANSWER", choice: idx });
}

function sendAction(msg) {
  msg.clientId = myClientId;
  if (gameState.isHost) {
    hostHandleIncomingMessage(msg);
  } else {
    NetworkBus.send(`${roomTopic}/host`, msg);
  }
}