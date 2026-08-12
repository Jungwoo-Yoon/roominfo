/* ==================================================================
   방구석 — 앱 로직
   ================================================================== */

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------------------------- 저장소 ---------------------------- */
const STORE_KEY = 'roominfo.v1';

/** 자취 경험이 없어 리뷰를 쓸 수 없는 이용자를 위한 기본 지급량 */
const INITIAL_PASSES = 20;

const store = {
  data: { userReviews: [], likes: {}, saved: {}, passes: INITIAL_PASSES, unlocked: {} },
  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* 저장소를 못 읽어도 앱은 동작해야 합니다 */ }
    // 이전 버전 저장값에는 열람권 항목이 없으므로 채워 넣습니다.
    if (typeof this.data.passes !== 'number') this.data.passes = INITIAL_PASSES;
    if (!this.data.unlocked) this.data.unlocked = {};
  },
  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch (e) {}
  },
};
store.load();

/* ---------------------------- 상태 ---------------------------- */
const state = {
  view: 'map',          // map | detail | list | ranking | saved | myreviews | write
  roomId: null,
  query: '',
  filter: 'all',
  sort: 'recent',       // recent | rating | likes
  panelTab: 'reviews',
  verifiedOnly: true,
  zoom: 1,
  tx: 0,
  ty: 0,
};

/* ---------------------------- 분석 (GA4) ----------------------------
   gtag가 없어도(광고 차단, 오프라인, file:// 실행 등) 앱은 그대로 동작해야 하므로
   모든 전송은 이 헬퍼를 거칩니다. */
const VIEW_TITLES = {
  map: '지도', detail: '방 상세', list: '전체 목록', ranking: '평점 랭킹',
  saved: '관심 목록', write: '리뷰 쓰기', myreviews: '내가 쓴 리뷰', settings: '설정',
};

function track(name, params = {}) {
  try {
    if (typeof gtag === 'function') gtag('event', name, params);
  } catch (e) { /* 분석 실패가 사용자 경험을 막지 않도록 */ }
}

/** 방문자 중 리뷰 작성자 비율을 낼 수 있도록 사용자 속성으로 남깁니다.
    localStorage 기준이라, 저장소를 지우거나 기기를 바꾸면 다시 'no'가 됩니다. */
function syncUserProps() {
  const n = store.data.userReviews.length;
  try {
    if (typeof gtag === 'function') {
      gtag('set', 'user_properties', {
        review_writer: n > 0 ? 'yes' : 'no',
        reviews_written: String(Math.min(n, 10)),
      });
    }
  } catch (e) {}
}

/* ---- 리뷰 열람 체류 시간 ----
   탭이 백그라운드에 있는 동안은 세지 않습니다(진짜 읽은 시간만 남기기 위해).
   구간 기준은 여기서 조정하세요. */
const READ_SKIM_SEC = 5;
const READ_DEEP_SEC = 20;

let visit = null;   // { roomId, activeMs, resumedAt, helpful }

function startRoomVisit(room) {
  if (!room) return;
  visit = {
    roomId: room.id,
    activeMs: 0,
    resumedAt: document.hidden ? null : performance.now(),
    helpful: 0,
    unlocked: 0,
  };
}

function pauseRoomVisit() {
  if (!visit || visit.resumedAt == null) return;
  visit.activeMs += performance.now() - visit.resumedAt;
  visit.resumedAt = null;
}

function resumeRoomVisit() {
  if (visit && visit.resumedAt == null) visit.resumedAt = performance.now();
}

/** 방 상세를 떠날 때 얼마나 읽었는지 남깁니다. */
function endRoomVisit(exitReason) {
  if (!visit) return;
  pauseRoomVisit();

  const sec = Math.round(visit.activeMs / 1000);
  // 도움돼요를 눌렀거나 열람권을 썼다면 시간과 무관하게 정독으로 봅니다.
  const acted = visit.helpful > 0 || visit.unlocked > 0;
  const level =
    acted                 ? 'engaged' :
    sec >= READ_DEEP_SEC  ? 'read'    :
    sec >= READ_SKIM_SEC  ? 'skim'    : 'bounce';

  track('review_engagement', {
    ...roomParams(getRoom(visit.roomId)),
    engaged_seconds: sec,
    helpful_clicks: visit.helpful,
    unlocked_reviews: visit.unlocked,
    engagement_level: level,
    meaningful_read: level === 'read' || level === 'engaged',
    exit_reason: exitReason,
    transport_type: 'beacon',   // 탭을 닫는 순간에도 전송되도록
  });
  visit = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseRoomVisit();
  else resumeRoomVisit();
});
window.addEventListener('pagehide', () => endRoomVisit('leave_site'));

/** 방 관련 이벤트에 공통으로 붙이는 정보 */
function roomParams(room) {
  if (!room) return {};
  return {
    room_id: room.id,
    room_name: room.name,
    room_type: room.type,
    rating: Number(fmt(roomScore(room))) || 0,
    review_count: visibleReviews(room).length,
    rent: room.rent,
    deposit: room.deposit,
  };
}

/* ---------------------------- 데이터 헬퍼 ---------------------------- */
function allRooms() {
  return ROOMS.map(room => {
    const extra = store.data.userReviews
      .filter(r => r.roomId === room.id)
      .map(r => ({ ...r, isMine: true }));
    const reviews = [...room.reviews.map(r => ({ ...r, verified: true })), ...extra];
    return { ...room, reviews };
  });
}

function getRoom(id) { return allRooms().find(r => r.id === id); }

/** 필터(인증 여부)를 통과한 리뷰만 */
function visibleReviews(room) {
  return state.verifiedOnly ? room.reviews.filter(r => r.verified) : room.reviews;
}

