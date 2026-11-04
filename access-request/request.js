import { url, publishableKey } from './config.js';

const form = document.getElementById('request');
const button = form.querySelector('button');
const status = document.getElementById('status');

button.disabled = false;
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  const fields = new FormData(form);
  const request = {
    p_name: fields.get('name').trim(),
    p_email: fields.get('email').trim(),
    p_use_case: fields.get('useCase').trim(),
  };
  button.disabled = true;
  status.textContent = 'Sending your request…';
  try {
    const response = await fetch(url + '/rest/v1/rpc/request_beta_access', {
      method: 'POST',
      headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      status.textContent = response.status === 400
        ? 'Check your name, email and audit details, then try again.'
        : 'Your request could not be saved. Please try again in a moment.';
      return;
    }
    form.reset();
    form.hidden = true;
    status.textContent = 'Request received. Thanks for your interest in the beta.';
  } catch {
    status.textContent = 'The connection dropped. Please try again.';
  } finally {
    button.disabled = false;
  }
});
