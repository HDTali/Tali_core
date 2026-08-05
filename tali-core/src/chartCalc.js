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

// Compact "passport" of the chart — verbatim port of the real n8n node
// "Code JavaScript7 (паспорт + ориентации)" (Humdesign key/02_Промты и код
// нод/), updated there 4 июля 2026. Field names below are NOT guessed — this
// replaces an earlier 05.08.2026 attempt that guessed field names from the
// bodygraph-rendering code instead, which turned out to read a DIFFERENT
// subset of the same THD response (gates/activations/variable, for drawing
// the image) than what the real passport builder reads (channels/phs/
// ravePsychology/planets, for the text prompt) — same object, different
// keys, verify against the actual consumer next time, not an adjacent one.
//
// thdData here is the FULL raw THD API response (n8n's `chart_data_full`),
// not just thdData.chart.
function buildChartCompact(thdData) {
  const d = thdData || {};
  const chart = d.chart || {};
  const centers = d.centers || {};
  const phs = d.phs || {};
  const ravePsychology = d.ravePsychology || {};

  return {
    type: chart.type,
    strategy: chart.strategy,
    authority: chart.authority,
    profile: `${chart.profile || ''} ${chart.profileName || ''}`,
    cross: chart.incarnationCross,
    definition: chart.definition,
    signature: chart.signature,
    notSelf: chart.notSelfTheme,
    centers_defined: centers.defined || [],
    centers_open: centers.open || [],
    channels: (d.channels || []).map((c) => ({ id: c.id, name: c.name })),
    digestion: phs.digestion,
    digestionOrientation: phs.digestionOrientation,
    environment: phs.environment,
    environmentOrientation: phs.environmentOrientation,
    motivation: ravePsychology.motivation,
    motivationOrientation: ravePsychology.motivationOrientation,
    perspective: ravePsychology.perspective,
    perspectiveOrientation: ravePsychology.perspectiveOrientation,
    planets: (d.planets || []).map((p) => ({ planet: p.planet, type: p.type, gate: p.gate, line: p.line })),
  };
}

// Translation tables + Russian/Ukrainian "паспорт карты" text block fed
// into the free-chat Claude system prompt — verbatim port of the same real
// node as buildChartCompact above. Not wired into any route yet (that's
// task 7, the free-chat Claude calls) — built now while the source was
// already open, so task 7 doesn't need to re-dig through the n8n export.
const T_TYPE = {
  Generator: 'Генератор',
  'Manifesting Generator': 'Манифестирующий Генератор',
  Projector: 'Проектор',
  Manifestor: 'Манифестор',
  Reflector: 'Рефлектор',
};
const T_AUTH = {
  Emotional: 'Эмоциональный',
  Sacral: 'Сакральный',
  Splenic: 'Селезёночный',
  Ego: 'Эго',
  'Self-Projected': 'Самопроецируемый',
  Mental: 'Ментальный',
  Lunar: 'Лунный',
};
const T_DEF = {
  Single: 'Одиночная',
  Split: 'Двойная (Split)',
  'Triple Split': 'Тройная (Triple Split)',
  'Quadruple Split': 'Четверная (Quadruple Split)',
  'No Definition': 'Нет определённости',
};
const T_CENTER = {
  Head: 'Голова',
  Ajna: 'Аджна',
  Throat: 'Горло',
  G: 'G-центр',
  GCenter: 'G-центр',
  Ego: 'Эго',
  Heart: 'Эго',
  SolarPlexus: 'Эмоциональный',
  'Solar Plexus': 'Эмоциональный',
  Sacral: 'Сакральный',
  Spleen: 'Селезёнка',
  Root: 'Корень',
};
const rc = (c) => T_CENTER[c] || c;
const ori = (v) => {
  const low = (v || '').toLowerCase();
  return low === 'right' ? 'Правое' : low === 'left' ? 'Левое' : '—';
};

