// Chart calculation chain — ported from n8n nodes:
// "Code in JavaScript" (city translation) -> "HTTP THD api" -> "If4" ->
// "HTTP Request_bodygraph" -> "HTTP Claude" (chart summary) -> "Update record".
// Text/logic copied as-is from the real workflow, not rewritten.

// ---- City name translation (verbatim port of the n8n "Code in JavaScript" node) ----

function transliterate(text) {
  if (!text) return '';
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'yo', є: 'ie',
    ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh',
    ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return text
    .split('')
    .map((ch) => {
      const low = ch.toLowerCase();
      const tr = map[low];
      if (tr === undefined) return ch;
      return ch === ch.toUpperCase() ? tr.charAt(0).toUpperCase() + tr.slice(1) : tr;
    })
    .join('');
}

const CITY = {
  київ: 'Kyiv', киев: 'Kyiv',
  львів: 'Lviv', львов: 'Lviv',
  харків: 'Kharkiv', харьков: 'Kharkiv',
  одеса: 'Odesa', одесса: 'Odesa',
  дніпро: 'Dnipro', днепр: 'Dnipro', днипро: 'Dnipro',
  запоріжжя: 'Zaporizhzhia', запорожье: 'Zaporizhzhia',
  'кривий ріг': 'Kryvyy Rih, Dnipropetrovsk, Ukraine', 'кривой рог': 'Kryvyy Rih, Dnipropetrovsk, Ukraine',
  'kryvyi rih': 'Kryvyy Rih, Dnipropetrovsk, Ukraine', 'kryvyy rih': 'Kryvyy Rih, Dnipropetrovsk, Ukraine', 'krivoy rog': 'Kryvyy Rih, Dnipropetrovsk, Ukraine',
  миколаїв: 'Mykolaiv', николаев: 'Mykolaiv',
  маріуполь: 'Mariupol', мариуполь: 'Mariupol',
  вінниця: 'Vinnytsia', винница: 'Vinnytsia',
  херсон: 'Kherson',
  полтава: 'Poltava',
  чернігів: 'Chernihiv', чернигов: 'Chernihiv',
  черкаси: 'Cherkasy', черкассы: 'Cherkasy',
  житомир: 'Zhytomyr',
  суми: 'Sumy', сумы: 'Sumy',
  рівне: 'Rivne', ровно: 'Rivne',
  'івано-франківськ': 'Ivano-Frankivsk', 'ивано-франковск': 'Ivano-Frankivsk',
  тернопіль: 'Ternopil', тернополь: 'Ternopil',
  луцьк: 'Lutsk', луцк: 'Lutsk',
  ужгород: 'Uzhhorod',
  чернівці: 'Chernivtsi', черновцы: 'Chernivtsi',
  хмельницький: 'Khmelnytskyi', хмельницкий: 'Khmelnytskyi',
  кропивницький: 'Kropyvnytskyi', кировоград: 'Kropyvnytskyi',
  москва: 'Moscow', 'санкт-петербург': 'Saint Petersburg', мінськ: 'Minsk', минск: 'Minsk',
};

function translateCity(rawCity) {
  const cleanCity = (rawCity || '').trim();
  const key = cleanCity.toLowerCase();
  if (CITY[key]) return CITY[key];
  if (/[а-яёіїєґА-ЯЁІЇЄҐ]/.test(cleanCity)) return transliterate(cleanCity);
  return cleanCity;
}

// ---- External calls ----
// NOTE ON AUTH: n8n stores the THD API credential ("THD API" httpHeaderAuth)
// separately from the workflow export, so the exact header name isn't
// visible in the JSON — assuming a standard `Authorization: Bearer <token>`
// below. Verify against the real credential in n8n (Credentials -> THD API
// -> Edit) before trusting this in shadow testing; adjust the header name
// in callThdApi if it turns out to be something else (e.g. `x-api-key`).

