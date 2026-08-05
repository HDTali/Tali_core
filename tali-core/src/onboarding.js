// Onboarding state machine — ported from the n8n "Switch" node (routes on
// profiles.state) plus the chain of Waiting Name / Waiting gender / Waiting
// Date / Waiting time / Waiting Location / Расчет карты nodes. Text and
// validation copied verbatim from the real workflow.
//
// Language selection (05.08.2026) — ported from a FRESH export
// ("ТАЛИ main (5).json", supplied by Наталия 05.08.2026) after discovering
// the older export this file was originally built from didn't have these
// nodes at all (production had moved on since that export was taken — same
// lesson as the 14.9 EUR vs 770 UAH price mismatch earlier). Real flow,
// verified against the actual nodes ("Видео приветствие", "Выбор языка",
// "Привет старт"):
//   new → video note (WELCOME_VIDEO_NOTE_FILE_ID, best-effort — see
//         sendVideoNote in telegramClient.js re: file_id being bot-scoped)
//       → waiting_language (buttons lang_ua/lang_ru, sets profile.lang)
//       → waiting_start_confirm (bilingual "пара слов" text + one button,
//         callback_data "start_onboarding" — does NOT auto-advance)
//       → waiting_name → ...rest unchanged
//
// NOT yet ported (separate follow-up, out of scope for this pass):
//  - "Язык выбран?" branch for switching language later from the menu
//    (existing subscriber, not part of first-time onboarding) — see
//    "Локализация 7" doc; only the first-time-registration path is built here.
//  - waiting_full_name / PDF-report side flow — separate from core onboarding.

const { pool } = require('./db');
const { sendMessage, sendPhotoBuffer, sendVideoNote } = require('./telegramClient');
const { translateCity, callThdApi, callBodygraph, buildChartCompact, generateChartSummary } = require('./chartCalc');

const ONBOARDING_STATES = [
  'new',
  'waiting_language',
  'waiting_start_confirm',
  'waiting_name',
  'waiting_gender',
  'waiting_date',
  'waiting_time',
  'waiting_location',
  'chart_calculating',
];

function isOnboardingState(state) {
  return !state || ONBOARDING_STATES.includes(state);
}

async function getOrCreateProfile(userId) {
  const { rows } = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
  if (rows.length > 0) return rows[0];
  const inserted = await pool.query(
    'INSERT INTO profiles (user_id) VALUES ($1) RETURNING *',
    [userId]
  );
  return inserted.rows[0];
}

