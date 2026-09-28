let modeIntroTimer = null;
let suspenseTimer = null;
let verdictTimer = null;

function createRoomAsHost() {
  playSound('click');
  gameState.isHost = true;

  const rawCode = Math.random().toString(36).substring(2, 6).toUpperCase();
  gameState.roomCode = rawCode;
  roomTopic = `dumat_quiz_v2/${rawCode}`;

  const pack = window.AVATAR_PACK || ["🤖"];
  const myAvatar = pack[gameState.selectedAvatarIdx % pack.length] || pack[0];

  gameState.players = [{
    id: 0,
    clientId: myClientId,
    name: gameState.name || 'Игрок 1',
    score: 0,
    avatar: myAvatar,
    ready: false,
    themes: []
  }];

  document.getElementById('screen-entry')?.classList.add('hidden');
  document.getElementById('arena-stage')?.classList.remove('hidden');
  document.getElementById('host-lobby-controls')?.classList.remove('hidden');

  NetworkBus.init(rawCode, (data) => hostHandleIncomingMessage(data));

  if (typeof mqtt !== 'undefined' && mqtt.connect) {
    try {
      mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
        clientId: 'dumat_h_' + Math.random().toString(16).substring(2, 10),
        keepalive: 60,
        reconnectPeriod: 1500
      });
      mqttClient.on('connect', () => mqttClient.subscribe(`${roomTopic}/host`));
      mqttClient.on('message', (topic, msg) => {
        try { NetworkBus.handleInbound(JSON.parse(msg.toString())); } catch(e) {}
      });
    } catch(err) { console.warn("MQTT host err:", err); }
  }

  renderGameUI();
}

