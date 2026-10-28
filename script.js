/* =========================================================================
 * CYBER WEATHER · 赛博朋克天气终端
 * 数据源：和风天气 QWeather（浏览器直连，身份放请求头 X-QW-Api-Key）
 *
 * 文件内模块顺序：
 *   1. 配置 CONFIG / 接口拼装
 *   2. 工具函数（DOM、防抖、超时请求、localStorage）
 *   3. 天气图标码 → emoji / 文案 / 主题 映射（和风 icon 码）
 *   4. 全局状态
 *   5. 接口请求层（城市搜索、坐标反查、实况、7天、24小时）
 *   6. 渲染层（当前天气、7天、日出日落、粒子、下雨提醒）
 *   7. 事件绑定（搜索联想、键盘、定位、最近搜索）
 *   8. 启动流程
 *
 * ⚠️ 版本说明（实测，2026-10）：本项目下发的专属 host 只开放了 v7 路由，
 *    官方文档里的「新版 v1」路径（/v1/weather/now、/v1/geo/lookup）在该 host
 *    上返回 404。因此这里用 v7 + geo/v2，两者字段一致、官方现行文档中仍可用。
 *    若你的控制台开通了 v1，只需把 CONFIG.apiVer 改成 'v1'、geoVer 改成 'v1'，
 *    其余代码无需改动（唯一区别：v1 的 location 只接受「经度,纬度」）。
 * ======================================================================= */

/* ---------------------------- 1. 配置 ---------------------------- */
const CONFIG = {
  host: 'https://kh487vgag4.re.qweatherapi.com',
  key: 'ef6edfbcd9354d2ba29056eefa961a98', // 课程作业演示用 key，公开在前端仅因无后端
  apiVer: 'v7',   // 天气接口版本
  geoVer: 'v2',   // GeoAPI 版本（城市搜索 / 坐标反查）
  timeout: 9000,  // 单个请求超时时间（ms）
  // 定位失败 / 首次进入时的兜底城市
  fallbackCity: { name: '北京', adm1: '北京市', lat: '39.90499', lon: '116.40529' },
  rainThreshold: 50, // 降水概率 ≥ 50% 触发下雨提醒
  rainHours: 2,      // 只看未来 2 小时
  demoTheme: null    // 演示开关：URL 带 ?demo=rain / ?demo=snow 时强制切换主题，方便课堂展示截图
};

/** 接口 URL 拼装。location 统一使用 "经度,纬度"（v7/v1 都支持，全球通用） */
const EP = {
  search: (keyword) => `${CONFIG.host}/geo/${CONFIG.geoVer}/city/lookup?location=${encodeURIComponent(keyword)}`,
  now: (loc) => `${CONFIG.host}/${CONFIG.apiVer}/weather/now?location=${loc}`,
  daily: (loc) => `${CONFIG.host}/${CONFIG.apiVer}/weather/7d?location=${loc}`,
  hourly: (loc) => `${CONFIG.host}/${CONFIG.apiVer}/weather/24h?location=${loc}`
};

/* ---------------------------- 2. 工具函数 ---------------------------- */
const $ = (id) => document.getElementById(id);

/** 简易 DOM 缓存 */
const els = {
  input: $('city-input'),
  searchBox: $('search-box'),
  spinner: $('search-spinner'),
  suggest: $('suggest-list'),
  recent: $('recent'),
  geoBtn: $('geo-btn'),
  alert: $('alert'),
  alertText: $('alert-text'),
  alertClose: $('alert-close'),
  emoji: $('wx-emoji'),
  particles: $('particles'),
  temp: $('temp'),
  wxText: $('wx-text'),
  cityLabel: $('city-label'),
  obsTime: $('obs-time'),
  feels: $('feels'),
  humidity: $('humidity'),
  wind: $('wind'),
  precip: $('precip'),
  sunrise: $('sunrise'),
  sunset: $('sunset'),
  dayProgress: $('day-progress'),
  dayLength: $('day-length'),
  sunTrack: $('sun-track'),
  sunDot: $('sun-dot'),
  fcList: $('fc-list'),
  toast: $('toast')
};

