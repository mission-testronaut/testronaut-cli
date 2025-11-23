export const finalResponseHandler = (msg) => {
  const final = msg.content?.trim().toLowerCase();
  if (final?.startsWith('success')) {
    console.log('\n┏━ FINAL AGENT RESPONSE ━━━━━━━━━━━━━━━━━━━');
    console.log(msg.content);
    console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return { finalMessage: msg.content, success: true};
  }
  if (final?.startsWith('failure')) {
    console.log('\n┏━ FINAL AGENT RESPONSE ━━━━━━━━━━━━━━━━━━━');
    console.log(msg.content);
    console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return { finalMessage: msg.content, success: false};
  }
  return null;
}

export const wait = (ms) => new Promise(res => setTimeout(res, ms));

export function validateAndInsertMissingToolResponses(messages, options = {}) {
  const { insertPlaceholders = true } = options;
  const missingResponses = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const toolCall of msg.tool_calls) {
        const expectedId = toolCall.id;

        const hasResponse = messages.slice(i + 1).some(
          (nextMsg) =>
            nextMsg.role === 'tool' &&
            nextMsg.tool_call_id === expectedId
        );

        if (!hasResponse) {
          console.warn(
            `⚠️ Missing response for tool_call_id: ${expectedId}, function: ${toolCall.function.name}, from assistant message index: ${i}`
          );
          missingResponses.push(expectedId);

          if (insertPlaceholders) {
            const placeholder = {
              role: 'tool',
              tool_call_id: expectedId,
              name: toolCall.function.name,
              type: 'function',
              content: `[auto-inserted placeholder] No result returned for ${toolCall.function.name}`,
            };

            // Insert directly after the assistant tool call
            messages.splice(i + 1, 0, placeholder);
            console.warn(`⚠️ Inserted placeholder for missing tool_call_id: ${expectedId}`);
          }
        }
      }
    }
  }

  if (missingResponses.length > 0) {
    console.warn(`⚠️ Missing tool responses for: ${missingResponses.join(', ')}`);
    return insertPlaceholders;
  }

  return true;
}