function hostHandleIncomingMessage(data) {
  if (!data) return;

  if (data.type === "REQUEST_STATE") {
    hostBroadcastState();
    return;
  }

  if (data.type === "JOIN") {
    const reqName = (data.name || '').trim();
    const reqClientId = String(data.clientId || '');
    if (!reqName || !reqClientId) return;

    const pack = window.AVATAR_PACK || ["🤖"];
    const existing = gameState.players.find(p => p.clientId === reqClientId);
    if (existing) {
      existing.name = reqName;
      if (data.avatarIdx !== undefined) existing.avatar = pack[data.avatarIdx] || existing.avatar;
      hostBroadcastState();
      return;
    }

    if (gameState.players.some(p => p.name.toLowerCase() === reqName.toLowerCase())) {
      NetworkBus.send(`${roomTopic}/player/${reqClientId}`, { type: "REJECT", reason: "NAME_TAKEN" });
      return;
    }

    if (gameState.players.length >= 8) {
      NetworkBus.send(`${roomTopic}/player/${reqClientId}`, { type: "REJECT", reason: "ROOM_FULL" });
      return;
    }

    const assignedAvatar = (data.avatarIdx !== undefined && pack[data.avatarIdx])
      ? pack[data.avatarIdx]
      : pack[gameState.players.length % pack.length];

    gameState.players.push({
      id: gameState.players.length,
      clientId: reqClientId,
      name: reqName,
      score: 0,
      avatar: assignedAvatar,
      ready: false,
      themes: []
    });

    playSound('boing');
    showToast(`🎮 ${reqName} присоединился к игре!`);
    hostBroadcastState();
    return;
  }

  if (data.type === "SUBMIT_THEMES") {
    hostHandleThemesSubmit(data.clientId, data.themes);
    return;
  }

  if (data.type === "LEAVE") {
    const leftClientId = String(data.clientId || '');
    gameState.players = gameState.players.filter(p => p.clientId !== leftClientId);
    hostRebuildBasket();
    hostBroadcastState();
    return;
  }

  const player = gameState.players.find(p => p.clientId === data.clientId);
  if (!player) return;
  const roundData = gameState.roundsData[gameState.activeQuestionIdx];
  if (!roundData) return;
  const type = roundData.type || 'classic';

  // 1. ВЫБОР РИСКА (СУНДУКИ С ЯВНЫМИ БАЛЛАМИ)
  if (data.type === "BLIND_CHEST_CHOSEN") {
    const chests = roundData.chests || [
      { value: 1, difficulty: "Простой", q: roundData.q, a: roundData.a, c: 0 },
      { value: 2, difficulty: "Средний", q: roundData.q, a: roundData.a, c: 1 },
      { value: 3, difficulty: "Хардкор", q: roundData.q, a: roundData.a, c: 2 }
    ];
    const item = chests[data.chestIdx] || chests[0];
    gameState.rt.blindChosenItem = item;
    gameState.rt.blindValue = item.value;
    gameState.rt.blindPhase = 'revealed';
    hostBroadcastState();

    setTimeout(() => {
      gameState.rt.blindPhase = 'answering';
      gameState.showOptions = true;
      hostBroadcastState();
    }, 600);
    return;
  }

  // 2. ХРОНОЛОГИЯ ПО ПОРЯДКУ
  if (data.type === "SUBMIT_ORDER") {
    const isCorrect = Array.isArray(data.order) && data.order.length === 4 && data.order.every((val, i) => {
      return gameState.rt.originalIndices && gameState.rt.originalIndices[val] === i;
    });
    if (isCorrect) player.score += 3;
    const correctSeq = (roundData.items || roundData.a || []).join(' → ');
    hostTriggerVerdict(player.name, isCorrect, isCorrect ? `Хронология верна! (+3 б.)` : `Ошибка в хронологии!`, correctSeq);
    return;
  }

  // 3. АУКЦИОН
  if (data.type === "SUBMIT_BID") {
    gameState.rt.bids = gameState.rt.bids || {};
    gameState.rt.bids[player.id] = data.bid;

    if (Object.keys(gameState.rt.bids).length >= gameState.players.length) {
      let maxBid = 0, winner = gameState.players[0];
      gameState.players.forEach(p => {
        const b = gameState.rt.bids[p.id] || 0;
        if (b > maxBid) { maxBid = b; winner = p; }
      });
      gameState.rt.winningBid = Math.max(1, maxBid);
      gameState.activePlayerIdx = gameState.players.findIndex(p => p.id === winner.id);
      gameState.rt.stage = 'play';
      gameState.showOptions = true;
      showToast(`🔨 Торги выиграл(а) ${winner.name} (ставка: ${maxBid} б.)!`);
      hostBroadcastState();
    }
    return;
  }

  // 4. САБОТАЖ
  if (data.type === "SELECT_TARGET") {
    const target = gameState.players.find(p => p.id === data.targetId);
    if (target) {
      player.score += 1;
      target.score = Math.max(0, target.score - 1);
      hostTriggerVerdict(player.name, true, `Кража 1 балла у ${target.name}!`);
    }
    return;
  }

  // 5. СНЕЖНЫЙ КОМ (РЕШЕНИЕ: ЗАБРАТЬ БАНК ИЛИ ИДТИ ДАЛЬШЕ)
  if (data.type === "SNOWBALL_DECIDE") {
    if (data.action === "BANK") {
      player.score += (gameState.rt.bankedPoints || 0);
      hostTriggerVerdict(player.name, true, `Забрал(а) банк: +${gameState.rt.bankedPoints} б.!`);
    } else {
      gameState.rt.chainIdx = (gameState.rt.chainIdx || 0) + 1;
      gameState.rt.awaitingDecision = false;
      gameState.showOptions = true;
      gameState.hasAnsweredCurrent = false;
      hostBroadcastState();
    }
    return;
  }

  // 6. РАУНД СОЮЗА
  if (data.type === "SUBMIT_UNION_VOTE") {
    gameState.rt.votes = gameState.rt.votes || {};
    gameState.rt.votes[player.id] = data.choice;

    if (Object.keys(gameState.rt.votes).length >= gameState.players.length) {
      const tally = [0, 0, 0, 0];
      Object.values(gameState.rt.votes).forEach(c => { if(tally[c] !== undefined) tally[c]++; });
      let maxVotes = -1, choice = 0;
      tally.forEach((v, idx) => { if(v > maxVotes) { maxVotes = v; choice = idx; } });

      const isCorrect = choice === roundData.c;
      gameState.players.forEach(p => {
        p.score = isCorrect ? p.score + 2 : Math.max(0, p.score - 2);
      });
      hostTriggerVerdict("Команда", isCorrect, null, roundData.a ? roundData.a[roundData.c] : '');
    }
    return;
  }

  // 7. ВЕТО И ВА-БАНК
  if (data.type === "VETO_BAN_CATEGORY") {
    gameState.rt.banned = gameState.rt.banned || [];
    if (!gameState.rt.banned.includes(data.catIndex)) gameState.rt.banned.push(data.catIndex);
    const cats = roundData.categories || [];
    if (gameState.rt.banned.length >= cats.length - 1) {
      let finalIdx = 0;
      cats.forEach((_, idx) => { if(!gameState.rt.banned.includes(idx)) finalIdx = idx; });
      gameState.rt.finalCatIdx = finalIdx;
      gameState.rt.phase = 'betting';
      gameState.rt.bets = {};
    }
    hostBroadcastState();
    return;
  }

  if (data.type === "VETO_SUBMIT_BET") {
    gameState.rt.bets = gameState.rt.bets || {};
    gameState.rt.bets[player.id] = data.bet;
    if (Object.keys(gameState.rt.bets).length >= gameState.players.length) {
      gameState.rt.phase = 'answering';
      gameState.rt.vetoAnswers = {};
    }
    hostBroadcastState();
    return;
  }

  if (data.type === "VETO_SUBMIT_ANSWER") {
    gameState.rt.vetoAnswers = gameState.rt.vetoAnswers || {};
    gameState.rt.vetoAnswers[player.id] = data.choice;
    if (Object.keys(gameState.rt.vetoAnswers).length >= gameState.players.length) {
      const cat = roundData.categories[gameState.rt.finalCatIdx];
      gameState.players.forEach(p => {
        const pChoice = gameState.rt.vetoAnswers[p.id];
        const pBet = gameState.rt.bets ? (gameState.rt.bets[p.id] || 1) : 1;
        if (pChoice === cat.c) p.score += pBet;
        else p.score = Math.max(0, p.score - pBet);
      });
      hostTriggerVerdict("ФИНАЛ", true, "Баллы за Ва-банк подсчитаны!", cat ? cat.a[cat.c] : '');
    }
    return;
  }

  // 8. СТАНДАРТНЫЙ ОТВЕТ (КЛАССИКА, МИНЫ, СНЕЖНЫЙ КОМ)
  if (data.type === "SUBMIT_ANSWER") {
    gameState.rt.suspenseChoice = data.choice;
    SoundManager.playTensionTick();
    hostBroadcastState();

    clearTimeout(suspenseTimer);
    suspenseTimer = setTimeout(() => {
      gameState.rt.suspenseChoice = null;

      // МИННОЕ ПОЛЕ
      if (type === 'mine') {
        gameState.rt.clickedOpts = gameState.rt.clickedOpts || [];
        if (!gameState.rt.clickedOpts.includes(data.choice)) gameState.rt.clickedOpts.push(data.choice);

        const mineList = Array.isArray(roundData.mines) ? roundData.mines : [1, 4];
        const isMine = mineList.includes(data.choice);
        const isDefuser = data.choice === roundData.c;

        if (isDefuser) {
          player.score += 3;
          hostTriggerVerdict(player.name, true, "Поле обезврежено: +3 балла!");
        } else if (isMine) {
          player.score = Math.max(0, player.score - 2);
          document.body.classList.add('screen-shake');
          setTimeout(() => document.body.classList.remove('screen-shake'), 600);
          hostTriggerVerdict(player.name, false, "Подрыв на мине: -2 балла!", roundData.a ? roundData.a[roundData.c] : '');
        } else {
          player.score += 1;
          playSound('correct');
          showToast(`🛡️ ${player.name} открыл безопасный сектор! (+1 б.)`);
          gameState.hasAnsweredCurrent = false;
          hostBroadcastState();
        }
        return;
      }

      // СНЕЖНЫЙ КОМ
      if (type === 'snowball') {
        const chain = roundData.chain || [];
        const qObj = chain[gameState.rt.chainIdx || 0] || {};
        const isCorrect = data.choice === qObj.c;

        if (isCorrect) {
          gameState.rt.bankedPoints = (gameState.rt.bankedPoints || 0) + (gameState.rt.chainIdx + 1);
          if (gameState.rt.chainIdx >= chain.length - 1) {
            player.score += gameState.rt.bankedPoints;
            hostTriggerVerdict(player.name, true, `Пройдена вся цепочка: +${gameState.rt.bankedPoints} б.!`);
          } else {
            gameState.rt.awaitingDecision = true;
            hostBroadcastState();
          }
        } else {
          gameState.rt.bankedPoints = 0;
          hostTriggerVerdict(player.name, false, "Снежный ком растаял!", qObj.a ? qObj.a[qObj.c] : '');
        }
        return;
      }

      if (type === 'auction') {
        const isCorrect = data.choice === roundData.c;
        const bid = gameState.rt.winningBid || 1;
        player.score = Math.max(0, player.score + (isCorrect ? bid : -bid));
        hostTriggerVerdict(player.name, isCorrect, null, roundData.a ? roundData.a[roundData.c] : '');
        return;
      }

      let qValue = 2;
      let targetCorrect = roundData.c;
      let correctText = roundData.a ? roundData.a[roundData.c] : '';

      if (type === 'blind' && gameState.rt.blindChosenItem) {
        qValue = gameState.rt.blindChosenItem.value || 2;
        targetCorrect = gameState.rt.blindChosenItem.c;
        correctText = gameState.rt.blindChosenItem.a ? gameState.rt.blindChosenItem.a[targetCorrect] : '';
      }

      const isCorrect = data.choice === targetCorrect;

      if (type === 'king') {
        if (isCorrect) player.score += 2;
        else {
          player.score = Math.max(0, player.score - 2);
          gameState.players.forEach(p => { if (p.id !== player.id) p.score += 1; });
        }
      } else if (type === 'sabotage' && isCorrect) {
        // СОЛО-РЕЖИМ ЗЛОГО КВИЗА (не зависает, если нет соперников)
        const others = gameState.players.filter(p => p.id !== player.id);
        if (others.length === 0) {
          player.score += 1;
          hostTriggerVerdict(player.name, true, "Саботаж: +1 балл (соперников нет)!");
          return;
        }
        gameState.rt.awaitingTarget = true;
        hostBroadcastState();
        return;
      } else {
        if (isCorrect) player.score += qValue;
      }

      hostTriggerVerdict(player.name, isCorrect, null, correctText);
    }, 1000);
  }
}