/** 防抖：搜索输入 300ms */
function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 是否开启了「减少动效」 */
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 带超时 + 统一错误处理的请求（AbortController） */
async function request(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.timeout);
  try {
    const res = await fetch(url, {
      headers: { 'X-QW-Api-Key': CONFIG.key },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // 和风天气用 code 字段表示业务状态，"200" 才是成功
    if (data.code !== '200') throw new Error(`接口返回 code=${data.code}`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请检查网络');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Toast 提示（3 秒后自动消失） */
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}

/** localStorage 存最近搜索（最多 5 个） */
const LS_KEY = 'cyber-weather-recent';
function readRecent() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
}
function writeRecent(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* 隐私模式忽略 */ }
}
function pushRecent(city) {
  const list = readRecent().filter((c) => c.lat !== city.lat || c.lon !== city.lon);
  list.unshift(city);
  writeRecent(list.slice(0, 5));
  renderRecent();
}

/** "HH:mm" → 当天分钟数 */
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
const pad = (n) => String(n).padStart(2, '0');

/* ---------------------------- 3. 天气图标码映射 ----------------------------
 * 和风天气用 3 位 icon 码表示天气现象（见官方文档《天气现象》）。
 * 规律：1xx 晴/云、3xx 雨、4xx 雪、5xx 雾/霾/沙尘、9xx 极端体感。
 *      1xx 段的 150~154 / 350+ 等高位为「夜间」版本，视觉上沿用同一 emoji。
 * 主题：'rain' → 蓝色调、'snow' → 冷青调、'default' → 紫粉。
 * ------------------------------------------------------------------------ */
const ICON_EXACT = {
  100: { emoji: '☀️', text: '晴', theme: 'default' },
  150: { emoji: '🌙', text: '晴（夜间）', theme: 'default' },
  101: { emoji: '⛅', text: '多云', theme: 'default' },
  151: { emoji: '☁️', text: '多云（夜间）', theme: 'default' },
  102: { emoji: '🌤️', text: '少云', theme: 'default' },
  152: { emoji: '☁️', text: '少云（夜间）', theme: 'default' },
  103: { emoji: '⛅', text: '晴间多云', theme: 'default' },
  153: { emoji: '☁️', text: '晴间多云（夜间）', theme: 'default' },
  104: { emoji: '☁️', text: '阴', theme: 'default' },
  154: { emoji: '☁️', text: '阴（夜间）', theme: 'default' },

  302: { emoji: '⛈️', text: '雷阵雨', theme: 'rain' },
  303: { emoji: '⛈️', text: '强雷阵雨', theme: 'rain' },
  304: { emoji: '⛈️', text: '雷阵雨伴冰雹', theme: 'rain' },
  305: { emoji: '🌦️', text: '小雨', theme: 'rain' },
  306: { emoji: '🌧️', text: '中雨', theme: 'rain' },
  307: { emoji: '🌧️', text: '大雨', theme: 'rain' },
  309: { emoji: '🌦️', text: '毛毛雨', theme: 'rain' },
  310: { emoji: '🌧️', text: '暴雨', theme: 'rain' },
  311: { emoji: '🌧️', text: '大暴雨', theme: 'rain' },
  312: { emoji: '🌧️', text: '特大暴雨', theme: 'rain' },
  313: { emoji: '🌧️', text: '冻雨', theme: 'rain' },

  404: { emoji: '🌨️', text: '雨夹雪', theme: 'snow' },
  405: { emoji: '🌨️', text: '雨雪天气', theme: 'snow' },
  406: { emoji: '🌨️', text: '阵雨夹雪', theme: 'snow' },
  400: { emoji: '❄️', text: '小雪', theme: 'snow' },
  401: { emoji: '❄️', text: '中雪', theme: 'snow' },
  402: { emoji: '❄️', text: '大雪', theme: 'snow' },
  403: { emoji: '❄️', text: '暴雪', theme: 'snow' },
  407: { emoji: '🌨️', text: '阵雪', theme: 'snow' },

  500: { emoji: '🌫️', text: '薄雾', theme: 'default' },
  501: { emoji: '🌫️', text: '雾', theme: 'default' },
  502: { emoji: '🌫️', text: '霾', theme: 'default' },
  503: { emoji: '🌪️', text: '扬沙', theme: 'default' },
  504: { emoji: '🌪️', text: '浮尘', theme: 'default' },
  507: { emoji: '🌪️', text: '沙尘暴', theme: 'default' },
  508: { emoji: '🌪️', text: '强沙尘暴', theme: 'default' },
  900: { emoji: '🔥', text: '热', theme: 'default' },
  901: { emoji: '🥶', text: '冷', theme: 'default' },
  999: { emoji: '❓', text: '未知', theme: 'default' }
};

/**
 * 根据 icon 码得到 { emoji, text, theme }
 * 精确表命中优先，未命中按百位区间兜底，永远不会抛错。
 */
function getWeatherMeta(icon, fallbackText) {
  const code = Number(icon);
  if (ICON_EXACT[code]) {
    // 接口自带中文描述时优先用它（如“小雨-中雨”这类组合文案）
    return { ...ICON_EXACT[code], text: fallbackText || ICON_EXACT[code].text };
  }
  if (code >= 300 && code < 400) return { emoji: '🌧️', text: fallbackText || '雨', theme: 'rain' };
  if (code >= 400 && code < 500) return { emoji: '❄️', text: fallbackText || '雪', theme: 'snow' };
  if (code >= 500 && code < 600) return { emoji: '🌫️', text: fallbackText || '雾/霾', theme: 'default' };
  if (code >= 100 && code < 200) return { emoji: '⛅', text: fallbackText || '多云', theme: 'default' };
  return { emoji: '❓', text: fallbackText || '未知', theme: 'default' };
}

/* ---------------------------- 4. 全局状态 ---------------------------- */
const state = {
  city: null,        // 当前城市 { name, adm1, lat, lon }
  suggestions: [],   // 当前联想结果
  activeIndex: -1,   // 键盘高亮项
  lastDaily: []      // 最近一次的日预报，窗口 resize 时重算日出日落光点
};

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/* ---------------------------- 5. 接口请求层 ---------------------------- */

/** 城市搜索 / 坐标反查（location 传 "116.41,39.92" 即为反查） */
async function fetchCities(keyword) {
  const data = await request(EP.search(keyword));
  return (data.location || []).map((c) => ({
    name: c.name,
    adm1: c.adm1 || c.country, // 省/州，缺失时退回国家
    adm2: c.adm2 || '',
    lat: c.lat,
    lon: c.lon
  }));
}

/** 拉取一个城市的完整天气（实况 + 7天 + 24小时，并行请求） */
async function fetchWeather(city) {
  const loc = `${city.lon},${city.lat}`;
  const [now, daily, hourly] = await Promise.all([
    request(EP.now(loc)),
    request(EP.daily(loc)),
    request(EP.hourly(loc))
  ]);
  return { now: now.now || {}, daily: daily.daily || [], hourly: hourly.hourly || [] };
}

/* ---------------------------- 6. 渲染层 ---------------------------- */

/** 切换主题：只改 body 的 data-weather，颜色全靠 CSS 变量联动 */
function setTheme(theme) {
  document.body.dataset.weather = theme || 'default';
}

/** 纯 CSS 粒子：雨丝 / 雪花（不用 canvas） */
function renderParticles(theme) {
  const box = els.particles;
  box.className = 'particles';
  box.innerHTML = '';
  if (reduceMotion()) return;              // 降级：不开粒子
  if (theme !== 'rain' && theme !== 'snow') return;
  box.classList.add(theme);

  const count = theme === 'rain' ? 20 : 14;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.style.left = `${(Math.random() * 100).toFixed(2)}%`;
    s.style.animationDelay = `${(Math.random() * (theme === 'rain' ? 0.8 : 5)).toFixed(2)}s`;
    s.style.animationDuration = theme === 'rain'
      ? `${(0.6 + Math.random() * 0.5).toFixed(2)}s`
      : `${(4 + Math.random() * 3).toFixed(2)}s`;
    s.style.opacity = (0.3 + Math.random() * 0.55).toFixed(2);
    box.appendChild(s);
  }
}