function avgOf(list, pick = r => r.rating) {
  const vals = list.map(pick).filter(v => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function roomScore(room) { return avgOf(visibleReviews(room)); }

function likeCount(r) { return (r.likes || 0) + (store.data.likes[r.id] ? 1 : 0); }

/* ---------------------------- 열람권 ----------------------------
   상단 요약(항목별 평점·기본 정보·태그)은 누구나 볼 수 있고,
   거주자 리뷰 본문만 열람권 1개로 하나씩 열립니다.
   실거주 인증 리뷰를 한 번 남기면 그 뒤로는 무제한입니다. */

/** 실거주 인증 리뷰를 쓴 사람은 열람권 없이 전부 볼 수 있습니다. */
function hasUnlimited() {
  return store.data.userReviews.some(r => r.verified);
}

/** 내가 쓴 리뷰와 이미 연 리뷰는 다시 차감하지 않습니다. */
function isUnlocked(review) {
  return !!review.isMine || hasUnlimited() || !!store.data.unlocked[review.id];
}

function passesLeft() { return Math.max(0, store.data.passes); }

function fmt(n, d = 1) { return n == null ? '–' : n.toFixed(d); }

function scoreColor(v) {
  if (v == null) return '#c9c6c0';
  if (v >= 4.5) return '#8ec98f';
  if (v >= 4)   return '#d9b3f0';
  if (v >= 3)   return '#f3c470';
  return '#f08a8a';
}

function priceText(room) {
  return `보증금 ${room.deposit.toLocaleString('ko-KR')}만 / 월 ${room.rent}만`;
}

function initial(name) { return (name || '?').trim().charAt(0); }

const AVATAR_COLORS = ['#6cc3d8', '#c07ef0', '#f3c470', '#8ec98f', '#f08a8a', '#8fb8f0'];
function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** 받침 유무에 따라 조사를 붙입니다. josa('채광', '이/가') → '채광이' */
function josa(word, pair) {
  const [withJong, withoutJong] = pair.split('/');
  const code = String(word).trim().charCodeAt(String(word).trim().length - 1);
  const isHangul = code >= 0xac00 && code <= 0xd7a3;
  const hasJong = isHangul && (code - 0xac00) % 28 !== 0;
  return word + (hasJong ? withJong : withoutJong);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------- 거주 인증 배지 ---------------------------- */
const CHECK_SVG =
  `<svg viewBox="0 0 14 14" aria-hidden="true">
     <circle cx="7" cy="7" r="6.4" fill="currentColor" opacity=".2"/>
     <path d="M4.1 7.2 6 9.1 9.9 5.1" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
   </svg>`;

/**
 * 리뷰어 닉네임 옆에 붙는 인증 배지.
 * compact 모드는 우측 패널처럼 좁은 곳을 위한 아이콘 전용입니다.
 */
function verifiedBadge(verified, compact = false) {
  if (compact) {
    return verified
      ? `<span class="badge-tick" title="거주 인증" role="img" aria-label="거주 인증">${CHECK_SVG}</span>`
      : '';
  }
  return verified
    ? `<span class="badge-verified">${CHECK_SVG}거주 인증</span>`
    : `<span class="badge-verified is-off" title="거주를 인증하지 않은 리뷰예요">미인증</span>`;
}

/* ---------------------------- 별점 렌더 ---------------------------- */
function starsHTML(value, size = '') {
  const v = Math.max(0, Math.min(5, value || 0));
  const pct = (v / 5) * 100;
  return `<span class="stars ${size}" role="img" aria-label="5점 만점에 ${v}점">
      <span class="stars-off">★★★★★</span>
      <span class="stars-on" style="width:${pct}%">★★★★★</span>
    </span>`;
}

/** 0.5 단위 별점 입력기. onChange(value)를 호출합니다. */
function makeStarPicker(initialValue, onChange, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'star-picker';
  wrap.innerHTML =
    `<span class="sp-off">★★★★★</span><span class="sp-on"></span>
     <span class="sp-hit">${Array.from({ length: 10 }, (_, i) =>
       `<button type="button" data-v="${(i + 1) / 2}" aria-label="${(i + 1) / 2}점"></button>`).join('')}</span>`;

  const on = $('.sp-on', wrap);
  let value = initialValue || 0;

  const paint = v => {
    on.textContent = '★★★★★';
    on.style.width = `${(Math.max(0, Math.min(5, v)) / 5) * 100}%`;
  };
  paint(value);

  $$('.sp-hit button', wrap).forEach(btn => {
    const v = parseFloat(btn.dataset.v);
    btn.addEventListener('mouseenter', () => paint(v));
    btn.addEventListener('focus', () => paint(v));
    btn.addEventListener('click', () => {
      value = v;
      paint(value);
      onChange(value);
    });
  });
  wrap.addEventListener('mouseleave', () => paint(value));

  wrap.setValue = v => { value = v; paint(v); onChange(v); };
  wrap.getValue = () => value;
  if (opts.id) wrap.id = opts.id;
  return wrap;
}

/* ---------------------------- 지도 ---------------------------- */
const mapEl   = $('#map');
const worldEl = $('#world');
const pinsEl  = $('#pins');
const wrapEl  = $('#mapWrap');
const tipEl   = $('#mapTip');

/** 지도를 끌어서 옮긴 직후의 click은 핀 열기로 보지 않습니다. */
let mapDragged = false;

function applyTransform() {
  const { zoom, tx, ty } = state;
  worldEl.setAttribute('transform', `translate(${tx} ${ty}) scale(${zoom})`);
  // 핀은 확대해도 같은 크기를 유지합니다.
  $$('.pin', pinsEl).forEach(g => {
    const x = +g.dataset.x, y = +g.dataset.y;
    g.setAttribute('transform', `translate(${x} ${y}) scale(${1 / zoom})`);
  });
}

function zoomTo(nextZoom, cx, cy) {
  const z = Math.max(0.75, Math.min(3, nextZoom));
  if (cx == null) { cx = 500; cy = 320; }
  // 커서 아래 지점이 고정되도록 이동값을 보정
  const wx = (cx - state.tx) / state.zoom;
  const wy = (cy - state.ty) / state.zoom;
  state.zoom = z;
  state.tx = cx - wx * z;
  state.ty = cy - wy * z;
  applyTransform();
}

function clientToSvg(clientX, clientY) {
  const r = mapEl.getBoundingClientRect();
  const vbW = 1000, vbH = 640;
  // preserveAspectRatio="xMidYMid slice" 기준 환산
  const scale = Math.max(r.width / vbW, r.height / vbH);
  const offX = (r.width - vbW * scale) / 2;
  const offY = (r.height - vbH * scale) / 2;
  return {
    x: (clientX - r.left - offX) / scale,
    y: (clientY - r.top - offY) / scale,
  };
}

function matchesFilter(room) {
  const q = state.query.trim().toLowerCase();
  if (q) {
    const hay = [
      room.name, room.address, room.type, room.walk,
      ...room.reviews.flatMap(r => [r.text, ...(r.tags || [])]),
    ].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (state.filter === '원룸' || state.filter === '오피스텔') return room.type === state.filter;
  if (state.filter === 'high') return (roomScore(room) || 0) >= 4;
  return true;
}

function renderPins() {
  pinsEl.textContent = '';
  allRooms().forEach(room => {
    const score = roomScore(room);
    const color = scoreColor(score);
    const dim = !matchesFilter(room);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `pin${dim ? ' is-dim' : ''}${state.roomId === room.id ? ' is-active' : ''}`);
    g.dataset.x = room.x;
    g.dataset.y = room.y;
    g.dataset.id = room.id;
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${room.name}, 평점 ${fmt(score)}점, 리뷰 ${visibleReviews(room).length}개`);
    g.innerHTML = `
      <g class="pin-body">
        <path d="M0 6 C -13 6 -22 -3 -22 -15 C -22 -26 -13 -34 0 -34 C 13 -34 22 -26 22 -15 C 22 -3 13 6 0 6 Z"
              fill="#fff"/>
        <path d="M0 10 L -6 1 L 6 1 Z" fill="#fff"/>
        <circle cx="0" cy="-15" r="16" fill="${color}"/>
        <text class="pin-label" y="-11">${score == null ? '–' : fmt(score)}</text>
      </g>
      <text class="pin-name" y="26">${esc(room.name)}</text>`;

    g.addEventListener('click', e => {
      e.stopPropagation();
      if (mapDragged) return;
      openRoom(room.id);
    });
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRoom(room.id); }
    });
    g.addEventListener('mouseenter', () => showTip(room, g));
    g.addEventListener('mouseleave', hideTip);
    pinsEl.appendChild(g);
  });
  applyTransform();
}

function showTip(room, g) {
  const score = roomScore(room);
  const n = visibleReviews(room).length;
  tipEl.innerHTML = `
    <h4>${esc(room.name)}</h4>
    <div class="tip-meta">${esc(room.type)} · ${esc(room.walk)} · ${esc(priceText(room))}</div>
    <div class="tip-row">
      <span class="tip-score" style="color:${scoreColor(score)}">${fmt(score)}</span>
      ${starsHTML(score || 0, 's-sm')}
      <span class="tip-cnt">리뷰 ${n}</span>
    </div>`;
  tipEl.hidden = false;

  const pinRect = g.getBoundingClientRect();
  const wrapRect = wrapEl.getBoundingClientRect();
  let left = pinRect.left + pinRect.width / 2 - wrapRect.left;
  const top = pinRect.top - wrapRect.top - 8;
  left = Math.max(120, Math.min(wrapRect.width - 120, left));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}
function hideTip() { tipEl.hidden = true; }

/* 팬 & 줌
   주의: 여기서 setPointerCapture를 쓰면 안 됩니다. 포인터가 캡처되면 뒤이어 발생하는
   click 이벤트까지 캡처 대상(<svg>)으로 재지정돼서, 핀의 click 핸들러가 아예 실행되지
   않습니다. 대신 window에서 이동/뗌을 듣고, 실제로 끌었을 때만 클릭을 무시합니다. */
(function initMapInteraction() {
  let dragging = false, last = null;

  mapEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    mapDragged = false;
    last = { x: e.clientX, y: e.clientY };
    mapEl.classList.add('is-panning');
  });

  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    const r = mapEl.getBoundingClientRect();
    const scale = Math.max(r.width / 1000, r.height / 640);
    const dx = (e.clientX - last.x) / scale;
    const dy = (e.clientY - last.y) / scale;
    if (Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) > 2) mapDragged = true;
    state.tx += dx; state.ty += dy;
    last = { x: e.clientX, y: e.clientY };
    applyTransform();
    if (mapDragged) hideTip();
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    mapEl.classList.remove('is-panning');
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  mapEl.addEventListener('wheel', e => {
    e.preventDefault();
    const p = clientToSvg(e.clientX, e.clientY);
    zoomTo(state.zoom * (e.deltaY < 0 ? 1.16 : 1 / 1.16), p.x, p.y);
    hideTip();
  }, { passive: false });

  $('#zoomIn').addEventListener('click', () => zoomTo(state.zoom * 1.25));
  $('#zoomOut').addEventListener('click', () => zoomTo(state.zoom / 1.25));
  $('#zoomReset').addEventListener('click', () => {
    state.zoom = 1; state.tx = 0; state.ty = 0; applyTransform();
  });
})();

/* ---------------------------- 통계 카드 ---------------------------- */
function renderStatsCards() {
  const rooms = allRooms();
  const reviews = rooms.flatMap(visibleReviews);

  $('#statRooms').textContent = rooms.length;
  $('#statReviews').textContent = reviews.length;
  $('#distTotal').textContent = `리뷰 ${reviews.length}개`;

  // 평점 분포 (5→1 버킷)
  const buckets = [5, 4, 3, 2, 1].map(b => ({
    label: b === 1 ? '1점 이하' : `${b}점대`,
    n: reviews.filter(r => (b === 5 ? r.rating >= 5 : b === 1 ? r.rating < 2 : Math.floor(r.rating) === b)).length,
  }));
  const max = Math.max(1, ...buckets.map(b => b.n));
  $('#distChart').innerHTML = buckets.map(b => `
    <div class="dist-row">
      <span>${b.label.replace('점대', '점')}</span>
      <div class="dist-bar"><i style="width:${(b.n / max) * 100}%"></i></div>
      <b>${b.n}</b>
    </div>`).join('');

  const avg = avgOf(reviews) || 0;
  $('#distAvg').textContent = fmt(avg, 1);
  $('#distStars').innerHTML = starsHTML(avg, 's-lg');

  // 항목별 평균 (낮을수록 주의가 필요한 항목)
  const colors = ['#f3c470', '#f08a8a', '#6cc3d8', '#8ec98f', '#d9b3f0', '#8fb8f0'];
  const data = ASPECT_KEYS.map((a, i) => ({
    ...a,
    v: avgOf(reviews.filter(r => r.aspects), r => r.aspects[a.key]) || 0,
    color: colors[i],
  }));

  // 항목 간 차이가 작아서, 최저~최고 구간을 늘려 막대 높낮이를 보이게 합니다.
  const lo = Math.min(...data.map(d => d.v));
  const hi = Math.max(...data.map(d => d.v));
  const barH = v => 18 + ((v - lo) / (hi - lo || 1)) * 50;

  $('#kwChart').innerHTML = data.map(d => `
    <div class="kw-col" title="${d.label} 평균 ${fmt(d.v)}점">
      <b>${fmt(d.v)}</b>
      <i style="height:${barH(d.v)}px;background:${d.color}"></i>
      <span style="background:${d.color}">${d.label.charAt(0)}</span>
    </div>`).join('');

  const best = [...data].sort((a, b) => b.v - a.v)[0];
  const worst = [...data].sort((a, b) => a.v - b.v)[0];
  $('#kwTop').innerHTML =
    `만족도가 가장 높은 항목은 <b>${esc(best.label)} ${fmt(best.v)}점</b>, ` +
    `가장 아쉬운 항목은 <b>${esc(worst.label)} ${fmt(worst.v)}점</b>이에요.`;
  $('#kwLegend').innerHTML = data.map(d => `
    <li><i style="background:${d.color}">${d.label.charAt(0)}</i>${d.label}<em>평균 ${fmt(d.v)}점</em></li>`).join('');
}

/* ---------------------------- 우측 패널 ---------------------------- */
function renderPanel() {
  const body = $('#panelBody');
  $$('.ptab').forEach(t => t.classList.toggle('is-on', t.dataset.ptab === state.panelTab));

  if (state.panelTab === 'reviews') {
    const rooms = allRooms();
    const items = rooms
      .flatMap(room => visibleReviews(room).map(r => ({ r, room })))
      .sort((a, b) => String(b.r.date).localeCompare(String(a.r.date)))
      .slice(0, 12);

    body.innerHTML = items.map(({ r, room }) => `
      <button class="pcard" data-open="${room.id}">
        <span class="avatar" style="background:${avatarColor(r.author)}">${esc(initial(r.author))}</span>
        <span>
          <span class="pcard-top">
            <span class="pcard-name">${esc(r.author)}${verifiedBadge(r.verified, true)}</span>
            <span class="pcard-date">${esc(r.date)}</span>
          </span>
          ${isUnlocked(r)
            ? `<span class="pcard-txt">${esc(r.text)}</span>`
            : `<span class="pcard-txt is-locked">${(r.tags || []).length
                ? (r.tags || []).map(t => `#${esc(t)}`).join(' ')
                : '열람권으로 볼 수 있는 리뷰'}</span>`}
          <span class="pcard-room">${esc(room.name)} · ${fmt(r.rating)}점</span>
        </span>
        <span class="pchev"><svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>`).join('');
    return;
  }

  // 동네 정보 탭
  const rooms = allRooms();
  const reviews = rooms.flatMap(visibleReviews);
  const avg = avgOf(reviews) || 0;
  const oneroom = rooms.filter(r => r.type === '원룸');
  const officetel = rooms.filter(r => r.type === '오피스텔');
  const avgRent = Math.round(rooms.reduce((a, r) => a + r.rent, 0) / rooms.length);
  const good = rooms.filter(r => (roomScore(r) || 0) >= 4).length;
  const ratio = Math.round((good / rooms.length) * 100);

  body.innerHTML = `
    <div class="pstat">
      <h4>성균관대 캠퍼스타운</h4>
      <div class="pstat-row"><span>등록된 방</span><b>${rooms.length}곳</b></div>
      <div class="pstat-row"><span>누적 리뷰</span><b>${reviews.length}개</b></div>
      <div class="pstat-row"><span>평균 평점</span><b>${fmt(avg)} / 5.0</b></div>
      <div class="pstat-row"><span>평균 월세</span><b>${avgRent}만원</b></div>
    </div>
    <div class="pstat">
      <h4>평점 4.0 이상 비율</h4>
      <div class="pstat-row"><span>${good}곳 / ${rooms.length}곳</span><b style="color:#5fa860">${ratio}%</b></div>
      <div class="pstat-bar"><i style="width:${ratio}%;background:#8ec98f"></i></div>
    </div>
    <div class="pstat">
      <h4>매물 유형</h4>
      <div class="pstat-row"><span>원룸</span><b>${oneroom.length}곳</b></div>
      <div class="pstat-bar"><i style="width:${(oneroom.length / rooms.length) * 100}%;background:#d9b3f0"></i></div>
      <div class="pstat-row" style="border:0"><span>오피스텔</span><b>${officetel.length}곳</b></div>
      <div class="pstat-bar"><i style="width:${(officetel.length / rooms.length) * 100}%;background:#6cc3d8"></i></div>
    </div>`;
}

/* ---------------------------- 상세 화면 ---------------------------- */
function openRoom(id) {
  go(`#/room/${id}`);
}

function sortReviews(list) {
  const arr = [...list];
  if (state.sort === 'rating') arr.sort((a, b) => b.rating - a.rating);
  else if (state.sort === 'likes') arr.sort((a, b) => likeCount(b) - likeCount(a));
  else arr.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return arr;
}

function renderDetail() {
  const room = getRoom(state.roomId);
  const host = $('#view-detail');
  if (!room) { host.innerHTML = '<div class="empty"><b>방을 찾을 수 없어요</b></div>'; return; }

  const reviews = visibleReviews(room);
  const score = roomScore(room);
  const saved = !!store.data.saved[room.id];

  const aspectColors = ['#f3c470', '#f08a8a', '#6cc3d8', '#8ec98f', '#d9b3f0', '#8fb8f0'];
  const aspectAvgs = ASPECT_KEYS.map((a, i) => ({
    ...a,
    color: aspectColors[i],
    v: avgOf(reviews.filter(r => r.aspects), r => r.aspects[a.key]),
  }));
  const aspectRows = aspectAvgs.map(a => `
      <div class="aspect-row">
        <span>${a.label}</span>
        <div class="aspect-bar"><i style="width:${((a.v || 0) / 5) * 100}%;background:${a.color}"></i></div>
        <b>${fmt(a.v)}</b>
      </div>`).join('');

  const rated = aspectAvgs.filter(a => a.v != null);
  const best = rated.length ? rated.reduce((x, y) => (y.v > x.v ? y : x)) : null;
  const worst = rated.length ? rated.reduce((x, y) => (y.v < x.v ? y : x)) : null;
  const recommend = reviews.length
    ? Math.round((reviews.filter(r => r.rating >= 4).length / reviews.length) * 100) : 0;

  const tagCount = {};
  reviews.forEach(r => (r.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const unlimited = hasUnlimited();
  const left = passesLeft();

  const reviewCards = sortReviews(reviews).map(r => {
    const liked = !!store.data.likes[r.id];
    const locked = !isUnlocked(r);
    const mini = r.aspects ? ASPECT_KEYS.map(a =>
      `<span class="mini-aspect">${a.label} <b>${fmt(r.aspects[a.key])}</b></span>`).join('') : '';

    // 열람권이 남아 있으면 1개로 열고, 다 썼으면 리뷰 작성으로 안내합니다.
    const overlay = !locked ? '' : `
          <div class="lock-overlay">
            ${left > 0 ? `
              <button class="btn btn-primary btn-sm" data-unlock="${esc(r.id)}">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="3.2" y="7" width="9.6" height="6.6" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
                열람권 1개로 보기
              </button>
              <span class="lock-note">남은 열람권 <b>${left}개</b></span>`
            : `
              <b class="lock-title">열람권을 모두 사용했어요</b>
              <button class="btn btn-primary btn-sm" data-scroll-form>실거주 인증 리뷰 쓰고 무제한 보기</button>`}
          </div>`;

    return `
      <article class="review">
        <div class="review-top">
          <span class="avatar" style="background:${avatarColor(r.author)}">${esc(initial(r.author))}</span>
          <div class="review-who">
            <span class="who-line"><strong>${esc(r.author)}</strong>${verifiedBadge(r.verified)}</span>
            <span>거주 ${esc(r.period)}</span>
          </div>
          <div class="review-right">
            <div style="display:flex;align-items:center;gap:7px">
              ${starsHTML(r.rating)}
              <span class="review-score">${fmt(r.rating)}</span>
            </div>
            <span class="review-date">${esc(r.date)} 작성</span>
          </div>
        </div>
        ${mini ? `<div class="review-aspects">${mini}</div>` : ''}
        <div class="review-body-wrap">
          <p class="review-body${locked ? ' is-locked' : ''}">${esc(r.text)}</p>
          ${overlay}
        </div>
        <div class="review-foot">
          ${(r.tags || []).map(t => `<span class="tag t-gray">#${esc(t)}</span>`).join('')}
          ${locked ? '' : `
          <button class="like-btn${liked ? ' is-on' : ''}" data-like="${esc(r.id)}">
            <svg viewBox="0 0 16 16"><path d="M4 7.5v5.2h6.6a1.6 1.6 0 0 0 1.6-1.3l.8-3.6a1 1 0 0 0-1-1.2H9.4l.5-2.4A1.3 1.3 0 0 0 8.6 2.6L6.2 7H4Z" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
            도움돼요 ${likeCount(r)}
          </button>`}
        </div>
      </article>`;
  }).join('');

  host.innerHTML = `
    <button class="back-btn" data-back>
      <svg viewBox="0 0 16 16"><path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      지도로 돌아가기
    </button>

    <div class="detail-head">
      <div>
        <h1 class="detail-title">${esc(room.name)}</h1>
        <div class="detail-sub">${esc(room.type)} · ${esc(room.address)} · ${esc(room.walk)}</div>
        <div class="tag-row">
          ${topTags.map(([t, n]) => `<span class="tag">#${esc(t)} ${n}</span>`).join('') || '<span class="tag t-gray">아직 태그가 없어요</span>'}
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn${saved ? ' is-on' : ''}" data-save="${esc(room.id)}">
          <svg viewBox="0 0 16 16"><path d="M4.5 2.6h7a.8.8 0 0 1 .8.8v10.1L8 10.9l-4.3 2.6V3.4a.8.8 0 0 1 .8-.8Z" fill="${saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          ${saved ? '관심 목록에 있음' : '관심 목록'}
        </button>
        <button class="btn btn-primary" data-scroll-form>리뷰 쓰기</button>
      </div>
    </div>

    <div class="detail-grid">
      <div style="display:grid;gap:18px">
        <div class="card">
          <div class="score-big">
            <div>
              <div class="score-num" style="color:${scoreColor(score)}">${fmt(score)}</div>
              <div class="score-meta">리뷰 ${reviews.length}개</div>
            </div>
            <div>${starsHTML(score || 0, 's-lg')}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>기본 정보</h3></div>
          <div class="spec">
            <div class="spec-row"><span>보증금 / 월세</span><b>${room.deposit}만 / ${room.rent}만</b></div>
            <div class="spec-row"><span>관리비</span><b>${room.manage}만원</b></div>
            <div class="spec-row"><span>층</span><b>${esc(room.floorInfo)}</b></div>
            <div class="spec-row"><span>전용면적</span><b>${room.area}㎡</b></div>
            <div class="spec-row"><span>위치</span><b>${esc(room.walk)}</b></div>
          </div>
        </div>
      </div>

      <div style="display:grid;gap:18px">
        <div class="card">
          <div class="card-head"><h3>항목별 평점</h3><span class="card-sub">거주자 ${reviews.length}명 평균</span></div>
          <div class="aspects">${aspectRows}</div>
        </div>

        <div class="card">
          <div class="card-head"><h3>살아본 사람들의 요약</h3></div>
          <div class="summary">
            <div class="sum-item">
              <span class="sum-ic" style="background:#e2efe1;color:#4f8b51">좋음</span>
              <div>
                <b>${best ? `${esc(josa(best.label, '이/가'))} 가장 만족스러웠어요` : '아직 항목 평가가 없어요'}</b>
                ${best ? `<em>평균 ${fmt(best.v)}점</em>` : ''}
              </div>
            </div>
            <div class="sum-item">
              <span class="sum-ic" style="background:#fdeaea;color:#c26a6a">주의</span>
              <div>
                <b>${worst ? `${esc(josa(worst.label, '은/는'))} 감안하셔야 해요` : '아직 항목 평가가 없어요'}</b>
                ${worst ? `<em>평균 ${fmt(worst.v)}점</em>` : ''}
              </div>
            </div>
            <div class="sum-item">
              <span class="sum-ic" style="background:var(--violet-tint);color:#7c3fae">추천</span>
              <div>
                <b>거주자 ${reviews.length}명 중 ${recommend}%가 4점 이상을 줬어요</b>
                <div class="sum-bar"><i style="width:${recommend}%"></i></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card form-card" id="formCard">
          <div class="card-head"><h3>이 방에 리뷰 남기기</h3><span class="card-sub">0.5점 단위로 평가할 수 있어요</span></div>
          <form id="reviewForm" novalidate>
            <div class="field">
              <label>전체 별점 <span class="hint">0점부터 5점까지</span></label>
              <div class="star-input">
                <span id="mainStar"></span>
                <span class="star-value" id="mainStarVal">0.0<small> / 5.0</small></span>
                <button type="button" class="star-clear" id="starClear">0점으로</button>
              </div>
            </div>

            <div class="field">
              <label>항목별 평점 <span class="hint">선택</span></label>
              <div class="aspect-inputs" id="aspectInputs"></div>
            </div>

            <div class="field-2">
              <div class="field">
                <label for="fAuthor">닉네임</label>
                <input class="input" id="fAuthor" placeholder="예) 3년차 자취러" maxlength="20" />
              </div>
              <div class="field">
                <label for="fPeriod">거주 기간</label>
                <input class="input" id="fPeriod" placeholder="예) 2023.03 – 2025.02" maxlength="30" />
              </div>
            </div>

            <div class="field">
              <label for="fText">거주 경험 <span class="hint">살아보지 않으면 모를 정보를 적어주세요</span></label>
              <textarea class="textarea" id="fText" maxlength="800"
                placeholder="예) 남향이라 채광이 좋습니다. 세탁기가 돌아가는 중에는 화장실 수압이 약해져요. 여름 장마철에는 방이 조금 습한 느낌이 있습니다."></textarea>
            </div>

            <div class="field">
              <label for="fTags">태그 <span class="hint">쉼표로 구분</span></label>
              <input class="input" id="fTags" placeholder="예) 남향, 채광 좋음, 벌레 없음" maxlength="80" />
            </div>

            <div class="field">
              <label style="display:flex;align-items:center;gap:9px;font-weight:400;font-size:12.5px;color:var(--ink-2)">
                <input type="checkbox" id="fVerify" />
                계약서로 거주를 인증합니다 (체크하지 않으면 미인증 리뷰로 등록돼요)
              </label>
            </div>

            <div class="form-actions">
              <button type="submit" class="btn btn-primary">리뷰 등록</button>
              <span class="form-note">등록한 리뷰는 이 브라우저에 저장됩니다.</span>
            </div>
          </form>
    </div>

    ${unlimited ? `
    <div class="pass-bar is-free">
      <span class="pass-ic">✓</span>
      <div>
        <b>모든 리뷰를 무제한으로 볼 수 있어요</b>
        <span>실거주 인증 리뷰를 남겨주셔서 열람권이 필요 없습니다.</span>
      </div>
    </div>`
    : `
    <div class="pass-bar${left === 0 ? ' is-empty' : ''}">
      <span class="pass-ic">${left}</span>
      <div>
        <b>${left > 0 ? `남은 열람권 ${left}개` : '열람권을 모두 사용했어요'}</b>
        <span>리뷰 본문 하나를 열 때마다 열람권 1개가 사용됩니다.
          <b>실거주 인증 리뷰를 작성하면 이후 모든 리뷰를 무제한</b>으로 볼 수 있어요.</span>
      </div>
      <button class="btn btn-sm${left === 0 ? ' btn-primary' : ''}" data-scroll-form>리뷰 쓰고 무제한 전환</button>
    </div>`}

    <div class="section-title">
      <h2>거주자 리뷰</h2>
      <span class="count">${reviews.length}개</span>
      <div class="sortset">
        <button class="chip${state.sort === 'recent' ? ' is-on' : ''}" data-sort="recent">최신순</button>
        <button class="chip${state.sort === 'rating' ? ' is-on' : ''}" data-sort="rating">평점순</button>
        <button class="chip${state.sort === 'likes' ? ' is-on' : ''}" data-sort="likes">도움순</button>
      </div>
    </div>
    <div class="review-list">
      ${reviewCards || '<div class="empty"><b>아직 리뷰가 없어요</b>이 방의 첫 번째 리뷰를 남겨보세요.</div>'}
    </div>`;

  // 별점 입력기 장착
  let mainValue = 0;
  const mainPicker = makeStarPicker(0, v => {
    mainValue = v;
    $('#mainStarVal').innerHTML = `${fmt(v)}<small> / 5.0</small>`;
  });
  $('#mainStar').appendChild(mainPicker);
  $('#starClear').addEventListener('click', () => mainPicker.setValue(0));

  const aspectValues = {};
  const aspectHost = $('#aspectInputs');
  ASPECT_KEYS.forEach(a => {
    aspectValues[a.key] = 0;
    const row = document.createElement('div');
    row.className = 'aspect-input';
    row.innerHTML = `<span>${a.label}</span>`;
    const b = document.createElement('b');
    b.textContent = '0.0';
    const picker = makeStarPicker(0, v => { aspectValues[a.key] = v; b.textContent = fmt(v); });
    row.appendChild(picker);
    row.appendChild(b);
    aspectHost.appendChild(row);
  });

  $('#reviewForm').addEventListener('submit', e => {
    e.preventDefault();
    submitReview(room, () => mainValue, aspectValues);
  });
}

function submitReview(room, getMain, aspectValues) {
  const text = $('#fText').value.trim();
  const rating = getMain();

  if (text.length < 10) {
    toast('거주 경험을 10자 이상 적어주세요.');
    $('#fText').focus();
    return;
  }

  const usedAspects = {};
  let hasAspect = false;
  ASPECT_KEYS.forEach(a => {
    if (aspectValues[a.key] > 0) { usedAspects[a.key] = aspectValues[a.key]; hasAspect = true; }
  });

  const now = new Date();
  const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
  const verified = $('#fVerify').checked;
  const isFirstEver = store.data.userReviews.length === 0;   // 작성자 전환 여부
  const wasLimited = !hasUnlimited();                        // 이번 리뷰로 무제한이 되는지

  store.data.userReviews.push({
    id: `u-${Date.now()}`,
    roomId: room.id,
    author: $('#fAuthor').value.trim() || '익명의 자취러',
    period: $('#fPeriod').value.trim() || '기간 미입력',
    date,
    rating,
    aspects: hasAspect ? usedAspects : null,
    tags: $('#fTags').value.split(',').map(t => t.trim()).filter(Boolean).slice(0, 5),
    text,
    likes: 0,
    verified,
  });
  store.save();

  // 사용자 속성을 먼저 갱신해야 이번 이벤트부터 '작성자'로 집계됩니다.
  syncUserProps();

  track('submit_review', {
    ...roomParams(room),
    review_rating: rating,
    verified,
    aspect_count: Object.keys(usedAspects).length,
    tag_count: $('#fTags').value.split(',').filter(t => t.trim()).length,
    text_length: text.length,
    is_first_review: isFirstEver,
  });

  // 읽기만 하던 방문자가 작성자로 전환된 순간. 이 이벤트의 사용자 수 / 전체 사용자 수 = 작성 전환율
  if (isFirstEver) track('first_review_written', roomParams(room));

  // 실거주 인증 리뷰를 처음 남기면 열람권 제한이 풀립니다.
  const justUnlimited = verified && wasLimited;
  if (justUnlimited) {
    track('unlimited_granted', { ...roomParams(room), passes_left_at_grant: passesLeft() });
  }

  if (justUnlimited) {
    toast('실거주 인증 리뷰 감사합니다! 이제 모든 리뷰를 열람권 없이 볼 수 있어요.');
  } else if (!verified && state.verifiedOnly) {
    state.verifiedOnly = false;
    syncVerifiedToggle();
    toast('미인증 리뷰로 등록했어요. 인증 리뷰 필터를 껐습니다.');
  } else {
    toast('리뷰를 등록했어요. 고맙습니다!');
  }
  render();
}

/* ---------------------------- 목록 / 랭킹 / 관심 / 내 리뷰 ---------------------------- */
function renderListView() {
  const host = $('#view-list');
  const mode = state.view;
  const rooms = allRooms().filter(matchesFilter);

  if (mode === 'myreviews') {
    const mine = allRooms()
      .flatMap(room => room.reviews.filter(r => r.isMine).map(r => ({ r, room })))
      .sort((a, b) => String(b.r.date).localeCompare(String(a.r.date)));

    host.innerHTML = `
      <h1 class="headline">내가 쓴 리뷰 <em>${mine.length}</em>개</h1>
      <div class="review-list">
        ${mine.length ? mine.map(({ r, room }) => `
          <article class="review">
            <div class="review-top">
              <span class="avatar" style="background:${avatarColor(r.author)}">${esc(initial(r.author))}</span>
              <div class="review-who">
                <span class="who-line"><strong>${esc(room.name)}</strong>${verifiedBadge(r.verified)}</span>
                <span>${esc(r.author)} · 거주 ${esc(r.period)}</span>
              </div>
              <div class="review-right">
                <div style="display:flex;align-items:center;gap:7px">${starsHTML(r.rating)}<span class="review-score">${fmt(r.rating)}</span></div>
                <span class="review-date">${esc(r.date)} 작성</span>
              </div>
            </div>
            <p class="review-body">${esc(r.text)}</p>
            <div class="review-foot">
              ${(r.tags || []).map(t => `<span class="tag t-gray">#${esc(t)}</span>`).join('')}
              <button class="like-btn" data-del="${esc(r.id)}">삭제</button>
            </div>
          </article>`).join('')
          : '<div class="empty"><b>아직 작성한 리뷰가 없어요</b>지도에서 살았던 방을 찾아 첫 리뷰를 남겨보세요.</div>'}
      </div>`;
    return;
  }

  if (mode === 'write') {
    host.innerHTML = `
      <h1 class="headline">어떤 방의 리뷰를 남기시겠어요?</h1>
      <p class="detail-sub" style="margin-top:10px">방을 선택하면 리뷰 작성 폼으로 이동합니다.</p>
      <div class="room-grid">
        ${allRooms().map(room => roomCardHTML(room)).join('')}
      </div>`;
    return;
  }

  if (mode === 'saved') {
    const list = allRooms().filter(r => store.data.saved[r.id]);
    host.innerHTML = `
      <h1 class="headline">관심 목록 <em>${list.length}</em>곳</h1>
      ${list.length
        ? `<div class="room-grid">${list.map(roomCardHTML).join('')}</div>`
        : '<div class="empty"><b>관심 목록이 비어 있어요</b>방 상세 화면에서 북마크를 누르면 여기에 모입니다.</div>'}`;
    return;
  }

  if (mode === 'settings') {
    host.innerHTML = `
      <h1 class="headline">설정</h1>
      <div class="card" style="margin-top:18px;max-width:520px">
        <div class="card-head"><h3>이 브라우저에 저장된 내 데이터</h3></div>
        <div class="spec">
          <div class="spec-row"><span>리뷰 열람</span><b>${hasUnlimited()
            ? '무제한 (실거주 인증 리뷰 작성)'
            : `열람권 ${passesLeft()}개 남음 / ${INITIAL_PASSES}개`}</b></div>
          <div class="spec-row"><span>열어본 리뷰</span><b>${Object.values(store.data.unlocked).filter(Boolean).length}개</b></div>
          <div class="spec-row"><span>작성한 리뷰</span><b>${store.data.userReviews.length}개</b></div>
          <div class="spec-row"><span>관심 목록</span><b>${Object.values(store.data.saved).filter(Boolean).length}곳</b></div>
          <div class="spec-row"><span>도움돼요 누른 리뷰</span><b>${Object.values(store.data.likes).filter(Boolean).length}개</b></div>
        </div>
        <div class="form-actions" style="margin-top:18px">
          <button class="btn" data-reset>내 데이터 모두 지우기</button>
          <span class="form-note">서버 없이 브라우저에만 저장됩니다.</span>
        </div>
      </div>`;
    return;
  }

  if (mode === 'ranking') {
    const ranked = [...allRooms()]
      .filter(r => roomScore(r) != null)
      .sort((a, b) => roomScore(b) - roomScore(a));
    host.innerHTML = `
      <h1 class="headline">평점 랭킹</h1>
      <p class="detail-sub" style="margin-top:10px">성균관대 캠퍼스타운 · 리뷰 평점 기준</p>
      <div class="review-list">
        ${ranked.map((room, i) => {
          const s = roomScore(room);
          return `<button class="rank-row${i < 3 ? ' top' : ''}" data-open="${room.id}">
            <span class="rank-no">${i + 1}</span>
            <span>
              <div class="rank-name">${esc(room.name)}</div>
              <div class="rank-meta">${esc(room.type)} · ${esc(room.walk)} · ${esc(priceText(room))}</div>
            </span>
            <span class="rank-right">
              ${starsHTML(s, 's-sm')}
              <span class="rc-score" style="background:${scoreColor(s)}">${fmt(s)}</span>
            </span>
          </button>`;
        }).join('')}
      </div>`;
    return;
  }

  // 전체 목록
  host.innerHTML = `
    <h1 class="headline">전체 방 <em>${rooms.length}</em>곳</h1>
    <div class="subrow">
      <span class="subrow-label">${state.query ? `‘${esc(state.query)}’ 검색 결과` : '등록된 모든 방'}</span>
      <div class="chipset">${filterChipsHTML()}</div>
    </div>
    ${rooms.length
      ? `<div class="room-grid">${rooms.map(roomCardHTML).join('')}</div>`
      : '<div class="empty"><b>조건에 맞는 방이 없어요</b>검색어나 필터를 바꿔보세요.</div>'}`;
}

function filterChipsHTML() {
  return [['all', '전체'], ['원룸', '원룸'], ['오피스텔', '오피스텔'], ['high', '평점 4.0+']]
    .map(([k, label]) => `<button class="chip${state.filter === k ? ' is-on' : ''}" data-filter="${k}">${label}</button>`)
    .join('');
}

function roomCardHTML(room) {
  const s = roomScore(room);
  return `
    <button class="room-card" data-open="${room.id}">
      <div class="rc-top">
        <div>
          <h3>${esc(room.name)}</h3>
          <div class="rc-addr">${esc(room.type)} · ${esc(room.walk)}</div>
        </div>
        <div class="rc-score" style="background:${scoreColor(s)}">${fmt(s)}</div>
      </div>
      <div class="rc-stars">${starsHTML(s || 0, 's-sm')}<span class="rc-cnt">리뷰 ${visibleReviews(room).length}개</span></div>
      <div class="rc-price">${esc(priceText(room))}<span>관리비 ${room.manage}만</span></div>
    </button>`;
}

/* ---------------------------- 렌더 ---------------------------- */
function render() {
  const isMap = state.view === 'map';
  const isDetail = state.view === 'detail';

  $('#view-map').hidden = !isMap;
  $('#view-detail').hidden = !isDetail;
  $('#view-list').hidden = isMap || isDetail;

  if (isMap) {
    $$('#filterChips .chip').forEach(c => c.classList.toggle('is-on', c.dataset.filter === state.filter));
    renderPins();
    renderStatsCards();
  }
  else if (isDetail) renderDetail();
  else renderListView();

  renderPanel();

  $('#savedBadge').textContent = Object.values(store.data.saved).filter(Boolean).length;
  $('#mineBadge').textContent = store.data.userReviews.length;

  const pass = $('#passLabel');
  pass.textContent = hasUnlimited() ? '리뷰 열람 무제한' : `열람권 ${passesLeft()}개`;
  pass.classList.toggle('is-unlimited', hasUnlimited());
  pass.classList.toggle('is-empty', !hasUnlimited() && passesLeft() === 0);

  const navKey = isDetail ? 'map' : state.view;
  $$('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.nav === navKey));
}

/* ---------------------------- 이벤트 ---------------------------- */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => { el.hidden = true; }, 250);
  }, 2600);
}

function syncVerifiedToggle() {
  const t = $('#verifiedToggle');
  t.classList.toggle('is-on', state.verifiedOnly);
  t.setAttribute('aria-checked', String(state.verifiedOnly));
}

document.addEventListener('click', e => {
  // 로고 클릭 = 첫 화면으로. 검색어와 필터도 함께 초기화합니다.
  const home = e.target.closest('[data-home]');
  if (home) {
    state.query = '';
    state.filter = 'all';
    state.roomId = null;
    $('#searchInput').value = '';
    $('#mapHint').textContent = '핀을 클릭하면 그 방의 리뷰를 볼 수 있어요';
    go('#/map');
    return;
  }

  const open = e.target.closest('[data-open]');
  if (open) { openRoom(open.dataset.open); return; }

  const back = e.target.closest('[data-back]');
  if (back) { go('#/map'); return; }

  const nav = e.target.closest('[data-nav]');
  if (nav) { go(`#/${nav.dataset.nav}`); return; }

  const chip = e.target.closest('[data-filter]');
  if (chip) {
    state.filter = chip.dataset.filter;
    $$('#filterChips .chip').forEach(c => c.classList.toggle('is-on', c.dataset.filter === state.filter));
    render();
    track('select_filter', { filter: state.filter, screen_name: state.view });
    return;
  }

  const sort = e.target.closest('[data-sort]');
  if (sort) {
    state.sort = sort.dataset.sort;
    render();
    track('sort_reviews', { sort: state.sort, room_id: state.roomId || '' });
    return;
  }

  const unlock = e.target.closest('[data-unlock]');
  if (unlock) {
    const id = unlock.dataset.unlock;
    if (hasUnlimited() || store.data.unlocked[id]) { render(); return; }
    if (passesLeft() <= 0) {
      toast('열람권을 모두 사용했어요. 실거주 인증 리뷰를 남기면 무제한으로 볼 수 있어요.');
      return;
    }
    store.data.passes -= 1;
    store.data.unlocked[id] = true;
    store.save();
    if (visit) visit.unlocked++;

    track('unlock_review', {
      review_id: id,
      passes_left: passesLeft(),
      passes_used: INITIAL_PASSES - passesLeft(),
      ...roomParams(getRoom(state.roomId)),
    });
    if (passesLeft() === 0) track('passes_exhausted', roomParams(getRoom(state.roomId)));

    toast(passesLeft() > 0
      ? `열람권 1개를 사용했어요. ${passesLeft()}개 남았습니다.`
      : '마지막 열람권을 사용했어요. 리뷰를 작성하면 무제한으로 볼 수 있어요.');
    render();
    return;
  }

  const like = e.target.closest('[data-like]');
  if (like) {
    const id = like.dataset.like;
    store.data.likes[id] = !store.data.likes[id];
    store.save();
    render();
    // 이번 열람에서 도움돼요를 눌렀다면 '정독'으로 봅니다.
    if (store.data.likes[id] && visit) visit.helpful++;
    track('like_review', {
      review_id: id,
      liked: !!store.data.likes[id],
      ...roomParams(getRoom(state.roomId)),
    });
    return;
  }

  const save = e.target.closest('[data-save]');
  if (save) {
    const id = save.dataset.save;
    store.data.saved[id] = !store.data.saved[id];
    store.save();
    toast(store.data.saved[id] ? '관심 목록에 담았어요.' : '관심 목록에서 뺐어요.');
    render();
    track('save_room', { saved: !!store.data.saved[id], ...roomParams(getRoom(id)) });
    return;
  }

  const del = e.target.closest('[data-del]');
  if (del) {
    store.data.userReviews = store.data.userReviews.filter(r => r.id !== del.dataset.del);
    store.save();
    syncUserProps();
    toast('리뷰를 삭제했어요.');
    render();
    return;
  }

  const reset = e.target.closest('[data-reset]');
  if (reset) {
    store.data = { userReviews: [], likes: {}, saved: {}, passes: INITIAL_PASSES, unlocked: {} };
    store.save();
    syncUserProps();
    toast('저장된 데이터를 모두 지웠어요.');
    render();
    return;
  }

  const scrollForm = e.target.closest('[data-scroll-form]');
  if (scrollForm) {
    $('#formCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const ptab = e.target.closest('[data-ptab]');
  if (ptab) { state.panelTab = ptab.dataset.ptab; renderPanel(); return; }

  const group = e.target.closest('[data-group]');
  if (group) {
    group.classList.toggle('is-collapsed');
    $(`[data-list="${group.dataset.group}"]`).classList.toggle('is-hidden');
  }
});

let searchTimer;
$('#searchInput').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;

    // 어떤 조건으로 방을 찾는지. 한두 글자는 입력 중인 경우가 많아 제외합니다.
    const q = state.query.trim();
    if (q.length >= 2) {
      track('search', { search_term: q, result_count: allRooms().filter(matchesFilter).length });
    }

    if (state.view === 'detail' && state.query) { go('#/list'); return; }
    render();
    if (state.view === 'map') {
      const hint = $('#mapHint');
      hint.textContent = state.query
        ? `‘${state.query}’ 검색 결과 ${allRooms().filter(matchesFilter).length}곳`
        : '핀을 클릭하면 그 방의 리뷰를 볼 수 있어요';
      hint.classList.remove('is-gone');
    }
  }, 160);
});

$('#verifiedToggle').addEventListener('click', () => {
  state.verifiedOnly = !state.verifiedOnly;
  syncVerifiedToggle();
  toast(state.verifiedOnly ? '거주 인증 리뷰만 봅니다.' : '모든 리뷰를 봅니다.');
  render();
  track('toggle_verified_only', { enabled: state.verifiedOnly });
});

$('#mapHelpBtn').addEventListener('click', () => {
  toast('드래그로 이동, 휠로 확대·축소할 수 있어요.');
});

$('#bellBtn').addEventListener('click', () => toast('새 리뷰 알림 3개가 있어요.'));
$('#regionSelect').addEventListener('click', () => toast('현재는 성균관대 캠퍼스타운만 서비스 중이에요.'));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.view === 'detail') go('#/map');
});

