const { Telegraf } = require('telegraf');
const express = require('express');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// Хранилище корзин
const carts = new Map();

// Товары с вашими ценами
const products = {
    ribs: { name: '🍖 Ребра свиные', price: 3000, unit: 'кг' },
    brisket: { name: '🥩 Брискет', price: 4500, unit: 'кг' },
    pork: { name: '🐖 Свинина', price: 2500, unit: 'кг' },
    turkey: { name: '🦃 Индейка', price: 3000, unit: 'кг' }
};

// Временное хранилище для выбора веса
const waitingForWeight = new Map();

// ID администраторов (замените на свои)
const ADMIN_IDS = [1323252853]; // Добавьте через запятую, если нужно несколько

// ==================== КОМАНДЫ БОТА ====================

bot.start((ctx) => {
    ctx.reply(
        '🍖 Добро пожаловать в Molotov BBQ!\n\n' +
        '📋 Команды:\n' +
        '/menu — посмотреть меню\n' +
        '/cart — моя корзина\n' +
        '/order — оформить заказ\n' +
        '/clear — очистить корзину'
    );
});

bot.command('menu', (ctx) => {
    ctx.reply('🔥 Наше меню. Нажимай — выбирай вес и добавляй в корзину:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🍖 Ребра свиные — 3000₽/кг', callback_data: 'select_ribs' }],
                [{ text: '🥩 Брискет — 4500₽/кг', callback_data: 'select_brisket' }],
                [{ text: '🐖 Свинина — 2500₽/кг', callback_data: 'select_pork' }],
                [{ text: '🦃 Индейка — 3000₽/кг', callback_data: 'select_turkey' }],
                [{ text: '🛒 Перейти в корзину', callback_data: 'view_cart' }]
            ]
        }
    });
});

// Выбор товара
bot.action('select_ribs', (ctx) => askForWeight(ctx, 'ribs'));
bot.action('select_brisket', (ctx) => askForWeight(ctx, 'brisket'));
bot.action('select_pork', (ctx) => askForWeight(ctx, 'pork'));
bot.action('select_turkey', (ctx) => askForWeight(ctx, 'turkey'));

// Запрос веса
async function askForWeight(ctx, productId) {
    const product = products[productId];
    waitingForWeight.set(ctx.from.id, productId);

    const keyboard = {
        inline_keyboard: [
            [{ text: '🔹 300 г', callback_data: 'weight_0.3' }, { text: '🔹 500 г', callback_data: 'weight_0.5' }],
            [{ text: '🔹 700 г', callback_data: 'weight_0.7' }, { text: '🔹 1 кг', callback_data: 'weight_1.0' }],
            [{ text: '🔹 1.5 кг', callback_data: 'weight_1.5' }, { text: '🔹 2 кг', callback_data: 'weight_2.0' }],
            [{ text: '✏️ Свой вес (кратно 100 г)', callback_data: 'weight_custom' }],
            [{ text: '❌ Отмена', callback_data: 'weight_cancel' }]
        ]
    };

    await ctx.reply(
        `${product.name}\n💰 Цена: ${product.price}₽/кг\n\n⚖️ Выберите вес (от 300 г до 5 кг, кратно 100 г):`,
        { reply_markup: keyboard }
    );
}

// Обработка выбора веса из кнопок
bot.action(/weight_(\d+\.?\d*)/, async (ctx) => {
    const weight = parseFloat(ctx.match[1]);
    await addToCartWithWeight(ctx, weight);
});

// Свой вес
bot.action('weight_custom', async (ctx) => {
    await ctx.reply(
        '📝 Введите вес в килограммах.\n\n' +
        'Примеры:\n• 0.3 = 300 г\n• 0.7 = 700 г\n• 1.2 = 1 кг 200 г\n\n' +
        'Вес должен быть от 0.3 до 5 и кратен 100 г (0.1 кг)'
    );
});

// Отмена
bot.action('weight_cancel', async (ctx) => {
    waitingForWeight.delete(ctx.from.id);
    await ctx.reply('❌ Добавление товара отменено');
    await ctx.answerCbQuery();
});

// Обработка текстового ввода веса
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    if (!waitingForWeight.has(userId)) return;

    const productId = waitingForWeight.get(userId);
    const input = ctx.message.text.trim();
    let weight = parseFloat(input.replace(',', '.'));

    if (isNaN(weight)) return ctx.reply('❌ Введите число, например: 0.7');
    if (weight < 0.3) return ctx.reply('❌ Минимум 300 г (0.3 кг)');
    if (weight > 5) return ctx.reply('❌ Максимум 5 кг');

    const remainder = weight % 0.1;
    if (Math.abs(remainder) > 0.001) {
        return ctx.reply('❌ Вес должен быть кратен 100 г.\nПримеры: 0.3, 0.7, 1.2');
    }

    weight = Math.round(weight * 10) / 10;
    waitingForWeight.delete(userId);
    await addToCartWithWeight(ctx, weight, productId);
});

