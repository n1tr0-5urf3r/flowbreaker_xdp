// DOM side of the game: HUD, rules panel, toasts, tooltip and overlays.

import { LANES, classify, protoName, tcpFlags, hostPort, isSuspicious } from './lanes.js';
import { COST } from './game.js';
import { WEAPONS, UPGRADES, POWERUPS } from './arsenal.js';
import { SKINS } from './skins.js';
import { PERKS, ACHIEVEMENTS, xpForLevel } from './progression.js';

const $ = (sel) => document.querySelector(sel);

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class UI {
  constructor(conn) {
    this.conn = conn;
    this.lastHUD = 0;
    this.prevStats = null;
    this.pps = 0;
    this.stats = null;
    this.rules = [];

    $('#rules').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-unblock]');
      if (btn) this.conn.send({ t: 'unblock', id: btn.dataset.unblock });
    });
    const slider = $('#eps');
    let debounce;
    slider.addEventListener('input', () => {
      $('#eps-val').textContent = slider.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => this.conn.send({ t: 'cfg', maxEps: Number(slider.value) }), 250);
    });
    $('#legend').innerHTML = LANES.map((l) => `<span><i style="background:${hex(l.color)}"></i>${l.name}</span>`).join('');
  }

  bindGame(game) {
    this.game = game;
    $('#armory').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      game.sound.ensure();
      if (b.dataset.act === 'upgrade') game.buyUpgrade(b.dataset.key);
      if (b.dataset.act === 'heli') game.buyHeli();
      if (b.dataset.act === 'ammo') game.buyAmmo();
      this.renderArmory(game);
    });
    $('#weapons').addEventListener('click', (e) => {
      const b = e.target.closest('[data-weapon]');
      if (b) game.selectWeapon(Number(b.dataset.weapon));
    });
    for (const kind of ['tank', 'heli', 'jet']) $(`#btn-${kind}`).addEventListener('click', () => game.toggleVehicle(kind));
    $('#btn-strike').addEventListener('click', () => game.requestStrike());
    this.bindSkins(game);
    $('#btn-research').addEventListener('click', () => this.openResearch(true));
    $('#research-close').addEventListener('click', () => this.openResearch(false));
    $('#research').addEventListener('click', (e) => {
      if (e.target.id === 'research') return this.openResearch(false);
      const b = e.target.closest('button[data-perk]');
      if (b && game.profile.buyPerk(b.dataset.perk)) {
        game.sound.upgrade();
        this.toast('Perk unlocked. It applies from your next run (PLAY AGAIN or reload).', 'kill');
      }
      if (e.target.closest('#respec')) game.profile.respec();
      this.renderResearch(game.profile);
      this.renderProfile(game.profile);
    });
    $('#btn-build').addEventListener('click', () => game.toggleBuild());
    $('#btn-pause').addEventListener('click', () => game.togglePause());
    $('#btn-panic').addEventListener('click', () => game.panic());
    $('#btn-restart').addEventListener('click', () => game.restart());
    $('#cost-turret').textContent = COST.turret;

    const snd = game.sound;
    $('#btn-mute').addEventListener('click', () => this.setMuted(snd.toggleMute()));
    for (const key of ['sfx', 'music']) {
      const el = $(`#vol-${key}`);
      el.value = Math.round(snd.settings[key] * 100);
      el.addEventListener('input', () => {
        snd.ensure();
        snd.set(key, Number(el.value) / 100);
      });
    }
    this.setMuted(snd.settings.muted);
  }

  setStatus(s) {
    const el = $('#conn');
    el.className = `conn ${s}`;
    el.textContent = { online: 'LIVE', offline: 'RECONNECTING', demo: 'DEMO', notoken: 'NO TOKEN' }[s] ?? s;
    $('#notoken').hidden = s !== 'notoken';
  }

  setHello(h) {
    $('#iface').textContent = `${h.iface} · ${h.mode}`;
    $('#ttl').textContent = h.ttl > 0 ? `${h.ttl}s` : 'until exit';
    $('#protect').innerHTML = h.protect.map((p) => `<code>${esc(p)}</code>`).join(' ');
    $('#protect-hosts').innerHTML = (h.protectHosts ?? []).map((p) => `<code>${esc(p)}</code>`).join(' ') || '<span class="dim">none</span>';
    $('#eps').value = h.maxEps;
    $('#eps-val').textContent = h.maxEps;
  }

  setStats(s) {
    const now = performance.now();
    if (this.prevStats) {
      const dt = (now - this.prevStats.at) / 1000;
      if (dt > 0) this.pps = Math.max(0, (s.seen - this.prevStats.seen) / dt);
    }
    this.prevStats = { seen: s.seen, at: now };
    this.stats = s;
  }

  setRules(rules) {
    this.rules = rules;
    const el = $('#rules');
    $('#rule-count').textContent = rules.length;
    if (!rules.length) {
      el.innerHTML = '<li class="empty">No rules yet. Shoot something!</li>';
      return;
    }
    el.innerHTML = rules
      .map((r) => {
        const ttl = r.expiresIn < 0 ? '∞' : `${Math.ceil(r.expiresIn)}s`;
        return `<li><div class="rule-label" title="${esc(r.label)}">${esc(r.label)}</div>
          <div class="rule-meta"><span class="drops">${fmt(r.drops)} dropped</span><span class="ttl">${ttl}</span>
          <button data-unblock="${esc(r.id)}" title="Unblock this flow">✕</button></div></li>`;
      })
      .join('');
  }

  // ---------------------------------------------------------- arsenal

  setMode(mode) {
    document.body.dataset.mode = mode;
    for (const kind of ['tank', 'heli', 'jet']) $(`#btn-${kind}`).classList.toggle('active', mode === kind);
    $('#mode-hint').innerHTML = {
      overview: '<kbd>A</kbd><kbd>D</kbd>/mouse lane · <kbd>B</kbd> build · <kbd>T</kbd> tank · click turret: cockpit',
      cockpit: '<kbd>mouse</kbd> aim · <kbd>A</kbd><kbd>D</kbd> next turret · <kbd>R</kbd> reload · <kbd>E</kbd>/<kbd>Esc</kbd> exit',
      tank: '<kbd>W</kbd><kbd>S</kbd> drive · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>Shift</kbd> boost · mouse aim · ram packets! · <kbd>T</kbd>/<kbd>Esc</kbd> exit',
      heli: '<kbd>W</kbd><kbd>S</kbd> fly · <kbd>A</kbd><kbd>D</kbd> yaw · <kbd>E</kbd><kbd>Q</kbd> up/down · <kbd>Shift</kbd> boost · fly low for power-ups · <kbd>H</kbd> exit',
      jet: '<kbd>W</kbd><kbd>S</kbd> throttle · <kbd>A</kbd><kbd>D</kbd> bank · <kbd>E</kbd><kbd>Q</kbd> climb/dive · grenades = bombs · <kbd>J</kbd> exit',
    }[mode];
  }

  setTargeting(on) {
    $('#btn-strike').classList.toggle('active', on);
    document.body.classList.toggle('targeting', on);
    if (!on) $('#strike-lane').hidden = true;
  }

  setStrikeLane(name) {
    const el = $('#strike-lane');
    el.hidden = !name;
    if (name) el.textContent = `✈ AIRSTRIKE → ${name} · click to confirm, right-click/Esc to cancel`;
  }

  setBoss(pk) {
    $('#boss').hidden = !pk;
    if (pk) {
      $('#boss-name').textContent = `ELEPHANT FLOW · ${pk.p.src}:${pk.p.sp} → :${pk.p.dp}`;
      this.updateBoss(pk);
    }
  }

  updateBoss(pk) {
    $('#boss-hp').style.width = `${Math.max(0, (pk.hp / pk.maxHp) * 100)}%`;
    $('#boss-count').textContent = `×${pk.count} samples · regenerates while the flow flows`;
  }

  banner(text, kind) {
    const el = $('#banner');
    el.textContent = text;
    el.className = `show ${kind}`;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { el.className = ''; }, 2600);
  }

  renderArmory(game) {
    const pips = (lvl, max) => Array.from({ length: max }, (_, i) => `<i class="${i <= lvl ? 'on' : ''}"></i>`).join('');
    $('#armory').innerHTML = UPGRADES.map((u) => {
      const lvl = game.upgrades[u.key];
      const maxed = lvl >= u.levels.length - 1;
      return `<div class="up"><div><b>${u.name}</b> <span class="pips">${pips(lvl, u.levels.length)}</span><br><span class="dim">${u.levels[lvl]}${maxed ? '' : ` → ${u.levels[lvl + 1]}`}</span></div>
        <button data-act="upgrade" data-key="${u.key}" ${maxed ? 'disabled' : ''}>${maxed ? 'MAX' : `${u.cost[lvl]}¢`}</button></div>`;
    }).join('') + `
      <div class="up"><div><b>Gunship</b><br><span class="dim">AI helicopter, 40 s patrol (G)</span></div><button data-act="heli">${game.price('heli')}¢</button></div>
      <div class="up"><div><b>Ammo pack</b><br><span class="dim">+4 rockets +5 grenades +1 cluster</span></div><button data-act="ammo">${COST.ammo}¢</button></div>`;
  }

  updateArsenal(game) {
    const bar = $('#weapons');
    if (!bar.children.length) {
      // Built once and updated in place, so clicks on a slot are never lost to a re-render.
      bar.innerHTML = WEAPONS.map((w, i) => `<div class="wslot" data-weapon="${i}" style="--wc:${hex(w.color)}"><kbd>${i + 1}</kbd><b>${w.name}</b><small></small></div>`).join('');
    }
    WEAPONS.forEach((w, i) => {
      const el = bar.children[i];
      el.classList.toggle('sel', i === game.weapon);
      el.classList.toggle('empty', w.ammo !== Infinity && game.ammo[w.key] === 0);
      const small = el.lastChild;
      if (w.key === 'laser') {
        small.innerHTML = `<span class="heat"><span style="width:${game.arsenal.heat}%" class="${game.arsenal.overheated ? 'hot' : ''}"></span></span>`;
      } else {
        small.textContent = w.ammo === Infinity ? '∞' : game.ammo[w.key];
      }
    });
    const now = performance.now() / 1000;
    $('#buffs').innerHTML = ['rapid', 'spread', 'overcharge'].filter((k) => (game.buffs[k] ?? 0) > now)
      .map((k) => `<span style="color:${hex(POWERUPS[k].color)}">${POWERUPS[k].glyph} ${POWERUPS[k].name} ${Math.ceil(game.buffs[k] - now)}s</span>`).join('');
    $('#strikes').textContent = game.strikes;
    $('#btn-strike').disabled = game.strikes <= 0;
  }

  // ------------------------------------------------------------ skins

  bindSkins(game) {
    const opts = (sel) => Object.entries(SKINS).map(([k, n]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${n}</option>`).join('');
    const sk = game.skins;
    const global = $('#skin-global');
    global.innerHTML = opts(sk.global);
    $('#skin-lanes').innerHTML = LANES.map((l, i) => `
      <div class="skin-row"><span style="color:${hex(l.color)}">${l.name}</span>
        <select data-lane="${l.key}"><option value="">(default)</option>${opts(sk.lane[l.key])}</select>
        <input type="color" data-lane="${l.key}" value="${hex(sk.colorFor(i))}" title="packet colour"></div>`).join('');
    const apply = () => {
      sk.save();
      game.reskinAll();
    };
    global.addEventListener('change', () => { sk.global = global.value; apply(); });
    $('#skin-lanes').addEventListener('change', (e) => {
      const lane = e.target.dataset.lane;
      if (!lane) return;
      if (e.target.tagName === 'SELECT') {
        if (e.target.value) sk.lane[lane] = e.target.value;
        else delete sk.lane[lane];
      } else {
        sk.color[lane] = e.target.value;
      }
      apply();
    });
    $('#skin-reset').addEventListener('click', () => {
      sk.global = 'neon';
      sk.lane = {};
      sk.color = {};
      this.bindSkinsRefresh(game);
      apply();
    });
  }

  bindSkinsRefresh(game) {
    $('#skin-global').value = game.skins.global;
    for (const el of document.querySelectorAll('#skin-lanes select')) el.value = '';
    document.querySelectorAll('#skin-lanes input[type=color]').forEach((el, i) => { el.value = hex(LANES[i].color); });
  }

  // ------------------------------------------------------- progression

  renderProfile(pr) {
    const d = pr.data;
    const need = xpForLevel(d.level);
    $('#pf-rank').textContent = pr.rank;
    $('#pf-level').textContent = `LVL ${d.level}`;
    $('#pf-xp').style.width = `${Math.min(100, (d.xp / need) * 100)}%`;
    $('#pf-xptext').textContent = `${Math.floor(d.xp)} / ${need} XP`;
    $('#pf-kp').textContent = d.kp;
    $('#btn-research').classList.toggle('glow', d.kp > 0);
    if (!$('#research').hidden) this.renderResearch(pr);
  }

  openResearch(on) {
    const g = this.game;
    $('#research').hidden = !on;
    if (on) {
      this.wasPaused = g.paused;
      g.paused = true; // hold the game while shopping
      g.arsenal.stopBeam();
      this.renderResearch(g.profile);
    } else {
      g.paused = this.wasPaused ?? false;
    }
  }

  renderResearch(pr) {
    const d = pr.data;
    $('#rs-head').innerHTML = `<b>${esc(pr.rank)}</b> · level ${d.level} · <span class="kp">${d.kp} KP</span> to spend`;
    $('#rs-perks').innerHTML = PERKS.map((p) => {
      const lvl = pr.perk(p.key);
      const max = p.cost.length;
      const maxed = lvl >= max;
      const pips = Array.from({ length: max }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
      return `<div class="perk ${maxed ? 'maxed' : ''}"><div><b>${p.name}</b> <span class="pips">${pips}</span><br>
        <span class="dim">${lvl ? `now: ${p.desc(lvl)}` : 'not unlocked'}${maxed ? '' : ` · next: ${p.desc(lvl + 1)}`}</span></div>
        <button data-perk="${p.key}" ${maxed || d.kp < p.cost[lvl] ? 'disabled' : ''}>${maxed ? 'MAX' : `${p.cost[lvl]} KP`}</button></div>`;
    }).join('');
    $('#rs-medals').innerHTML = ACHIEVEMENTS.map((a) => {
      const got = d.achievements[a.id];
      return `<div class="medal ${got ? 'got' : ''}" title="${esc(a.desc)}"><span>${got ? '🏆' : '🔒'}</span><div><b>${a.name}</b><br><span class="dim">${a.desc} · ${a.xp} XP</span></div></div>`;
    }).join('');
    const st = d.stats;
    const hrs = Math.floor(st.playSeconds / 3600);
    const mins = Math.floor((st.playSeconds % 3600) / 60);
    $('#rs-stats').innerHTML = [
      ['runs', st.runs], ['flows blocked', fmt(st.blocked)], ['kernel drops', fmt(st.kernelDrops)],
      ['elephants slain', st.bosses], ['best score', fmt(st.bestScore)], ['time defending', `${hrs}h ${mins}m`],
    ].map(([k, v]) => `<div><span class="dim">${k}</span><b>${v}</b></div>`).join('');
  }

  setMuted(muted) {
    const btn = $('#btn-mute');
    btn.textContent = muted ? '🔇' : '🔊';
    btn.classList.toggle('active', !muted);
    btn.title = muted ? 'Unmute (M)' : 'Mute (M)';
  }

  setBuilding(on) {
    $('#btn-build').classList.toggle('active', on);
    document.body.classList.toggle('building', on);
  }

  setPaused(on) {
    $('#btn-pause').classList.toggle('active', on);
    $('#paused').hidden = !on;
  }

  setGameOver(on, score = 0, kills = 0, summary = null) {
    $('#gameover').hidden = !on;
    if (on) {
      $('#go-score').textContent = fmt(score);
      $('#go-kills').textContent = kills;
      const sum = $('#go-summary');
      if (summary) {
        sum.innerHTML = `+${Math.round(summary.xp)} XP${summary.levels ? ` · <b class="kp">${summary.levels} level-up${summary.levels > 1 ? 's' : ''}!</b>` : ''} · best ${fmt(summary.best)}`
          + (summary.unlocked.length ? `<br>🏆 ${summary.unlocked.map((a) => esc(a.name)).join(' · ')}` : '');
      } else sum.textContent = '';
    }
  }

  setCockpit(t) {
    $('#cockpit').hidden = !t;
    document.body.classList.toggle('in-cockpit', !!t);
    if (t) {
      $('#ck-lane').textContent = LANES[t.lane].name;
      $('#ck-lane').style.color = hex(LANES[t.lane].color);
      this.ckTarget = undefined;
    }
  }

  updateCockpit(t, target, cooldown) {
    $('#ck-ammo').textContent = `${t.ammo}/${t.maxAmmo}`;
    $('#ck-heat').style.width = `${Math.min(100, (cooldown / 0.11) * 100)}%`;
    const id = target ? target.id : null;
    $('#crosshair').classList.toggle('locked', !!target && !target.p.prot);
    $('#crosshair').classList.toggle('shielded', !!target && target.p.prot);
    if (id === this.ckTarget) return;
    this.ckTarget = id;
    const box = $('#ck-target');
    if (!target) {
      box.innerHTML = '<span class="dim">NO TARGET</span>';
      return;
    }
    const p = target.p;
    const lane = LANES[classify(p)];
    const ports = p.proto === 6 || p.proto === 17;
    box.innerHTML = `<b style="color:${hex(lane.color)}">${lane.name}</b> ${protoName(p)}${p.prot ? ' <b class="prot">PROTECTED</b>' : ''}${isSuspicious(p) ? ' <b class="susp">SUSPICIOUS</b>' : ''}<br>
      ${esc(ports ? hostPort(p.src, p.sp) : p.src)} → ${esc(ports ? hostPort(p.dst, p.dp) : p.dst)}<br>
      <span class="dim">${p.len} B${p.proto === 6 ? ` · ${tcpFlags(p.flags)}` : ''}${target.count > 1 ? ` · ×${target.count}` : ''}</span>`;
  }

  updateHUD(game) {
    const now = performance.now();
    if (now - this.lastHUD < 100) return;
    this.lastHUD = now;
    this.updateArsenal(game);
    $('#score').textContent = fmt(game.score);
    $('#credits').textContent = game.credits;
    const mult = Math.min(5, 1 + Math.floor(game.combo / 3));
    $('#combo').textContent = game.combo > 1 ? `${game.combo} combo ×${mult}` : '';
    const bar = $('#integrity-bar');
    const frac = game.integrity / game.maxIntegrity;
    bar.style.width = `${frac * 100}%`;
    bar.className = frac > 0.5 ? 'ok' : frac > 0.25 ? 'mid' : 'low';
    $('#integrity').textContent = `${game.integrity}/${game.maxIntegrity}`;
    $('#cost-turret').textContent = game.price('turret');
    if (this.stats) {
      $('#stat-pps').textContent = fmt(this.pps);
      $('#stat-drop').textContent = fmt(this.stats.dropped);
    }
  }

  updateTooltip(pk, mouse) {
    const tip = $('#tooltip');
    if (!pk || !mouse) {
      tip.hidden = true;
      this.tipId = null;
      return;
    }
    const rect = document.querySelector('#stage canvas').getBoundingClientRect();
    tip.style.left = `${rect.left + mouse.x + 16}px`;
    tip.style.top = `${rect.top + mouse.y + 16}px`;
    tip.hidden = false;
    if (this.tipId === pk.id) return;
    this.tipId = pk.id;
    const p = pk.p;
    const lane = LANES[classify(p)];
    const ports = p.proto === 6 || p.proto === 17;
    tip.innerHTML = `
      <div class="tip-head" style="color:${hex(lane.color)}">${lane.name}${lane.name === protoName(p).toUpperCase() ? '' : ` · ${protoName(p)}`}${p.prot ? ' · <b class="prot">PROTECTED</b>' : ''}${isSuspicious(p) ? ' · <b class="susp">SUSPICIOUS</b>' : ''}</div>
      <div>${esc(ports ? hostPort(p.src, p.sp) : p.src)}</div>
      <div class="arrow">↓</div>
      <div>${esc(ports ? hostPort(p.dst, p.dp) : p.dst)}</div>
      <div class="tip-meta">${p.len} B${p.proto === 6 ? ` · flags ${tcpFlags(p.flags)}` : ''}${!ports ? ` · type ${p.dp}` : ''} · flow ${esc(p.id)}${pk.count > 1 ? ` · ×${pk.count}` : ''}</div>`;
  }

  toast(msg, kind = 'info') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    box.prepend(el);
    while (box.children.length > 3) box.lastChild.remove();
    setTimeout(() => el.classList.add('fade'), 3200);
    setTimeout(() => el.remove(), 3800);
  }
}
