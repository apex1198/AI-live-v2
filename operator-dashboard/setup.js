'use strict';

(function startMagicSetupView() {
  const invoke = window.__TAURI__?.core?.invoke;
  const progress = document.getElementById('setup-progress');
  const fill = document.getElementById('setup-progress-fill');
  const percent = document.getElementById('setup-percent');
  const stepLabel = document.getElementById('setup-step');
  const message = document.getElementById('setup-message');
  const kicker = document.getElementById('setup-kicker');
  const errorPanel = document.getElementById('setup-error');
  const errorMessage = document.getElementById('setup-error-message');
  const retry = document.getElementById('setup-retry');
  const steps = [...document.querySelectorAll('#setup-steps li')];
  const order = ['sandbox', 'runtime', 'python', 'models', 'warmup'];

  function render(status) {
    const value = Math.max(0, Math.min(100, Number(status.progress) || 0));
    fill.style.width = `${value}%`;
    percent.textContent = `${Math.round(value)}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(value)));
    stepLabel.textContent = status.stepLabel || 'Preparing studio';
    message.textContent = status.message || 'Preparing the isolated AI workspace.';
    kicker.textContent = status.firstRun ? 'MAGIC SETUP' : 'STARTING STUDIO';
    const activeIndex = Math.max(0, order.indexOf(status.step));
    steps.forEach((item, index) => {
      item.classList.toggle('active', status.state !== 'ERROR' && index === activeIndex);
      item.classList.toggle('done', status.state === 'READY' || index < activeIndex);
    });
    const failed = status.state === 'ERROR';
    errorPanel.hidden = !failed;
    if (failed) errorMessage.textContent = status.error || 'The setup could not be completed.';
  }

  async function poll() {
    if (!invoke) {
      render({ state: 'ERROR', progress: 0, error: 'Native setup bridge is unavailable.' });
      return;
    }
    try {
      const status = await invoke('magic_setup_status');
      render(status);
      if (status.state !== 'READY' && status.state !== 'ERROR') setTimeout(poll, 250);
    } catch (error) {
      render({ state: 'ERROR', progress: 0, error: String(error) });
    }
  }

  retry.addEventListener('click', async () => {
    retry.disabled = true;
    errorPanel.hidden = true;
    try { await invoke('retry_magic_setup'); } finally { retry.disabled = false; setTimeout(poll, 100); }
  });
  poll();
})();
