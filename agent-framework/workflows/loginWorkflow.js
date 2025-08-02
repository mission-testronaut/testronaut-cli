export const loginWorkflow = {
  goal: 'Login to Collegium and verify dashboard access',
  steps: [
    { type: 'navigate', url: 'https://staging.collegiumbuilt.com/login' },
    { type: 'fill', selector: '#\:r0\:', text: 'owner@collegiumbuilt.com' },
    { type: 'fill', selector: '#auth-login-v2-password', text: 'letmein123' },
    { type: 'click', selector: "button[type='submit']", delayMs: 3000 },
    { type: 'check_text', text: 'Dashboard', expect: true },
  ],
};