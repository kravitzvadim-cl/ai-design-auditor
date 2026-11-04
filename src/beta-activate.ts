const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
const activation = document.querySelector<HTMLFormElement>('#activation')!;
const hash = fragment.get('token_hash') ?? '';
const access = fragment.get('access_token') ?? '';
const type = fragment.get('type') ?? '';
const password = activation.elements.namedItem('password') as HTMLInputElement | null;
password?.addEventListener('input', () => {
  password.setCustomValidity(new TextEncoder().encode(password.value).length > 72 ? 'Use a shorter password.' : '');
});
const token = /^[A-Za-z0-9_-]{16,256}$/.test(hash) ? hash :
  password && access.length <= 3500 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(access) ? access : '';
if (token && (password ? ['invite', 'recovery'] : ['invite', 'magiclink']).includes(type)) {
  (activation.elements.namedItem('token') as HTMLInputElement).value = token;
  (activation.elements.namedItem('type') as HTMLInputElement).value = type;
  activation.querySelector('button')!.disabled = false;
} else {
  const status = document.getElementById('activation-status')!;
  if (!status.textContent) status.textContent = password ? 'Open the password link from your invitation or recovery email.' : 'Open the private sign-in link from your invitation.';
}
