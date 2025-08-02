export const finalResponseHandler = (msg) => {
  const final = msg.content?.trim().toLowerCase();
  if (final?.startsWith('success')) {
    console.log('\n┏━ FINAL AGENT RESPONSE ━━━━━━━━━━━━━━━━━━━');
    console.log(msg.content);
    console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return true;
  }
  if (final?.startsWith('failure')) {
    console.log('\n┏━ FINAL AGENT RESPONSE ━━━━━━━━━━━━━━━━━━━');
    console.log(msg.content);
    console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return false;
  }
  return null;
}