/** 当前天气卡片 */
function renderCurrent(now, city) {
  const meta = getWeatherMeta(now.icon, now.text);
  els.emoji.textContent = meta.emoji;
  els.wxText.textContent = meta.text;
  els.temp.textContent = now.temp ?? '--';
  els.feels.textContent = now.feelsLike ? `${now.feelsLike}°` : '--';
  els.humidity.textContent = now.humidity ? `${now.humidity}%` : '--';
  els.wind.textContent = now.windSpeed ? `${now.windDir || ''} ${now.windSpeed}km/h` : '--';
  els.precip.textContent = now.precip != null ? `${now.precip}mm` : '--';
  els.cityLabel.textContent = `${city.name} · ${city.adm1 || ''}`;
  els.obsTime.textContent = now.obsTime ? `观测 ${now.obsTime.slice(11, 16)}` : '--';

  // 演示模式下强制使用指定主题（?demo=rain / ?demo=snow）
  const theme = CONFIG.demoTheme || meta.theme;
  setTheme(theme);
  renderParticles(theme);
  return meta;
}

/** 7 天预报 + 温度区间条形图 */
function renderForecast(daily) {
  if (!daily.length) {
    els.fcList.innerHTML = '<li class="fc-item"><span class="fc-txt">暂无预报数据</span></li>';
    return;
  }
  // 全周最高/最低，用于把每天的区间映射到同一根轴上
  const maxList = daily.map((d) => Number(d.tempMax));
  const minList = daily.map((d) => Number(d.tempMin));
  const hi = Math.max(...maxList);
  const lo = Math.min(...minList);
  const span = Math.max(1, hi - lo);

  els.fcList.innerHTML = '';
  daily.forEach((d, i) => {
    const date = new Date(d.fxDate + 'T00:00:00');
    const meta = getWeatherMeta(d.iconDay, d.textDay);
    const left = ((Number(d.tempMin) - lo) / span) * 100;
    const width = Math.max(6, ((Number(d.tempMax) - Number(d.tempMin)) / span) * 100);

    const li = document.createElement('li');
    li.className = 'fc-item';
    li.innerHTML = `
      <div class="fc-left">
        <span class="fc-day">${i === 0 ? '今天' : WEEK[date.getDay()]}</span>
        <span class="fc-date">${pad(date.getMonth() + 1)}/${pad(date.getDate())}</span>
      </div>
      <span class="fc-emoji" title="${meta.text}">${meta.emoji}</span>
      <div class="fc-mid">
        <span class="fc-txt">${meta.text}</span>
        <div class="fc-bar"><span class="fc-fill" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span></div>
      </div>
      <div class="fc-right">
        <span class="fc-min">${d.tempMin}°</span>
        <span class="fc-max">${d.tempMax}°</span>
      </div>`;
    els.fcList.appendChild(li);
  });
}