setTimeout(() => $('#mapHint').classList.add('is-gone'), 5200);

/* ---------------------------- 라우팅 ---------------------------- */
const VIEWS = ['map', 'list', 'ranking', 'saved', 'write', 'myreviews', 'settings'];

/** 주소창 해시로 화면을 결정합니다. 방 상세는 #/room/r1 처럼 공유할 수 있어요. */
function routeFromHash() {
  endRoomVisit('navigate');   // 다른 화면으로 넘어가기 전에 열람 기록을 마감

  const h = location.hash.replace(/^#\/?/, '');
  const room = h.match(/^room\/(.+)$/);

  if (room && getRoom(room[1])) {
    state.view = 'detail';
    state.roomId = room[1];
  } else if (VIEWS.includes(h)) {
    state.view = h;
    state.roomId = null;
  } else {
    state.view = 'map';
    state.roomId = null;
  }
  render();
  trackNavigation();
}

/* 화면 전환 집계.
   최초 1회는 gtag('config')가 이미 page_view를 보내므로 건너뜁니다. */
let firstRoute = true;

const BASE_TITLE = '원룸 리뷰 사이트 방구석 — 살아본 사람이 남긴 자취방 실거주 후기';

function trackNavigation() {
  const room = state.view === 'detail' ? getRoom(state.roomId) : null;
  const title = room ? `방 상세 – ${room.name}` : `${VIEW_TITLES[state.view] || state.view} – 방구석`;

  // 브라우저 탭·북마크·공유 링크에 화면에 맞는 제목이 남도록 합니다.
  document.title = room
    ? `${room.name} 원룸 리뷰 — ${room.walk} | 방구석`
    : state.view === 'map' ? BASE_TITLE : `${VIEW_TITLES[state.view] || ''} | 방구석 원룸 리뷰`;

  if (firstRoute) {
    firstRoute = false;
  } else {
    track('page_view', {
      page_location: location.href,
      page_path: location.hash || '#/map',
      page_title: title,
      screen_name: state.view,
    });
  }

  // 어떤 방이 많이 열리는지 — 최초 진입(공유 링크)까지 포함해 집계합니다.
  if (room) {
    track('view_room', roomParams(room));
    startRoomVisit(room);
  }
}

function go(hash) {
  if (location.hash === hash) routeFromHash();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  routeFromHash();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------------------------- 시작 ---------------------------- */
syncUserProps();      // 첫 이벤트부터 작성자 여부가 붙도록 라우팅보다 먼저
syncVerifiedToggle();
routeFromHash();
