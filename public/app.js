(() => {
  'use strict';

  const ROUND_DURATION = 25;
  const MAX_DEPTH = 7000;
  const TIER_ORDER = ['plankton', 'too_clever', 'schooler', 'rare', 'deep_cut', 'krillion'];

  const state = {
    tiers: {},
    oceanZones: [],
    dives: [],
    prompts: {},
    activeDiveTitle: '',
    roundPrompts: [],
    currentRoundIndex: 0,
    totalScore: 0,
    totalDepth: 0,
    history: [],
    timerEnabled: true,
    timeLeft: ROUND_DURATION,
    timerHandle: null,
    roundLocked: false,
    evaluating: false
  };

  // DOM References
  const el = {
    diveSelect: document.getElementById('diveSelect'),
    timerToggleBtn: document.getElementById('timerToggleBtn'),
    openLabBtn: document.getElementById('openLabBtn'),
    openRulesBtn: document.getElementById('openRulesBtn'),
    depthValue: document.getElementById('depthValue'),
    totalScoreValue: document.getElementById('totalScoreValue'),
    oceanZoneBadge: document.getElementById('oceanZoneBadge'),
    depthFill: document.getElementById('depthFill'),
    diverMarker: document.getElementById('diverMarker'),
    markerTag: document.getElementById('markerTag'),
    tiersLegendList: document.getElementById('tiersLegendList'),

    gameView: document.getElementById('gameView'),
    summaryView: document.getElementById('summaryView'),
    roundCounter: document.getElementById('roundCounter'),
    diveNamePill: document.getElementById('diveNamePill'),
    timerDisplayWrap: document.getElementById('timerDisplayWrap'),
    timerSeconds: document.getElementById('timerSeconds'),
    timerBarTrack: document.getElementById('timerBarTrack'),
    timerBarFill: document.getElementById('timerBarFill'),
    promptRu: document.getElementById('promptRu'),
    promptEn: document.getElementById('promptEn'),
    toggleHintBtn: document.getElementById('toggleHintBtn'),
    promptHintText: document.getElementById('promptHintText'),

    answerForm: document.getElementById('answerForm'),
    answerInput: document.getElementById('answerInput'),
    answerError: document.getElementById('answerError'),
    submitBtn: document.getElementById('submitBtn'),
    exampleChips: document.getElementById('exampleChips'),

    revealPanel: document.getElementById('revealPanel'),
    tierBanner: document.getElementById('tierBanner'),
    tierEmoji: document.getElementById('tierEmoji'),
    tierTitle: document.getElementById('tierTitle'),
    tierSubtitle: document.getElementById('tierSubtitle'),
    freqPill: document.getElementById('freqPill'),
    revOriginal: document.getElementById('revOriginal'),
    revLang: document.getElementById('revLang'),
    revTranslated: document.getElementById('revTranslated'),
    revAltTranslations: document.getElementById('revAltTranslations'),
    revSemanticBadge: document.getElementById('revSemanticBadge'),
    revExplanation: document.getElementById('revExplanation'),
    spectrumGrid: document.getElementById('spectrumGrid'),
    nextRoundBtn: document.getElementById('nextRoundBtn'),

    summaryZoneBadge: document.getElementById('summaryZoneBadge'),
    summaryDepth: document.getElementById('summaryDepth'),
    summaryScore: document.getElementById('summaryScore'),
    summaryZoneName: document.getElementById('summaryZoneName'),
    summaryTableBody: document.getElementById('summaryTableBody'),
    copyShareBtn: document.getElementById('copyShareBtn'),
    playAgainBtn: document.getElementById('playAgainBtn'),
    copyFeedback: document.getElementById('copyFeedback'),

    labDialog: document.getElementById('labDialog'),
    labPromptSelect: document.getElementById('labPromptSelect'),
    labForm: document.getElementById('labForm'),
    labAnswerInput: document.getElementById('labAnswerInput'),
    labError: document.getElementById('labError'),
    labTestBtn: document.getElementById('labTestBtn'),
    labResult: document.getElementById('labResult'),

    rulesDialog: document.getElementById('rulesDialog'),
    rulesTierCards: document.getElementById('rulesTierCards')
  };

  function getZoneForDepth(depth) {
    return (
      state.oceanZones.find(z => depth >= z.minDepth && depth <= z.maxDepth) ||
      state.oceanZones[0] ||
      { name: 'Солнечная зона', badge: '🌊 Поверхность' }
    );
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString('ru-RU');
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderSidebarLegend() {
    clearChildren(el.tiersLegendList);
    clearChildren(el.rulesTierCards);

    TIER_ORDER.forEach(tierId => {
      const t = state.tiers[tierId];
      if (!t) return;

      const li = document.createElement('li');
      li.className = 'tier-legend-item';
      li.style.setProperty('--tier-color', t.color);

      const left = document.createElement('span');
      left.className = 'tier-legend-name';
      left.textContent = `${t.emoji} ${t.name}`;

      const right = document.createElement('span');
      right.className = 'tier-legend-pts';
      right.textContent = `${t.points} pts · ${t.depth} м`;

      li.append(left, right);
      el.tiersLegendList.appendChild(li);

      const card = document.createElement('div');
      card.className = 'rule-tier-card';
      card.style.setProperty('--tier-color', t.color);
      const title = document.createElement('strong');
      title.textContent = `${t.emoji} ${t.name} (${t.ruName}) — ${t.points} очков / ${t.depth} м`;
      const desc = document.createElement('p');
      desc.textContent = `${t.frequencyLabel}. ${t.description}`;
      card.append(title, desc);
      el.rulesTierCards.appendChild(card);
    });
  }

  function populateLabSelect() {
    clearChildren(el.labPromptSelect);
    Object.values(state.prompts).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.ruPrompt} (${p.enPrompt})`;
      el.labPromptSelect.appendChild(opt);
    });
  }

  function updateDepthMeter() {
    const pct = Math.min(100, Math.max(0, (state.totalDepth / MAX_DEPTH) * 100));
    el.depthValue.textContent = formatNumber(state.totalDepth);
    el.totalScoreValue.textContent = formatNumber(state.totalScore);
    el.depthFill.style.height = `${pct}%`;
    el.diverMarker.style.top = `${pct}%`;
    el.markerTag.textContent = `${formatNumber(state.totalDepth)} м`;

    const zone = getZoneForDepth(state.totalDepth);
    el.oceanZoneBadge.textContent = zone.badge;
  }

  function stopTimer() {
    if (state.timerHandle) {
      clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
  }

  function updateTimerDisplay() {
    if (!state.timerEnabled) {
      el.timerSeconds.textContent = '∞';
      el.timerSeconds.classList.remove('urgent');
      el.timerBarFill.style.width = '100%';
      return;
    }
    el.timerSeconds.textContent = `${state.timeLeft}s`;
    el.timerSeconds.classList.toggle('urgent', state.timeLeft <= 6 && !state.roundLocked);
    const pct = Math.max(0, (state.timeLeft / ROUND_DURATION) * 100);
    el.timerBarFill.style.width = `${pct}%`;
  }

  function startTimer() {
    stopTimer();
    state.timeLeft = ROUND_DURATION;
    updateTimerDisplay();
    if (!state.timerEnabled) return;

    state.timerHandle = setInterval(() => {
      if (state.roundLocked) {
        stopTimer();
        return;
      }
      state.timeLeft -= 1;
      updateTimerDisplay();
      if (state.timeLeft <= 0) {
        stopTimer();
        submitAnswer(el.answerInput.value.trim(), true);
      }
    }, 1000);
  }

  function startDive(diveId) {
    stopTimer();
    state.currentRoundIndex = 0;
    state.totalScore = 0;
    state.totalDepth = 0;
    state.history = [];
    state.roundLocked = false;

    if (diveId === 'random-mix') {
      const all = Object.values(state.prompts);
      const shuffled = [...all].sort(() => Math.random() - 0.5);
      state.roundPrompts = shuffled.slice(0, 7);
      state.activeDiveTitle = '🎲 Случайный микс';
    } else {
      const dive = state.dives.find(d => d.id === diveId) || state.dives[0];
      state.roundPrompts = dive.promptIds.map(id => state.prompts[id]).filter(Boolean);
      state.activeDiveTitle = dive.badge;
    }

    el.summaryView.classList.add('hidden');
    el.gameView.classList.remove('hidden');
    updateDepthMeter();
    renderRound();
  }

  function renderRound() {
    const prompt = state.roundPrompts[state.currentRoundIndex];
    if (!prompt) return renderSummary();

    state.roundLocked = false;
    state.evaluating = false;

    el.roundCounter.textContent = `Раунд ${state.currentRoundIndex + 1} из ${state.roundPrompts.length}`;
    el.diveNamePill.textContent = state.activeDiveTitle;
    el.promptRu.textContent = prompt.ruPrompt;
    el.promptEn.textContent = prompt.enPrompt;
    el.promptHintText.textContent = prompt.hint;
    el.promptHintText.classList.add('hidden');

    el.answerInput.value = '';
    el.answerInput.disabled = false;
    el.answerInput.removeAttribute('aria-invalid');
    el.answerInput.setCustomValidity('');
    el.answerInput.dataset.dirty = 'false';
    el.answerError.textContent = '';
    el.answerError.classList.add('hidden');
    el.submitBtn.disabled = false;
    el.submitBtn.textContent = 'Проверить и нырнуть ↓';
    el.revealPanel.classList.add('hidden');

    // Quick multilingual example buttons
    clearChildren(el.exampleChips);
    if (Array.isArray(prompt.examples) && prompt.examples.length > 0) {
      const label = document.createElement('span');
      label.textContent = 'Примеры: ';
      el.exampleChips.appendChild(label);
      prompt.examples.forEach(ex => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip-btn';
        btn.textContent = `${ex.lang} ${ex.text}`;
        btn.addEventListener('click', () => {
          if (state.roundLocked) return;
          el.answerInput.value = ex.text;
          el.answerInput.focus();
        });
        el.exampleChips.appendChild(btn);
      });
    }

    startTimer();
    el.answerInput.focus();
  }

  async function submitAnswer(rawAnswer, isTimeout = false) {
    if (state.roundLocked || state.evaluating) return;
    const prompt = state.roundPrompts[state.currentRoundIndex];
    if (!prompt) return;

    if (!rawAnswer && !isTimeout) {
      setFieldError(el.answerInput, el.answerError, 'Введите ответ на любом языке перед отправкой.');
      el.answerInput.focus();
      return;
    }

    setFieldError(el.answerInput, el.answerError, '');

    stopTimer();
    state.evaluating = true;
    el.answerInput.disabled = true;
    el.submitBtn.disabled = true;
    el.submitBtn.textContent = 'Перевод и проверка...';

    try {
      const res = await fetch('/api/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptId: prompt.id,
          answer: rawAnswer
        })
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || 'Evaluation failed');

      state.roundLocked = true;
      state.evaluating = false;

      if (result.accepted) {
        state.totalScore += result.points;
        state.totalDepth += result.depth;
      }

      state.history.push({
        prompt,
        result
      });

      updateDepthMeter();
      renderReveal(result);
    } catch (err) {
      state.evaluating = false;
      el.answerInput.disabled = false;
      el.submitBtn.disabled = false;
      el.submitBtn.textContent = 'Проверить и нырнуть ↓';
      alert(`Ошибка проверки ответа: ${err.message}`);
    }
  }

  function renderReveal(result) {
    el.submitBtn.textContent = 'Ответ проверен';
    el.revealPanel.classList.remove('hidden');

    if (result.accepted && result.tier) {
      el.tierBanner.style.setProperty('--banner-color', result.tier.color);
      el.tierBanner.style.setProperty('--banner-bg', result.tier.bgGlow);
      el.tierEmoji.textContent = result.tier.emoji;
      el.tierTitle.textContent = `${result.tier.name} (${result.tier.ruName})`;
      el.tierSubtitle.textContent = `+${result.points} очков · +${result.depth} м глубины`;
      el.freqPill.textContent = `Встречаемость: ~${result.frequencyPct}% (${result.tier.frequencyLabel})`;
    } else {
      el.tierBanner.style.setProperty('--banner-color', '#f43f5e');
      el.tierBanner.style.setProperty('--banner-bg', 'rgba(244, 63, 94, 0.16)');
      el.tierEmoji.textContent = result.matchType === 'empty' ? '⏳' : '🫧';
      el.tierTitle.textContent = result.matchType === 'empty' ? 'Время вышло' : 'Не засчитано (0 м)';
      el.tierSubtitle.textContent = '+0 очков · Остаёмся на прежней глубине';
      el.freqPill.textContent = result.semanticScore > 0
        ? `Близость по теме: ${result.semanticScore}%`
        : 'Не подходит по смыслу';
    }

    el.revOriginal.textContent = result.originalInput ? `«${result.originalInput}»` : '—';
    el.revLang.textContent = `${result.detectedLang.flag} ${result.detectedLang.name}`;
    el.revTranslated.textContent = result.translatedEnglish || '—';

    const alts = (result.alternativeTranslations || []).filter(
      a => a.toLowerCase() !== (result.translatedEnglish || '').toLowerCase()
    );
    el.revAltTranslations.textContent = alts.length > 0 ? `(вар.: ${alts.slice(0, 3).join(', ')})` : '';

    if (result.accepted) {
      el.revSemanticBadge.classList.remove('rejected');
      if (result.matchType === 'unique_discovery') {
        el.revSemanticBadge.textContent = `🌟 Уникальный ответ · ${result.semanticScore}%`;
      } else if (result.matchType === 'subtype') {
        el.revSemanticBadge.textContent = `✨ Редкая разновидность · ${result.semanticScore}%`;
      } else if (result.matchType === 'semantic_close') {
        el.revSemanticBadge.textContent = `🧠 Близко по смыслу · ${result.semanticScore}%`;
      } else {
        el.revSemanticBadge.textContent = `✓ Засчитано · ${result.semanticScore}%`;
      }
    } else {
      el.revSemanticBadge.classList.add('rejected');
      el.revSemanticBadge.textContent = result.semanticScore > 0
        ? `🔍 Близко по теме (${result.semanticScore}%) · Не засчитано`
        : '✕ Не засчитано';
    }
    el.revExplanation.textContent = result.matchExplanation;

    // Render 6-tier spectrum for this prompt
    clearChildren(el.spectrumGrid);
    (result.sampleSpectrum || []).forEach(spec => {
      const cell = document.createElement('div');
      cell.className = 'spec-cell';
      cell.style.setProperty('--tier-color', spec.color);

      const top = document.createElement('div');
      top.className = 'spec-tier';
      const left = document.createElement('span');
      left.textContent = `${spec.emoji} ${spec.name}`;
      const right = document.createElement('span');
      right.textContent = `${spec.depth} м`;
      top.append(left, right);

      const ex = document.createElement('div');
      ex.className = 'spec-examples';
      ex.textContent = spec.examples.map(e => e.name).join(', ') || '—';

      cell.append(top, ex);
      el.spectrumGrid.appendChild(cell);
    });

    const isLast = state.currentRoundIndex >= state.roundPrompts.length - 1;
    el.nextRoundBtn.textContent = isLast ? 'Итоги погружения →' : 'Следующий раунд →';
    el.nextRoundBtn.focus();
  }

  function renderSummary() {
    stopTimer();
    el.gameView.classList.add('hidden');
    el.summaryView.classList.remove('hidden');
    el.copyFeedback.classList.add('hidden');

    const zone = getZoneForDepth(state.totalDepth);
    el.summaryZoneBadge.textContent = zone.badge;
    el.summaryDepth.textContent = `${formatNumber(state.totalDepth)} м`;
    el.summaryScore.textContent = formatNumber(state.totalScore);
    el.summaryZoneName.textContent = `Достигнутая зона: ${zone.name}`;

    clearChildren(el.summaryTableBody);
    state.history.forEach((item, idx) => {
      const tr = document.createElement('tr');
      const r = item.result;

      const tdIdx = document.createElement('td');
      tdIdx.textContent = String(idx + 1);

      const tdPrompt = document.createElement('td');
      tdPrompt.textContent = item.prompt.ruPrompt;

      const tdOrig = document.createElement('td');
      tdOrig.textContent = r.originalInput ? `${r.detectedLang.flag} ${r.originalInput}` : '—';

      const tdTrans = document.createElement('td');
      tdTrans.textContent = r.canonicalAnswer
        ? `${r.translatedEnglish} → ${r.canonicalAnswer}`
        : r.translatedEnglish || '—';

      const tdTier = document.createElement('td');
      if (r.accepted && r.tier) {
        tdTier.textContent = `${r.tier.emoji} ${r.tier.name}`;
        tdTier.style.color = r.tier.color;
        tdTier.style.fontWeight = '700';
      } else {
        tdTier.textContent = '✕ Мимо';
        tdTier.style.color = '#fb7185';
      }

      const tdDepth = document.createElement('td');
      tdDepth.textContent = `+${r.depth} м`;

      tr.append(tdIdx, tdPrompt, tdOrig, tdTrans, tdTier, tdDepth);
      el.summaryTableBody.appendChild(tr);
    });
  }

  function buildShareLog() {
    const zone = getZoneForDepth(state.totalDepth);
    const icons = state.history
      .map(h => (h.result.accepted && h.result.tier ? h.result.tier.emoji : '🫧'))
      .join(' ');
    return [
      `🌊 Krillion: Multilang — ${state.activeDiveTitle}`,
      `📏 Глубина: ${formatNumber(state.totalDepth)} м / 7 000 м (${state.totalScore} pts)`,
      `🏅 Ранг: ${zone.badge}`,
      `${icons}`
    ].join('\n');
  }

  async function runLabCheck(e) {
    e.preventDefault();
    const promptId = el.labPromptSelect.value;
    const answer = el.labAnswerInput.value.trim();
    if (!answer) {
      setFieldError(el.labAnswerInput, el.labError, 'Введите слово или фразу для проверки.');
      el.labAnswerInput.focus();
      return;
    }
    setFieldError(el.labAnswerInput, el.labError, '');

    el.labTestBtn.disabled = true;
    el.labTestBtn.textContent = 'Проверка...';

    try {
      const res = await fetch('/api/translate-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId, answer })
      });
      const r = await res.json();
      if (!r.ok) throw new Error(r.error || 'Error');

      el.labResult.classList.remove('hidden');
      clearChildren(el.labResult);

      const line1 = document.createElement('p');
      line1.innerHTML = ''; // built safely with nodes below
      const strong1 = document.createElement('strong');
      strong1.textContent = '1. Определён язык: ';
      line1.append(strong1, `${r.detectedLang.flag} ${r.detectedLang.name} («${r.originalInput}»)`);

      const line2 = document.createElement('p');
      const strong2 = document.createElement('strong');
      strong2.textContent = '2. Перевод (EN): ';
      const altTxt = (r.alternativeTranslations || []).length > 1
        ? ` · варианты: ${r.alternativeTranslations.slice(0, 4).join(', ')}`
        : '';
      line2.append(strong2, `${r.translatedEnglish}${altTxt}`);

      const line3 = document.createElement('p');
      const strong3 = document.createElement('strong');
      strong3.textContent = '3. Смысл и вердикт: ';
      let statusTxt;
      if (r.accepted) {
        statusTxt = `✓ ЗАСЧИТАНО (${r.semanticScore}%, метод: ${r.matchType}) — ${r.tier.emoji} ${r.tier.name} (+${r.points} pts / +${r.depth} м)`;
      } else if (r.semanticScore > 0) {
        statusTxt = `🔍 БЛИЗКО ПО ТЕМЕ (${r.semanticScore}%), но не засчитано (0 pts)`;
      } else {
        statusTxt = '✕ НЕ ЗАСЧИТАНО (0 pts)';
      }
      line3.append(strong3, statusTxt);
      line3.style.color = r.accepted ? '#6ee7b7' : (r.semanticScore > 0 ? '#fcd34d' : '#fda4af');

      const line4 = document.createElement('p');
      line4.textContent = r.matchExplanation;
      line4.style.fontSize = '0.88rem';
      line4.style.color = '#cbd5e1';

      el.labResult.append(line1, line2, line3, line4);
    } catch (err) {
      el.labResult.classList.remove('hidden');
      el.labResult.textContent = `Ошибка: ${err.message}`;
    } finally {
      el.labTestBtn.disabled = false;
      el.labTestBtn.textContent = 'Проверить';
    }
  }

  function setFieldError(inputEl, errorEl, message) {
    if (message) {
      inputEl.setAttribute('aria-invalid', 'true');
      inputEl.setCustomValidity(message);
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    } else {
      inputEl.removeAttribute('aria-invalid');
      inputEl.setCustomValidity('');
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }
  }

  /**
   * Accessible validation timing:
   * - clear errors immediately on input
   * - validate on blur only if edited
   */
  function attachFieldValidation(inputEl, errorEl, emptyMsg) {
    inputEl.dataset.dirty = 'false';
    inputEl.addEventListener('input', () => {
      inputEl.dataset.dirty = 'true';
      setFieldError(inputEl, errorEl, '');
    });
    inputEl.addEventListener('blur', () => {
      if (inputEl.dataset.dirty !== 'true') return;
      if (!inputEl.value.trim()) {
        setFieldError(inputEl, errorEl, emptyMsg);
      }
    });
  }

  /**
   * IME-safe Enter-to-submit for multilingual input (Japanese, Chinese, Korean).
   * Prevents premature submission while IME composition is active (including Safari's keyCode 229 & timing bug).
   */
  function attachImeSafeSubmit(inputEl, formEl) {
    let lastCompositionEndAt = null;
    inputEl.addEventListener('compositionend', event => {
      lastCompositionEndAt = event.timeStamp;
    });
    inputEl.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      if (lastCompositionEndAt !== null && Math.abs(event.timeStamp - lastCompositionEndAt) < 50) {
        return;
      }
      formEl.requestSubmit();
    });
  }

  function setupDialogs() {
    // Conditionally polyfill Invoker Commands (command / commandfor) only when native support is missing
    if (!('commandForElement' in HTMLButtonElement.prototype)) {
      import('https://esm.run/invokers-polyfill').catch(() => {
        // Offline / blocked CDN fallback handled below
        el.openLabBtn.addEventListener('click', () => {
          if (!el.labDialog.open) el.labDialog.showModal();
        });
        el.openRulesBtn.addEventListener('click', () => {
          if (!el.rulesDialog.open) el.rulesDialog.showModal();
        });
        document.querySelectorAll('.close-dialog-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const target = document.getElementById(btn.dataset.close);
            if (target && target.open) target.close();
          });
        });
      });
    }

    // Keep lab category synced to active round when opened
    el.openLabBtn.addEventListener('click', () => {
      const activePrompt = state.roundPrompts[state.currentRoundIndex];
      if (activePrompt) el.labPromptSelect.value = activePrompt.id;
    });

    // Bounding-box pointerdown + pointerup fallback for browsers without <dialog closedby="any">
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const isOutsideDialog = (e, dialog) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
        let pressedOutside = false;
        dialog.addEventListener('pointerdown', e => {
          pressedOutside = isOutsideDialog(e, dialog);
        });
        dialog.addEventListener('pointerup', e => {
          if (pressedOutside && isOutsideDialog(e, dialog)) {
            dialog.close();
          }
          pressedOutside = false;
        });
      }
    }
  }

  async function init() {
    try {
      const res = await fetch('/api/dives');
      const data = await res.json();
      if (!data.ok) throw new Error('Failed to load game data');

      state.tiers = data.tiers;
      state.oceanZones = data.oceanZones;
      state.dives = data.dives;
      state.prompts = data.prompts;

      renderSidebarLegend();
      populateLabSelect();
      setupDialogs();

      el.diveSelect.addEventListener('change', () => {
        startDive(el.diveSelect.value);
      });

      el.timerToggleBtn.addEventListener('click', () => {
        state.timerEnabled = !state.timerEnabled;
        el.timerToggleBtn.setAttribute('aria-pressed', String(state.timerEnabled));
        el.timerToggleBtn.textContent = state.timerEnabled
          ? '⏱ 25 сек (Оригинал)'
          : '∞ Без таймера';
        if (!state.roundLocked) {
          if (state.timerEnabled) {
            startTimer();
          } else {
            stopTimer();
            updateTimerDisplay();
          }
        }
      });

      el.toggleHintBtn.addEventListener('click', () => {
        el.promptHintText.classList.toggle('hidden');
      });

      el.answerForm.addEventListener('submit', e => {
        e.preventDefault();
        submitAnswer(el.answerInput.value.trim(), false);
      });
      attachFieldValidation(el.answerInput, el.answerError, 'Введите ответ на любом языке перед отправкой.');
      attachImeSafeSubmit(el.answerInput, el.answerForm);

      el.nextRoundBtn.addEventListener('click', () => {
        state.currentRoundIndex += 1;
        renderRound();
      });

      el.playAgainBtn.addEventListener('click', () => {
        startDive(el.diveSelect.value);
      });

      el.copyShareBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(buildShareLog());
          el.copyFeedback.classList.remove('hidden');
        } catch {
          el.copyFeedback.textContent = buildShareLog();
          el.copyFeedback.classList.remove('hidden');
        }
      });

      el.labForm.addEventListener('submit', runLabCheck);
      attachFieldValidation(el.labAnswerInput, el.labError, 'Введите слово или фразу для проверки.');
      attachImeSafeSubmit(el.labAnswerInput, el.labForm);

      startDive(el.diveSelect.value);
    } catch (err) {
      el.promptRu.textContent = 'Не удалось загрузить игру';
      el.promptEn.textContent = err.message;
    }
  }

  init();
})();