/** 日出日落轨道：按当前时间占白天时长的比例放光点 */
function renderSun(today) {
  if (!today || !today.sunrise || !today.sunset) {
    els.sunrise.textContent = '--:--';
    els.sunset.textContent = '--:--';
    els.dayProgress.textContent = '--';
    els.sunDot.hidden = true;
    return;
  }
  const up = toMinutes(today.sunrise);
  const down = toMinutes(today.sunset);
  const nowDate = new Date();
  const cur = nowDate.getHours() * 60 + nowDate.getMinutes();

  els.sunrise.textContent = today.sunrise;
  els.sunset.textContent = today.sunset;

  const total = down - up;
  const h = Math.floor(total / 60);
  els.dayLength.textContent = `白昼 ${h}h${pad(total % 60)}m`;

  // 夜间：隐藏光点，只显示状态
  if (cur < up || cur > down) {
    els.dayProgress.textContent = '夜间';
    els.sunDot.hidden = true;
    return;
  }

  const p = (cur - up) / Math.max(1, total);          // 0 = 日出，1 = 日落
  const angle = Math.PI * (1 - p);                     // π(左) → 0(右)
  els.sunDot.hidden = false;
  els.sunDot.style.left = `${(50 + 50 * Math.cos(angle)).toFixed(2)}%`;
  els.sunDot.style.top = `${(100 - 100 * Math.sin(angle)).toFixed(2)}%`;
  els.dayProgress.textContent = `${Math.round(p * 100)}%`;
}

/**
 * 下雨提醒：取未来 2 小时的逐小时降水概率 pop，
 * 只要有一小时 ≥ 阈值（默认 50%）就弹霓虹警示条，取最早的那个小时。
 */
