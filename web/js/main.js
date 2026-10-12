import { Connection } from './net.js';
import { UI } from './ui.js';
import { Game } from './game.js';

let game;
const conn = new Connection({
  status: (s) => ui.setStatus(s),
  hello: (m) => ui.setHello(m.hello),
  batch: (m) => game.onBatch(m.pkts),
  stats: (m) => ui.setStats(m.stats),
  rules: (m) => { ui.setRules(m.rules); game.onRules(m.rules); },
  killed: (m) => game.onKilled(m),
  deflect: (m) => game.onDeflect(m),
  panicked: (m) => game.onPanicked(m),
  error: (m) => game.onError(m),
});
const ui = new UI(conn);
game = new Game(document.getElementById('stage'), conn, ui);
ui.bindGame(game);
window.game = game; // handy for poking at state from devtools
conn.connect();

// Splash doubles as the user gesture browsers need before audio can play.
const params = new URLSearchParams(location.search);
if (params.has('token') || params.has('demo')) {
  const splash = document.getElementById('splash');
  splash.hidden = false;
  document.getElementById('splash-sub').textContent = params.has('demo')
    ? 'Demo mode: simulated traffic, nothing is dropped.'
    : 'Live mode: hits drop real traffic on this machine.';
  game.paused = true; // hold the game (silently) until the player is ready
  const start = () => {
    splash.hidden = true;
    game.paused = false;
    game.sound.ensure();
  };
  document.getElementById('btn-start').addEventListener('click', start);
  splash.addEventListener('click', (e) => { if (e.target === splash) start(); });
  window.addEventListener('keydown', (e) => {
    if (!splash.hidden && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      start();
    }
  });
}
