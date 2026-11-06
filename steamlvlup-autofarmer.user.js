// ==UserScript==
// @name         SteamLvlUp Puzzle Box Full-Auto Farmer Pro
// @namespace    https://steamlvlup.com/
// @version      1.1.0
// @description  Полный автофарм PuzzleBox: пуленепробиваемый захват p5, настраиваемое время выдержки из UI, честная победа через checkGameEnd и авто-выход
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
            autoDailyBeforeFarm: true,
            dailyTasksDoneInSession: false,
            geminiApiKey: '',
            completed: 0,
            totalGames: 2,
            diff: 2,             // 0 = Легкая, 1 = Средняя, 2 = Сложная
            minTime: 240,        // Случайная выдержка от (сек)
            maxTime: 260,        // Случайная выдержка до (сек)
            diffWaitSec: 10,     // Ожидание перед выбором сложности (сек)
            boardWaitSec: 10,    // Ожидание прогрузки стола и кусочков (сек)
            exitWaitSec: 7,      // Ожидание появления кнопки "Выход" (сек)
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

    // Возвращает true, если сейчас выполняется шаг ежедневных заданий или открыта капча
    function processDailyTasksAndGiveaways(state) {
        const now = Date.now();
        const capInfo = enhanceCaptchaModal(state);

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

        const shouldRun = state.dailyTasksActive || (state.active && state.autoDailyBeforeFarm && !state.dailyTasksDoneInSession);
        if (!shouldRun) return false;

        // 1. Активируем вкладку Ежедневные задания (data-quests="daily")
        const dailyTab = document.querySelector('.gw-context-menu div[data-quests="daily"]');
        if (dailyTab && !dailyTab.classList.contains('gw-page-active')) {
            dailyTab.click();
        }

        // 2. Квест "Посетите страницу Розыгрышей" (quest_dl_advanced) — забирается в 1 клик без капчи
        const advQuestBtn = document.querySelector('.gw-quests[data-type="daily"] .q-b-get[data-type="quest_dl_advanced"]');
        if (advQuestBtn) {
            if (now - lastDailyActionAt < 3000) return true;
            lastDailyActionAt = now;
            state.status = '🎁 Забираем квест «Посетите страницу Розыгрышей» (+500 монет)...';
            saveState(state);
            advQuestBtn.click();
            return true;
        }

        // 3. Квест "Пройдите проверку капчи" (quest_dl_capcha)
        const capQuestBtn = document.querySelector('.gw-quests[data-type="daily"] .q-b-get[data-type="quest_dl_capcha"]');
        if (capQuestBtn) {
            if (now - lastDailyActionAt < 3500) return true;
            lastDailyActionAt = now;
            state.status = '🎁 Открываем квест «Пройдите проверку капчи» (+300 монет)...';
            saveState(state);
            capQuestBtn.click();
            return true;
        }

        // 4. Вступление в Ежедневный и Еженедельный Розыгрыши (за 1 билет)
        const ticketsEl = document.querySelector('.gwg-bal-item[data-i="tickets"] span');
        const tickets = ticketsEl ? (parseInt(ticketsEl.innerText.trim()) || 0) : 0;
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

        // 5. Все ежедневные задания и розыгрыши выполнены!
        state.dailyTasksDoneInSession = true;
        if (state.dailyTasksActive && !state.active) {
            state.dailyTasksActive = false;
            state.status = '✅ Ежедневные задания собраны, в розыгрыши вступили!';
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

        // 1. Завершение всех игр в очереди
        if (state.completed >= state.totalGames) {
            state.active = false;
            state.status = '🎉 Все запланированные игры завершены!';
            saveState(state);
            return;
        }

        const now = Date.now();

        // 2. Модалка "Новая игра" -> кликаем "УВЕРЕН" (не чаще 1 раза в 4 сек, только если холст ещё не открыт)
        const modalAccept = document.querySelector('.new-game-accept');
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
            state.status = '⏳ Выход нажат. Ожидаем авто-перезагрузку страницы от игры...';
            return;
        }

        const screenState = getGameScreenState();

        // 4. Пазл собран (или экран завершения раунда) -> выжидаем появление кнопки "Выход" и нажимаем её штатно
        if (state.solvingStarted || screenState === 'GAME_END') {
            if (!state.solvingStarted) {
                state.solvingStarted = true;
                state.solveTime = now;
            }
            // Если по какой-то причине p.menu.gameEnd еще не выставлен — дожимаем сборку
            if (p && p.menu && !p.menu.gameEnd) {
                solvePuzzle();
            }

            const waitMs = (state.exitWaitSec || 7) * 1000;
            const elapsed = now - state.solveTime;

            if (elapsed < waitMs) {
                const left = Math.ceil((waitMs - elapsed) / 1000);
                state.status = `🏆 Экран победы! Ожидание кнопки "Выход": ${left}с...`;
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

            if (state.completed < state.totalGames) {
                state.active = true;
            } else {
                state.active = false;
                state.status = '🎉 Все запланированные игры завершены!';
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
                state.status = `🖥 Экран выбора сложности. Пауза (${state.diffWaitSec}с)...`;
                saveState(state);
                return;
            }

            if (now < state.diffWaitEndTime) {
                const left = Math.ceil((state.diffWaitEndTime - now) / 1000);
                state.status = `🖥 Экран выбора сложности. Клик через: ${left}с...`;
                saveState(state);
                return;
            }

            const boardWaitMs = (state.boardWaitSec || 10) * 1000;
            state.diffSelected = true;
            state.boardWaitEndTime = now + boardWaitMs;
            state.status = `Выбираем сложность (${state.completed + 1}/${state.totalGames})...`;
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
            state.status = `Фарм запущен! Выдержка на таймере игры: ${duration}с`;
            saveState(state);
            return;
        }

        // 12. Обратный отсчет СТРОГО ПО РЕАЛЬНОМУ ТАЙМЕРУ ИГРЫ (gameTimer)
        if (gameTimer < state.roundTargetDuration) {
            const remaining = Math.max(0, state.roundTargetDuration - gameTimer);
            state.status = `Игра (${state.completed + 1}/${state.totalGames}). Сборка через: ${remaining}с (в игре: ${gameTimer}/${state.roundTargetDuration}с)`;
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
    // ПЛАВАЮЩИЙ И ПЕРЕТАСКИВАЕМЫЙ UI ВИДЖЕТ
    // ==========================================
    function makeDraggable(el, handle) {
        let isDragging = false;
        let startX = 0, startY = 0;
        let origLeft = 0, origTop = 0;

        handle.style.cursor = 'move';
        handle.style.userSelect = 'none';

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
        const existingWidget = document.getElementById('af-widget');
        if (existingWidget) {
            if (document.getElementById('af-daily-btn')) return;
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
        div.style.cssText = `
            position: fixed;
            ${savedPos.left ? `left: ${savedPos.left};` : `right: ${savedPos.right};`}
            top: ${savedPos.top};
            z-index: 9999999;
            background: rgba(17, 18, 23, 0.95);
            border: 2px solid #5865f2;
            border-radius: 12px;
            padding: 12px 14px;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.7);
            backdrop-filter: blur(8px);
            width: 320px;
        `;

        const curState = getState();

        div.innerHTML = `
            <div id="af-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; cursor: move; border-bottom: 1px solid #333; padding-bottom: 6px;">
                <div style="font-weight: bold; color: #5865f2; display: flex; align-items: center; gap: 6px;">
                    <span>🧩 Full-Auto Farmer v1.1.0</span>
                </div>
                <button id="af-toggle" style="background: none; border: none; color: #888; font-size: 11px; cursor: pointer;">[Скрыть]</button>
            </div>
            <div id="af-body">
                <div id="af-engine-badge" style="margin-bottom: 8px; padding: 4px 6px; background: #161720; border-radius: 6px; font-size: 11px; text-align: center; color: #aaa; border: 1px solid #2a2b38;">
                    ⏳ Связь с игрой: ожидание...
                </div>
                <div style="margin-bottom: 8px;">
                    <label style="display:block; font-size:11px; color:#aaa; margin-bottom:3px;">Сложность:</label>
                    <select id="af-diff" style="width: 100%; background: #252630; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 5px;">
                        <option value="2">🔴 Сложная (до 500s ➔ 1400 XP)</option>
                        <option value="1">🟡 Средняя (до 300s ➔ 800 XP)</option>
                        <option value="0">🟢 Легкая (до 80s ➔ 300 XP)</option>
                    </select>
                </div>
                <div style="margin-bottom: 8px;">
                    <label style="display:block; font-size:11px; color:#aaa; margin-bottom:3px;">Сколько игр собрать:</label>
                    <input id="af-count" type="number" value="${curState.totalGames}" min="1" max="99" style="width: 95%; background: #252630; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 5px;">
                </div>
                <div style="margin-bottom: 8px;">
                    <label style="display:block; font-size:11px; color:#aaa; margin-bottom:3px;">Случайная выдержка перед сборкой (сек):</label>
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <input id="af-min" type="number" value="${curState.minTime}" style="width: 45%; background: #252630; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 5px; text-align: center;">
                        <span style="color: #888;">—</span>
                        <input id="af-max" type="number" value="${curState.maxTime}" style="width: 45%; background: #252630; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 5px; text-align: center;">
                    </div>
                </div>
                <div style="margin-bottom: 9px; padding: 6px; background: #20212b; border-radius: 6px;">
                    <div style="margin-bottom: 5px;">
                        <label style="display:block; font-size:11px; color:#aaa; margin-bottom:2px;">Пауза до выбора сложности (сек):</label>
                        <input id="af-diff-wait" type="number" value="${curState.diffWaitSec || 10}" min="0" max="60" style="width: 95%; background: #252630; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 4px;">
                    </div>
                    <div style="margin-bottom: 5px;">
                        <label style="display:block; font-size:11px; color:#aaa; margin-bottom:2px;">Пауза на прогрузку стола (сек):</label>
                        <input id="af-board-wait" type="number" value="${curState.boardWaitSec || 10}" min="0" max="60" style="width: 95%; background: #252630; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 4px;">
                    </div>
                    <div>
                        <label style="display:block; font-size:11px; color:#aaa; margin-bottom:2px;">Пауза перед выходом (сек):</label>
                        <input id="af-exit-wait" type="number" value="${curState.exitWaitSec || 7}" min="1" max="60" style="width: 95%; background: #252630; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 4px;">
                    </div>
                </div>
                <div style="margin-bottom: 9px; padding: 7px 8px; background: #191b26; border: 1px solid #323652; border-radius: 6px;">
                    <div style="font-size: 11px; font-weight: bold; color: #ffca28; margin-bottom: 5px;">🎁 Ежедневные задачи и Розыгрыши</div>
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #ccc; cursor: pointer; margin-bottom: 6px;">
                        <input id="af-auto-daily" type="checkbox" ${curState.autoDailyBeforeFarm !== false ? 'checked' : ''} style="cursor: pointer;">
                        <span>Выполнять автоматически перед фармом</span>
                    </label>
                    <div style="margin-bottom: 6px;">
                        <input id="af-gemini-key" type="password" placeholder="Gemini API Key (опционально для авто-капчи)" value="${curState.geminiApiKey || ''}" style="width: 95%; background: #252630; color: #fff; border: 1px solid #444; border-radius: 5px; padding: 4px 6px; font-size: 11px;">
                    </div>
                    <button id="af-daily-btn" style="width: 100%; padding: 6px; border: none; border-radius: 5px; font-weight: bold; font-size: 11px; cursor: pointer; background: ${curState.dailyTasksActive ? '#ff9800' : '#7c4dff'}; color: #fff;">
                        ${curState.dailyTasksActive ? '⏳ Выполняем задачи/розыгрыши...' : '🎁 Собрать задачи и вступить в розыгрыши'}
                    </button>
                </div>
                <div id="af-status" style="margin-bottom: 10px; padding: 8px; background: #0c0d12; border-radius: 6px; color: #00e676; font-size: 11px; text-align: center; border: 1px solid #222; min-height: 28px; display: flex; align-items: center; justify-content: center;">
                    ${curState.status}
                </div>
                <div style="display: flex; gap: 8px;">
                    <button id="af-action-btn" style="flex: 1; padding: 8px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; background: ${curState.active ? '#ff4b4b' : '#00c853'}; color: #fff;">
                        ${curState.active ? '⏸ Стоп' : '▶ Старт'}
                    </button>
                    <button id="af-solve-btn" style="flex: 1; padding: 8px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; background: #2979ff; color: #fff;">
                        ⚡ Собрать
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(div);

        makeDraggable(div, div.querySelector('#af-header'));

        const diffEl = div.querySelector('#af-diff');
        const countEl = div.querySelector('#af-count');
        const minEl = div.querySelector('#af-min');
        const maxEl = div.querySelector('#af-max');
        const diffWaitEl = div.querySelector('#af-diff-wait');
        const boardWaitEl = div.querySelector('#af-board-wait');
        const exitWaitEl = div.querySelector('#af-exit-wait');
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

        const bindInput = (el, prop, fallback) => {
            ['input', 'change'].forEach(ev => {
                el.addEventListener(ev, () => {
                    const st = getState();
                    st[prop] = parseInt(el.value) || fallback;
                    saveState(st);
                });
            });
        };
        bindInput(countEl, 'totalGames', 1);
        bindInput(minEl, 'minTime', 240);
        bindInput(maxEl, 'maxTime', 260);
        bindInput(diffWaitEl, 'diffWaitSec', 10);
        bindInput(boardWaitEl, 'boardWaitSec', 10);
        bindInput(exitWaitEl, 'exitWaitSec', 7);

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
            st.dailyTasksActive = !st.dailyTasksActive;
            if (st.dailyTasksActive) {
                st.dailyTasksDoneInSession = false;
                st.status = '🎁 Запуск сбора ежедневных заданий и розыгрышей...';
            } else {
                st.status = 'Сбор ежедневных заданий остановлен.';
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
                st.status = 'Автофарм запущен!';
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

            // Если игрок нажимает "Собрать" вручную слишком рано на Сложной сложности,
            // предупреждаем, что сервер может выдать "Ошибка" и 0 XP из-за античита по времени!
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
                toggleBtn.innerText = '[Скрыть]';
            } else {
                bodyEl.style.display = 'none';
                toggleBtn.innerText = '[Развернуть]';
            }
        });
    }

    function updateUI(state) {
        createUI();
        const statusEl = document.getElementById('af-status');
        if (statusEl) statusEl.innerText = state.status;

        const actionBtn = document.getElementById('af-action-btn');
        if (actionBtn) {
            actionBtn.innerText = state.active ? '⏸ Стоп' : '▶ Старт';
            actionBtn.style.background = state.active ? '#ff4b4b' : '#00c853';
        }

        const dailyBtn = document.getElementById('af-daily-btn');
        if (dailyBtn) {
            dailyBtn.innerText = state.dailyTasksActive ? '⏳ Выполняем задачи/розыгрыши...' : '🎁 Собрать задачи и вступить в розыгрыши';
            dailyBtn.style.background = state.dailyTasksActive ? '#ff9800' : '#7c4dff';
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
                badgeEl.style.color = '#00e676';
                badgeEl.style.borderColor = '#00e676';
            } else if (p) {
                badgeEl.style.color = '#ffeb3b';
                badgeEl.style.borderColor = '#ffeb3b';
            } else {
                badgeEl.style.color = '#888';
                badgeEl.style.borderColor = '#444';
            }
            badgeEl.innerText = screenNames[screenState] || '⏳ Ожидание...';
        }
    }

    window.addEventListener('DOMContentLoaded', createUI);
    if (document.body) createUI();

})();