async function setProfile(userId, fields) {
  const keys = Object.keys(fields);
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE profiles SET ${setClause}, updated_at = now() WHERE user_id = $1 RETURNING *`,
    [userId, ...keys.map((k) => fields[k])]
  );
  return rows[0];
}

function t(lang, ru, ua) {
  return lang === 'ua' ? ua : ru;
}

const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// Returns true if this message was handled as part of onboarding (caller
// should stop processing); false if the profile is past onboarding and the
// caller should fall through to normal chat handling.
async function handleOnboarding({ userId, chatId, profile, text, callbackData }) {
  const lang = profile.lang || 'ru';
  const state = profile.state || 'new';

  if (!isOnboardingState(state)) return false;

  // Brand new profile — first contact. Matches "Видео приветствие" →
  // "Выбор языка": video note first (best-effort — see sendVideoNote), then
  // the language screen (exact text/buttons from a real export, not
  // reworded — this screen is itself bilingual-in-one-message, shown before
  // we know the person's language).
  if (state === 'new') {
    await setProfile(userId, { state: 'waiting_language' });
    try {
      await sendVideoNote(chatId);
    } catch (videoErr) {
      console.error('sendVideoNote failed, continuing without it', videoErr);
    }
    await sendMessage(
      chatId,
      '🇺🇦 Обери, якою мовою тобі зручніше спілкуватися:\n\n' +
        'Выбери, на каком языке тебе удобнее общаться:',
      {
        buttons: [
          [{ text: '🇺🇦 Українська', callback_data: 'lang_ua' }],
          [{ text: 'Русский', callback_data: 'lang_ru' }],
        ],
      }
    );
    return true;
  }

  if (state === 'waiting_language') {
    if (callbackData !== 'lang_ua' && callbackData !== 'lang_ru') {
      // Not a button click — re-show the same bilingual prompt rather than
      // guess a language to reply in.
      await sendMessage(
        chatId,
        '🇺🇦 Обери, якою мовою тобі зручніше спілкуватися:\n\n' +
          'Выбери, на каком языке тебе удобнее общаться:',
        {
          buttons: [
            [{ text: '🇺🇦 Українська', callback_data: 'lang_ua' }],
            [{ text: 'Русский', callback_data: 'lang_ru' }],
          ],
        }
      );
      return true;
    }
    const chosenLang = callbackData === 'lang_ua' ? 'ua' : 'ru';
    await setProfile(userId, { lang: chosenLang, state: 'waiting_start_confirm' });
    // Matches "Привет старт": bilingual "пара слов" text + single button
    // (callback_data "start_onboarding") — the person must tap it, this
    // step does not auto-advance to the name question.
    await sendMessage(
      chatId,
      t(
        chosenLang,
        `Пара слов, прежде чем начнём.\n\nСо мной можно говорить двумя способами: жать кнопки тем внизу — или просто писать текстом что угодно, своими словами. После ответа по теме, если захочешь пойти глубже, ответь на мой вопрос или напиши «расскажи подробнее».\n\nТы можешь рассказать мне о своей ситуации, мыслях, которые беспокоят, о решении, в котором сомневаешься — я помогу разобраться, опираясь на твой Дизайн.\n\nИли напиши свой вопрос.\nНапример: «расскажи про мой талант», «как мне лучше проявляться», «почему я так устаю от людей».\n\nНа старте у тебя есть 5 бесплатных вопросов — на пробу обоих способов.\n\nА теперь давай знакомиться.`,
        `Кілька слів, перш ніж почнемо.\n\nЗі мною можна спілкуватися двома способами: тиснути кнопки тем унизу — або просто писати текстом що завгодно, своїми словами. Після відповіді за темою, якщо захочеш піти глибше, дай відповідь на моє запитання або напиши «розкажи детальніше».\n\nТи можеш розповісти мені про свою ситуацію, думки, які турбують, про рішення, у якому сумніваєшся — я допоможу розібратися, спираючись на твій Дизайн.\n\nАбо напиши своє запитання.\nНаприклад: «розкажи про мій талант», «як мені краще проявлятися», «чому я так втомлююся від людей».\n\nНа старті в тебе є 5 безкоштовних запитань — спробувати обидва способи.\n\nА тепер давай знайомитися.`
      ),
      {
        buttons: [
          [{ text: t(chosenLang, 'Привет, давай начнем', 'Привіт, давай почнемо'), callback_data: 'start_onboarding' }],
        ],
      }
    );
    return true;
  }

  if (state === 'waiting_start_confirm') {
    if (callbackData !== 'start_onboarding') {
      // Nudge toward the button rather than silently ignore free text here.
      await sendMessage(
        chatId,
        t(lang, `Нажми на кнопку выше, чтобы начать 🕊`, `Натисни кнопку вище, щоб почати 🕊`)
      );
      return true;
    }
    await setProfile(userId, { state: 'waiting_name' });
    await sendMessage(
      chatId,
      t(
        lang,
        `Рада знакомству.\nКак мне к тебе обращаться? 🕊\n\nНапиши имя.`,
        `Рада знайомству.\nЯк мені до тебе звертатися? 🕊\n\nНапиши ім'я.`
      )
    );
    return true;
  }

  if (state === 'waiting_name') {
    await setProfile(userId, { display_name: text, state: 'waiting_gender' });
    await sendMessage(
      chatId,
      t(lang, `Отлично! Выбери свой пол:`, `Чудово! Обери свою стать:`),
      {
        buttons: [
          [{ text: t(lang, '👩 Женский', '👩 Жіноча'), callback_data: 'gender_female' }],
          [{ text: t(lang, '👨 Мужской', '👨 Чоловіча'), callback_data: 'gender_male' }],
        ],
      }
    );
    return true;
  }

  if (state === 'waiting_gender') {
    if (callbackData !== 'gender_female' && callbackData !== 'gender_male') {
      // Not a button click — re-send the prompt rather than guess.
      await sendMessage(
        chatId,
        t(lang, `Выбери свой пол кнопкой выше 🕊`, `Обери свою стать кнопкою вище 🕊`)
      );
      return true;
    }
    const gender = callbackData === 'gender_female' ? 'женский' : 'мужской';
    await setProfile(userId, { gender, state: 'waiting_date' });
    await sendMessage(
      chatId,
      t(
        lang,
        `Спасибо 🕊\n\n<b>Шаг 1 из 3 — дата рождения</b>\n\nНапиши, пожалуйста, свою дату рождения.\n\nФормат: ДД.ММ.ГГГГ\nНапример: 09.02.1988`,
        `Дякую 🕊\n\n<b>Крок 1 з 3 — дата народження</b>\n\nНапиши, будь ласка, свою дату народження.\n\nФормат: ДД.ММ.РРРР\nНаприклад: 09.02.1988`
      )
    );
    return true;
  }

  if (state === 'waiting_date') {
    if (!DATE_RE.test(text || '')) {
      await sendMessage(
        chatId,
        t(
          lang,
          `Хм, кажется, я не поняла формат 🕊\n\nПопробуй ещё раз, нужно так:\n<b>ДД.ММ.ГГГГ</b>\n\nНапример: 09.02.1988`,
          `Хм, здається, я не зрозуміла формат 🕊\n\nСпробуй ще раз, потрібно так:\n<b>ДД.ММ.РРРР</b>\n\nНаприклад: 09.02.1988`
        )
      );
      return true;
    }
    await setProfile(userId, { birth_date: text, state: 'waiting_time' });
    await sendMessage(
      chatId,
      t(
        lang,
        `Спасибо 🕊\n\n<b>Шаг 2 из 3 время рождения</b>\n\nТеперь время рождения, как можно точнее.\n\nФормат: ЧЧ:ММ\nНапример: 13:50, 08:23\n\n💡 Если ты не знаешь точное время, напиши примерное или 12:00. Карта будет менее точной по профилю и линиям, но мы всё равно построим её для тебя.`,
        `Дякую 🕊\n\n<b>Крок 2 з 3 — час народження</b>\n\nТепер час народження, якомога точніше.\n\nФормат: ГГ:ХХ\nНаприклад: 13:50, 08:23\n\n💡 Якщо не знаєш точний час, напиши приблизний або 12:00. Карта буде менш точною за профілем і лініями, але ми все одно побудуємо її для тебе.`
      )
    );
    return true;
  }

  if (state === 'waiting_time') {
    if (!TIME_RE.test(text || '')) {
      await sendMessage(
        chatId,
        t(
          lang,
          `Не получилось распознать время 🕊\n\nПопробуй ещё раз, формат <b>ЧЧ:ММ</b>\n\nНапример: 08:50 или 23:15`,
          `Не вдалося розпізнати час 🕊\n\nСпробуй ще раз, формат <b>ГГ:ХХ</b>\n\nНаприклад: 08:50 або 23:15`
        )
      );
      return true;
    }
    await setProfile(userId, { birth_time: text, state: 'waiting_location' });
    await sendMessage(
      chatId,
      t(
        lang,
        `Спасибо 🕊\n\n<b>Шаг 3 из 3  место рождения</b>\n\nПоследний шаг название города, где ты родился(ась).\n\nЕсли это маленький город — напиши ближайший областной центр.\nМожно по-русски или по-английски.\n\nНапример: Херсон, Kyiv, New York`,
        `Дякую 🕊\n\n<b>Крок 3 з 3 — місце народження</b>\n\nОстанній крок — назва міста, де ти народився(лася).\n\nЯкщо це маленьке місто — напиши найближчий обласний центр.\nМожна українською, російською або англійською.\n\nНаприклад: Київ, Kharkiv, New York`
      )
    );
    return true;
  }

  if (state === 'waiting_location') {
    await setProfile(userId, { birth_location: text, state: 'chart_calculating' });
    await sendMessage(
      chatId,
      t(
        lang,
        `Спасибо 🕊\n\nСмотри, сейчас происходит кое-что интересное 🕊\n\nЯ рассчитываю положения планет в момент твоего рождения и за 88 дней до него.\n\nПервое - это твоя личность, то, что ты осознаёшь в себе.\nВторое - это твоё тело, подсознательное, то, что в тебе уже есть, но ты, возможно, ещё не называла это словами.\n\nЭто может занять 1-3 минуты 🌿`,
        `Дякую 🕊\n\nДивись, зараз відбувається дещо цікаве 🕊\n\nЯ розраховую положення планет у момент твого народження і за 88 днів до нього.\n\nПерше — це твоя особистість, те, що ти усвідомлюєш про себе.\nДруге — це твоє тіло, підсвідоме, те, що в тобі вже є, але ти, можливо, ще не називав(ла) це словами.\n\nЦе може зайняти 1–3 хвилини 🌿`
      )
    );
    await runChartCalculation({ userId, chatId, profile: { ...profile, birth_location: text }, lang });
    return true;
  }

  // chart_calculating: a message arriving mid-calculation (shouldn't
  // normally happen since we await the whole chain) — just acknowledge.
  if (state === 'chart_calculating') {
    await sendMessage(
      chatId,
      t(lang, `Секунду, ещё считаю твою карту 🕊`, `Секунду, ще рахую твою карту 🕊`)
    );
    return true;
  }

  return false;
}

