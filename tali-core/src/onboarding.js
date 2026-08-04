// Onboarding state machine — ported from the n8n "Switch" node (routes on
// profiles.state) plus the chain of Waiting Name / Waiting gender / Waiting
// Date / Waiting time / Waiting Location / Расчет карты nodes. Text and
// validation copied verbatim from the real workflow.
//
// NOT yet ported (separate follow-up, out of scope for this pass):
//  - language selection buttons (Выбор языка / Язык выбран? / Update lang) —
//    `lang` defaults to 'ru' here; switching is a later step.
//  - waiting_full_name / PDF-report side flow — separate from core onboarding.
//  - the welcome video + intro text drafted in "Приветствие_и_видео_кружок.md"
//    — not wired in yet, still needs a decision on how the video note is sent.

const { pool } = require('./db');
const { sendMessage, sendPhoto } = require('./telegramClient');
const { translateCity, callThdApi, callBodygraph, generateChartSummary } = require('./chartCalc');

const ONBOARDING_STATES = [
  'new',
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

  // Brand new profile — first contact. Ask for name, matching the "Имя" node.
  if (state === 'new') {
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
      // NOTE: sendPhoto() currently expects a URL/file_id, not a raw Buffer —
      // wiring up multipart upload for the bodygraph image is a follow-up
      // (see progress notes). Not blocking chart summary generation below.
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
      chart_compact: null, // TODO(task 6): build the compact "passport" shape once bodygraph's response fields are confirmed
      memory_summary: profile.memory_summary,
    });

    await sendMessage(chatId, chartSummary);
  } catch (err) {
    console.error('chart calculation failed', err);
    await sendMessage(chatId, errorText);
  }
}

module.exports = { getOrCreateProfile, isOnboardingState, handleOnboarding };