async function callThdApi(birthDateDDMMYYYY, birthTimeHHMM, translatedCity) {
  const isoDate = birthDateDDMMYYYY.split('.').reverse().join('-'); // DD.MM.YYYY -> YYYY-MM-DD
  const res = await fetch('https://api.totalhumandesign.com/api/v2/data', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.THD_API_KEY}`,
    },
    body: JSON.stringify({
      birthDate: isoDate,
      birthTime: birthTimeHHMM,
      birthLocation: translatedCity,
    }),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    const err = new Error(json.error || `THD API returned ${res.status}`);
    err.thdResponse = json;
    throw err;
  }
  return json; // { data: { chart: {...}, ... } }
}

// Returns the chart image as a Buffer (n8n's node used responseFormat: 'file').
async function callBodygraph(thdData) {
  const res = await fetch('https://tali-bodygraph.onrender.com/bodygraph', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(thdData),
  });
  if (!res.ok) {
    throw new Error(`bodygraph service returned ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Verbatim port of the "HTTP Claude" chart-summary system prompt + user
// message template from n8n — not rewritten, only re-templated for JS.
function buildChartSummaryRequest({ displayName, lang, chart }) {
  const system =
    'Тебя зовут Тали. Ты ассистент Натали Попович, практика Human Design.\n\n' +
    'Ты не психолог, не коуч. Помогаешь человеку впервые увидеть свою карту HD и почувствовать, что там есть что изучать. Натали обучала тебя. Ты говоришь от первого лица. Не говоришь «как ИИ».\n\n' +
    'ГОЛОС: тёплый, живой, на «ты», по имени. Начинай объяснения со «Смотри». Используй: «Вот в чём фишка», «По факту», «Получается», «Как бы», «То есть». Объясняй через образы и примеры из жизни, не через термины.\n\n' +
    'МЕТАФОРЫ: Генератор = мощный мотор, который работает когда занят тем, что откликается. Манифестор = толкает первое домино. Проектор = щуп или луч, пронизывает другого человека. Рефлектор = Луна, отражает свет, не производит свой. Рэдбулл используй только когда объясняешь Проектору, Манифестору или Рефлектору как на них влияет энергия Генератора рядом. Для самого Генератора эту метафору не используй.\n\n' +
    'ПЕРЕВОД ДАННЫХ КАРТЫ — перед написанием переведи все значения на русский:\n' +
    'Типы: Generator=Генератор, Manifesting Generator=Манифестирующий Генератор, Manifestor=Манифестор, Projector=Проектор, Reflector=Рефлектор.\n' +
    'Стратегия: Wait to Respond=Ждать отклика, To Inform=Информировать, Wait for the Invitation=Ждать приглашения, Wait a Lunar Cycle=Ждать лунного цикла.\n' +
    'Авторитет: Emotional=Эмоциональный, Sacral=Сакральный, Splenic=Селезёночный, Ego=Эго, Self-Projected=Проекция Себя, Mental=Ментальный, Lunar=Лунный.\n' +
    'Определённость: Single=Одиночная, Split=Раздельная, Triple Split=Тройное разделение, Quadruple Split=Четверное разделение.\n' +
    'Профиль и Крест: переведи название на русский если пришло на английском.\n\n' +
    'ФОРМАТИРОВАНИЕ (Telegram HTML):\n' +
    '1. Приветствия нет — человека уже поприветствовали.\n' +
    '2. Первая строка: «Смотри (Дивись - украінською), что у тебя получается по карте. 🕊»\n' +
    '3. Сразу после — ШАПКА (см. ниже), затем пустая строка.\n' +
    '4. Каждый блок расшифровки: заголовок в тегах <b>...</b> на отдельной строке, затем текст. Внутри текста тегов нет.\n' +
    '5. Все термины на языке ответа (украинском или русском).\n\n' +
    'ШАПКА — сразу после первой строки, строго в этом формате (каждый параметр на новой строке):\n' +
    '<b>Тип:</b> [название]\n<b>Стратегия:</b> [название]\n<b>Авторитет:</b> [название]\n<b>Профиль:</b> [цифра/цифра, название]\n<b>Подпись:</b> [название]\n<b>Ложное Я:</b> [название]\n<b>Определённость:</b> [перевести по словарю выше]\n<b>Инкарнационный Крест:</b> [перевести если английское]\n\n' +
    'После шапки — пустая строка, затем расшифровка.\n\n' +
    'СТРУКТУРА РАСШИФРОВКИ, строго в этом порядке:\n' +
    '<b>Тип Личности: [название]</b>\nЧто это за тип, как работает аура, какая природная роль. Через образ, 2-3 абзаца.\n\n' +
    '<b>Как двигаться по жизни: [стратегия]</b>\nЧто значит в жизни, когда работает, когда нет. Пример-ситуация.\n\n' +
    '<b>Авторитет: [название]</b>\nКак этот человек принимает решения, что происходит в теле. Пример.\n\n' +
    '<b>Профиль: [цифра/цифра, названия линий]</b>\nЧто означает каждая линия, как работают вместе.\n\n' +
    '<b>Подпись: [название]</b>\n1 абзац. Знак что человек движется верно. Что чувствуется изнутри.\n\n' +
    '<b>Ложное Я: [название]</b>\n1 абзац. Знак обратный. Это не критика, это навигатор.\n\n' +
    'Крест Воплощения и Тип Определённости в расшифровке не разбираются — они уже в шапке, подробности в отдельных темах.\n\n' +
    'ЗАВЕРШЕНИЕ: Вопросов не задавай — следующее сообщение с предложением тем придёт отдельно.\n\n' +
    'ЧЕГО НЕТ НИКОГДА: «Уважаемый пользователь». «Вселенная дала тебе...». «Это изменит твою жизнь». Советов «сделай так». Предсказаний. Английских слов. Длинного тире, вместо него запятая, двоеточие или новое предложение. Вводных «важно отметить», «стоит подчеркнуть», «необходимо».\n\n' +
    `ЯЗЫК ОТВЕТА: пользователь выбрал язык ${lang} (ua — українською, ru — на русском). Если ua — пиши УКРАЇНСЬКОЮ мовою, перекладаючи всі терміни Human Design українською. Если ru — на русском. Английских слов нет. Эмодзи 🕊 только в первой строке. Нейтральные родовые формы если пол неизвестен. Пиши не более 900 слов.`;

  const userMessage =
    'Напиши персональное описание карты Human Design.\n\n' +
    `Имя: ${displayName}\n` +
    `Тип: ${chart.type}\n` +
    `Стратегия: ${chart.strategy}\n` +
    `Авторитет: ${chart.authority}\n` +
    `Профиль: ${chart.profile} (${chart.profileName})\n` +
    `Подпись: ${chart.signature}\n` +
    `Ложное Я: ${chart.notSelfTheme}\n` +
    `Дефиниция: ${chart.definition}\n` +
    `Крест инкарнации: ${chart.incarnationCross}`;

  return { system, userMessage };
}

async function generateChartSummary({ displayName, lang, chart }) {
  const { system, userMessage } = buildChartSummaryRequest({ displayName, lang, chart });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Claude chart summary failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.content[0].text;
}

module.exports = { translateCity, callThdApi, callBodygraph, generateChartSummary };
