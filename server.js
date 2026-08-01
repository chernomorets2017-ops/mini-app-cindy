/**
 * CCD RACE — backend
 * ---------------------------------------------------------------------------
 * Реализует то, что НЕЛЬЗЯ делать в клиенте Telegram Mini App:
 *   1. Проверку подписки на канал (Bot API getChatMember)
 *   2. Реальную оплату (Bot API sendInvoice/createInvoiceLink + pre_checkout_query
 *      + successful_payment) — только backend может держать провайдер-токен
 *      и подтверждать платежи.
 *   3. WebSocket-комнаты для мультиплеера (комната с другом + матчмейкинг на 10).
 *
 * Запуск:
 *   npm init -y
 *   npm install express ws node-telegram-bot-api cors
 *   BOT_TOKEN=xxxx CHANNEL_ID=@mods_ccd node server.js
 *
 * ВАЖНО: провайдер-токен для платежей (ЮKassa) НИКОГДА не должен попадать
 * в клиентский код — здесь он подставляется только на сервере через ENV.
 * Баланс монет хранится в базе на сервере (ниже — простая in-memory реализация,
 * замените на настоящую БД — Postgres/Redis — в проде).
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || 'PUT_YOUR_BOT_TOKEN_HERE';
const CHANNEL_ID = process.env.CHANNEL_ID || '@mods_ccd';           // канал для проверки подписки
const PROVIDER_TOKEN = process.env.PROVIDER_TOKEN || '390540012:LIVE:100292'; // ЮKassa provider token
const PORT = process.env.PORT || 8080;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// "БД": в проде замените на Postgres/Redis. Это только чтобы сервер был рабочим.
// -----------------------------------------------------------------------------
const balances = new Map();   // userId -> coins
const pendingInvoices = new Map(); // payload -> { userId, coinsAmount }

function getBalance(userId) { return balances.get(userId) || 0; }
function addBalance(userId, amount) {
    const next = getBalance(userId) + amount;
    balances.set(userId, next);
    return next;
}

// -----------------------------------------------------------------------------
// Проверка initData от Telegram Mini App (HMAC-SHA256 по секрету бота).
// Обязательна, иначе кто угодно сможет слать чужой userId и красть баланс.
// -----------------------------------------------------------------------------
function verifyInitData(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const dataCheckArr = [];
        for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            dataCheckArr.push(`${key}=${value}`);
        }
        const dataCheckString = dataCheckArr.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return null;
        const userJson = params.get('user');
        return userJson ? JSON.parse(userJson) : null;
    } catch (e) {
        console.error('initData verify failed', e);
        return null;
    }
}

// -----------------------------------------------------------------------------
// 1) ПРОВЕРКА ПОДПИСКИ — Bot API getChatMember()
// -----------------------------------------------------------------------------
app.post('/api/check-subscription', async (req, res) => {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });

    try {
        const member = await bot.getChatMember(CHANNEL_ID, user.id);
        const subscribed = ['member', 'administrator', 'creator'].includes(member.status);
        res.json({ subscribed });
    } catch (err) {
        console.error('getChatMember failed', err.message);
        // Частая причина: бот не админ канала, либо пользователь никогда не открывал бота.
        res.json({ subscribed: false });
    }
});

// -----------------------------------------------------------------------------
// 2) БАЛАНС
// -----------------------------------------------------------------------------
app.post('/api/balance', (req, res) => {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });
    res.json({ coins: getBalance(user.id) });
});

// -----------------------------------------------------------------------------
// 3) ОПЛАТА — createInvoiceLink -> openInvoice на клиенте -> pre_checkout_query
//    -> successful_payment -> начисление монет.
// -----------------------------------------------------------------------------
app.post('/api/create-invoice', async (req, res) => {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });

    const { priceRub, coinsAmount } = req.body;
    if (!priceRub || !coinsAmount) return res.status(400).json({ error: 'missing price/coins' });

    // Telegram/провайдеры (в т.ч. ЮKassa) отклоняют слишком маленькие суммы —
    // обычно порог около 100 RUB для live-провайдера. Проверяем заранее,
    // чтобы не получать невнятную ошибку из Bot API.
    const MIN_PRICE_RUB = 100;
    if (priceRub < MIN_PRICE_RUB) {
        return res.status(400).json({ error: `Минимальная сумма платежа — ${MIN_PRICE_RUB} ₽` });
    }

    const payload = `pack_${coinsAmount}_${user.id}_${Date.now()}`;
    pendingInvoices.set(payload, { userId: user.id, coinsAmount });

    try {
        const invoiceLink = await bot.createInvoiceLink(
            `${coinsAmount} Монеток CCD RACE`,
            `Покупка игровых монет для тюнинга тачки`,
            payload,
            PROVIDER_TOKEN,
            'RUB',
            [{ label: `${coinsAmount} Монет`, amount: priceRub * 100 }]
        );
        res.json({ invoiceLink });
    } catch (err) {
        console.error('createInvoiceLink failed', err.message);
        res.status(500).json({ error: 'invoice creation failed' });
    }
});

// Telegram отправляет pre_checkout_query боту перед подтверждением платежа —
// нужно ответить в течение 10 секунд, иначе платеж отменяется.
bot.on('pre_checkout_query', (query) => {
    const known = pendingInvoices.has(query.invoice_payload);
    bot.answerPreCheckoutQuery(query.id, known).catch(console.error);
});

// После реального прохождения оплаты Telegram шлет боту successful_payment —
// это единственное надежное место для начисления монет.
bot.on('message', (msg) => {
    if (!msg.successful_payment) return;
    const payload = msg.successful_payment.invoice_payload;
    const pending = pendingInvoices.get(payload);
    if (!pending) return;
    pendingInvoices.delete(payload);
    const newBalance = addBalance(pending.userId, pending.coinsAmount);
    console.log(`Начислено ${pending.coinsAmount} монет пользователю ${pending.userId}. Новый баланс: ${newBalance}`);
});

// -----------------------------------------------------------------------------
// 4) WEBSOCKET — комнаты с другом + публичный матчмейкинг на 10 игроков
// -----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const rooms = new Map();  // roomId -> { hostId, players: Map(userId -> {ws, name, car, ready}), state }
let publicQueueRoomId = null;

function makeRoomId() { return Math.floor(10000 + Math.random() * 89999).toString(); }

function broadcastRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const players = [...room.players.entries()].map(([id, p]) => ({
        id, name: p.name, car: p.car, ready: p.ready, isHost: id === room.hostId
    }));
    const msg = JSON.stringify({ type: 'room_update', roomId, hostId: room.hostId, players });
    room.players.forEach(p => { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg); });
}

function startRace(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.state = 'racing';
    room.startedAt = Date.now();
    const players = [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, car: p.car }));
    const msg = JSON.stringify({ type: 'race_start', seed: Date.now(), players });
    room.players.forEach(p => { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg); });

    // Сервер — источник истины для позиций: рассылаем состояние 10 раз/сек
    room.tickInterval = setInterval(() => {
        const positions = [...room.players.entries()].map(([id, p]) => ({ id, distance: p.distance || 0, speed: p.speed || 0 }));
        const posMsg = JSON.stringify({ type: 'positions', players: positions });
        room.players.forEach(p => { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(posMsg); });
    }, 100);
}

function finishRace(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    clearInterval(room.tickInterval);
    room.state = 'finished';
    const standings = [...room.players.entries()]
        .map(([id, p]) => ({ id, name: p.name, distance: p.distance || 0 }))
        .sort((a, b) => b.distance - a.distance)
        .map((s, i) => ({ ...s, rank: i + 1 }));
    const msg = JSON.stringify({ type: 'race_finished', standings });
    room.players.forEach(p => { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg); });
}

wss.on('connection', (ws) => {
    let currentRoomId = null;
    let currentUserId = null;
    let finishVotes = new Set();

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }

        switch (msg.type) {
            case 'create_room': {
                const roomId = makeRoomId();
                rooms.set(roomId, { hostId: msg.userId, players: new Map(), state: 'lobby' });
                rooms.get(roomId).players.set(msg.userId, { ws, name: msg.name, car: msg.car, ready: false });
                currentRoomId = roomId; currentUserId = msg.userId;
                broadcastRoom(roomId);
                break;
            }
            case 'join_room': {
                const room = rooms.get(msg.roomId);
                if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' })); return; }
                if (room.players.size >= 10) { ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' })); return; }
                room.players.set(msg.userId, { ws, name: msg.name, car: msg.car, ready: false });
                currentRoomId = msg.roomId; currentUserId = msg.userId;
                broadcastRoom(msg.roomId);
                break;
            }
            case 'join_public_queue': {
                // Простейший матчмейкинг: одна общая "публичная" комната, пока не наберется 10
                // либо не стартует по таймеру. В проде — очередь + несколько параллельных лобби.
                if (!publicQueueRoomId || !rooms.has(publicQueueRoomId) || rooms.get(publicQueueRoomId).players.size >= 10 || rooms.get(publicQueueRoomId).state !== 'lobby') {
                    publicQueueRoomId = makeRoomId();
                    rooms.set(publicQueueRoomId, { hostId: msg.userId, players: new Map(), state: 'lobby' });
                }
                const room = rooms.get(publicQueueRoomId);
                room.players.set(msg.userId, { ws, name: msg.name, car: msg.car, ready: false });
                currentRoomId = publicQueueRoomId; currentUserId = msg.userId;
                broadcastRoom(publicQueueRoomId);
                break;
            }
            case 'set_ready': {
                const room = rooms.get(currentRoomId);
                if (!room || !room.players.has(currentUserId)) return;
                room.players.get(currentUserId).ready = !!msg.ready;
                broadcastRoom(currentRoomId);
                break;
            }
            case 'force_start': {
                const room = rooms.get(currentRoomId);
                if (!room || room.hostId !== currentUserId) return;
                const allReady = room.players.size >= 2 && [...room.players.values()].every(p => p.ready);
                if (!allReady) { ws.send(JSON.stringify({ type: 'error', message: 'Не все игроки готовы' })); return; }
                startRace(currentRoomId);
                break;
            }
            case 'position_update': {
                const room = rooms.get(currentRoomId);
                if (!room || !room.players.has(currentUserId)) return;
                const p = room.players.get(currentUserId);
                p.distance = msg.distance; p.speed = msg.speed;
                break;
            }
            case 'race_finished_client': {
                const room = rooms.get(currentRoomId);
                if (!room) return;
                finishVotes.add(currentUserId);
                // когда все игроки в комнате прислали финиш — считаем гонку завершенной
                if (finishVotes.size >= room.players.size) finishRace(currentRoomId);
                break;
            }
            case 'leave_room': {
                const room = rooms.get(currentRoomId);
                if (room) {
                    room.players.delete(currentUserId);
                    if (room.players.size === 0) { clearInterval(room.tickInterval); rooms.delete(currentRoomId); }
                    else broadcastRoom(currentRoomId);
                }
                currentRoomId = null; currentUserId = null;
                break;
            }
        }
    });

    ws.on('close', () => {
        const room = rooms.get(currentRoomId);
        if (room) {
            room.players.delete(currentUserId);
            if (room.players.size === 0) { clearInterval(room.tickInterval); rooms.delete(currentRoomId); }
            else broadcastRoom(currentRoomId);
        }
    });
});

server.listen(PORT, () => console.log(`CCD RACE backend listening on :${PORT}`));