// Добавление в корзину
async function addToCartWithWeight(ctx, weight, productId = null) {
    let userId = ctx.from.id;
    let actualProductId = productId;

    if (!actualProductId && waitingForWeight.has(userId)) {
        actualProductId = waitingForWeight.get(userId);
        waitingForWeight.delete(userId);
    }

    if (!actualProductId) {
        return ctx.reply('❌ Ошибка. Попробуйте добавить товар заново через /menu');
    }

    const product = products[actualProductId];
    const sum = product.price * weight;

    if (!carts.has(userId)) carts.set(userId, []);
    const cart = carts.get(userId);
    const existing = cart.find(item => item.id === actualProductId);

    if (existing) {
        existing.weight += weight;
        existing.totalPrice = existing.price * existing.weight;
    } else {
        cart.push({
            id: actualProductId,
            name: product.name,
            price: product.price,
            weight: weight,
            totalPrice: sum
        });
    }

    carts.set(userId, cart);
    const weightText = weight >= 1 ? `${weight} кг` : `${weight * 1000} г`;

    await ctx.reply(`✅ ${product.name}\n⚖️ Вес: ${weightText}\n💰 Сумма: ${sum}₽\n\nТовар добавлен в корзину!`);
    await ctx.answerCbQuery();
}

// Показать корзину
async function showCart(ctx) {
    const userId = ctx.from.id;
    const cart = carts.get(userId) || [];

    if (cart.length === 0) {
        return ctx.reply('🛒 Корзина пуста. Добавьте что-нибудь через /menu');
    }

    let total = 0;
    let text = '🛒 ВАША КОРЗИНА:\n\n';

    cart.forEach((item, index) => {
        const weightText = item.weight >= 1 ? `${item.weight} кг` : `${item.weight * 1000} г`;
        total += item.totalPrice;
        text += `${item.name}\n`;
        text += `   ⚖️ Вес: ${weightText}\n`;
        text += `   💰 ${item.price}₽/кг = ${item.totalPrice}₽\n`;
        text += `   🗑️ /del_${index}\n\n`;
    });

    text += `\n💰 ИТОГО: ${total} ₽`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '📦 Оформить заказ', callback_data: 'checkout' }],
            [{ text: '🗑 Очистить корзину', callback_data: 'clear_cart' }]
        ]
    };

    await ctx.reply(text, { reply_markup: keyboard });
}

bot.action('view_cart', (ctx) => showCart(ctx));
bot.command('cart', (ctx) => showCart(ctx));

// Удаление товара
bot.command(/del_(\d+)/, (ctx) => {
    const userId = ctx.from.id;
    const index = parseInt(ctx.match[1]);
    const cart = carts.get(userId);

    if (cart && cart[index]) {
        cart.splice(index, 1);
        carts.set(userId, cart);
        ctx.reply('❌ Товар удалён');
        showCart(ctx);
    } else {
        ctx.reply('❌ Товар не найден');
    }
});

// Очистка корзины
bot.action('clear_cart', (ctx) => {
    carts.delete(ctx.from.id);
    ctx.answerCbQuery('Корзина очищена');
    ctx.reply('🗑 Корзина очищена!');
});

bot.command('clear', (ctx) => {
    carts.delete(ctx.from.id);
    ctx.reply('🗑 Корзина очищена!');
});

// Оформление заказа
bot.action('checkout', (ctx) => checkout(ctx));
bot.command('order', (ctx) => checkout(ctx));

async function checkout(ctx) {
    const userId = ctx.from.id;
    const cart = carts.get(userId);

    if (!cart || cart.length === 0) {
        return ctx.reply('🛒 Корзина пуста. Добавьте товары через /menu');
    }

    let total = 0;
    let orderText = '📦 НОВЫЙ ЗАКАЗ\n\n';

    cart.forEach(item => {
        const weightText = item.weight >= 1 ? `${item.weight} кг` : `${item.weight * 1000} г`;
        total += item.totalPrice;
        orderText += `${item.name}\n`;
        orderText += `   Вес: ${weightText}\n`;
        orderText += `   Цена: ${item.price}₽/кг = ${item.totalPrice}₽\n\n`;
    });

    orderText += `💰 Итого: ${total} ₽\n`;
    orderText += `👤 Клиент: ${ctx.from.first_name}\n`;
    orderText += `🆔 ID: ${userId}\n`;
    orderText += `📛 Username: @${ctx.from.username || 'нет username'}`;

    // Отправляем всем администраторам
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.telegram.sendMessage(adminId, orderText);
        } catch (error) {
            console.error(`Ошибка отправки админу ${adminId}:`, error);
        }
    }

    carts.delete(userId);

    await ctx.reply(
        '✅ ЗАКАЗ ОТПРАВЛЕН!\n\n' +
        'Мы свяжемся с вами для подтверждения.\n\n' +
        'Спасибо, что выбрали Molotov BBQ! 🔥'
    );
}

// ==================== ВЕБ-СЕРВЕР ДЛЯ RENDER ====================

const app = express();
app.use(express.json());

// Ручка для проверки, что бот жив
app.get('/', (req, res) => {
    res.send('🔥 Molotov BBQ Bot is running!');
});

// Ручка для вебхуков Telegram
app.post('/webhook', async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.send('ok');
    } catch (error) {
        console.error('Ошибка обработки вебхука:', error);
        res.status(500).send('error');
    }
});

// Устанавливаем вебхук при запуске
const setWebhook = async () => {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (!url) {
        console.error('RENDER_EXTERNAL_URL не задан');
        return;
    }

    try {
        await bot.telegram.setWebhook(`${url}/webhook`);
        console.log(`✅ Вебхук установлен: ${url}/webhook`);
    } catch (error) {
        console.error('Ошибка установки вебхука:', error);
    }
};

// Запускаем сервер
const port = process.env.PORT || 3000;
app.listen(port, async () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    await setWebhook();
});