function hostHandleThemesSubmit(clientId, themes) {
  const p = gameState.players.find(player => player.clientId === clientId);
  if (p) {
    p.ready = true;
    p.themes = themes;
  }
  hostRebuildBasket();
  hostBroadcastState();
}

function hostRebuildBasket() {
  const all = [];
  gameState.players.forEach(p => {
    (p.themes || []).forEach(t => { if (!all.includes(t)) all.push(t); });
  });
  gameState.basketThemes = all;
}

// ТОЧНЫЙ 2-СЕКУНДНЫЙ ВЕРДИКТ
function hostTriggerVerdict(playerName, isCorrect, customText = null, correctText = '') {
  try {
    if (isCorrect) playSound('correct');
    else SoundManager.playError();
  } catch(e) {}

  gameState.feedbackData = {
    playerName, isCorrect, customText, correctText
  };
  hostBroadcastState();

  clearTimeout(verdictTimer);
  verdictTimer = setTimeout(() => {
    gameState.feedbackData = null;
    gameState.hasAnsweredCurrent = false;
    hostBroadcastState();

    if (gameState.currentRound < gameState.totalRounds) {
      hostLaunchRound(gameState.currentRound + 1);
    } else {
      gameState.gameOver = true;
      gameState.roundStage = 'podium';
      try { playSound('correct'); } catch(e) {}
      hostBroadcastState();
    }
  }, 2000);
}

