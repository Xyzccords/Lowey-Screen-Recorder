const timerEl = document.getElementById('timer');
const dotEl = document.getElementById('dot');
let intervalId = null;

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function runTimerFrom(startedAt) {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(() => {
    timerEl.textContent = formatElapsed(Date.now() - startedAt);
  }, 500);
}

window.lowey.onFloatingStart((startedAt) => {
  dotEl.classList.remove('paused');
  runTimerFrom(startedAt);
});

window.lowey.onFloatingPause(() => {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  dotEl.classList.add('paused');
});

window.lowey.onFloatingResume((startedAt) => {
  dotEl.classList.remove('paused');
  runTimerFrom(startedAt);
});
