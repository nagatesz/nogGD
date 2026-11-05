const game = document.querySelector('#game');
const statusText = document.querySelector('#status');
const statusDot = document.querySelector('#status-dot');
const welcome = document.querySelector('#welcome');
const resourceInput = document.querySelector('#resources');
const levelInput = document.querySelector('#levels');

function setStatus(message, state = 'ready') {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state}`;
}

document.querySelector('#start').addEventListener('click', () => resourceInput.click());
document.querySelector('#fullscreen').addEventListener('click', async () => {
  const target = document.querySelector('.game-frame');
  if (!document.fullscreenElement) await target.requestFullscreen();
  else await document.exitFullscreen();
});

resourceInput.addEventListener('change', () => {
  const files = Array.from(resourceInput.files || []);
  if (!files.length) return;
  welcome.classList.add('hidden');
  setStatus(`Copying ${files.length.toLocaleString()} resource files into browser storage…`, 'busy');
  game.contentWindow.postMessage({type: 'import-resources', files}, location.origin);
});

levelInput.addEventListener('change', () => {
  const files = Array.from(levelInput.files || []);
  if (!files.length) return;
  setStatus('Reading local level data on this device…', 'busy');
  game.contentWindow.postMessage({type: 'import-level-files', files}, location.origin);
});

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== game.contentWindow) return;
  const message = event.data || {};
  if (message.type === 'noggd-status') {
    setStatus(message.text || 'Ready', message.state || 'ready');
    if (message.gameReady) welcome.classList.add('hidden');
  }
});

game.addEventListener('load', () => setStatus('Game runtime loaded. Choose your local Resources folder to begin.', 'ready'));