function renderRainAlert(hourly) {
  const deadline = Date.now() + CONFIG.rainHours * 3600 * 1000;
  const hit = (hourly || [])
    .filter((h) => {
      const t = new Date(h.fxTime).getTime();
      return t >= Date.now() - 30 * 60 * 1000 && t <= deadline; // 容忍半小时的整点误差
    })
    .find((h) => Number(h.pop || 0) >= CONFIG.rainThreshold);

  if (!hit) {
    els.alert.hidden = true;
    return;
  }
  const time = new Date(hit.fxTime);
  els.alertText.textContent =
    `检测到 ${pad(time.getHours())}:${pad(time.getMinutes())} 前后有降雨（概率 ${hit.pop}%），出门带伞`;
  els.alert.hidden = false;
}

/** 演示用的下雨提醒条（真实数据没触发时才补一条，文案标注“演示模式”） */
function showDemoAlert() {
  els.alertText.textContent = '演示模式：检测到 18:00 前后有降雨（概率 80%），出门带伞';
  els.alert.hidden = false;
}

/** 加载态：7 天列表显示骨架屏 */
function renderForecastSkeleton() {
  els.fcList.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const li = document.createElement('li');
    li.className = 'fc-item';
    li.innerHTML = '<div class="skeleton" style="grid-column:1 / -1"></div>';
    els.fcList.appendChild(li);
  }
}

/** 最近搜索霓虹标签 */
function renderRecent() {
  const list = readRecent();
  els.recent.innerHTML = '';
  list.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag' + (state.city && state.city.lat === c.lat ? ' is-current' : '');
    btn.textContent = c.name;
    btn.title = `${c.name} · ${c.adm1}`;
    btn.addEventListener('click', () => selectCity(c));
    els.recent.appendChild(btn);
  });
}

/* ---------------------------- 7. 事件绑定 ---------------------------- */

/** 主流程：切换城市并拉取全部数据（失败也不留空白） */
async function selectCity(city) {
  state.city = city;
  els.input.value = city.name;
  els.input.blur();
  closeSuggest();
  renderRecent();
  renderForecastSkeleton();
  els.wxText.textContent = '加载中…';

  try {
    const data = await fetchWeather(city);
    state.lastDaily = data.daily;
    renderCurrent(data.now, city);
    renderForecast(data.daily);
    renderSun(data.daily[0]);
    renderRainAlert(data.hourly);
    if (CONFIG.demoTheme === 'rain' && els.alert.hidden) showDemoAlert();
  } catch (err) {
    // 出错时保留上一帧结构，只把文案换成错误态
    els.wxText.textContent = '数据获取失败';
    els.obsTime.textContent = err.message || 'ERROR';
    renderForecast([]);
    toast(`天气加载失败：${err.message}`);
  }
}

/** 输入联想（防抖 300ms） */
const doSearch = debounce(async () => {
  const kw = els.input.value.trim();
  if (!kw) { closeSuggest(); return; }
  els.spinner.hidden = false;
  try {
    const list = await fetchCities(kw);
    state.suggestions = list;
    state.activeIndex = -1;
    renderSuggest(list);
  } catch (err) {
    renderSuggest([], err.message);
  } finally {
    els.spinner.hidden = true;
  }
}, 300);

