// ==UserScript==
// @name         SteamLvlUp Puzzle Box Full-Auto Farmer Pro
// @namespace    https://steamlvlup.com/
// @version      1.3.0
// @description  Полный автофарм PuzzleBox: игра по числу билетов, гибкий сбор задач и розыгрышей, помощник капчи и обновлённый UI
// @author       Antigravity
// @match        https://steamlvlup.com/giveaways*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Полная блокировка назойливого окна браузера "Перезагрузить сайт? Изменения могут не сохраниться"
    try {
        window.addEventListener('beforeunload', function(e) {
            e.stopImmediatePropagation();
            delete e['returnValue'];
        }, true);
        window.reloadPageAlert = function() {
            window.onbeforeunload = null;
        };
    } catch(e) {}

    const STORAGE_KEY = 'puzzle_farmer_state';
    const UI_POS_KEY = 'af_ui_pos';

    function getDefaultState() {
        return {
            active: false,
            dailyTasksActive: false,
            doQuests: true,          // Выполнять сбор задач (Daily / Weekly / Global)
            doGiveaways: true,       // Вступать в розыгрыши (Ежедневный / Еженедельный)
            autoDailyBeforeFarm: true,
            dailyTasksDoneInSession: false,
            geminiApiKey: '',
            useAllTickets: false,    // Играть, пока не закончатся билеты
            completed: 0,
            totalGames: 2,
            diff: 2,                 // 0 = Легкая, 1 = Средняя, 2 = Сложная
            minTime: 240,            // Случайная выдержка от (сек)
            maxTime: 260,            // Случайная выдержка до (сек)
            diffWaitSec: 10,         // Ожидание перед выбором сложности (сек)
            boardWaitSec: 10,        // Ожидание прогрузки стола и кусочков (сек)
            exitWaitSec: 7,          // Ожидание появления кнопки "Выход" (сек)
            roundStartTime: 0,
            roundTargetTime: 0,
            roundTargetDuration: 0,
            lastTicketId: null,
            diffSelected: false,
            diffWaitEndTime: 0,
            boardWaitEndTime: 0,
            settingsClosed: false,
            pieceNudged: false,
            solvingStarted: false,
            exitClicked: false,
            solveTime: 0,
            status: 'Готов к запуску'
        };
    }

    function getTicketsBalance() {
        const el = document.querySelector('.gwg-bal-item[data-i="tickets"] span');
        return el ? (parseInt(el.innerText.trim(), 10) || 0) : 0;
    }

    function getCoinsBalance() {
        const el = document.querySelector('.gw-user-balance') || document.querySelector('.gw-c-val');
        return el ? (parseInt(el.innerText.replace(/[^\d]/g, ''), 10) || 0) : 0;
    }

    let lastSavedJson = '';

    function getState() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            if (!data) return getDefaultState();
            return { ...getDefaultState(), ...JSON.parse(data) };
        } catch (e) {
            return getDefaultState();
        }
    }

    function saveState(state) {
        try {
            const json = JSON.stringify(state);
            if (json !== lastSavedJson) {
                lastSavedJson = json;
                localStorage.setItem(STORAGE_KEY, json);
            }
        } catch (e) {}
    }

    // ==========================================
    // ПУЛЕНЕПРОБИВАЕМЫЙ ПЕРЕХВАТ ДВИЖКА ИГРЫ (p5.js v1.4.0)
    // ==========================================
    let gameInstance = null;

    function setGameInstance(inst) {
        if (!inst) return;
        if (!gameInstance || (inst.variables && inst.variables.pieces)) {
            gameInstance = inst;
            window._puzzle = inst;
            try {
                const cv = document.getElementById('defaultCanvas0');
                if (cv) cv._p5 = inst;
            } catch(e) {}
        }
    }

    function getPuzzleInstance() {
        if (gameInstance && gameInstance.variables) return gameInstance;
        if (window._puzzle && window._puzzle.variables) return window._puzzle;
        const cv = document.getElementById('defaultCanvas0');
        if (cv && cv._p5 && cv._p5.variables) return cv._p5;
        if (window.p5 && window.p5.instance && window.p5.instance.variables) return window.p5.instance;
        return gameInstance || window._puzzle || (cv ? cv._p5 : null) || (window.p5 && window.p5.instance) || null;
    }

    // 1. Хук прототипа p5 (registerMethod, createCanvas, redraw)
    function hookP5Prototype() {
        if (!window.p5 || !window.p5.prototype) return;

        // p5 официальный API расширений
        if (typeof window.p5.prototype.registerMethod === 'function' && !window._p5Registered) {
            window._p5Registered = true;
            try {
                window.p5.prototype.registerMethod('init', function() {
                    setGameInstance(this);
                });
                window.p5.prototype.registerMethod('post', function() {
                    if (this.variables && this.variables.pieces) {
                        setGameInstance(this);
                    }
                });
            } catch(e) {}
        }

        // Хук redraw (вызывается каждый кадр анимации)
        if (typeof window.p5.prototype.redraw === 'function' && !window._p5RedrawHooked) {
            window._p5RedrawHooked = true;
            const origRedraw = window.p5.prototype.redraw;
            window.p5.prototype.redraw = function() {
                if (!gameInstance || (this.variables && this.variables.pieces)) {
                    setGameInstance(this);
                }
                return origRedraw.apply(this, arguments);
            };
        }

        // Хук createCanvas (вызывается при создании игрового поля)
        if (typeof window.p5.prototype.createCanvas === 'function' && !window._p5CanvasHooked) {
            window._p5CanvasHooked = true;
            const origCreateCanvas = window.p5.prototype.createCanvas;
            window.p5.prototype.createCanvas = function(...args) {
                setGameInstance(this);
                const res = origCreateCanvas.apply(this, args);
                try {
                    const cv = document.getElementById('defaultCanvas0');
                    if (cv) cv._p5 = this;
                } catch(e) {}
                return res;
            };
        }
    }

    // 2. Хук конструктора window.p5
    function hookP5Constructor() {
        if (window.p5 && !window._p5CtorHooked) {
            window._p5CtorHooked = true;
            const OrigP5 = window.p5;
            window.p5 = function(...args) {
                const inst = new OrigP5(...args);
                setGameInstance(inst);
                return inst;
            };
            Object.setPrototypeOf(window.p5, OrigP5);
            window.p5.prototype = OrigP5.prototype;
        }
    }

    // Запускаем постоянный перехват
    if (window.__slvlupP5Interval) clearInterval(window.__slvlupP5Interval);
    window.__slvlupP5Interval = setInterval(() => {
        hookP5Prototype();
        hookP5Constructor();
        if (!gameInstance) {
            const cv = document.getElementById('defaultCanvas0');
            if (cv && cv._p5) setGameInstance(cv._p5);
        }
    }, 25);

    // ==========================================
    // ЛОГИКА СБОРКИ ПАЗЛА
    // ==========================================
    function solvePuzzle() {
        const p = getPuzzleInstance();
        if (!p || !p.variables || !p.variables.pieces || !p.puzzle || !p.puzzle.decArr) {
            console.warn("[AutoFarmer] Игра еще не инициализирована для сборки!", p);
            return false;
        }

        const pieces = p.variables.pieces;
        const slots = p.puzzle.decArr;
        const pw = p.puzzle.pieceW || 60;
        const ph = p.puzzle.pieceH || 60;
        let count = 0;

        // Временно отключаем sendGameHisory на время цикла расстановки 63 кусочков,
        // чтобы последний кусочек в findCell() не отправил мгновенную историю с разницей 0.4 сек!
        const origSendHistory = p.sendGameHisory;
        p.sendGameHisory = function() {};

        // Очищаем историю от возможных случайных промахов (s: 0) перед финальной расстановкой
        if (Array.isArray(p.variables.historyOfGame)) {
            p.variables.historyOfGame.length = 0;
        }

        for (const piece of pieces) {
            if (!piece) continue;
            const slot = slots.find(s => s && s.idCell === piece.id);
            if (slot) {
                piece.truePosition = false;
                piece.x = slot.X;
                piece.y = slot.Y;
                piece.xCenter = slot.X + (piece.w || pw) / 2;
                piece.yCenter = slot.Y + (piece.h || ph) / 2;
                count++;
                if (typeof p.puzzle.findCell === 'function') {
                    try { p.puzzle.findCell(piece); } catch(e) {}
                } else if (typeof piece.checkConnection === 'function') {
                    try { piece.checkConnection(); } catch(e) {}
                }
            }
        }

        // Возвращаем штатный sendGameHisory
        p.sendGameHisory = origSendHistory;

        // Распределяем таймстампы ходов (t) равномерно от старта игры до текущего p.millis(),
        // чтобы сервер видел реальную длительность партии (~240-260 сек), а не 0.4 сек!
        try {
            const hist = p.variables.historyOfGame;
            if (Array.isArray(hist) && hist.length > 1) {
                const nowMs = (typeof p.millis === 'function') ? Math.floor(p.millis()) : ((p.menu && p.menu.time ? p.menu.time : 250) * 1000 + 15000);
                const gameSec = (p.menu && typeof p.menu.time === 'number' && p.menu.time > 0) ? p.menu.time : 250;
                const totalSpanMs = gameSec * 1000;
                const rawStartMs = (typeof p.variables.startTime === 'number' && p.variables.startTime > 0 && p.variables.startTime < nowMs - 10000)
                    ? Math.floor(p.variables.startTime)
                    : Math.max(3000, nowMs - totalSpanMs);
                const startMs = rawStartMs + Math.floor(Math.random() * 1500) + 500;
                const stepMs = (nowMs - startMs) / (hist.length - 1);

                for (let i = 0; i < hist.length; i++) {
                    const jitter = (i > 0 && i < hist.length - 1) ? Math.floor((Math.random() - 0.5) * stepMs * 0.4) : 0;
                    hist[i].id = i;
                    hist[i].t = Math.round(startMs + i * stepMs + jitter);
                }
            }
        } catch(e) {
            console.warn("[AutoFarmer] Ошибка нормализации таймстампов истории:", e);
        }

        // Снимаем предупреждение о перезагрузке
        try {
            if (typeof window.reloadPageAlert === 'function') window.reloadPageAlert(false);
            window.onbeforeunload = null;
        } catch(e) {}

        // Сбрасываем флаг gameEnd, чтобы checkGameEnd() штатно выполнил весь финальный блок
        // и ровно один раз вызвал p.sendGameHisory(1) уже с правильными таймстампами!
        if (p.menu) {
            p.menu.gameEnd = false;
        }

        if (typeof p.puzzle.checkGameEnd === 'function') {
            try { p.puzzle.checkGameEnd(); } catch(e) {}
        } else if (typeof p.checkGameEnd === 'function') {
            try { p.checkGameEnd(); } catch(e) {}
        }

        console.log(`[AutoFarmer] Пазл собран! Совмещено кусочков: ${count}/${pieces.length}, gameEnd=${p.menu && p.menu.gameEnd}`);
        return count > 0;
    }

    // Имитация клика по холсту
    function clickCanvas(normX, normY) {
        const canvas = document.getElementById('defaultCanvas0');
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const clientX = rect.left + rect.width * normX;
        const clientY = rect.top + rect.height * normY;

        const opts = { clientX, clientY, bubbles: true, cancelable: true, view: window };
        canvas.dispatchEvent(new MouseEvent('mousemove', opts));
        canvas.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0, buttons: 1 }));
        canvas.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 0, buttons: 0 }));
        canvas.dispatchEvent(new MouseEvent('click', { ...opts, button: 0 }));
    }

    // Закрытие окна настроек
    function closeSettingsModal() {
        const p = getPuzzleInstance();
        if (p && Array.isArray(p.buttonsArr)) {
            const closeBtn = p.buttonsArr.find(b => b && (b.id === 'close_sets' || b.name === 'close_sets' || b.type === 'close_sets'));
            if (closeBtn && typeof closeBtn.click === 'function') {
                try { closeBtn.click(); } catch(e) {}
            }
        }
        if (p && p.menu) {
            p.menu.settingModal = false;
        }
        clickCanvas(0.50, 0.71);
        console.log("[AutoFarmer] Нажата кнопка 'Закрыть' в настройках.");
    }

    // Выбор сложности через меню игры (choseEasy / choseNormal / choseHard)
    function triggerDifficulty(diff) {
        const p = getPuzzleInstance();
        const btnName = diff === 2 ? 'choseHard' : (diff === 1 ? 'choseNormal' : 'choseEasy');
        const targetX = diff === 2 ? 770 : (diff === 1 ? 450 : 140);
        const targetY = 450;

        if (p && Array.isArray(p.buttonsArr) && p.buttonsArr.length > 0) {
            try {
                const btn = p.buttonsArr.find(b => b && b.name === btnName);
                if (btn && typeof btn.click === 'function') {
                    btn.click();
                    console.log(`[AutoFarmer] Выбрана сложность через кнопку движка: ${btnName}`);
                    return true;
                }
            } catch(e) {}
        }

        if (p && p.menu && typeof p.menu.checkClickButtons === 'function') {
            try { p.menu.checkClickButtons(targetX, targetY); } catch(e) {}
        }

        clickCanvas((targetX + 50) / 1000, (targetY + 30) / 650);
        return false;
    }

    // Определение текущего экрана игры по внутренним флагам движка p5
    function getGameScreenState() {
        const p = getPuzzleInstance();
        if (!p) return 'NO_ENGINE';
        if (!p.loaded) return 'PRELOADER';
        if (p.menu && p.menu.gameEnd) return 'GAME_END';
        if (!p.started) return 'START_SCREEN';
        if (!isTableWithPiecesReady()) return 'LOADING_BOARD';
        if (p.onAnimation) return 'BOARD_ANIMATING';
        if (p.menu && p.menu.settingModal) return 'SETTINGS_MODAL';
        if (p.menu && p.menu.helpModal) return 'HELP_MODAL';
        return 'PLAYING';
    }

    // Проверка: стол с кусочками прогружен
    function isTableWithPiecesReady() {
        const p = getPuzzleInstance();
        if (!p || !p.variables || !p.variables.pieces) return false;
        const pieces = p.variables.pieces;
        if (pieces.length === 0) return false;
        const first = pieces[0];
        return first && (first.w > 0 || first.h > 0 || first.x !== undefined);
    }

    // Поиск кусочка в целевой левой зоне (WEBGL координаты: X от -480 до -310)
    function findPieceInTargetZone() {
        const p = getPuzzleInstance();
        if (!p || !p.variables || !Array.isArray(p.variables.pieces)) return null;
        const pieces = p.variables.pieces;

        let piece = pieces.find(pc => pc && !pc.truePosition && pc.x >= -485 && pc.x <= -300 && pc.y >= -200 && pc.y <= 250);

        if (!piece) {
            piece = pieces.find(pc => pc && !pc.truePosition && pc.x < -250);
        }

        return piece || pieces.find(pc => pc && !pc.truePosition) || pieces[0];
    }

    // Сдвиг кусочка в левой зоне для запуска игрового таймера
    function nudgePieceInTargetZone() {
        const p = getPuzzleInstance();
        const canvas = document.getElementById('defaultCanvas0');
        if (!p || !isTableWithPiecesReady() || !canvas) return false;

        if (p.menu) {
            p.menu.settingModal = false;
            p.menu.helpModal = false;
        }

        const piece = findPieceInTargetZone();
        if (!piece) return false;

        const rect = canvas.getBoundingClientRect();
        const cw = canvas.width || 1000;
        const ch = canvas.height || 650;
        const scaleX = rect.width / cw;
        const scaleY = rect.height / ch;

        // В WEBGL движок применяет перспективную поправку:
        // hitX = (mouseX - cw/2) * (1 - 77/500), hitY = (mouseY - ch/2) * (1 - 43/325)
        const pieceCenterWebglX = (piece.xCenter !== undefined) ? piece.xCenter : (piece.x + (piece.w || 60) / 2);
        const pieceCenterWebglY = (piece.yCenter !== undefined) ? piece.yCenter : (piece.y + (piece.h || 60) / 2);
        const p5MouseX = cw / 2 + pieceCenterWebglX / (1 - 77 / 500);
        const p5MouseY = ch / 2 + pieceCenterWebglY / (1 - 43 / 325);

        const startClientX = rect.left + p5MouseX * scaleX;
        const startClientY = rect.top + p5MouseY * scaleY;
        const endClientX = startClientX + 15 * scaleX;
        const endClientY = startClientY;

        // 1. DOM эмуляция перетаскивания мыши
        const moveEvent1 = new MouseEvent('mousemove', { clientX: startClientX, clientY: startClientY, bubbles: true, cancelable: true, view: window });
        const downEvent  = new MouseEvent('mousedown', { clientX: startClientX, clientY: startClientY, button: 0, buttons: 1, bubbles: true, cancelable: true, view: window });
        const moveEvent2 = new MouseEvent('mousemove', { clientX: endClientX, clientY: endClientY, button: 0, buttons: 1, bubbles: true, cancelable: true, view: window });
        const upEvent    = new MouseEvent('mouseup',   { clientX: endClientX, clientY: endClientY, button: 0, buttons: 0, bubbles: true, cancelable: true, view: window });

        canvas.dispatchEvent(moveEvent1);
        canvas.dispatchEvent(downEvent);
        canvas.dispatchEvent(moveEvent2);
        canvas.dispatchEvent(upEvent);

        // 2. Прямой вызов обработчиков p5 и объекта кусочка с точными перспективными координатами
        try {
            p.mouseX = p5MouseX;
            p.mouseY = p5MouseY;
            p.mouseIsPressed = true;
            if (typeof p.mousePressed === 'function') p.mousePressed();
            if (!piece.drag && typeof piece.pressed === 'function') piece.pressed();

            p.mouseX = p5MouseX + 15;
            p.mouseY = p5MouseY;
            if (typeof p.mouseDragged === 'function') p.mouseDragged();

            p.mouseIsPressed = false;
            if (typeof p.mouseReleased === 'function') p.mouseReleased();
            if (piece.drag && typeof piece.released === 'function') piece.released();

            // Гарантируем инициализацию startTime и фонового секундного таймера игры
            if (p.started && p.loaded && p.variables && p.variables.startTime === undefined && typeof p.millis === 'function') {
                p.variables.startTime = p.millis();
                if (typeof p.backGameProc === 'function') p.backGameProc();
            }
        } catch(e) {
            console.warn("[AutoFarmer] Ошибка сдвига кусочка:", e);
        }

        if (typeof p.loop === 'function' && !p._looping) {
            try { p.loop(); } catch(e) {}
        }

        console.log("[AutoFarmer] Кусочек в целевой левой зоне сдвинут!", piece);
        return true;
    }

    // ==========================================
    // МОДУЛЬ: ЕЖЕДНЕВНЫЕ ЗАДАНИЯ, РОЗЫГРЫШИ И ПОМОЩНИК КАПЧИ
    // ==========================================
    const CAPTCHA_DICT = {
        'skull': 'ЧЕРЕП', 'star': 'ЗВЕЗДА', 'heart': 'СЕРДЦЕ', 'cat': 'КОТ / КОШКА',
        'dog': 'СОБАКА', 'fire': 'ОГОНЬ / ПЛАМЯ', 'sword': 'МЕЧ / КЛИНОК', 'shield': 'ЩИТ',
        'crown': 'КОРОНА', 'diamond': 'АЛМАЗ / КРИСТАЛЛ', 'gem': 'КРИСТАЛЛ / САМОЦВЕТ',
        'coin': 'МОНЕТА', 'money': 'ДЕНЬГИ / ДОЛЛАР', 'key': 'КЛЮЧ', 'lock': 'ЗАМОК',
        'book': 'КНИГА', 'tree': 'ДЕРЕВО', 'flower': 'ЦВЕТОК', 'sun': 'СОЛНЦЕ',
        'moon': 'ЛУНА / МЕСЯЦ', 'cloud': 'ОБЛАКО / ТУЧА', 'lightning': 'МОЛНИЯ',
        'ghost': 'ПРИЗРАК / ПРИВИДЕНИЕ', 'robot': 'РОБОТ', 'alien': 'ПРИШЕЛЕЦ / ИНОПЛАНЕТЯНИН',
        'monster': 'МОНСТР / ЧУДОВИЩЕ', 'dragon': 'ДРАКОН', 'bird': 'ПТИЦА', 'fish': 'РЫБА',
        'snake': 'ЗМЕЯ', 'spider': 'ПАУК', 'car': 'МАШИНА / АВТОМОБИЛЬ', 'plane': 'САМОЛЁТ',
        'ship': 'КОРАБЛЬ / ЛОДКА', 'rocket': 'РАКЕТА', 'gun': 'ОРУЖИЕ / ПИСТОЛЕТ',
        'bomb': 'БОМБА / ГРАНАТА', 'explosion': 'ВЗРЫВ', 'potion': 'ЗЕЛЬЕ / КОЛБА',
        'bottle': 'БУТЫЛКА', 'cup': 'ЧАШКА / КУБОК', 'trophy': 'КУБОК / ТРОФЕЙ',
        'hat': 'ШЛЯПА / ШАПКА', 'helmet': 'ШЛЕМ / КАСКА', 'glasses': 'ОЧКИ',
        'eye': 'ГЛАЗ', 'hand': 'РУКА / ЛАДОНЬ', 'fist': 'КУЛАК', 'foot': 'НОГА / СТУПНЯ',
        'wing': 'КРЫЛО', 'feather': 'ПЕРО', 'bone': 'КОСТЬ', 'meat': 'МЯСО',
        'apple': 'ЯБЛОКО', 'banana': 'БАНАН', 'cake': 'ТОРТ / ПИРОЖНОЕ', 'pizza': 'ПИЦЦА',
        'burger': 'БУРГЕР', 'coffee': 'КОФЕ', 'beer': 'ПИВО / КРУЖКА', 'music': 'МУЗЫКА / НОТА',
        'bell': 'КОЛОКОЛЬЧИК', 'clock': 'ЧАСЫ', 'hourglass': 'ПЕСОЧНЫЕ ЧАСЫ',
        'flag': 'ФЛАГ', 'cross': 'КРЕСТ', 'arrow': 'СТРЕЛА / СТРЕЛКА', 'axe': 'ТОПОР',
        'hammer': 'МОЛОТ / МОЛОТОК', 'bow': 'ЛУК', 'medal': 'МЕДАЛЬ', 'ring': 'КОЛЬЦО',
        'box': 'КОРОБКА / ЯЩИК', 'chest': 'СУНДУК', 'gift': 'ПОДАРОК', 'house': 'ДОМ',
        'castle': 'ЗАМОК / БАШНЯ', 'planet': 'ПЛАНЕТА', 'earth': 'ЗЕМЛЯ / ШАР',
        'snowflake': 'СНЕЖИНКА', 'ice': 'ЛЁД', 'water': 'ВОДА / КАПЛЯ', 'drop': 'КАПЛЯ',
        'blood': 'КРОВЬ', 'leaf': 'ЛИСТ', 'mushroom': 'ГРИБ', 'pumpkin': 'ТЫКВА',
        'candy': 'КОНФЕТА', 'cookie': 'ПЕЧЕНЬЕ', 'bread': 'ХЛЕБ', 'cheese': 'СЫР',
        'egg': 'ЯЙЦО', 'Bear': 'МЕДВЕДЬ', 'bear': 'МЕДВЕДЬ', 'wolf': 'ВОЛК',
        'fox': 'ЛИСА', 'rabbit': 'КРОЛИК / ЗАЯЦ', 'bunny': 'КРОЛИК / ЗАЯЦ',
        'frog': 'ЛЯГУШКА', 'monkey': 'ОБЕЗЬЯНА', 'pig': 'СВИНЬЯ', 'cow': 'КОРОВА',
        'horse': 'ЛОШАДЬ / КОНЬ', 'lion': 'ЛЕВ', 'tiger': 'ТИГР', 'panda': 'ПАНДА',
        'owl': 'СОВА', 'penguin': 'ПИНГВИН', 'chicken': 'КУРИЦА / ЦЫПЛЁНОК',
        'duck': 'УТКА', 'shark': 'АКУЛА', 'octopus': 'ОСЬМИНОГ', 'crab': 'КРАБ',
        'butterfly': 'БАБОЧКА', 'bee': 'ПЧЕЛА', 'bug': 'ЖУК', 'worm': 'ЧЕРВЯК',
        'smile': 'УЛЫБКА / СМАЙЛ', 'angry': 'ЗЛОЙ / ЯРОСТЬ', 'sad': 'ГРУСТНЫЙ / ПЛАЧ',
        'cry': 'ПЛАЧ / СЛЁЗЫ', 'laugh': 'СМЕХ', 'love': 'ЛЮБОВЬ / СЕРДЦЕ',
        'kiss': 'ПОЦЕЛУЙ / ГУБЫ', 'tongue': 'ЯЗЫК', 'brain': 'МОЗГ', 'tooth': 'ЗУБ',
        'beard': 'БОРОДА', 'mustache': 'УСЫ', 'mask': 'МАСКА', 'clown': 'КЛОУН',
        'ninja': 'НИНДЗЯ', 'pirate': 'ПИРАТ', 'knight': 'РЫЦАРЬ', 'wizard': 'МАГ / ВОЛШЕБНИК',
        'witch': 'ВЕДЬМА', 'angel': 'АНГЕЛ', 'devil': 'ДЬЯВОЛ / ЧЁРТ', 'demon': 'ДЕМОН',
        'zombie': 'ЗОМБИ', 'vampire': 'ВАМПИР', 'mummy': 'МУМИЯ', 'santa': 'САНТА',
        'snowman': 'СНЕГОВИК', 'ball': 'МЯЧ / ШАР', 'gamepad': 'ГЕЙМПАД / ДЖОЙСТИК',
        'dice': 'КУБИК / КОСТИ', 'card': 'КАРТА', 'puzzle': 'ПАЗЛ', 'phone': 'ТЕЛЕФОН',
        'computer': 'КОМПЬЮТЕР / МОНИТОР', 'tv': 'ТЕЛЕВИЗОР', 'camera': 'КАМЕРА / ФОТОАППАРАТ',
        'battery': 'БАТАРЕЙКА', 'light': 'ЛАМПОЧКА / СВЕТ', 'bulb': 'ЛАМПОЧКА',
        'magnet': 'МАГНИТ', 'gear': 'ШЕСТЕРЁНКА', 'wrench': 'ГАЕЧНЫЙ КЛЮЧ',
        'scissors': 'НОЖНИЦЫ', 'pencil': 'КАРАНДАШ', 'pen': 'РУЧКА', 'brush': 'КИСТЬ',
        'microphone': 'МИКРОФОН', 'headphones': 'НАУШНИКИ', 'guitar': 'ГИТАРА',
        'drum': 'БАРАБАН', 'anchor': 'ЯКОРЬ', 'steering': 'РУЛЬ / ШТУРВАЛ',
        'wheel': 'КОЛЕСО', 'train': 'ПОЕЗД', 'bike': 'ВЕЛОСИПЕД', 'motorcycle': 'МОТОЦИКЛ',
        'tank': 'ТАНК', 'helicopter': 'ВЕРТОЛЁТ', 'ufo': 'НЛО / ТАРЕЛКА',
        'tent': 'ПАЛАТКА', 'campfire': 'КОСТЁР', 'mountain': 'ГОРА', 'volcano': 'ВУЛКАН',
        'island': 'ОСТРОВ', 'palm': 'ПАЛЬМА', 'cactus': 'КАКТУС', 'rose': 'РОЗА',
        'clover': 'КЛЕВЕР', 'rainbow': 'РАДУГА', 'tornado': 'ТОРНАДО / ВИХРЬ',
        'umbrella': 'ЗОНТ', 'shoe': 'ОБУВЬ / БОТИНОК', 'boot': 'САПОГ / БОТИНОК',
        'sock': 'НОСОК', 'glove': 'ПЕРЧАТКА', 'shirt': 'ФУТБОЛКА / РУБАШКА',
        'dress': 'ПЛАТЬЕ', 'pants': 'ШТАНЫ / БРЮКИ', 'bag': 'СУМКА / МЕШОК',
        'backpack': 'РЮКЗАК', 'wallet': 'КОШЕЛЁК', 'Purse': 'СУМОЧКА',
        'pill': 'ТАБЛЕТКА / КАПСУЛА', 'syringe': 'ШПРИЦ', 'bandage': 'ПЛАСТЫРЬ / БИНТ',
        'dna': 'ДНК', 'atom': 'АТОМ', 'microscope': 'МИКРОСКОП', 'telescope': 'ТЕЛЕСКОП',
        'compass': 'КОМПАС', 'map': 'КАРТА / СВИТОК', 'scroll': 'СВИТОК',
        'letter': 'ПИСЬМО / КОНВЕРТ', 'mail': 'ПОЧТА / КОНВЕРТ', 'trash': 'МУСОРКА / КОРЗИНА',
        'broom': 'МЕТЛА', 'soap': 'МЫЛО', 'toilet': 'ТУАЛЕТ / УНИТАЗ',
        'bed': 'КРОВАТЬ', 'chair': 'СТУЛ / КРЕСЛО', 'door': 'ДВЕРЬ', 'window': 'ОКНО',
        'brick': 'КИРПИЧ / СТЕНА', 'fence': 'ЗАБОР', 'ladder': 'ЛЕСТНИЦА',
        'chain': 'ЦЕПЬ', 'rope': 'ВЕРЁВКА', 'barrel': 'БОЧКА', 'bucket': 'ВЕДРО',
        'shovel': 'ЛОПАТА', 'pickaxe': 'КИРКА', 'saw': 'ПИЛА', 'knife': 'НОЖ / КИНЖАЛ',
        'dagger': 'КИНЖАЛ', 'spear': 'КОПЬЁ', 'wand': 'ВОЛШЕБНАЯ ПАЛОЧКА',
        'staff': 'ПОСОХ', 'orb': 'СФЕРА / ШАР', 'crystal': 'КРИСТАЛЛ',
        'rune': 'РУНА / КАМЕНЬ', 'portal': 'ПОРТАЛ', 'grave': 'МОГИЛА / НАДГРОБИЕ',
        'coffin': 'ГРОБ', 'candle': 'СВЕЧА', 'lantern': 'ФОНАРЬ', 'torch': 'ФАКЕЛ'
    };

    const translationCache = {};
    let lastCaptchaBg = '';
    let aiSolvingInProgress = false;
    let lastDailyActionAt = 0;

    async function translateKeywordToRu(word) {
        if (!word) return '';
        const clean = word.trim();
        const lower = clean.toLowerCase();
        if (CAPTCHA_DICT[clean]) return CAPTCHA_DICT[clean];
        if (CAPTCHA_DICT[lower]) return CAPTCHA_DICT[lower];
        if (translationCache[lower]) return translationCache[lower];

        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=${encodeURIComponent(clean)}`;
            const res = await fetch(url);
            const data = await res.json();
            const tr = (data && data[0] && data[0][0] && data[0][0][0]) ? String(data[0][0][0]).toUpperCase() : '';
            if (tr) {
                translationCache[lower] = tr;
                return tr;
            }
        } catch (e) {}
        return '';
    }

    async function solveCaptchaWithGemini(bgUrl, keyword, ruWord, apiKey) {
        if (aiSolvingInProgress || !apiKey || !bgUrl) return;
        aiSolvingInProgress = true;
        try {
            // Загружаем 240x240 картинку капчи и рисуем сетку с номерами 1..9
            const img = new Image();
            img.crossOrigin = 'anonymous';
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = bgUrl;
            });

            const cv = document.createElement('canvas');
            cv.width = 240;
            cv.height = 240;
            const ctx = cv.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 240, 240);
            ctx.drawImage(img, 0, 0, 240, 240);

            // Рисуем четкие границы 3x3 и номера 1..9 в углу каждой ячейки
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.lineWidth = 1;
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    const idx = r * 3 + c + 1;
                    const x = c * 80;
                    const y = r * 80;
                    ctx.strokeRect(x, y, 80, 80);
                    ctx.fillStyle = 'rgba(0,0,0,0.75)';
                    ctx.fillRect(x + 2, y + 2, 16, 16);
                    ctx.fillStyle = '#00e676';
                    ctx.font = 'bold 12px sans-serif';
                    ctx.fillText(String(idx), x + 6, y + 14);
                }
            }

            const base64Png = cv.toDataURL('image/png').split(',')[1];
            const prompt = `This 240x240 image is a 3x3 grid of 9 Steam emoticon icons numbered 1 to 9 (1-3 top row, 4-6 middle row, 7-9 bottom row). Note that some icons may be mirrored/flipped. Identify between 2 and 4 cells that depict or contain "${keyword}" (Russian: "${ruWord || keyword}"). Return ONLY a valid JSON array of integer cell numbers between 1 and 9, for example: [2, 5, 8]`;

            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey.trim())}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            { inline_data: { mime_type: 'image/png', data: base64Png } }
                        ]
                    }],
                    generationConfig: { temperature: 0.1 }
                })
            });

            const json = await resp.json();
            const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const match = text.match(/\[[\d,\s]+\]/);
            if (match) {
                const indices = JSON.parse(match[0]).map(n => parseInt(n)).filter(n => n >= 1 && n <= 9);
                if (indices.length >= 2 && indices.length <= 4) {
                    const items = document.querySelectorAll('.slvlup-capcha-modal .capcha-item');
                    items.forEach(el => {
                        if (el.classList.contains('active-capcha') || el.classList.contains('active')) el.click();
                    });
                    indices.forEach(idx => {
                        if (items[idx - 1]) items[idx - 1].click();
                    });
                    console.log(`[AutoFarmer] ИИ выбрал ячейки капчи для "${keyword}":`, indices);
                    setTimeout(() => {
                        const sendBtn = document.querySelector('.slvlup-capcha-modal .send-capcha');
                        if (sendBtn) sendBtn.click();
                    }, 500);
                }
            }
        } catch (e) {
            console.warn('[AutoFarmer] Ошибка авто-решения капчи через Gemini API:', e);
        } finally {
            aiSolvingInProgress = false;
        }
    }

    function enhanceCaptchaModal(state) {
        const modal = document.querySelector('.slvlup-capcha-modal');
        const widget = document.getElementById('af-widget');
        if (!modal || modal.offsetParent === null) {
            if (widget && widget.dataset.savedLeft) {
                widget.style.left = widget.dataset.savedLeft;
                delete widget.dataset.savedLeft;
            }
            lastCaptchaBg = '';
            return null;
        }

        // Если виджет перекрывает модалку капчи по центру экрана, временно сдвигаем его влево
        if (widget && !widget.dataset.savedLeft) {
            const wRect = widget.getBoundingClientRect();
            const mRect = modal.getBoundingClientRect();
            const overlaps = !(wRect.right < mRect.left || wRect.left > mRect.right || wRect.bottom < mRect.top || wRect.top > mRect.bottom);
            if (overlaps) {
                widget.dataset.savedLeft = widget.style.left || '';
                widget.style.left = '16px';
                widget.style.right = 'auto';
            }
        }

        // Нумеруем ячейки 1..9 для удобства
        const items = modal.querySelectorAll('.capcha-item');
        items.forEach((item, idx) => {
            if (!item.querySelector('.af-cap-num')) {
                item.style.position = 'relative';
                const badge = document.createElement('span');
                badge.className = 'af-cap-num';
                badge.innerText = String(idx + 1);
                badge.style.cssText = 'position:absolute;top:3px;left:4px;font-size:10px;font-weight:bold;color:#aaa;background:rgba(0,0,0,0.55);padding:1px 4px;border-radius:4px;pointer-events:none;';
                item.appendChild(badge);
            }
        });

        const kwEl = modal.querySelector('.capcha-keyword');
        const imgEl = modal.querySelector('.capcha-img');
        if (!kwEl || !imgEl) return null;

        const rawKw = (kwEl.dataset.rawKeyword && kwEl.innerText.includes(kwEl.dataset.rawKeyword))
            ? kwEl.dataset.rawKeyword
            : kwEl.innerText.split('➔')[0].trim();

        if (!rawKw) return null;
        kwEl.dataset.rawKeyword = rawKw;

        const bgStyle = imgEl.style.backgroundImage || '';
        const bgMatch = bgStyle.match(/url\(["']?([^"')]+)["']?\)/);
        const bgUrl = bgMatch ? bgMatch[1] : '';

        translateKeywordToRu(rawKw).then(ru => {
            if (ru && !kwEl.innerText.includes('➔')) {
                kwEl.innerHTML = `${rawKw} <span style="color:#00e676;font-weight:bold;margin-left:4px;">➔ 🇷🇺 ${ru}</span>`;
            }
            if (bgUrl && bgUrl !== lastCaptchaBg) {
                lastCaptchaBg = bgUrl;
                if (state && state.geminiApiKey && state.geminiApiKey.trim().length > 10) {
                    solveCaptchaWithGemini(bgUrl, rawKw, ru, state.geminiApiKey);
                }
            }
        });

        const cachedRu = CAPTCHA_DICT[rawKw.toLowerCase()] || translationCache[rawKw.toLowerCase()] || '';
        return { keyword: rawKw, ru: cachedRu };
    }

    let favQuestInProgress = false;

    function findWeeklyFavoriteQuest() {
        const holders = document.querySelectorAll('.gw-quests[data-type="weekly"] .gw-quest-holder');
        for (const holder of holders) {
            const infoText = holder.querySelector('.gw-quest-info span')?.innerText?.trim() || '';
            if (/избранн|favorite/i.test(infoText)) {
                const waitBtn = holder.querySelector('.q-b-wait');
                const refreshBtn = holder.querySelector('.refresh-task');
                const questId = refreshBtn?.getAttribute('data-quest');
                if (waitBtn && questId && !holder.dataset.afFavProcessed) {
                    const m = infoText.match(/(\d+)/);
                    const targetCount = m ? parseInt(m[1], 10) : 30;
                    return { holder, questId, targetCount, infoText };
                }
            }
        }
        return null;
    }

    async function runWeeklyFavoriteQuest(favQuest) {
        if (favQuestInProgress) return;
        favQuestInProgress = true;
        const { holder, questId, targetCount } = favQuest;
        holder.dataset.afFavProcessed = '1';

        const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
        const ajaxPost = (url, data) => new Promise(resolve => {
            if (typeof window.$ === 'function' && window.$.ajax) {
                window.$.ajax({
                    url,
                    type: 'POST',
                    headers: { 'X-CSRF-TOKEN': csrf },
                    data,
                    success: d => resolve(d),
                    error: () => resolve(null)
                });
            } else {
                const body = new URLSearchParams(data).toString();
                fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-CSRF-TOKEN': csrf,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body
                }).then(r => r.json()).then(resolve).catch(() => resolve(null));
            }
        });

        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const addedItems = [];

        try {
            const weeklyTab = document.querySelector('.gw-context-menu div[data-quests="weekly"]');
            if (weeklyTab && !weeklyTab.classList.contains('gw-page-active')) weeklyTab.click();

            let st = getState();
            st.status = `⭐ Загружаем список наборов из Магазина (https://steamlvlup.com/)...`;
            saveState(st);
            updateUI(st);

            let candidates = [];
            for (let page = 0; page < 3 && candidates.length < targetCount; page++) {
                const storeData = await ajaxPost('/store/load', {
                    hide_exist: false,
                    page,
                    page_size: 100,
                    sort_by: 'sold',
                    sort_type: 'desc'
                });
                if (storeData && storeData.success && Array.isArray(storeData.items)) {
                    for (const item of storeData.items) {
                        if (!item.fav && candidates.length < targetCount) {
                            candidates.push({ appid: item.appid, border: item.border });
                        }
                    }
                } else {
                    break;
                }
            }

            if (candidates.length === 0) {
                console.warn('[AutoFarmer] Не удалось получить список наборов из /store/load');
                return;
            }

            // 1. Отмечаем N наборов в избранное
            for (let i = 0; i < candidates.length; i++) {
                const item = candidates[i];
                await ajaxPost('/store/fav', { appid: item.appid, border: item.border, type: 1 });
                addedItems.push(item);

                const pbPie = holder.querySelector('.pb-pie');
                if (pbPie) pbPie.setAttribute('data-progress', `${i + 1} / ${targetCount}`);
                const pieEl = holder.querySelector('.pie');
                if (pieEl) {
                    const pct = Math.min(100, Math.round(((i + 1) / targetCount) * 100));
                    pieEl.style.setProperty('--p', String(pct));
                    pieEl.innerText = ` ${pct}%`;
                }

                st = getState();
                st.status = `⭐ Добавляем в избранное: ${i + 1}/${candidates.length}...`;
                saveState(st);
                updateUI(st);
                await sleep(110);
            }

            // 2. Получаем награду за выполненное задание
            st = getState();
            st.status = `🎁 Забираем награду за «Добавьте в избранное ${targetCount} наборов»...`;
            saveState(st);
            updateUI(st);
            await sleep(400);

            const claimRes = await ajaxPost('/giveaway/quest/get', { id: questId });
            if (claimRes && claimRes.success) {
                if (typeof window.changeBalances === 'function') {
                    window.changeBalances(claimRes.amount, 'points');
                }
                const waitBtn = holder.querySelector('.q-b-wait');
                if (waitBtn) {
                    waitBtn.classList.remove('q-b-wait');
                    waitBtn.classList.add('q-b-done');
                    waitBtn.setAttribute('data-quest', questId);
                    waitBtn.innerHTML = `Получено`;
                }
            }

            await sleep(500);

            // 3. Заменяем задачу, если доступны замены
            const refreshCountEl = document.querySelector('#balanceTrefresh b');
            const refreshAvailable = refreshCountEl ? (parseInt(refreshCountEl.innerText.trim()) || 0) : 0;
            if (refreshAvailable > 0) {
                st = getState();
                st.status = `🔄 Заменяем задачу про избранное (доступно замен: ${refreshAvailable})...`;
                saveState(st);
                updateUI(st);

                if (typeof window.refreshTask === 'function') {
                    window.refreshTask(questId);
                } else {
                    await ajaxPost('/giveaway/quest/refresh', { id: questId });
                }
                await sleep(1200);
            }
        } catch (err) {
            console.warn('[AutoFarmer] Ошибка при выполнении квеста с избранным:', err);
        } finally {
            // 4. Удаляем все добавленные наборы обратно из избранного
            for (let i = 0; i < addedItems.length; i++) {
                const item = addedItems[i];
                await ajaxPost('/store/fav', { appid: item.appid, border: item.border, type: 0 });
                const st = getState();
                st.status = `🧹 Удаляем наборы из избранного: ${i + 1}/${addedItems.length}...`;
                saveState(st);
                updateUI(st);
                await sleep(110);
            }
            lastDailyActionAt = Date.now();
            favQuestInProgress = false;
        }
    }

    // Возвращает true, если сейчас выполняется шаг ежедневных заданий или открыта капча
    function processDailyTasksAndGiveaways(state) {
        const now = Date.now();
        const capInfo = enhanceCaptchaModal(state);

        // Если уже выполняется авто-квест с добавлением 30 наборов в избранное — ждём завершения
        if (favQuestInProgress) return true;

        // Если открыта модалка капчи — ждём её решения (вручную или через ИИ)
        const capModal = document.querySelector('.slvlup-capcha-modal');
        if (capModal && capModal.offsetParent !== null) {
            const label = capInfo ? `"${capInfo.keyword}"${capInfo.ru ? ' (' + capInfo.ru + ')' : ''}` : '...';
            state.status = (state.geminiApiKey && state.geminiApiKey.trim().length > 10)
                ? `🤖 ИИ решает капчу: ${label}...`
                : `🧩 Выберите 2–4 картинки: ${label} и нажмите Отправить`;
            saveState(state);
            return true;
        }

        const doQuests = state.doQuests !== false;
        const doGiveaways = state.doGiveaways !== false;

        // Если оба пункта (Задачи и Розыгрыши) отключены галочками — ничего не делаем
        if (!doQuests && !doGiveaways) {
            if (state.dailyTasksActive) {
                state.dailyTasksActive = false;
                state.status = '⚠️ Включите галочку «Задачи» или «Розыгрыши»!';
                saveState(state);
            }
            return false;
        }

        const favQuest = doQuests ? findWeeklyFavoriteQuest() : null;
        const hasPendingWeeklyOrGlobal = doQuests && !!(
            favQuest ||
            document.querySelector('.gw-quests[data-type="weekly"] .q-b-get') ||
            document.querySelector('.gw-quests[data-type="global"] .q-b-get') ||
            document.querySelector('.refresh-task-accept') ||
            ((parseInt(document.querySelector('#balanceTrefresh b')?.innerText?.trim()) || 0) > 0 &&
                Array.from(document.querySelectorAll('.gw-quests[data-type="weekly"] .gw-quest-progress'))
                    .some(prog => prog.querySelector('.q-b-done:not(.refresh-task)') && prog.querySelector('.refresh-task')))
        );

        const shouldRun = state.dailyTasksActive || (state.active && state.autoDailyBeforeFarm && (!state.dailyTasksDoneInSession || hasPendingWeeklyOrGlobal));
        if (!shouldRun) return false;

        if (doQuests) {
            // 0. Если открыта модалка подтверждения замены еженедельного задания — подтверждаем
            const refreshAcceptBtn = document.querySelector('.refresh-task-accept');
            if (refreshAcceptBtn && refreshAcceptBtn.offsetParent !== null) {
                if (now - lastDailyActionAt < 1200) return true;
                lastDailyActionAt = now;
                state.status = '🔄 Подтверждаем замену выполненного задания...';
                saveState(state);
                refreshAcceptBtn.click();
                return true;
            }

            // 1. Вкладка «Ежедневные Задания» (data-quests="daily")
            const dailyClaimBtn = document.querySelector('.gw-quests[data-type="daily"] .q-b-get:not([data-type="quest_dl_capcha"])');
            if (dailyClaimBtn) {
                const dailyTab = document.querySelector('.gw-context-menu div[data-quests="daily"]');
                if (dailyTab && !dailyTab.classList.contains('gw-page-active')) dailyTab.click();
                if (now - lastDailyActionAt < 2500) return true;
                lastDailyActionAt = now;
                const qTitle = dailyClaimBtn.closest('.gw-quest-holder')?.querySelector('.gw-quest-info span')?.innerText?.trim() || 'Ежедневное задание';
                state.status = `🎁 Забираем: «${qTitle}»...`;
                saveState(state);
                dailyClaimBtn.click();
                return true;
            }

            const capQuestBtn = document.querySelector('.gw-quests[data-type="daily"] .q-b-get[data-type="quest_dl_capcha"]');
            if (capQuestBtn) {
                const dailyTab = document.querySelector('.gw-context-menu div[data-quests="daily"]');
                if (dailyTab && !dailyTab.classList.contains('gw-page-active')) dailyTab.click();
                if (now - lastDailyActionAt < 3500) return true;
                lastDailyActionAt = now;
                state.status = '🎁 Открываем квест «Пройдите проверку капчи» (+300 монет)...';
                saveState(state);
                capQuestBtn.click();
                return true;
            }

            // 2. Вкладка «Еженедельные Задания» (data-quests="weekly") — сбор наград, авто-квест с избранным и замена выполненных задач
            if (favQuest) {
                runWeeklyFavoriteQuest(favQuest);
                return true;
            }

            const weeklyClaimBtn = document.querySelector('.gw-quests[data-type="weekly"] .q-b-get');
            if (weeklyClaimBtn) {
                const weeklyTab = document.querySelector('.gw-context-menu div[data-quests="weekly"]');
                if (weeklyTab && !weeklyTab.classList.contains('gw-page-active')) weeklyTab.click();
                if (now - lastDailyActionAt < 2500) return true;
                lastDailyActionAt = now;
                const qTitle = weeklyClaimBtn.closest('.gw-quest-holder')?.querySelector('.gw-quest-info span')?.innerText?.trim() || 'Еженедельное задание';
                state.status = `🎁 Забираем еженедельное задание: «${qTitle}»...`;
                saveState(state);
                weeklyClaimBtn.click();
                return true;
            }

            const refreshCountEl = document.querySelector('#balanceTrefresh b');
            const refreshAvailable = refreshCountEl ? (parseInt(refreshCountEl.innerText.trim()) || 0) : 0;
            if (refreshAvailable > 0) {
                const completedWeeklyRefreshBtn = Array.from(
                    document.querySelectorAll('.gw-quests[data-type="weekly"] .gw-quest-progress')
                ).find(prog => prog.querySelector('.q-b-done:not(.refresh-task)') && prog.querySelector('.refresh-task'))
                 ?.querySelector('.refresh-task');

                if (completedWeeklyRefreshBtn) {
                    const weeklyTab = document.querySelector('.gw-context-menu div[data-quests="weekly"]');
                    if (weeklyTab && !weeklyTab.classList.contains('gw-page-active')) weeklyTab.click();
                    if (now - lastDailyActionAt < 2500) return true;
                    lastDailyActionAt = now;
                    state.status = `🔄 Заменяем выполненное еженедельное задание (доступно замен: ${refreshAvailable})...`;
                    saveState(state);
                    completedWeeklyRefreshBtn.click();
                    setTimeout(() => {
                        const acceptBtn = document.querySelector('.refresh-task-accept');
                        if (acceptBtn) acceptBtn.click();
                    }, 400);
                    return true;
                }
            }

            // 3. Вкладка «Постоянные Задачи» (data-quests="global")
            const globalClaimBtn = document.querySelector('.gw-quests[data-type="global"] .q-b-get');
            if (globalClaimBtn) {
                const globalTab = document.querySelector('.gw-context-menu div[data-quests="global"]');
                if (globalTab && !globalTab.classList.contains('gw-page-active')) globalTab.click();
                if (now - lastDailyActionAt < 2500) return true;
                lastDailyActionAt = now;
                const qTitle = globalClaimBtn.closest('.gw-quest-holder')?.querySelector('.gw-quest-info span')?.innerText?.trim() || 'Постоянная задача';
                state.status = `🎁 Забираем постоянную задачу: «${qTitle}»...`;
                saveState(state);
                globalClaimBtn.click();
                return true;
            }
        }

        // 4. Вступление в Ежедневный и Еженедельный Розыгрыши (за 1 билет)
        if (doGiveaways) {
            const tickets = getTicketsBalance();
            const unjoinedBtn = document.querySelector('.gw-draw-v2-card:not(.gw-draw-joined) .gw-draw-join-btn');

            if (unjoinedBtn && tickets >= 1) {
                const gwPageContent = document.querySelector('.giveaways-content[data-page="giveaway"]');
                if (gwPageContent && !gwPageContent.classList.contains('gc-active')) {
                    if (typeof window.changePage === 'function') {
                        window.changePage('giveaway');
                    } else {
                        const gwNav = document.querySelector('.gw-page[data-page="giveaway"]');
                        if (gwNav) gwNav.click();
                    }
                }

                if (now - lastDailyActionAt < 3500) return true;
                lastDailyActionAt = now;

                const card = unjoinedBtn.closest('.gw-draw-v2-card');
                const title = card?.querySelector('.gw-draw-v2-title')?.innerText?.trim() || 'Розыгрыш';
                state.status = `🎟 Вступаем в «${title}» (1 билет)...`;
                saveState(state);
                unjoinedBtn.click();
                return true;
            }
        }

        // 5. Все выбранные задачи/розыгрыши выполнены!
        state.dailyTasksDoneInSession = true;
        if (state.dailyTasksActive && !state.active) {
            state.dailyTasksActive = false;
            if (doQuests && doGiveaways) {
                state.status = '✅ Задания собраны, в розыгрыши вступили!';
            } else if (doQuests) {
                state.status = '✅ Все доступные задания собраны!';
            } else {
                state.status = '✅ Вступление в розыгрыши выполнено!';
            }
            saveState(state);
            return false;
        }

        state.dailyTasksActive = false;
        // Если включен автофарм пазлов — возвращаемся в раздел Аркадные игры (arcgames)
        const arcContent = document.querySelector('.giveaways-content[data-page="arcgames"]');
        if (state.active && arcContent && !arcContent.classList.contains('gc-active')) {
            if (typeof window.changePage === 'function') {
                window.changePage('arcgames');
            } else {
                const arcNav = document.querySelector('.gw-page[data-page="arcgames"]');
                if (arcNav) arcNav.click();
            }
            state.status = 'Переходим к Аркадным играм (Puzzle Box)...';
            saveState(state);
            return true;
        }

        saveState(state);
        return false;
    }

    // ==========================================
    // ГЛАВНЫЙ ЦИКЛ АВТОМАТА (1 раз в секунду)
    // ==========================================
    let lastAcceptClickAt = 0;
    let lastPlayClickAt = 0;

    if (window.__slvlupAfInterval) clearInterval(window.__slvlupAfInterval);
    window.__slvlupAfInterval = setInterval(() => {
        const state = getState();
        updateUI(state);

        const canvas = document.getElementById('defaultCanvas0');
        if (!canvas) {
            if (processDailyTasksAndGiveaways(state)) return;
        }

        if (!state.active) return;

        const now = Date.now();
        const modalAccept = document.querySelector('.new-game-accept');

        // 1. Проверка завершения очереди игр или окончания билетов (когда мы в лобби)
        if (!canvas && !modalAccept) {
            const ticketsEl = document.querySelector('.gwg-bal-item[data-i="tickets"] span');
            const currentTickets = ticketsEl ? (parseInt(ticketsEl.innerText.trim(), 10) || 0) : null;

            if (state.useAllTickets) {
                if (currentTickets !== null && currentTickets <= 0) {
                    state.active = false;
                    state.status = `🎉 Все билеты израсходованы! Собрано игр: ${state.completed}`;
                    saveState(state);
                    return;
                }
            } else {
                if (state.completed >= state.totalGames) {
                    state.active = false;
                    state.status = `🎉 Все запланированные игры завершены (${state.completed}/${state.totalGames})!`;
                    saveState(state);
                    return;
                }
                if (currentTickets !== null && currentTickets <= 0) {
                    state.active = false;
                    state.status = `🎟 Закончились билеты! Собрано игр: ${state.completed}/${state.totalGames}`;
                    saveState(state);
                    return;
                }
            }
        }

        // 2. Модалка "Новая игра" -> кликаем "УВЕРЕН" (не чаще 1 раза в 4 сек, только если холст ещё не открыт)
        if (!canvas && modalAccept && modalAccept.offsetParent !== null && !modalAccept.classList.contains('disabled')) {
            if (now - lastAcceptClickAt < 4000) return;
            lastAcceptClickAt = now;
            state.status = 'Подтверждаем билет (Уверен)...';
            state.diffSelected = false;
            state.diffWaitEndTime = 0;
            state.boardWaitEndTime = 0;
            state.settingsClosed = false;
            state.pieceNudged = false;
            state.roundStartTime = 0;
            state.roundTargetTime = 0;
            state.solvingStarted = false;
            state.exitClicked = false;
            saveState(state);
            modalAccept.click();
            return;
        }

        // 3. Список игр -> кликаем "Играть" у Puzzle Box (не чаще 1 раза в 4 сек, только если холст ещё не открыт)
        const playBtn = document.querySelector('.new-game[data-game="puzzle"]');
        if (!canvas && playBtn && playBtn.offsetParent !== null && !modalAccept) {
            if (now - lastPlayClickAt < 4000) return;
            lastPlayClickAt = now;
            state.status = 'Входим в Puzzle Box...';
            state.diffSelected = false;
            state.diffWaitEndTime = 0;
            state.boardWaitEndTime = 0;
            state.settingsClosed = false;
            state.pieceNudged = false;
            state.roundStartTime = 0;
            state.roundTargetTime = 0;
            state.solvingStarted = false;
            state.exitClicked = false;
            saveState(state);
            playBtn.click();
            return;
        }

        if (!canvas) return; // Игра еще не открылась

        // Сброс состояния при обнаружении нового билета
        const p = getPuzzleInstance();
        const currentTicketId = (p && p.ticketId) || window.ticketId || null;
        if (currentTicketId && state.lastTicketId !== currentTicketId) {
            console.log(`[AutoFarmer] Обнаружен новый билет #${currentTicketId}! Сброс таймеров.`);
            state.lastTicketId = currentTicketId;
            state.roundStartTime = 0;
            state.roundTargetTime = 0;
            state.roundTargetDuration = 0;
            state.diffSelected = false;
            state.pieceNudged = false;
            state.solvingStarted = false;
            state.exitClicked = false;
            saveState(state);
        }

        // Если выход уже нажат — ждём нативную перезагрузку страницы от игры (скрипт ничего не трогает)
        if (state.exitClicked) {
            state.status = '⏳ Выход нажат. Ожидаем возврат в лобби...';
            return;
        }

        const screenState = getGameScreenState();
        const gameProgressText = state.useAllTickets
            ? `#${state.completed + 1} (билетов: ${getTicketsBalance()})`
            : `${state.completed + 1}/${state.totalGames}`;

        // 4. Пазл собран (или экран завершения раунда) -> выжидаем появление кнопки "Выход" и нажимаем её штатно
        if (state.solvingStarted || screenState === 'GAME_END') {
            if (!state.solvingStarted) {
                state.solvingStarted = true;
                state.solveTime = now;
            }
            if (p && p.menu && !p.menu.gameEnd) {
                solvePuzzle();
            }

            const waitMs = (state.exitWaitSec || 7) * 1000;
            const elapsed = now - state.solveTime;

            if (elapsed < waitMs) {
                const left = Math.ceil((waitMs - elapsed) / 1000);
                state.status = `🏆 Экран победы! Выход через: ${left}с...`;
                saveState(state);
                return;
            }

            state.status = 'Нажимаем "Выход" в игре...';

            // Фиксируем завершение этого раунда в памяти перед нажатием
            state.completed++;
            state.solvingStarted = false;
            state.exitClicked = true;
            state.diffSelected = false;
            state.diffWaitEndTime = 0;
            state.boardWaitEndTime = 0;
            state.settingsClosed = false;
            state.pieceNudged = false;
            state.roundStartTime = 0;
            state.roundTargetTime = 0;

            if (state.useAllTickets) {
                const remTickets = getTicketsBalance();
                if (remTickets > 0) {
                    state.active = true;
                } else {
                    state.active = false;
                    state.status = `🎉 Все билеты израсходованы! Собрано игр: ${state.completed}`;
                }
            } else {
                if (state.completed < state.totalGames) {
                    state.active = true;
                } else {
                    state.active = false;
                    state.status = `🎉 Все запланированные игры завершены (${state.completed}/${state.totalGames})!`;
                }
            }
            saveState(state);

            // 1. Штатный вызов click() у кнопки close_gameEnd в p.buttonsArr
            if (p && Array.isArray(p.buttonsArr)) {
                const exitBtn = p.buttonsArr.find(b =>
                    b && (b.name === 'close_gameEnd' || b.id === 'close_gameEnd' || (typeof b.name === 'string' && b.name.startsWith('close_game')))
                );
                if (exitBtn && typeof exitBtn.click === 'function') {
                    try { exitBtn.click(); } catch(e) {}
                }
            }

            // 2. Внутренний вызов checkClickButtons по точным координатам кнопки (origX: 844..964, origY: 540..630)
            if (p && p.menu && typeof p.menu.checkClickButtons === 'function') {
                try { p.menu.checkClickButtons(885, 570); } catch(e) {}
            }

            // 3. Эмуляция клика по холсту в зоне кнопки Выход
            clickCanvas(0.89, 0.88);
            return;
        }

        // 5. Проверяем, какой экран сейчас открыт в движке игры
        if (screenState === 'NO_ENGINE' || screenState === 'PRELOADER') {
            state.status = '⏳ Загрузка движка и текстур игры (Preloader)...';
            saveState(state);
            return;
        }

        // 6. Если открыт стартовый экран выбора сложности (!p.started)
        if (screenState === 'START_SCREEN') {
            const waitMs = (state.diffWaitSec || 10) * 1000;
            if (!state.diffWaitEndTime) {
                state.diffWaitEndTime = now + waitMs;
                state.status = `🖥 Выбор сложности. Пауза (${state.diffWaitSec}с)...`;
                saveState(state);
                return;
            }

            if (now < state.diffWaitEndTime) {
                const left = Math.ceil((state.diffWaitEndTime - now) / 1000);
                state.status = `🖥 Выбор сложности. Клик через: ${left}с...`;
                saveState(state);
                return;
            }

            const boardWaitMs = (state.boardWaitSec || 10) * 1000;
            state.diffSelected = true;
            state.boardWaitEndTime = now + boardWaitMs;
            state.status = `Выбираем сложность (${gameProgressText})...`;
            saveState(state);

            triggerDifficulty(state.diff);
            return;
        }

        // Если p.started === true, значит сложность ТОЧНО выбрана
        state.diffSelected = true;

        // 7. Ожидание завершения анимации раздачи кусочков или пользовательской паузы на прогрузку стола
        if (screenState === 'LOADING_BOARD' || screenState === 'BOARD_ANIMATING') {
            state.status = screenState === 'BOARD_ANIMATING'
                ? '⏳ Анимация раскладки кусочков по столу...'
                : '⏳ Генерация кусочков пазла...';
            saveState(state);
            return;
        }

        if (state.boardWaitEndTime > 0 && now < state.boardWaitEndTime) {
            const left = Math.ceil((state.boardWaitEndTime - now) / 1000);
            state.status = `⏳ Стол загружен. Пауза перед стартом: ${left}с...`;
            saveState(state);
            return;
        }

        // 8. Закрываем окно настроек или подсказок, если оно открыто на экране
        if (screenState === 'SETTINGS_MODAL' || screenState === 'HELP_MODAL') {
            state.status = 'Закрываем модальное окно настроек/помощи...';
            saveState(state);
            closeSettingsModal();
            if (p && p.menu) p.menu.helpModal = false;
            return;
        }

        // 9. Сдвиг кусочка в левой зоне для запуска секундомера
        if (!state.pieceNudged) {
            state.status = 'Сдвигаем кусочек для запуска таймера...';
            saveState(state);

            const nudged = nudgePieceInTargetZone();
            if (nudged) {
                state.pieceNudged = true;
                saveState(state);
            }
            return;
        }

        // 10. Проверка таймера игры (p.menu.time)
        const gameTimer = (p && p.menu && typeof p.menu.time === 'number') ? p.menu.time : 0;

        // Если секундомер игры еще на нуле — сдвигаем кусочек и ждем фактического старта времени
        if (gameTimer === 0) {
            state.roundStartTime = 0;
            state.roundTargetTime = 0;
            state.roundTargetDuration = 0;
            nudgePieceInTargetZone();
            state.status = 'Сдвигаем кусочек и ждем старта таймера игры...';
            saveState(state);
            return;
        }

        // 11. Инициализация целевой длительности ТОЛЬКО когда таймер игры реально пошёл
        if (!state.roundTargetDuration) {
            const minT = Math.max(90, state.minTime || 240);
            const maxT = Math.max(minT, state.maxTime || minT);
            const duration = Math.floor(Math.random() * (maxT - minT + 1)) + minT;
            state.roundTargetDuration = duration;
            state.roundStartTime = now;
            state.roundTargetTime = now + duration * 1000;
            state.status = `Фарм запущен! Выдержка на таймере: ${duration}с`;
            saveState(state);
            return;
        }

        // 12. Обратный отсчет СТРОГО ПО РЕАЛЬНОМУ ТАЙМЕРУ ИГРЫ (gameTimer)
        if (gameTimer < state.roundTargetDuration) {
            const remaining = Math.max(0, state.roundTargetDuration - gameTimer);
            state.status = `Игра ${gameProgressText} • Сборка через: ${remaining}с (${gameTimer}/${state.roundTargetDuration}с)`;
            saveState(state);
            return;
        }

        // 13. Автоматическая сборка пазла ТОЛЬКО когда секундомер игры достиг целевого времени!
        state.status = '⚡ Время вышло! Собираем пазл...';
        saveState(state);

        solvePuzzle();

        state.roundStartTime = 0;
        state.roundTargetTime = 0;
        state.roundTargetDuration = 0;
        state.solvingStarted = true;
        state.solveTime = now;
        saveState(state);
    }, 1000);

    // ==========================================
    // ПЛАВАЮЩИЙ И ПЕРЕТАСКИВАЕМЫЙ UI ВИДЖЕТ (v1.3.0)
    // ==========================================
    function injectStyles() {
        if (document.getElementById('af-styles')) return;
        const style = document.createElement('style');
        style.id = 'af-styles';
        style.textContent = `
            #af-widget {
                position: fixed;
                z-index: 9999999;
                width: 340px;
                background: linear-gradient(165deg, rgba(19, 21, 31, 0.97) 0%, rgba(12, 14, 22, 0.98) 100%);
                border: 1px solid rgba(99, 102, 241, 0.45);
                border-radius: 14px;
                padding: 12px 14px;
                color: #f3f4f6;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
                font-size: 12px;
                box-shadow: 0 14px 40px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
                backdrop-filter: blur(12px);
                box-sizing: border-box;
                transition: border-color 0.2s ease;
            }
            #af-widget * {
                box-sizing: border-box;
            }
            #af-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding-bottom: 8px;
                margin-bottom: 10px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                cursor: move;
                user-select: none;
            }
            .af-brand {
                display: flex;
                align-items: center;
                gap: 7px;
                font-weight: 700;
                font-size: 13px;
                color: #fff;
                letter-spacing: 0.2px;
            }
            .af-ver {
                font-size: 10px;
                font-weight: 600;
                padding: 2px 6px;
                border-radius: 999px;
                background: rgba(99, 102, 241, 0.2);
                color: #818cf8;
                border: 1px solid rgba(99, 102, 241, 0.35);
            }
            #af-toggle {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #9ca3af;
                font-size: 11px;
                border-radius: 6px;
                padding: 2px 8px;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            #af-toggle:hover {
                background: rgba(255, 255, 255, 0.12);
                color: #fff;
            }
            .af-stats-row {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 6px;
                margin-bottom: 8px;
            }
            .af-stat-pill {
                background: rgba(255, 255, 255, 0.035);
                border: 1px solid rgba(255, 255, 255, 0.07);
                border-radius: 8px;
                padding: 5px 6px;
                text-align: center;
                font-size: 11px;
                color: #d1d5db;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .af-stat-pill b {
                color: #fff;
                font-weight: 700;
            }
            #af-engine-badge {
                margin-bottom: 10px;
                padding: 5px 8px;
                background: rgba(15, 17, 26, 0.9);
                border-radius: 8px;
                font-size: 11px;
                font-weight: 500;
                text-align: center;
                color: #9ca3af;
                border: 1px solid rgba(255, 255, 255, 0.08);
                transition: all 0.2s ease;
            }
            .af-card {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.07);
                border-radius: 10px;
                padding: 9px 10px;
                margin-bottom: 9px;
            }
            .af-card-title {
                font-size: 11px;
                font-weight: 700;
                color: #e5e7eb;
                margin-bottom: 7px;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .af-label {
                display: block;
                font-size: 11px;
                color: #9ca3af;
                margin-bottom: 4px;
            }
            .af-input, .af-select {
                width: 100%;
                background: #181b28;
                color: #f9fafb;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 7px;
                padding: 5px 8px;
                font-size: 12px;
                outline: none;
                transition: border-color 0.15s ease, opacity 0.15s ease;
            }
            .af-input:focus, .af-select:focus {
                border-color: #6366f1;
            }
            .af-input:disabled {
                opacity: 0.45;
                cursor: not-allowed;
            }
            .af-row {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .af-chip-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
                margin-bottom: 7px;
            }
            .af-check-chip {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 5px 8px;
                background: rgba(24, 27, 40, 0.85);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 7px;
                font-size: 11px;
                color: #d1d5db;
                cursor: pointer;
                user-select: none;
                transition: all 0.15s ease;
            }
            .af-check-chip:hover {
                border-color: rgba(99, 102, 241, 0.5);
                color: #fff;
            }
            .af-check-chip input[type="checkbox"] {
                accent-color: #6366f1;
                cursor: pointer;
                margin: 0;
            }
            .af-details {
                margin-top: 6px;
                border-top: 1px solid rgba(255, 255, 255, 0.06);
                padding-top: 6px;
            }
            .af-details summary {
                font-size: 11px;
                color: #9ca3af;
                cursor: pointer;
                user-select: none;
                list-style: none;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .af-details summary::-webkit-details-marker {
                display: none;
            }
            .af-details summary:hover {
                color: #e5e7eb;
            }
            .af-btn {
                border: none;
                border-radius: 8px;
                padding: 8px 10px;
                font-weight: 700;
                font-size: 12px;
                cursor: pointer;
                color: #fff;
                transition: filter 0.15s ease, transform 0.1s ease, opacity 0.15s ease;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
            }
            .af-btn:hover:not(:disabled) {
                filter: brightness(1.1);
            }
            .af-btn:active:not(:disabled) {
                transform: translateY(1px);
            }
            .af-btn:disabled {
                opacity: 0.45;
                cursor: not-allowed;
            }
            #af-status {
                margin-bottom: 9px;
                padding: 7px 9px;
                background: #090b10;
                border-radius: 8px;
                color: #10b981;
                font-size: 11px;
                font-weight: 500;
                text-align: center;
                border: 1px solid rgba(16, 185, 129, 0.22);
                min-height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
                line-height: 1.35;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function makeDraggable(el, handle) {
        let isDragging = false;
        let startX = 0, startY = 0;
        let origLeft = 0, origTop = 0;

        handle.addEventListener('mousedown', (e) => {
            if (e.target.id === 'af-toggle') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = el.getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newLeft = Math.max(10, Math.min(window.innerWidth - el.offsetWidth - 10, origLeft + dx));
            const newTop = Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, origTop + dy));

            el.style.left = `${newLeft}px`;
            el.style.top = `${newTop}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                try {
                    localStorage.setItem(UI_POS_KEY, JSON.stringify({
                        left: el.style.left,
                        top: el.style.top
                    }));
                } catch(e) {}
            }
        });
    }

    function createUI() {
        injectStyles();
        const existingWidget = document.getElementById('af-widget');
        if (existingWidget) {
            if (document.getElementById('af-all-tickets')) return;
            existingWidget.remove();
        }

        let savedPos = { right: '20px', top: '70px', left: '', bottom: '' };
        try {
            const posData = localStorage.getItem(UI_POS_KEY);
            if (posData) {
                const parsed = JSON.parse(posData);
                if (parsed.left && parsed.top) {
                    savedPos = { left: parsed.left, top: parsed.top, right: 'auto', bottom: 'auto' };
                }
            }
        } catch(e) {}

        const div = document.createElement('div');
        div.id = 'af-widget';
        if (savedPos.left) {
            div.style.left = savedPos.left;
            div.style.right = 'auto';
        } else {
            div.style.right = savedPos.right;
        }
        div.style.top = savedPos.top;

        const curState = getState();

        div.innerHTML = `
            <div id="af-header">
                <div class="af-brand">
                    <span>🧩 AutoFarmer Pro</span>
                    <span class="af-ver">v1.3.0</span>
                </div>
                <button id="af-toggle">Свернуть</button>
            </div>
            <div id="af-body">
                <div class="af-stats-row">
                    <div class="af-stat-pill" title="Доступно билетов">🎟 Билеты: <b id="af-stat-tickets">0</b></div>
                    <div class="af-stat-pill" title="Баланс монет">🪙 Монеты: <b id="af-stat-coins">0</b></div>
                    <div class="af-stat-pill" title="Собрано игр за сессию">🏆 Игр: <b id="af-stat-games">0/0</b></div>
                </div>
                <div id="af-engine-badge">⏳ Связь с игрой: ожидание...</div>

                <div class="af-card">
                    <div class="af-card-title">
                        <span>🎮 Настройки Puzzle Box</span>
                    </div>
                    <div style="margin-bottom: 7px;">
                        <label class="af-label">Сложность:</label>
                        <select id="af-diff" class="af-select">
                            <option value="2">🔴 Сложная (до 500s ➔ 1400 XP)</option>
                            <option value="1">🟡 Средняя (до 300s ➔ 800 XP)</option>
                            <option value="0">🟢 Легкая (до 80s ➔ 300 XP)</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 7px;">
                        <label class="af-label">Количество игр:</label>
                        <div class="af-row">
                            <input id="af-count" class="af-input" type="number" value="${curState.totalGames}" min="1" max="999" style="width: 90px; text-align: center;" ${curState.useAllTickets ? 'disabled' : ''}>
                            <label class="af-check-chip" style="flex: 1; justify-content: center;" title="Запускать игры подряд, пока не закончатся все билеты">
                                <input id="af-all-tickets" type="checkbox" ${curState.useAllTickets ? 'checked' : ''}>
                                <span>🎟 На все билеты</span>
                            </label>
                        </div>
                    </div>
                    <div>
                        <label class="af-label">Выдержка перед сборкой (сек):</label>
                        <div class="af-row">
                            <input id="af-min" class="af-input" type="number" value="${curState.minTime}" style="text-align: center;">
                            <span style="color: #6b7280;">—</span>
                            <input id="af-max" class="af-input" type="number" value="${curState.maxTime}" style="text-align: center;">
                        </div>
                    </div>
                    <details class="af-details">
                        <summary>
                            <span>⚙️ Тайминги и паузы</span>
                            <span id="af-pauses-summary" style="font-size: 10px; color: #6b7280;">${curState.diffWaitSec || 10}с / ${curState.boardWaitSec || 10}с / ${curState.exitWaitSec || 7}с ▾</span>
                        </summary>
                        <div style="margin-top: 7px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                            <div>
                                <label class="af-label" style="font-size:10px;">До выбора (с)</label>
                                <input id="af-diff-wait" class="af-input" type="number" value="${curState.diffWaitSec || 10}" min="0" max="60" style="text-align: center; padding: 4px;">
                            </div>
                            <div>
                                <label class="af-label" style="font-size:10px;">Стол (с)</label>
                                <input id="af-board-wait" class="af-input" type="number" value="${curState.boardWaitSec || 10}" min="0" max="60" style="text-align: center; padding: 4px;">
                            </div>
                            <div>
                                <label class="af-label" style="font-size:10px;">Выход (с)</label>
                                <input id="af-exit-wait" class="af-input" type="number" value="${curState.exitWaitSec || 7}" min="1" max="60" style="text-align: center; padding: 4px;">
                            </div>
                        </div>
                    </details>
                </div>

                <div class="af-card">
                    <div class="af-card-title">
                        <span style="color: #fbbf24;">🎁 Задачи и Розыгрыши</span>
                        <label style="display: flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 500; color: #9ca3af; cursor: pointer;" title="Автоматически проверять выбранные пункты перед стартом фарма и между играми">
                            <input id="af-auto-daily" type="checkbox" ${curState.autoDailyBeforeFarm !== false ? 'checked' : ''} style="accent-color: #fbbf24; cursor: pointer; margin: 0;">
                            <span>Авто перед фармом</span>
                        </label>
                    </div>
                    <div class="af-chip-grid">
                        <label class="af-check-chip" title="Собирать Ежедневные, Еженедельные (с автозаменой и 30 в избранное) и Постоянные задачи">
                            <input id="af-do-quests" type="checkbox" ${curState.doQuests !== false ? 'checked' : ''}>
                            <span>📋 Задачи</span>
                        </label>
                        <label class="af-check-chip" title="Вступать в Ежедневный и Еженедельный розыгрыши за 1 билет">
                            <input id="af-do-giveaways" type="checkbox" ${curState.doGiveaways !== false ? 'checked' : ''}>
                            <span>🎟 Розыгрыши</span>
                        </label>
                    </div>
                    <details class="af-details" style="margin-top: 0; border-top: none; padding-top: 0; margin-bottom: 7px;">
                        <summary style="font-size: 10px;">
                            <span>🤖 ИИ-капча (Gemini API Key)</span>
                            <span>▾</span>
                        </summary>
                        <div style="margin-top: 5px;">
                            <input id="af-gemini-key" class="af-input" type="password" placeholder="Вставьте ключ Gemini API (необязательно)" value="${curState.geminiApiKey || ''}" style="font-size: 11px; padding: 4px 7px;">
                        </div>
                    </details>
                    <button id="af-daily-btn" class="af-btn" style="width: 100%; padding: 6px 8px; font-size: 11px; background: #6366f1;">
                        🎁 Собрать задачи и розыгрыши
                    </button>
                </div>

                <div id="af-status">${curState.status}</div>

                <div class="af-row">
                    <button id="af-action-btn" class="af-btn" style="flex: 1.2; background: ${curState.active ? '#ef4444' : '#10b981'};">
                        ${curState.active ? '⏸ Стоп' : '▶ Старт'}
                    </button>
                    <button id="af-solve-btn" class="af-btn" style="flex: 1; background: #3b82f6;">
                        ⚡ Собрать
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(div);

        makeDraggable(div, div.querySelector('#af-header'));

        const diffEl = div.querySelector('#af-diff');
        const countEl = div.querySelector('#af-count');
        const allTicketsEl = div.querySelector('#af-all-tickets');
        const minEl = div.querySelector('#af-min');
        const maxEl = div.querySelector('#af-max');
        const diffWaitEl = div.querySelector('#af-diff-wait');
        const boardWaitEl = div.querySelector('#af-board-wait');
        const exitWaitEl = div.querySelector('#af-exit-wait');
        const pausesSummaryEl = div.querySelector('#af-pauses-summary');
        const doQuestsEl = div.querySelector('#af-do-quests');
        const doGiveawaysEl = div.querySelector('#af-do-giveaways');
        const autoDailyEl = div.querySelector('#af-auto-daily');
        const geminiKeyEl = div.querySelector('#af-gemini-key');
        const dailyBtn = div.querySelector('#af-daily-btn');
        const actionBtn = div.querySelector('#af-action-btn');
        const solveBtn = div.querySelector('#af-solve-btn');
        const toggleBtn = div.querySelector('#af-toggle');
        const bodyEl = div.querySelector('#af-body');

        diffEl.value = curState.diff;

        diffEl.addEventListener('change', () => {
            const st = getState();
            st.diff = parseInt(diffEl.value);
            if (st.diff === 2) {
                st.minTime = 240;
                st.maxTime = 260;
            } else if (st.diff === 1) {
                st.minTime = 140;
                st.maxTime = 170;
            } else {
                st.minTime = 60;
                st.maxTime = 75;
            }
            minEl.value = st.minTime;
            maxEl.value = st.maxTime;
            saveState(st);
        });

        allTicketsEl.addEventListener('change', () => {
            const st = getState();
            st.useAllTickets = !!allTicketsEl.checked;
            countEl.disabled = st.useAllTickets;
            saveState(st);
            updateUI(st);
        });

        const updatePausesSummary = (st) => {
            if (pausesSummaryEl) {
                pausesSummaryEl.innerText = `${st.diffWaitSec || 10}с / ${st.boardWaitSec || 10}с / ${st.exitWaitSec || 7}с ▾`;
            }
        };

        const bindInput = (el, prop, fallback) => {
            ['input', 'change'].forEach(ev => {
                el.addEventListener(ev, () => {
                    const st = getState();
                    st[prop] = parseInt(el.value) || fallback;
                    saveState(st);
                    updatePausesSummary(st);
                });
            });
        };
        bindInput(countEl, 'totalGames', 1);
        bindInput(minEl, 'minTime', 240);
        bindInput(maxEl, 'maxTime', 260);
        bindInput(diffWaitEl, 'diffWaitSec', 10);
        bindInput(boardWaitEl, 'boardWaitSec', 10);
        bindInput(exitWaitEl, 'exitWaitSec', 7);

        doQuestsEl.addEventListener('change', () => {
            const st = getState();
            st.doQuests = !!doQuestsEl.checked;
            saveState(st);
            updateUI(st);
        });

        doGiveawaysEl.addEventListener('change', () => {
            const st = getState();
            st.doGiveaways = !!doGiveawaysEl.checked;
            saveState(st);
            updateUI(st);
        });

        autoDailyEl.addEventListener('change', () => {
            const st = getState();
            st.autoDailyBeforeFarm = !!autoDailyEl.checked;
            saveState(st);
        });

        ['input', 'change'].forEach(ev => {
            geminiKeyEl.addEventListener(ev, () => {
                const st = getState();
                st.geminiApiKey = geminiKeyEl.value.trim();
                saveState(st);
            });
        });

        dailyBtn.addEventListener('click', () => {
            const st = getState();
            if (!st.doQuests && !st.doGiveaways) return;
            st.dailyTasksActive = !st.dailyTasksActive;
            if (st.dailyTasksActive) {
                st.dailyTasksDoneInSession = false;
                st.status = '🎁 Запуск выбранных задач / розыгрышей...';
            } else {
                st.status = 'Выполнение задач/розыгрышей остановлено.';
            }
            saveState(st);
            updateUI(st);
        });

        actionBtn.addEventListener('click', () => {
            const st = getState();
            st.active = !st.active;
            if (st.active) {
                st.completed = 0;
                st.dailyTasksDoneInSession = false;
                st.diffSelected = false;
                st.diffWaitEndTime = 0;
                st.boardWaitEndTime = 0;
                st.settingsClosed = false;
                st.pieceNudged = false;
                st.roundStartTime = 0;
                st.roundTargetTime = 0;
                st.solvingStarted = false;
                st.exitClicked = false;
                st.status = st.useAllTickets
                    ? `Автофарм запущен (на все билеты: ${getTicketsBalance()} шт.)!`
                    : `Автофарм запущен (план: ${st.totalGames} игр)!`;
            } else {
                st.dailyTasksActive = false;
                st.status = 'Остановлено пользователем.';
            }
            saveState(st);
            updateUI(st);
        });

        solveBtn.addEventListener('click', () => {
            const st = getState();
            const p = getPuzzleInstance();
            const gameTime = (p && p.menu && typeof p.menu.time === 'number') ? p.menu.time : 0;

            if (st.diff === 2 && gameTime < 90) {
                const conf = confirm(`⚠️ Внимание!\nТекущее время игры: ${gameTime}с.\nДля Сложной сложности сервер начисляет 0 XP (Ошибка), если собрать пазл быстрее ~90 сек (античит сервера).\n\nВы действительно хотите собрать пазл сейчас?`);
                if (!conf) return;
            }

            const now = Date.now();
            const ok = solvePuzzle();
            if (!ok) {
                alert('Кусочки пазла еще не прогрузились на столе! Подождите пару секунд.');
                return;
            }

            st.roundStartTime = 0;
            st.roundTargetTime = 0;
            st.solvingStarted = true;
            st.solveTime = now;
            st.status = '⚡ Пазл собран вручную! Ожидание наград...';
            saveState(st);
            updateUI(st);
        });

        toggleBtn.addEventListener('click', () => {
            if (bodyEl.style.display === 'none') {
                bodyEl.style.display = 'block';
                toggleBtn.innerText = 'Свернуть';
            } else {
                bodyEl.style.display = 'none';
                toggleBtn.innerText = 'Развернуть';
            }
        });
    }

    function updateUI(state) {
        createUI();
        const statusEl = document.getElementById('af-status');
        if (statusEl) statusEl.innerText = state.status;

        const statTicketsEl = document.getElementById('af-stat-tickets');
        if (statTicketsEl) statTicketsEl.innerText = String(getTicketsBalance());

        const statCoinsEl = document.getElementById('af-stat-coins');
        if (statCoinsEl) statCoinsEl.innerText = String(getCoinsBalance());

        const statGamesEl = document.getElementById('af-stat-games');
        if (statGamesEl) {
            statGamesEl.innerText = state.useAllTickets
                ? `${state.completed}/∞`
                : `${state.completed}/${state.totalGames}`;
        }

        const countEl = document.getElementById('af-count');
        if (countEl) {
            countEl.disabled = !!state.useAllTickets;
        }

        const actionBtn = document.getElementById('af-action-btn');
        if (actionBtn) {
            actionBtn.innerText = state.active ? '⏸ Стоп' : '▶ Старт';
            actionBtn.style.background = state.active ? '#ef4444' : '#10b981';
        }

        const dailyBtn = document.getElementById('af-daily-btn');
        if (dailyBtn) {
            const doQ = state.doQuests !== false;
            const doG = state.doGiveaways !== false;
            dailyBtn.disabled = (!doQ && !doG);
            if (state.dailyTasksActive) {
                dailyBtn.innerText = '⏳ Выполняем... (Нажмите для отмены)';
                dailyBtn.style.background = '#f59e0b';
            } else {
                dailyBtn.style.background = '#6366f1';
                if (doQ && doG) {
                    dailyBtn.innerText = '🎁 Собрать задачи и розыгрыши';
                } else if (doQ) {
                    dailyBtn.innerText = '📋 Собрать только задачи';
                } else if (doG) {
                    dailyBtn.innerText = '🎟 Вступить только в розыгрыши';
                } else {
                    dailyBtn.innerText = '🚫 Задачи и розыгрыши отключены';
                }
            }
        }

        const badgeEl = document.getElementById('af-engine-badge');
        if (badgeEl) {
            const p = getPuzzleInstance();
            const screenState = getGameScreenState();
            const pieces = (p && p.variables && Array.isArray(p.variables.pieces)) ? p.variables.pieces : null;
            const screenNames = {
                'NO_ENGINE': '⏳ Ожидание запуска игры...',
                'PRELOADER': '⏳ Экран загрузки (Preloader)...',
                'START_SCREEN': '🖥 Экран: Выбор сложности',
                'LOADING_BOARD': '⏳ Экран: Генерация стола...',
                'BOARD_ANIMATING': '🎬 Экран: Раздача кусочков...',
                'SETTINGS_MODAL': '⚙️ Экран: Модалка настроек',
                'HELP_MODAL': '❓ Экран: Модалка помощи',
                'PLAYING': `🟢 Экран: Стол пазла (${pieces ? pieces.length : 0} кус.)`,
                'GAME_END': '🏆 Экран: Пазл собран (Финал)'
            };
            if (screenState === 'PLAYING' || screenState === 'GAME_END') {
                badgeEl.style.color = '#10b981';
                badgeEl.style.borderColor = 'rgba(16, 185, 129, 0.4)';
            } else if (p) {
                badgeEl.style.color = '#fbbf24';
                badgeEl.style.borderColor = 'rgba(251, 191, 36, 0.4)';
            } else {
                badgeEl.style.color = '#9ca3af';
                badgeEl.style.borderColor = 'rgba(255, 255, 255, 0.08)';
            }
            badgeEl.innerText = screenNames[screenState] || '⏳ Ожидание...';
        }
    }

    window.addEventListener('DOMContentLoaded', createUI);
    if (document.body) createUI();

})();