function hostStartMasterGame() {
  if (!gameState.roundsData || !gameState.roundsData.length) {
    showToast("Сначала загрузите вопросы!", true);
    openHostAIModal();
    return;
  }

  // game-in.mp3 НЕ ВЫЗЫВАЕТСЯ!
  gameState.roundStage = 'countdown';
  gameState.rt.countdown = 3;
  hostBroadcastState();
  SoundManager.playCountdownTick();

  const intv = setInterval(() => {
    gameState.rt.countdown--;
    if (gameState.rt.countdown > 0) {
      SoundManager.playCountdownTick();
      hostBroadcastState();
    } else if (gameState.rt.countdown === 0) {
      SoundManager.playCountdownBoom();
      hostBroadcastState();
    } else {
      clearInterval(intv);
      hostLaunchRound(1);
    }
  }, 1000);
}

function hostLaunchRound(num) {
  gameState.currentRound = num;
  gameState.activeQuestionIdx = num - 1;
  gameState.feedbackData = null;
  gameState.hasAnsweredCurrent = false;
  playerOrderPicked = [];
  gameState.rt = {};

  const rData = gameState.roundsData[gameState.activeQuestionIdx] || {};
  const type = rData.type || 'classic';

  if (type === 'blind') {
    gameState.rt.blindPhase = 'pick_chest';
  } else if (type === 'order') {
    const raw = (rData.items || rData.a || []).map((t, i) => ({ text: t, orig: i }));
    const shuffled = [...raw].sort(() => 0.5 - Math.random());
    gameState.rt.shuffledOptions = shuffled.map(s => s.text);
    gameState.rt.originalIndices = shuffled.map(s => s.orig);
  } else if (type === 'mine') {
    gameState.rt.clickedOpts = [];
  } else if (type === 'auction') {
    gameState.rt.stage = 'bidding';
    gameState.rt.bids = {};
  } else if (type === 'snowball') {
    gameState.rt.chainIdx = 0;
    gameState.rt.bankedPoints = 0;
  } else if (type === 'union') {
    gameState.rt.votes = {};
  } else if (type === 'veto') {
    gameState.rt.banned = [];
    gameState.rt.phase = 'banning';
  }

  if (type === 'king') {
    const leader = gameState.players.reduce((best, p) => p.score > best.score ? p : best, gameState.players[0]);
    gameState.activePlayerIdx = gameState.players.findIndex(p => p.id === leader.id);
  } else {
    gameState.activePlayerIdx = (num - 1) % Math.max(1, gameState.players.length);
  }

  const isSpecial = type !== 'classic';
  if (num === 1 || isSpecial) {
    gameState.roundStage = 'mode_intro';
    gameState.showOptions = false;
    hostBroadcastState();

    let introLeft = 5;
    clearInterval(modeIntroTimer);
    modeIntroTimer = setInterval(() => {
      introLeft--;
      if (introLeft <= 0) {
        clearInterval(modeIntroTimer);
        hostProceedToQuestion();
      }
    }, 1000);
  } else {
    hostProceedToQuestion();
  }
}

