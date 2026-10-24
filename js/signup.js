(function () {
  const form = document.getElementById('signupForm');
  const note = document.getElementById('signupNote');
  if (!form || !note) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const emailInput = form.querySelector('input[name="email"]');
    const trap = form.querySelector('input[name="website"]');
    const button = form.querySelector('button');
    const email = emailInput ? emailInput.value.trim() : '';
    const website = trap ? trap.value : '';
    if (button) button.disabled = true;
    note.textContent = 'One moment.';
    try {
      const response = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, website }),
      });
      let data = {};
      try { data = await response.json(); } catch (error) { data = {}; }
      const message = typeof data.message === 'string' ? data.message : data.error;
      note.textContent = typeof message === 'string' && message.length < 240
        ? message
        : 'Please try again in a moment.';
      if (response.ok && data.status === 'ok' && emailInput) emailInput.value = '';
    } catch (error) {
      note.textContent = 'Please try again in a moment.';
    } finally {
      if (button) button.disabled = false;
    }
  });
})();