async function runChartCalculation({ userId, chatId, profile, lang }) {
  const errorText = t(
    lang,
    `Что-то пошло не так с моей стороны 🕊\n\nПопробуй чуть позже — или выбери в Меню /start, чтобы вернуться к своей карте.\n\nЕсли проблема повторяется — напиши напрямую:\n@natalia_popovych`,
    `Щось пішло не так з мого боку 🕊\n\nСпробуй трохи пізніше — або обери в Меню /start, щоб повернутися до своєї карти.\n\nЯкщо проблема повторюється — напиши напряму:\n@natalia_popovych`
  );
  const cityErrorText = t(
    lang,
    `К сожалению, я не смогла найти этот населённый пункт в международной базе данных. 😔 Если это небольшой город или посёлок — напиши, пожалуйста, ближайший крупный город или областной центр. Можно вводить по-русски или по-английски. Например: Лондон, Lviv, New York`,
    `На жаль, я не змогла знайти цей населений пункт у міжнародній базі даних. 😔 Якщо це невелике місто чи селище — напиши, будь ласка, найближче велике місто або обласний центр. Можна вводити українською, російською або англійською. Наприклад: Лондон, Lviv, New York`
  );

  try {
    const translatedCity = translateCity(profile.birth_location);
    const thd = await callThdApi(profile.birth_date, profile.birth_time, translatedCity);

    if (thd.error) {
      // Matches n8n's "Error city" branch: revert to waiting_location so
      // the person can retype a bigger/nearby city.
      await setProfile(userId, { state: 'waiting_location' });
      await sendMessage(chatId, cityErrorText);
      return;
    }

    const chart = thd.data.chart;

    let photoBuffer = null;
    try {
      photoBuffer = await callBodygraph(thd.data);
    } catch (bgErr) {
      console.error('bodygraph render failed, continuing without image', bgErr);
    }
    if (photoBuffer) {
      // Matches n8n's "Send a photo message" node: sent right after the
      // bodygraph render, no caption, before the Claude text summary below.
      try {
        await sendPhotoBuffer(chatId, photoBuffer);
      } catch (photoErr) {
        console.error('sendPhotoBuffer failed, continuing without image', photoErr);
      }
    }

    await sendMessage(
      chatId,
      t(lang, `🕊 Пишу расшифровку твоей карты...\n\nЭто займёт около минуты — уже работаю ✨`, `🕊 Пишу розшифровку твоєї карти...\n\nЦе займе близько хвилини — вже працюю ✨`)
    );

    const chartSummary = await generateChartSummary({
      displayName: profile.display_name,
      lang,
      chart,
    });

    await setProfile(userId, {
      state: 'chart_ready',
      chart_data: JSON.stringify(chart),
      chart_compact: JSON.stringify(buildChartCompact(thd.data)),
      memory_summary: profile.memory_summary,
    });

    await sendMessage(chatId, chartSummary);
  } catch (err) {
    console.error('chart calculation failed', err);
    await sendMessage(chatId, errorText);
  }
}

module.exports = { getOrCreateProfile, isOnboardingState, handleOnboarding };