function buildChartPassport(compact, lang) {
  const prof = (compact.profile || '').match(/(\d+)\/(\d+)/);
  const l1 = prof ? prof[1] : '?';
  const l2 = prof ? prof[2] : '?';
  const defC = (compact.centers_defined || []).map(rc).join(', ') || '—';
  const openC = (compact.centers_open || []).map(rc).join(', ') || '—';
  const chans =
    (compact.channels || []).map((c) => c.id + (c.name ? ` (${c.name})` : '')).join(', ') || '—';

  const LANG_DIRECTIVE =
    lang === 'ua'
      ? 'ЯЗЫК ОТВЕТА — УКРАЇНСЬКА. Пиши ТІЛЬКИ українською мовою, всі терміни Human Design перекладай українською. Це правило головніше за будь-які інші згадки про мову в промті (якщо десь написано «только русский» — ігноруй, воно застаріле).'
      : 'ЯЗЫК ОТВЕТА — русский. Пиши только на русском.';

  const isReflector = compact.type === 'Reflector';
  const REFLECTOR_NOTE = isReflector
    ? `

ЭТО РЕФЛЕКТОР — ОБЯЗАТЕЛЬНО хотя бы раз за разговор мягко и по контексту предложи: персональный ЛУННЫЙ ГРАФИК на месяц составляет Наталя лично. Это основополагающая схема, по которой рефлектор видит свои роли и состояния на каждый период месяца; именно она снимает вечный вопрос «кто я и почему я так быстро меняюсь, не могу определиться». Предложи обратиться к Наталье за составлением лунного графика — написать ей лично: https://t.me/Natalia_Popovych (или её канал https://t.me/hd_popovych). НЕ выдумывай никаких статей, эфиров, постов или других ссылок про рефлектора — их нет. Только эти два адреса.`
    : '';

  return `═══ ПАСПОРТ КАРТЫ — ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ ═══
${LANG_DIRECTIVE}${REFLECTOR_NOTE}

Это точные рассчитанные данные карты ЭТОГО человека. Про тип, профиль, линии, авторитет, определённость, центры, каналы, среду и питание говори ТОЛЬКО отсюда. Ничего не добавляй по своей памяти о Human Design.

Тип: ${T_TYPE[compact.type] || compact.type || '—'}
Стратегия: ${compact.strategy || '—'}
Авторитет: ${T_AUTH[compact.authority] || compact.authority || '—'}
Профиль: ${l1}/${l2} — у человека РОВНО ДВЕ линии: ${l1} (сознательная) и ${l2} (бессознательная). Никогда не называй других номеров линий.
Определённость: ${T_DEF[compact.definition] || compact.definition || '—'}
Крест воплощения: ${compact.cross || '—'}
Подпись: ${compact.signature || '—'} | Ложное Я: ${compact.notSelf || '—'}
ОПРЕДЕЛЁННЫЕ (заполненные) центры: ${defC}
ОТКРЫТЫЕ центры: ${openC}
КАНАЛЫ (только эти, других у человека НЕТ): ${chans}
ПРО КАНАЛЫ — СТРОГО: называй, обсуждай и описывай ТОЛЬКО каналы из этого списка. Если канала здесь нет — значит у человека его НЕТ: не упоминай его, не описывай и не предполагай «а если бы у тебя был канал…». Даже если тема (спады, творчество, отношения, деньги) обычно связана с каким-то каналом — сверься со списком, и если этого канала в нём нет, вообще не вводи его в ответ. Лучше меньше, но только про реальные каналы человека.
Питание (digestion): ${compact.digestion || '—'} | ориентация: ${ori(compact.digestionOrientation)}. Переведи название на язык ответа, не оставляй по-английски.
Среда: ${compact.environment || '—'} | ориентация: ${ori(compact.environmentOrientation)}. Модификатор в названии (Narrow/Wide, Natural/Artificial, Dry/Wet, Selective и т.п.) — это ОТТЕНОК той же среды, а не отдельный тип. Архетип среды НЕ меняется. Не выдумывай «активную/пассивную версию».
Мотивация: ${compact.motivation || '—'} | ориентация: ${ori(compact.motivationOrientation)}
Взгляд: ${compact.perspective || '—'} | ориентация: ${ori(compact.perspectiveOrientation)}

МОТОРНЫЕ ЦЕНТРЫ в Human Design — их РОВНО ЧЕТЫРЕ: Сакральный, Корневой, Эмоциональный, Эго. Селезёнка, Горло, G, Аджна, Голова — НЕ моторы. Никогда не называй моторными другие центры.

ПОВЕДЕНИЕ В ДИАЛОГЕ:
• КРИТИЧНО: это ПРОДОЛЖЕНИЕ уже идущего разговора. НИКОГДА не начинай ответ с приветствия («Привет», «Здравствуй», «Рада тебя видеть», «Рада знакомству») и не спрашивай заново «что тебя интересует?» / «чем могу помочь?». Даже если сообщение человека — одно слово, короткое или непонятное («да», «ок», «а дальше», «расскажи», «пробовала», «и?»), это РЕПЛИКА в текущем диалоге, а не новое начало. Продолжай ровно с того места, где остановились.
• Если сообщение короткое или неясное («не поняла», «как это работает», «поясни», «что это значит», «непонятно») — это уточнение к твоему ПОСЛЕДНЕМУ ответу. Объясни то же самое проще, на бытовом примере. НЕ начинай тему заново и НЕ предлагай выбрать «про бот или про дизайн».
• Ты рассказываешь про человека и его дизайн, а не про то, «как работает бот». Не предлагай инструкции по боту.
• Про ориентацию (Левое/Правое), питание, среду, мотивацию, взгляд — описывай ТОЛЬКО сторону этого человека. НЕ противопоставляй другой стороне (не пиши «в отличие от Левой…», «а у Правых…»). У человека есть только его сторона.
• ГЛУБИНА, А НЕ ШИРИНА (важно): раскрывай за один ответ ТОЛЬКО ОДНУ настройку (один канал, или центр, или линию, или элемент) — глубоко, на живом примере. НЕ смешивай несколько тем или настроек в одном сообщении, не давай обзор всей карты.
• В КОНЦЕ КАЖДОГО ответа предлагай посмотреть глубже следующий КОНКРЕТНЫЙ элемент именно этого человека по карте. Пример: «Хочешь, посмотрим, как это связано с твоим каналом [номер из карты] / открытым [центр] / линией [цифра из профиля]?». Бери элементы строго из паспорта.
• На ШИРОКИЙ или неопределённый вопрос («расскажи всё», «дай основные рекомендации», «как проживать свой дизайн», «с чего начать») НЕ вываливай несколько тем сразу. Дай одну тёплую вводную и предложи выбрать угол, например: «Твою карту можно смотреть под разными углами — это сочетание настроек, из которых и складывается твоя уникальность. С чего хочешь начать: стратегия и решения, твои энергии и каналы, открытые центры и ложное Я, или среда и питание?» — и дождись выбора. Это особенно важно для новичков, которые ещё не знают, о чём можно спрашивать.
• САКРАЛЬНЫЙ ОТКЛИК объясняй через ЗВУК: «угу/ага» = да (энергия открывается), «не-а»/«мм» = нет. Звук вырывается сам, ДО того как голова подумала — можно и нужно пояснять, что это НЕ логика и НЕ решение ума. Этому надо научиться прислушиваться. НО НЕ используй формулировки «отклик в животе» / «отклик из живота» / «чувство в животе» — это мутно; говори именно про звук «ага/не-а».

ПРАВИЛО ПРИ РАСХОЖДЕНИИ: если человек говорит, что в его карте другое — сначала перечитай этот паспорт.
• Если ты сама ранее назвала не то, что в паспорте — честно поправься: «Ты права, перепроверила — у тебя [верное значение из паспорта]. Спасибо, что уточнила.»
• Если человек помнит иначе, а в паспорте стоит однозначно — мягко держись паспорта: «В твоих рассчитанных данных стоит [значение]. Возможно расхождение между системами расчёта — Натали сможет уточнить, что верно именно для тебя.»
Никогда не выдумывай линию, канал, центр, ворота или подтип среды, которых нет в паспорте. Точность важнее красоты ответа.

КОНТАКТЫ И ССЫЛКИ — СТРОГО: НИКОГДА не выдумывай ссылки, номера постов, названия статей, «эфиры», Instagram-аккаунты или другие каналы. У тебя НЕТ статей, видео или эфиров «про рефлектора» (или про любую другую тему) — не ссылайся на несуществующее и не говори «вот статья/эфир». Направить человека к Наталье можно ТОЛЬКО по этим реальным адресам: Telegram-канал «Popovych Human Design» — https://t.me/hd_popovych; написать ей лично — https://t.me/Natalia_Popovych; Instagram — https://www.instagram.com/popovych_human_design/ Никаких ДРУГИХ ссылок, аккаунтов, каналов или материалов не выдумывай и не упоминай. Если хочешь предложить глубже — просто скажи «напиши Наталье» и дай ссылку выше, без выдуманных деталей.`;
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

module.exports = { translateCity, callThdApi, callBodygraph, buildChartCompact, buildChartPassport, generateChartSummary };