/** 渲染下拉；无结果时给出可点击的提示行 */
function renderSuggest(list, errMsg) {
  els.suggest.innerHTML = '';
  els.suggest.hidden = false;
  els.searchBox.setAttribute('aria-expanded', 'true');

  if (errMsg || !list.length) {
    const li = document.createElement('li');
    li.className = 's-empty';
    li.textContent = errMsg ? `搜索失败：${errMsg}` : '没有找到匹配的城市';
    els.suggest.appendChild(li);
    return;
  }
  list.forEach((c, i) => {
    const li = document.createElement('li');
    li.id = `suggest-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.innerHTML = `<span class="s-name">${c.name}</span><span class="s-adm">${c.adm1 || ''}${c.adm2 ? ' · ' + c.adm2 : ''}</span>`;
    li.addEventListener('mousedown', (e) => { // mousedown 早于 blur，避免下拉先关掉
      e.preventDefault();
      chooseSuggest(i);
    });
    els.suggest.appendChild(li);
  });
}

function closeSuggest() {
  els.suggest.hidden = true;
  els.suggest.innerHTML = '';
  els.searchBox.setAttribute('aria-expanded', 'false');
  els.input.removeAttribute('aria-activedescendant');
  state.activeIndex = -1;
}

/** 高亮某一项（键盘导航） */
function highlight(index) {
  const items = els.suggest.querySelectorAll('li[role="option"]');
  if (!items.length) return;
  state.activeIndex = (index + items.length) % items.length;
  items.forEach((li, i) => {
    const on = i === state.activeIndex;
    li.classList.toggle('active', on);
    li.setAttribute('aria-selected', String(on));
    if (on) {
      li.scrollIntoView({ block: 'nearest' });
      els.input.setAttribute('aria-activedescendant', li.id);
    }
  });
}

/** 选中某一项 → 写入最近搜索 → 加载天气 */
function chooseSuggest(index) {
  const city = state.suggestions[index];
  if (!city) return;
  pushRecent(city);
  selectCity(city);
}

/** 定位：navigator.geolocation → 坐标反查城市名 → 加载 */
function locateMe() {
  if (!navigator.geolocation) {
    toast('当前浏览器不支持定位，已回退默认城市');
    selectCity(CONFIG.fallbackCity);
    return;
  }
  els.geoBtn.classList.add('is-busy');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        // 和风 GeoAPI 传 "经度,纬度" 即为反查（最多返回 1 个最近城市）
        const list = await fetchCities(`${pos.coords.longitude.toFixed(2)},${pos.coords.latitude.toFixed(2)}`);
        if (!list.length) throw new Error('附近没有匹配的城市');
        pushRecent(list[0]);
        toast(`已定位到 ${list[0].name}`);
        await selectCity(list[0]);
      } catch (err) {
        toast(`反查城市失败：${err.message}`);
      } finally {
        els.geoBtn.classList.remove('is-busy');
      }
    },
    (err) => {
      els.geoBtn.classList.remove('is-busy');
      const denied = err && err.code === 1;
      toast(denied ? '你拒绝了定位授权，已回退到默认城市' : '定位失败，已回退到默认城市');
      selectCity(CONFIG.fallbackCity);
    },
    { timeout: 8000, maximumAge: 60000, enableHighAccuracy: false }
  );
}

/** 绑定所有交互 */
function bindEvents() {
  els.input.addEventListener('input', doSearch);

  els.input.addEventListener('keydown', (e) => {
    const open = !els.suggest.hidden;
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); highlight(state.activeIndex + 1); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlight(state.activeIndex - 1); }
    else if (e.key === 'Enter') {
      // 回车：有高亮选高亮，否则选第一项
      if (open && state.suggestions.length) {
        e.preventDefault();
        chooseSuggest(state.activeIndex >= 0 ? state.activeIndex : 0);
      }
    } else if (e.key === 'Escape') {
      closeSuggest();
    }
  });

  // 点击页面其他地方关闭下拉
  document.addEventListener('click', (e) => {
    if (!els.searchBox.contains(e.target) && !els.suggest.contains(e.target)) closeSuggest();
  });

  els.geoBtn.addEventListener('click', locateMe);

  els.alertClose.addEventListener('click', () => { els.alert.hidden = true; });

  // 日落/日出光点随窗口尺寸重算（百分比布局本就自适应，这里兜底刷新一次）
  window.addEventListener('resize', debounce(() => {
    if (state.lastDaily) renderSun(state.lastDaily[0]);
  }, 200));
}

/* ---------------------------- 8. 启动 ---------------------------- */
function boot() {
  // 一次性上电动画：0.6s 后移除遮罩
  const bootEl = $('boot');
  if (bootEl) setTimeout(() => bootEl.remove(), 700);

  // 演示开关：?demo=rain 蓝色雨天 / ?demo=snow 冷青雪天（不影响真实数据）
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo === 'rain' || demo === 'snow') CONFIG.demoTheme = demo;

  bindEvents();
  renderRecent();
  renderForecastSkeleton();

  // 优先用最近搜索的第一个城市，否则用兜底城市
  const last = readRecent()[0];
  selectCity(last || CONFIG.fallbackCity);
}

document.addEventListener('DOMContentLoaded', boot);