function skipModeIntro() {
  clearInterval(modeIntroTimer);
  hostProceedToQuestion();
}

function hostProceedToQuestion() {
  clearInterval(modeIntroTimer);
  gameState.roundStage = 'play';
  gameState.showOptions = true;
  gameState.hasAnsweredCurrent = false;
  hostBroadcastState();
}

function hostBroadcastState() {
  const activeP = gameState.players[gameState.activePlayerIdx] || gameState.players[0];
  gameState.activePlayerClientId = activeP ? activeP.clientId : '';

  const payload = {
    type: "STATE_UPDATE",
    currentRound: gameState.currentRound,
    totalRounds: gameState.totalRounds,
    roundStage: gameState.roundStage,
    roundType: (gameState.roundsData[gameState.activeQuestionIdx] || {}).type || 'classic',
    theme: (gameState.roundsData[gameState.activeQuestionIdx] || {}).theme || '',
    roomCode: gameState.roomCode,
    activePlayerIdx: gameState.activePlayerIdx,
    activePlayerClientId: gameState.activePlayerClientId,
    activePlayerName: activeP ? activeP.name : '',
    feedback: gameState.feedbackData,
    showOptions: gameState.showOptions,
    rt: gameState.rt,
    roundsData: gameState.roundsData,
    basketThemes: gameState.basketThemes,
    players: gameState.players,
    gameOver: gameState.gameOver
  };

  NetworkBus.send(`${roomTopic}/broadcast`, payload);
  renderGameUI();
}